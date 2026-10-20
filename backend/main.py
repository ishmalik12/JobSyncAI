import os
import json
import logging
import re
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from starlette.concurrency import run_in_threadpool
import pymupdf
from pydantic import BaseModel, Field
from matcher import match_jobs, performance_snapshot, prepare_match, rank_jobs, score_match_batch
from config import FRONTEND_ORIGIN, JOB_REFRESH_INTERVAL_HOURS, MONGODB_URI
from database import catalog_migrated, connect_database, database_health, find_jobs_by_ids, get_database, list_jobs
from security import current_user, create_session, hash_password, revoke_session, validate_auth_config, verify_password
from interview_coach import (
    build_coach_system_prompt,
    call_gemini_chat,
    get_effective_api_key,
    GEMINI_MODEL,
)

logger = logging.getLogger(__name__)
DATA_FILE = Path(__file__).parent / "data" / "jobs.json"
INDIA_CITIES = (
    "bengaluru", "bangalore", "hyderabad", "gurugram", "gurgaon", "delhi",
    "noida", "pune", "mumbai", "chennai", "kolkata", "ahmedabad", "jaipur",
    "kochi", "cochin", "coimbatore", "mysore", "mangalore", "lucknow", "indore",
)

app = FastAPI(title="JobSync AI")
_refresh_task: asyncio.Task | None = None

_raw_origins = [origin.strip().rstrip("/") for origin in FRONTEND_ORIGIN.split(",") if origin.strip()]
ALLOWED_ORIGINS = _raw_origins if _raw_origins else ["http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.on_event("startup")
def startup_database():
    global _refresh_task
    if MONGODB_URI:
        connect_database()
    if JOB_REFRESH_INTERVAL_HOURS > 0:
        _refresh_task = asyncio.get_running_loop().create_task(_scheduled_refresh())


async def _scheduled_refresh():
    while True:
        await asyncio.sleep(JOB_REFRESH_INTERVAL_HOURS * 3600)
        updater = Path(__file__).parent / "update_jobs.py"
        try:
            process = await asyncio.create_subprocess_exec(sys.executable, str(updater), cwd=str(updater.parent))
            result = await process.wait()
            if result:
                logger.error("Scheduled job refresh exited with status %s", result)
        except Exception:
            logger.exception("Scheduled job refresh could not start")


@app.on_event("shutdown")
async def stop_scheduled_refresh():
    global _refresh_task
    if _refresh_task:
        _refresh_task.cancel()
        try:
            await _refresh_task
        except asyncio.CancelledError:
            pass
        _refresh_task = None


@app.get("/health")
def health():
    database = database_health()
    return {"status": "ok" if not database["configured"] or database["connected"] else "degraded", "database": database}


def catalog_jobs() -> list[dict]:
    try:
        use_mongo = bool(MONGODB_URI and catalog_migrated())
    except Exception as exc:
        logger.exception("MongoDB catalog state could not be read")
        raise HTTPException(status_code=503, detail="The MongoDB catalog is unavailable.") from exc
    if use_mongo:
        try:
            return list_jobs()
        except Exception as exc:
            logger.exception("MongoDB job catalog could not be read")
            raise HTTPException(status_code=503, detail="The MongoDB job catalog is unavailable. Check the backend database connection.") from exc
    try:
        with DATA_FILE.open(encoding="utf-8-sig") as data_file:
            jobs = json.load(data_file)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=503, detail="Job data is unavailable.") from exc
    if not isinstance(jobs, list):
        raise HTTPException(status_code=503, detail="Job data is invalid.")
    return jobs


@app.get("/ingestion/status")
def ingestion_status():
    if not MONGODB_URI:
        return {"configured": False, "sources": []}
    try:
        collection = get_database().ingestion_runs
        source_ids = collection.distinct("source_id")
        sources = {}
        for source_id in source_ids:
            latest = collection.find_one({"source_id": source_id}, {"_id": 0}, sort=[("started_at", -1)])
            successful = collection.find_one({"source_id": source_id, "success": True}, {"_id": 0}, sort=[("started_at", -1)])
            sources[source_id] = {
                "last_attempt_at": latest.get("started_at") if latest else None,
                "last_attempt_success": latest.get("success") if latest else None,
                "last_error": latest.get("error") if latest and not latest.get("success") else None,
                "last_successful_refresh": successful.get("fetched_at") if successful else None,
                "last_successful_job_count": successful.get("saved_job_count") if successful else None,
            }
        return {"configured": True, "sources": sources}
    except Exception as exc:
        raise HTTPException(status_code=503, detail="Ingestion status is unavailable.") from exc


