"""Idempotently import backend/data/jobs.json into the configured MongoDB catalog."""
from __future__ import annotations

import json
from pathlib import Path

from config import MONGODB_URI
from database import get_database, mark_catalog_migrated, normalize_job_document, normalize_job_url

DATA_FILE = Path(__file__).parent / "data" / "jobs.json"


def load_unique_jobs() -> tuple[list[dict], int]:
    with DATA_FILE.open(encoding="utf-8-sig") as source:
        jobs = json.load(source)
    if not isinstance(jobs, list):
        raise ValueError("jobs.json must contain a JSON array")
    unique: list[dict] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()
    duplicates = 0
    for record in jobs:
        if not isinstance(record, dict):
            continue
        job = normalize_job_document(record)
        identifier = job["id"].casefold()
        url = normalize_job_url(job.get("apply_url"))
        if identifier in seen_ids or (url and url in seen_urls):
            duplicates += 1
            continue
        seen_ids.add(identifier)
        if url:
            seen_urls.add(url)
        job.pop("_id", None)
        job.pop("updated_at", None)
        unique.append(job)
    return unique, duplicates


def main() -> None:
    if not MONGODB_URI:
        raise SystemExit("Set MONGODB_URI in backend/.env before migrating.")
    jobs, duplicates = load_unique_jobs()
    db = get_database()
    from pymongo import UpdateOne

    operations = []
    for job in jobs:
        document = normalize_job_document(job)
        operations.append(UpdateOne({"_id": document["_id"]}, {"$set": document}, upsert=True))
    result = db.jobs.bulk_write(operations, ordered=False) if operations else None
    expected_ids = [job["id"] for job in jobs]
    verified = db.jobs.count_documents({"_id": {"$in": expected_ids}})
    if verified != len(expected_ids):
        raise RuntimeError(f"Migration verification failed: expected {len(expected_ids)} jobs, found {verified}.")
    mark_catalog_migrated(verified)
    print(f"MongoDB migration verified: {verified} unique jobs; {duplicates} duplicate rows skipped.")
    if result:
        print(f"Upserts: {len(result.upserted_ids)} new, {result.modified_count} updated, {result.matched_count} unchanged.")


if __name__ == "__main__":
    main()
