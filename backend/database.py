"""MongoDB connection and repository helpers. JSON remains the unconfigured dev fallback."""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from config import MONGODB_DATABASE, MONGODB_URI

logger = logging.getLogger(__name__)
_lock = threading.RLock()
_client = None
_database = None
_last_error: str | None = None
_catalog_cache_revision: str | None = None
_catalog_cache_jobs: list[dict[str, Any]] = []


def database_configured() -> bool:
    return bool(MONGODB_URI)


def connect_database() -> bool:
    """Connect, ping and provision indexes; return False if Mongo is not configured."""
    global _client, _database, _last_error
    if not MONGODB_URI:
        return False
    with _lock:
        if _database is not None:
            try:
                _client.admin.command("ping")
                return True
            except Exception:
                _database = None
                _client = None
        try:
            from pymongo import MongoClient

            client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=4000, connectTimeoutMS=4000)
            client.admin.command("ping")
            database = client[MONGODB_DATABASE]
            _create_indexes(database)
            _client, _database, _last_error = client, database, None
            return True
        except Exception as exc:
            _last_error = f"MongoDB is configured but unavailable: {exc.__class__.__name__}"
            logger.exception("MongoDB connection failed")
            return False


def _create_indexes(database: Any) -> None:
    database.jobs.create_index("apply_url", name="jobs_apply_url")
    database.jobs.create_index("apply_url_normalized", unique=True, sparse=True, name="jobs_apply_url_unique")
    database.jobs.create_index([("source", 1), ("source_board", 1)], name="jobs_source_board")
    database.jobs.create_index([("company", 1), ("location", 1)], name="jobs_company_location")
    database.jobs.create_index([("posted_at", -1)], name="jobs_posted_at")
    database.users.create_index("email_normalized", unique=True, name="users_email_unique")
    database.auth_sessions.create_index("jti", unique=True, name="sessions_jti_unique")
    database.auth_sessions.create_index("expires_at", expireAfterSeconds=0, name="sessions_expiry_ttl")
    database.saved_jobs.create_index([("user_id", 1), ("job_id", 1)], unique=True, name="saved_jobs_user_job_unique")
    database.applications.create_index([("user_id", 1), ("job_id", 1)], unique=True, name="applications_user_job_unique")
    database.user_preferences.create_index("user_id", unique=True, name="preferences_user_unique")
    database.job_visits.create_index([("user_id", 1), ("visited_at", -1)], name="job_visits_user_time")
    database.job_visits.create_index([("user_id", 1), ("job_id", 1), ("visited_at", -1)], name="job_visits_user_job_time")
    database.ingestion_runs.create_index([("started_at", -1)], name="ingestion_runs_started")
    database.ingestion_runs.create_index([("source_id", 1), ("started_at", -1)], name="ingestion_source_history")
    database.growth_logs.create_index([("user_id", 1), ("created_at", -1)], name="growth_logs_user_time")
    database.interview_chats.create_index([("user_id", 1), ("updated_at", -1)], name="interview_chats_user_time")
    database.interview_memories.create_index([("user_id", 1), ("created_at", -1)], name="interview_memories_user_time")


def get_database(required: bool = True):
    if not MONGODB_URI:
        if required:
            raise RuntimeError("MongoDB is not configured. Set MONGODB_URI in backend/.env.")
        return None
    if _database is None and not connect_database():
        raise RuntimeError(_last_error or "MongoDB is unavailable.")
    return _database


def database_health() -> dict[str, Any]:
    if not MONGODB_URI:
        return {"configured": False, "connected": False, "mode": "json-fallback"}
    try:
        db = get_database()
        migrated = bool(db.system_state.find_one({"_id": "catalog_migration"}, {"completed_at": 1}))
        return {"configured": True, "connected": True, "database": db.name, "catalog_migrated": migrated}
    except Exception as exc:
        return {"configured": True, "connected": False, "error": _last_error or f"MongoDB unavailable ({exc.__class__.__name__})."}


def normalize_job_document(job: dict[str, Any]) -> dict[str, Any]:
    document = dict(job)
    job_id = str(document.get("id", "")).strip()
    if not job_id:
        raise ValueError("Every job must have a stable id before it can be stored.")
    document["id"] = job_id
    document["_id"] = job_id
    canonical_url = normalize_job_url(document.get("apply_url"))
    if canonical_url:
        document["apply_url_normalized"] = canonical_url
    document.setdefault("updated_at", datetime.now(timezone.utc))
    return document