def _is_india_job(job: dict) -> bool:
    country = str(job.get("country") or "").strip().casefold()
    location = str(job.get("location") or "").casefold()
    return country in {"in", "ind", "india"} or bool(
        re.search(r"\bindia\b", location)
        or any(re.search(rf"\b{re.escape(city)}\b", location) for city in INDIA_CITIES)
    )


@app.get("/jobs/stats")
def jobs_stats():
    jobs = catalog_jobs()
    companies = {str(job.get("company") or "").strip() for job in jobs if isinstance(job, dict)}
    india_jobs = [job for job in jobs if isinstance(job, dict) and _is_india_job(job)]
    remote_india = [job for job in india_jobs if (
        str(job.get("work_mode") or "").casefold() == "remote"
        or ("remote" in str(job.get("location") or "").casefold() and "india" in str(job.get("location") or "").casefold())
    )]
    return {
        "job_count": len(jobs),
        "company_count": len(companies - {""}),
        "india_job_count": len(india_jobs),
        "remote_india_count": len(remote_india),
    }


@app.get("/diagnostics/performance")
def matching_performance():
    return performance_snapshot()

@app.post("/resume/parse")
async def parse_resume(file: UploadFile = File(...)):
    filename = (file.filename or "").lower()

    if not filename.endswith(".pdf"):
        raise HTTPException(
            status_code=400,
            detail="Please upload a PDF resume."
        )

    content = await file.read()

    if len(content) > 5 * 1024 * 1024:
        raise HTTPException(
            status_code=413,
            detail="Maximum file size is 5 MB."
        )

    if not content.startswith(b"%PDF-"):
        raise HTTPException(
            status_code=400,
            detail="Invalid PDF file."
        )

    try:
        with pymupdf.open(
            stream=content,
            filetype="pdf"
        ) as document:
            if document.is_encrypted:
                raise HTTPException(
                    status_code=400,
                    detail="Password-protected PDFs are not supported."
                )

            if len(document) > 30:
                raise HTTPException(
                    status_code=400,
                    detail="Resume is too long."
                )

            text = "\n".join(
                page.get_text() for page in document
            ).strip()

    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Could not read this PDF."
        )

    if not text:
        raise HTTPException(
            status_code=400,
            detail="No readable text found. Try a text-based PDF."
        )

    return {
        "filename": file.filename,
        "text": text,
        "characters": len(text)
    }


class MatchRequest(BaseModel):
    resume_text: str
    limit: int = Field(default=100, ge=1, le=5000)


class Credentials(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    password: str = Field(min_length=10, max_length=256)
    name: str = Field(default="", max_length=100)


class ApplicationRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=300)
    status: str = Field(default="Saved", max_length=30)
    notes: str = Field(default="", max_length=2000)


class ApplicationUpdate(BaseModel):
    status: str = Field(min_length=1, max_length=30)
    notes: str | None = Field(default=None, max_length=2000)


class ProfileUpdate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    preferred_titles: list[str] = Field(default_factory=list, max_length=20)
    preferred_locations: list[str] = Field(default_factory=list, max_length=20)
    remote_preference: str = Field(default="any", max_length=20)
    employment_types: list[str] = Field(default_factory=list, max_length=10)
    interests: list[str] = Field(default_factory=list, max_length=30)


class VisitRequest(BaseModel):
    job_id: str = Field(min_length=1, max_length=300)


GROWTH_CATEGORIES = {"Technical Skills", "System Design", "Behavioral & Soft Skills", "Resume & Portfolio", "Interview Mindset"}
GROWTH_STATUSES = {"Identified", "Practicing", "Mastered"}


class GrowthItemCreate(BaseModel):
    title: str = Field(min_length=1, max_length=150)
    category: str = Field(default="Technical Skills", max_length=50)
    reflection: str = Field(default="", max_length=2000)
    action_plan: str = Field(default="", max_length=2000)
    status: str = Field(default="Identified", max_length=30)
    source: str = Field(default="", max_length=150)


class GrowthItemUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=150)
    category: str | None = Field(default=None, max_length=50)
    reflection: str | None = Field(default=None, max_length=2000)
    action_plan: str | None = Field(default=None, max_length=2000)
    status: str | None = Field(default=None, max_length=30)
    source: str | None = Field(default=None, max_length=150)


APPLICATION_STATUSES = {"Saved", "Applied", "Interviewing", "Rejected", "Offered", "Withdrawn"}


def _user_collection(name: str):
    try:
        return get_database()[name]
    except Exception as exc:
        logger.exception("MongoDB user-data collection unavailable")
        raise HTTPException(status_code=503, detail="User data is temporarily unavailable; check MongoDB configuration.") from exc


