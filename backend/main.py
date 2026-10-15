import json
import logging
import re
import asyncio
import sys
from pathlib import Path
from datetime import datetime, timezone
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

logger = logging.getLogger(__name__)
DATA_FILE = Path(__file__).parent / "data" / "jobs.json"
INDIA_CITIES = (
    "bengaluru", "bangalore", "hyderabad", "gurugram", "gurgaon", "delhi",
    "noida", "pune", "mumbai", "chennai", "kolkata", "ahmedabad", "jaipur",
    "kochi", "cochin", "coimbatore", "mysore", "mangalore", "lucknow", "indore",
)

app = FastAPI(title="JobSync AI")
_refresh_task: asyncio.Task | None = None

app.add_middleware(
    CORSMiddleware,
    allow_origins=[FRONTEND_ORIGIN],
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


APPLICATION_STATUSES = {"Saved", "Applied", "Interviewing", "Rejected", "Offered", "Withdrawn"}


def _user_collection(name: str):
    try:
        return get_database()[name]
    except Exception as exc:
        logger.exception("MongoDB user-data collection unavailable")
        raise HTTPException(status_code=503, detail="User data is temporarily unavailable; check MongoDB configuration.") from exc


def _auth_user_document(user: dict) -> dict:
    return {"id": str(user["_id"]), "email": user["email"], "name": user.get("name", "")}


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
    return [{"status": row["status"], "notes": row.get("notes", ""), "updated_at": row.get("updated_at"),
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