def normalize_job_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        return ""
    parts = urlsplit(value.strip())
    tracking = {"gh_src", "lever-via", "lever-social", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"}
    query = [(key, item) for key, item in parse_qsl(parts.query, keep_blank_values=True)
             if key.casefold() not in tracking and not key.casefold().startswith("utm_")]
    return urlunsplit((parts.scheme.casefold(), parts.netloc.casefold(), parts.path.rstrip("/"), urlencode(query), ""))


def upsert_jobs(jobs: list[dict[str, Any]]) -> dict[str, int]:
    from pymongo import UpdateOne

    db = get_database()
    operations = []
    for job in jobs:
        document = normalize_job_document(job)
        operations.append(UpdateOne({"_id": document["_id"]}, {"$set": document}, upsert=True))
    if not operations:
        return {"matched": 0, "modified": 0, "upserted": 0}
    result = db.jobs.bulk_write(operations, ordered=False)
    bump_catalog_revision(db)
    return {"matched": result.matched_count, "modified": result.modified_count, "upserted": len(result.upserted_ids)}


def persist_refresh(jobs: list[dict[str, Any]], source_reports: list[dict[str, Any]], fetched_at: str) -> dict[str, int] | None:
    """Upsert a refreshed snapshot and prune only boards with non-empty successful fetches."""
    if not MONGODB_URI:
        return None
    from pymongo import UpdateOne

    db = get_database()
    operations = []
    for job in jobs:
        document = normalize_job_document(job)
        operations.append(UpdateOne({"_id": document["_id"]}, {"$set": document}, upsert=True))
    result = db.jobs.bulk_write(operations, ordered=False) if operations else None
    for report in source_reports:
        source_id = report.get("source_id", "").casefold()
        ats, _, board = source_id.partition(":")
        active_ids = [str(job.get("id")) for job in jobs
                      if str(job.get("source", "")).casefold() == ats
                      and str(job.get("source_board", "")).casefold() == board]
        # A board is authoritative only when the API returned rows and at least one row normalized.
        if report.get("success") and report.get("raw_count", 0) > 0 and active_ids:
            db.jobs.delete_many({"source": ats, "source_board": board, "_id": {"$nin": active_ids}})
    bump_catalog_revision(db)
    for report in source_reports:
        db.ingestion_runs.insert_one({
            **report,
            "fetched_at": fetched_at,
            "started_at": datetime.now(timezone.utc),
            "saved_job_count": sum(1 for job in jobs if f"{job.get('source', '')}:{job.get('source_board', '')}".casefold() == report.get("source_id", "").casefold()),
        })
    return {"matched": result.matched_count if result else 0,
            "modified": result.modified_count if result else 0,
            "upserted": len(result.upserted_ids) if result else 0}


def list_jobs() -> list[dict[str, Any]]:
    global _catalog_cache_revision, _catalog_cache_jobs
    db = get_database()
    state = db.system_state.find_one({"_id": "catalog_version"}, {"revision": 1}) or {}
    revision = state.get("revision")
    if revision and revision == _catalog_cache_revision:
        return list(_catalog_cache_jobs)
    rows = db.jobs.find({}, {"_id": 0, "apply_url_normalized": 0, "updated_at": 0}).sort("id", 1)
    jobs = list(rows)
    _catalog_cache_jobs = jobs
    _catalog_cache_revision = revision
    return list(jobs)


def catalog_migrated() -> bool:
    if not MONGODB_URI:
        return False
    return bool(get_database().system_state.find_one({"_id": "catalog_migration"}))


def mark_catalog_migrated(count: int) -> None:
    db = get_database()
    bump_catalog_revision(db)
    db.system_state.update_one(
        {"_id": "catalog_migration"},
        {"$set": {"completed_at": datetime.now(timezone.utc), "job_count": count}},
        upsert=True,
    )


def bump_catalog_revision(database: Any | None = None) -> None:
    db = database if database is not None else get_database()
    db.system_state.update_one(
        {"_id": "catalog_version"},
        {"$set": {"revision": uuid4().hex, "updated_at": datetime.now(timezone.utc)}},
        upsert=True,
    )


def find_job(job_id: str) -> dict[str, Any] | None:
    row = get_database().jobs.find_one({"_id": str(job_id)}, {"_id": 0})
    return row


def find_jobs_by_ids(job_ids: list[str]) -> list[dict[str, Any]]:
    if not job_ids:
        return []
    rows = get_database().jobs.find(
        {"_id": {"$in": [str(job_id) for job_id in job_ids]}},
        {"_id": 0, "apply_url_normalized": 0, "updated_at": 0},
    )
    return list(rows)


def safe_document(document: dict[str, Any]) -> dict[str, Any]:
    result = dict(document)
    result.pop("_id", None)
    for key, value in tuple(result.items()):
        if hasattr(value, "isoformat"):
            result[key] = value.isoformat()
    return result