def _auth_user_document(user: dict) -> dict:
    return {"id": str(user["_id"]), "email": user["email"], "name": user.get("name", ""),
            "created_at": user.get("created_at")}


def _visit_object_id(visit_id: str):
    try:
        from bson import ObjectId
        return ObjectId(visit_id)
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid visit id.") from exc


def lookup_catalog_jobs(job_ids: list[str]) -> dict[str, dict]:
    try:
        migrated = bool(MONGODB_URI and catalog_migrated())
        if migrated:
            records = find_jobs_by_ids(job_ids)
        else:
            requested = set(job_ids)
            records = [job for job in catalog_jobs() if str(job.get("id")) in requested]
    except Exception as exc:
        raise HTTPException(status_code=503, detail="The job catalog is temporarily unavailable.") from exc
    return {str(job.get("id")): job for job in records}


@app.post("/auth/register")
def register(body: Credentials):
    validate_auth_config()
    email = body.email.strip().casefold()
    if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    users = _user_collection("users")
    user = {"_id": str(uuid4()), "email": body.email.strip(), "email_normalized": email,
            "name": body.name.strip(), "password_hash": hash_password(body.password),
            "created_at": datetime.now(timezone.utc)}
    try:
        users.insert_one(user)
    except Exception as exc:
        if exc.__class__.__name__ == "DuplicateKeyError":
            raise HTTPException(status_code=409, detail="An account with this email already exists.") from exc
        raise HTTPException(status_code=503, detail="Could not create the account. Check the database connection.") from exc
    try:
        token = create_session(user["_id"])
    except Exception as exc:
        users.delete_one({"_id": user["_id"]})
        raise HTTPException(status_code=503, detail="Could not start a sign-in session. Try again.") from exc
    return {"access_token": token, "token_type": "bearer", "user": _auth_user_document(user)}


@app.post("/auth/login")
def login(body: Credentials):
    validate_auth_config()
    email = body.email.strip().casefold()
    try:
        user = _user_collection("users").find_one({"email_normalized": email})
    except HTTPException:
        raise
    if not user or not verify_password(body.password, user.get("password_hash", "")):
        raise HTTPException(status_code=401, detail="Email or password is incorrect.")
    return {"access_token": create_session(str(user["_id"])), "token_type": "bearer", "user": _auth_user_document(user)}


@app.get("/auth/me")
def me(user: dict = Depends(current_user)):
    return user


@app.get("/users/me")
def get_profile(user: dict = Depends(current_user)):
    account = _user_collection("users").find_one({"_id": user["id"]})
    if not account:
        raise HTTPException(status_code=404, detail="Account was not found.")
    preferences = _user_collection("user_preferences").find_one({"user_id": user["id"]}) or {}
    profile_fields = ("preferred_titles", "preferred_locations", "remote_preference", "employment_types", "interests")
    return {**_auth_user_document(account), **{key: preferences.get(key, [] if key != "remote_preference" else "any") for key in profile_fields}}


@app.patch("/users/me")
def update_profile(body: ProfileUpdate, user: dict = Depends(current_user)):
    values = body.model_dump()
    for key in ("preferred_titles", "preferred_locations", "employment_types", "interests"):
        if any(not isinstance(value, str) or not value.strip() or len(value) > 100 for value in values[key]):
            raise HTTPException(status_code=422, detail=f"{key} must contain non-empty strings up to 100 characters.")
        values[key] = list(dict.fromkeys(value.strip() for value in values[key]))
    if values["remote_preference"] not in {"any", "remote", "hybrid", "onsite"}:
        raise HTTPException(status_code=422, detail="Unsupported remote-work preference.")
    name = values.pop("name").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Name cannot be empty.")
    _user_collection("users").update_one({"_id": user["id"]}, {"$set": {"name": name}})
    _user_collection("user_preferences").update_one({"user_id": user["id"]}, {"$set": {**values, "user_id": user["id"], "updated_at": datetime.now(timezone.utc)}}, upsert=True)
    return get_profile(user)


@app.get("/users/me/job-visits")
def list_job_visits(user: dict = Depends(current_user)):
    rows = list(_user_collection("job_visits").find({"user_id": user["id"]}).sort("visited_at", -1).limit(200))
    jobs = lookup_catalog_jobs([str(row["job_id"]) for row in rows])
    return [{"id": str(row["_id"]), "job_id": row["job_id"], "visited_at": row["visited_at"],
             "job": jobs.get(str(row["job_id"])) or row.get("job_snapshot")} for row in rows]


@app.post("/users/me/job-visits")
def record_job_visit(body: VisitRequest, user: dict = Depends(current_user)):
    job = lookup_catalog_jobs([body.job_id]).get(body.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job listing was not found.")
    visits = _user_collection("job_visits")
    now = datetime.now(timezone.utc)
    recent = visits.find_one({"user_id": user["id"], "job_id": body.job_id, "visited_at": {"$gte": now - timedelta(minutes=5)}})
    if recent:
        visits.update_one({"_id": recent["_id"]}, {"$set": {"visited_at": now, "job_snapshot": job}})
        return {"id": str(recent["_id"]), "job_id": body.job_id, "visited_at": now, "job": job}
    result = visits.insert_one({"user_id": user["id"], "job_id": body.job_id, "visited_at": now, "job_snapshot": job})
    return {"id": str(result.inserted_id), "job_id": body.job_id, "visited_at": now, "job": job}


@app.delete("/users/me/job-visits/{visit_id}")
def delete_job_visit(visit_id: str, user: dict = Depends(current_user)):
    result = _user_collection("job_visits").delete_one({"_id": _visit_object_id(visit_id), "user_id": user["id"]})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail="Visit was not found.")
    return {"ok": True}


@app.delete("/users/me/job-visits")
def clear_job_visits(user: dict = Depends(current_user)):
    result = _user_collection("job_visits").delete_many({"user_id": user["id"]})
    return {"deleted": result.deleted_count}


@app.post("/auth/logout")
def logout(authorization: str | None = Header(default=None), user: dict = Depends(current_user)):
    revoke_session(authorization)
    return {"ok": True}


@app.get("/saved-jobs")
def saved_jobs(user: dict = Depends(current_user)):
    records = list(_user_collection("saved_jobs").find({"user_id": user["id"]}).sort("saved_at", -1))
    jobs = lookup_catalog_jobs([str(row["job_id"]) for row in records])
    return [{"saved_at": row.get("saved_at"), "job": jobs.get(str(row["job_id"])) or row.get("job_snapshot")}
            for row in records if jobs.get(str(row["job_id"])) or row.get("job_snapshot")]


@app.post("/saved-jobs/{job_id}")
def save_job(job_id: str, user: dict = Depends(current_user)):
    job = lookup_catalog_jobs([job_id]).get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job listing was not found.")
    _user_collection("saved_jobs").update_one(
        {"user_id": user["id"], "job_id": job_id},
        {"$setOnInsert": {"user_id": user["id"], "job_id": job_id, "saved_at": datetime.now(timezone.utc), "job_snapshot": job}},
        upsert=True,
    )
    return {"job_id": job_id, "saved": True}


@app.delete("/saved-jobs/{job_id}")
def unsave_job(job_id: str, user: dict = Depends(current_user)):
    _user_collection("saved_jobs").delete_one({"user_id": user["id"], "job_id": job_id})
    return {"job_id": job_id, "saved": False}


@app.get("/applications")
def list_applications(user: dict = Depends(current_user)):
    records = list(_user_collection("applications").find({"user_id": user["id"]}).sort("updated_at", -1))
    jobs = lookup_catalog_jobs([str(row["job_id"]) for row in records])
    return [{"status": row["status"], "notes": row.get("notes", ""), "created_at": row.get("created_at"), "updated_at": row.get("updated_at"),
             "job": jobs.get(str(row["job_id"])) or row.get("job_snapshot")}
            for row in records if jobs.get(str(row["job_id"])) or row.get("job_snapshot")]


@app.post("/applications")
def track_application(body: ApplicationRequest, user: dict = Depends(current_user)):
    if body.status not in APPLICATION_STATUSES:
        raise HTTPException(status_code=422, detail="Unsupported application status.")
    job = lookup_catalog_jobs([body.job_id]).get(body.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job listing was not found.")
    now = datetime.now(timezone.utc)
    _user_collection("applications").update_one(
        {"user_id": user["id"], "job_id": body.job_id},
        {"$set": {"status": body.status, "notes": body.notes.strip(), "updated_at": now},
         "$setOnInsert": {"user_id": user["id"], "job_id": body.job_id, "created_at": now, "job_snapshot": job}},
        upsert=True,
    )
    return {"job_id": body.job_id, "status": body.status, "updated_at": now}


@app.patch("/applications/{job_id}")
def update_application(job_id: str, body: ApplicationUpdate, user: dict = Depends(current_user)):
    if body.status not in APPLICATION_STATUSES:
        raise HTTPException(status_code=422, detail="Unsupported application status.")
    fields = {"status": body.status, "updated_at": datetime.now(timezone.utc)}
    if body.notes is not None:
        fields["notes"] = body.notes.strip()
    result = _user_collection("applications").update_one(
        {"user_id": user["id"], "job_id": job_id}, {"$set": fields}
    )
    if not result.matched_count:
        raise HTTPException(status_code=404, detail="Tracked application was not found.")
    return {"job_id": job_id, **fields}


@app.delete("/applications/{job_id}")
def delete_application(job_id: str, user: dict = Depends(current_user)):
    result = _user_collection("applications").delete_one({"user_id": user["id"], "job_id": job_id})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail="Tracked application was not found.")
    return {"ok": True}


@app.get("/preferences")
def get_preferences(user: dict = Depends(current_user)):
    row = _user_collection("user_preferences").find_one({"user_id": user["id"]})
    return {key: value for key, value in (row or {}).items() if key not in {"_id", "user_id"}}


@app.put("/preferences")
def save_preferences(body: dict, user: dict = Depends(current_user)):
    allowed = {"search", "location_search", "remote_only", "india_only", "remote_india_only",
               "role_type", "min_score", "required_skills", "skill_match_mode", "sort_mode", "theme"}
    preferences = {key: value for key, value in body.items() if key in allowed}
    if "min_score" in preferences and (not isinstance(preferences["min_score"], (int, float)) or not 0 <= preferences["min_score"] <= 100):
        raise HTTPException(status_code=422, detail="Minimum score must be between 0 and 100.")
    if "required_skills" in preferences and (not isinstance(preferences["required_skills"], list) or len(preferences["required_skills"]) > 50):
        raise HTTPException(status_code=422, detail="Required skills must be a list of at most 50 items.")
    if "required_skills" in preferences and any(not isinstance(skill, str) or len(skill) > 100 for skill in preferences["required_skills"]):
        raise HTTPException(status_code=422, detail="Each required skill must be a string of at most 100 characters.")
    if "role_type" in preferences and preferences["role_type"] not in {"all", "ai_ml", "software", "data", "internship", "entry"}:
        raise HTTPException(status_code=422, detail="Unsupported role filter.")
    if "skill_match_mode" in preferences and preferences["skill_match_mode"] not in {"any", "all"}:
        raise HTTPException(status_code=422, detail="Skill match mode must be any or all.")
    if "sort_mode" in preferences and preferences["sort_mode"] not in {"score-desc", "score-asc", "title-asc"}:
        raise HTTPException(status_code=422, detail="Unsupported sort mode.")
    if "theme" in preferences and preferences["theme"] not in {"light", "dark"}:
        raise HTTPException(status_code=422, detail="Theme must be light or dark.")
    for key in ("remote_only", "india_only", "remote_india_only"):
        if key in preferences and not isinstance(preferences[key], bool):
            raise HTTPException(status_code=422, detail=f"{key} must be a boolean.")
    for key in ("search", "location_search"):
        if key in preferences and (not isinstance(preferences[key], str) or len(preferences[key]) > 250):
            raise HTTPException(status_code=422, detail=f"{key} must be a string of at most 250 characters.")
    _user_collection("user_preferences").update_one(
        {"user_id": user["id"]}, {"$set": {**preferences, "user_id": user["id"], "updated_at": datetime.now(timezone.utc)}}, upsert=True
    )
    return preferences


@app.get("/growth")
def list_growth_items(user: dict = Depends(current_user)):
    items = list(_user_collection("growth_logs").find({"user_id": user["id"]}).sort("created_at", -1))
    return [
        {
            "id": str(item["_id"]),
            "title": item.get("title", ""),
            "category": item.get("category", "Technical Skills"),
            "reflection": item.get("reflection", ""),
            "action_plan": item.get("action_plan", ""),
            "status": item.get("status", "Identified"),
            "source": item.get("source", ""),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
        }
        for item in items
    ]


@app.post("/growth")
def create_growth_item(body: GrowthItemCreate, user: dict = Depends(current_user)):
    category = body.category if body.category in GROWTH_CATEGORIES else "Technical Skills"
    status = body.status if body.status in GROWTH_STATUSES else "Identified"
    now = datetime.now(timezone.utc)
    item_id = str(uuid4())
    doc = {
        "_id": item_id,
        "user_id": user["id"],
        "title": body.title.strip(),
        "category": category,
        "reflection": body.reflection.strip(),
        "action_plan": body.action_plan.strip(),
        "status": status,
        "source": body.source.strip(),
        "created_at": now,
        "updated_at": now,
    }
    _user_collection("growth_logs").insert_one(doc)
    return {**doc, "id": item_id}


@app.patch("/growth/{item_id}")
def update_growth_item(item_id: str, body: GrowthItemUpdate, user: dict = Depends(current_user)):
    fields: dict[str, Any] = {"updated_at": datetime.now(timezone.utc)}
    if body.title is not None:
        fields["title"] = body.title.strip()
    if body.category is not None:
        fields["category"] = body.category if body.category in GROWTH_CATEGORIES else "Technical Skills"
    if body.reflection is not None:
        fields["reflection"] = body.reflection.strip()
    if body.action_plan is not None:
        fields["action_plan"] = body.action_plan.strip()
    if body.status is not None:
        fields["status"] = body.status if body.status in GROWTH_STATUSES else "Identified"
    if body.source is not None:
        fields["source"] = body.source.strip()

    result = _user_collection("growth_logs").update_one(
        {"_id": item_id, "user_id": user["id"]},
        {"$set": fields}
    )
    if not result.matched_count:
        raise HTTPException(status_code=404, detail="Growth record was not found.")
    updated = _user_collection("growth_logs").find_one({"_id": item_id, "user_id": user["id"]})
    return {
        "id": str(updated["_id"]),
        "title": updated.get("title", ""),
        "category": updated.get("category", "Technical Skills"),
        "reflection": updated.get("reflection", ""),
        "action_plan": updated.get("action_plan", ""),
        "status": updated.get("status", "Identified"),
        "source": updated.get("source", ""),
        "created_at": updated.get("created_at"),
        "updated_at": updated.get("updated_at"),
    }


@app.delete("/growth/{item_id}")
def delete_growth_item(item_id: str, user: dict = Depends(current_user)):
    result = _user_collection("growth_logs").delete_one({"_id": item_id, "user_id": user["id"]})
    if not result.deleted_count:
        raise HTTPException(status_code=404, detail="Growth record was not found.")
    return {"ok": True}


@app.post("/jobs/match")
def jobs_match(request: MatchRequest):
    if not request.resume_text.strip():
        raise HTTPException(
            status_code=400,
            detail="Resume text cannot be empty."
        )

    return {"jobs": match_jobs(request.resume_text, limit=request.limit, records=catalog_jobs())}


@app.get("/jobs")
def jobs_list(q: str = "", location: str = "", remote: bool = False, skip: int = 0, limit: int = 50):
    jobs = catalog_jobs()
    query = q.strip().casefold()
    place = location.strip().casefold()
    filtered = [job for job in jobs if
        (not query or query in (str(job.get("title", "")) + " " + str(job.get("company", ""))).casefold())
        and (not place or place in str(job.get("location", "")).casefold())
        and (not remote or str(job.get("work_mode", "")).casefold() == "remote" or "remote" in str(job.get("location", "")).casefold())
    ]
    bounded_limit = min(200, max(1, limit))
    return {"total": len(filtered), "jobs": filtered[max(0, skip):max(0, skip) + bounded_limit]}

class StreamMatchRequest(MatchRequest):
    batch_size: int = Field(default=100, ge=1, le=500)


def _sse_event(name: str, payload: dict) -> str:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {name}\ndata: {data}\n\n"


@app.post("/jobs/match/stream")
async def jobs_match_stream(body: StreamMatchRequest, request: Request):
    if not body.resume_text.strip():
        raise HTTPException(
            status_code=400,
            detail="Resume text cannot be empty."
        )

    async def event_stream():
        processed_count = 0
        emitted_count = 0
        total_jobs = 0
        yield _sse_event("started", {
            "stage": "preparing",
            "processed_count": processed_count,
            "emitted_count": emitted_count,
            "total_jobs": None,
        })

        try:
            records = await run_in_threadpool(catalog_jobs)
            prepared = await run_in_threadpool(prepare_match, body.resume_text, records)
            jobs, job_embeddings, resume_embedding, resume_skills = prepared
            total_jobs = len(jobs)
            yield _sse_event("ready", {
                "stage": "matching",
                "processed_count": 0,
                "emitted_count": 0,
                "total_jobs": total_jobs,
            })

            if not jobs or job_embeddings is None or resume_embedding is None:
                yield _sse_event("completed", {
                    "processed_count": 0,
                    "emitted_count": 0,
                    "total_jobs": 0,
                    "returned_count": 0,
                    "ranked_ids": [],
                })
                return

            all_results = []
            for start in range(0, total_jobs, body.batch_size):
                if await request.is_disconnected():
                    return
                end = min(start + body.batch_size, total_jobs)
                batch = await run_in_threadpool(
                    score_match_batch,
                    jobs,
                    job_embeddings,
                    resume_embedding,
                    resume_skills,
                    start,
                    end,
                )
                all_results.extend(batch)
                processed_count = end
                emitted_count += len(batch)
                if await request.is_disconnected():
                    return
                yield _sse_event("batch", {
                    "jobs": batch,
                    "processed_count": processed_count,
                    "emitted_count": emitted_count,
                    "total_jobs": total_jobs,
                })

            ranked_all = rank_jobs(all_results)
            ranked_results = ranked_all[:body.limit]
            yield _sse_event("completed", {
                "processed_count": processed_count,
                "emitted_count": emitted_count,
                "total_jobs": total_jobs,
                "returned_count": len(ranked_results),
                "ranked_ids": [job["id"] for job in ranked_results],
            })
        except Exception:
            logger.exception("Progressive job matching failed")
            yield _sse_event("error", {
                "message": "Matching stopped. Any results already received are partial.",
                "processed_count": processed_count,
                "emitted_count": emitted_count,
                "total_jobs": total_jobs,
                "partial": emitted_count > 0,
            })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# -----------------------------------------------------------------------------
# AI Interview Coach & Debrief Endpoints (Gemini 2.5 Flash)
# -----------------------------------------------------------------------------


class CoachMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=8000)
    api_key: str | None = Field(default=None, max_length=200)


class CoachSessionCreate(BaseModel):
    title: str = Field(default="New Interview Debrief", max_length=150)
    company: str = Field(default="", max_length=100)
    role: str = Field(default="", max_length=100)
    notes: str = Field(default="", max_length=2000)


class GeminiKeyUpdate(BaseModel):
    api_key: str = Field(min_length=1, max_length=200)


class SaveGrowthFromCoach(BaseModel):
    title: str = Field(min_length=1, max_length=150)
    category: str = Field(default="Technical Skills", max_length=50)
    reflection: str = Field(default="", max_length=2000)
    action_plan: str = Field(default="", max_length=2000)
    source: str = Field(default="", max_length=150)
    status: str = Field(default="Identified", max_length=30)


@app.get("/interview-coach/status")
def coach_status(user: dict = Depends(current_user)):
    user_pref = _user_collection("user_preferences").find_one({"user_id": user["id"]}) or {}
    key = get_effective_api_key(user_pref.get("gemini_api_key"))
    return {
        "has_api_key": bool(key),
        "model": GEMINI_MODEL or "gemini-2.5-flash",
        "key_source": "user_preferences" if user_pref.get("gemini_api_key") else ("env" if os.getenv("GEMINI_API_KEY") else ("config" if key else "none")),
    }


@app.post("/interview-coach/key")
def update_coach_key(body: GeminiKeyUpdate, user: dict = Depends(current_user)):
    clean_key = body.api_key.strip()
    _user_collection("user_preferences").update_one(
        {"user_id": user["id"]},
        {"$set": {"gemini_api_key": clean_key, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )
    return {"ok": True, "has_api_key": bool(clean_key)}


@app.get("/interview-coach/sessions")
def list_coach_sessions(user: dict = Depends(current_user)):
    docs = list(_user_collection("interview_chats").find({"user_id": user["id"]}).sort("updated_at", -1).limit(50))
    return [
        {
            "id": str(d["_id"]),
            "title": d.get("title", "Interview Debrief"),
            "company": d.get("company", ""),
            "role": d.get("role", ""),
            "notes": d.get("notes", ""),
            "message_count": len(d.get("messages", [])),
            "created_at": d.get("created_at"),
            "updated_at": d.get("updated_at"),
        }
        for d in docs
    ]


@app.post("/interview-coach/sessions")
def create_coach_session(body: CoachSessionCreate, user: dict = Depends(current_user)):
    session_id = str(uuid4())
    now = datetime.now(timezone.utc)
    title = body.title.strip() or (f"Debrief: {body.company}" if body.company.strip() else "Interview Debrief")
    doc = {
        "_id": session_id,
        "user_id": user["id"],
        "title": title,
        "company": body.company.strip(),
        "role": body.role.strip(),
        "notes": body.notes.strip(),
        "messages": [],
        "created_at": now,
        "updated_at": now,
    }
    _user_collection("interview_chats").insert_one(doc)
    return {
        "id": session_id,
        "title": title,
        "company": body.company.strip(),
        "role": body.role.strip(),
        "notes": body.notes.strip(),
        "messages": [],
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }


@app.get("/interview-coach/sessions/{session_id}")
def get_coach_session(session_id: str, user: dict = Depends(current_user)):
    doc = _user_collection("interview_chats").find_one({"_id": session_id, "user_id": user["id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Debrief session was not found.")
    return {
        "id": str(doc["_id"]),
        "title": doc.get("title", "Interview Debrief"),
        "company": doc.get("company", ""),
        "role": doc.get("role", ""),
        "notes": doc.get("notes", ""),
        "messages": doc.get("messages", []),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
    }


@app.delete("/interview-coach/sessions/{session_id}")
def delete_coach_session(session_id: str, user: dict = Depends(current_user)):
    res = _user_collection("interview_chats").delete_one({"_id": session_id, "user_id": user["id"]})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="Debrief session was not found.")
    return {"ok": True}


@app.post("/interview-coach/sessions/{session_id}/message")
def send_coach_message(session_id: str, body: CoachMessageRequest, user: dict = Depends(current_user)):
    doc = _user_collection("interview_chats").find_one({"_id": session_id, "user_id": user["id"]})
    if not doc:
        raise HTTPException(status_code=404, detail="Debrief session was not found.")

    user_pref = _user_collection("user_preferences").find_one({"user_id": user["id"]}) or {}
    effective_key = body.api_key or get_effective_api_key(user_pref.get("gemini_api_key"))

    memories = list(_user_collection("interview_memories").find({"user_id": user["id"]}).sort("created_at", -1).limit(10))
    growth_logs = list(_user_collection("growth_logs").find({"user_id": user["id"]}).sort("created_at", -1).limit(15))
    applications = list(_user_collection("applications").find({"user_id": user["id"]}).limit(10))

    user_name = user.get("name") or user.get("email", "").split("@")[0] or "Candidate"
    system_prompt = build_coach_system_prompt(user_name, memories, growth_logs, applications)

    now = datetime.now(timezone.utc)
    user_msg = {
        "id": str(uuid4()),
        "role": "user",
        "content": body.content.strip(),
        "created_at": now.isoformat(),
    }

    history = list(doc.get("messages", []))
    history.append(user_msg)

    dialog = [{"role": m["role"], "content": m["content"]} for m in history]

    reply, extracted_growth, model_used = call_gemini_chat(dialog, system_prompt, effective_key)

    assistant_msg = {
        "id": str(uuid4()),
        "role": "assistant",
        "content": reply,
        "model": model_used,
        "extracted_growth": extracted_growth,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    history.append(assistant_msg)

    updates: dict[str, Any] = {
        "messages": history,
        "updated_at": datetime.now(timezone.utc),
    }
    if doc.get("title") in {"New Interview Debrief", "Interview Debrief", ""}:
        first_words = " ".join(body.content.strip().split()[:6])
        if first_words:
            updates["title"] = first_words[:50]

    _user_collection("interview_chats").update_one(
        {"_id": session_id, "user_id": user["id"]},
        {"$set": updates},
    )

    if extracted_growth:
        weaknesses_found = [item["title"] for item in extracted_growth if item.get("title")]
        mem_doc = {
            "_id": str(uuid4()),
            "user_id": user["id"],
            "session_id": session_id,
            "company": doc.get("company", ""),
            "role": doc.get("role", ""),
            "weaknesses": weaknesses_found,
            "takeaways": reply[:300],
            "created_at": datetime.now(timezone.utc),
        }
        _user_collection("interview_memories").insert_one(mem_doc)

    return {
        "reply": reply,
        "model": model_used,
        "extracted_growth": extracted_growth,
        "session_id": session_id,
    }


@app.post("/interview-coach/save-growth")
def save_growth_from_coach(body: SaveGrowthFromCoach, user: dict = Depends(current_user)):
    category = body.category if body.category in GROWTH_CATEGORIES else "Technical Skills"
    status = body.status if body.status in GROWTH_STATUSES else "Identified"
    now = datetime.now(timezone.utc)
    item_id = str(uuid4())
    doc = {
        "_id": item_id,
        "user_id": user["id"],
        "title": body.title.strip(),
        "category": category,
        "reflection": body.reflection.strip(),
        "action_plan": body.action_plan.strip(),
        "status": status,
        "source": body.source.strip() or "Interview Debrief Coach",
        "created_at": now,
        "updated_at": now,
    }
    _user_collection("growth_logs").insert_one(doc)
    return {
        "id": item_id,
        "title": doc["title"],
        "category": doc["category"],
        "reflection": doc["reflection"],
        "action_plan": doc["action_plan"],
        "status": doc["status"],
        "source": doc["source"],
        "created_at": now.isoformat(),
        "updated_at": now.isoformat(),
    }


@app.get("/interview-coach/memories")
def list_coach_memories(user: dict = Depends(current_user)):
    docs = list(_user_collection("interview_memories").find({"user_id": user["id"]}).sort("created_at", -1).limit(30))
    return [
        {
            "id": str(d["_id"]),
            "session_id": d.get("session_id", ""),
            "company": d.get("company", ""),
            "role": d.get("role", ""),
            "weaknesses": d.get("weaknesses", []),
            "takeaways": d.get("takeaways", ""),
            "created_at": d.get("created_at"),
        }
        for d in docs
    ]


