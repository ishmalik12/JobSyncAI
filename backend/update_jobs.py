import json
import os
import re
import tempfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from job_sources import Job, fetch_all_with_report, normalize_jobs
from database import persist_refresh

BASE_DIR = Path(__file__).parent
COMPANIES_FILE = BASE_DIR / "data" / "companies.json"
JOBS_FILE = BASE_DIR / "data" / "jobs.json"
FULL_JOBS_FILE = BASE_DIR / "data" / "jobs_full.json"
INDIA_CITIES = (
    "bengaluru", "bangalore", "hyderabad", "gurugram", "gurgaon", "delhi",
    "noida", "pune", "mumbai", "chennai", "kolkata", "ahmedabad", "jaipur",
    "kochi", "cochin", "coimbatore", "mysore", "mangalore", "lucknow", "indore",
)


def normalized_url(value):
    if not isinstance(value, str) or not value.strip():
        return ""
    parts = urlsplit(value.strip())
    tracking = {"gh_src", "lever-via", "lever-social", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"}
    query = [(key, item) for key, item in parse_qsl(parts.query, keep_blank_values=True) if key.casefold() not in tracking and not key.casefold().startswith("utm_")]
    return urlunsplit((parts.scheme.casefold(), parts.netloc.casefold(), parts.path.rstrip("/"), urlencode(query), ""))


def record_keys(record):
    return str(record.get("id", "")).strip().casefold(), normalized_url(record.get("apply_url"))


def belongs_to_source(record, source):
    source_ats, source_slug = source["source_id"].split(":", 1)
    if record.get("source_board"):
        return str(record.get("source_board")).casefold() == source_slug.casefold() and str(record.get("source", "")).casefold() == source_ats
    return str(record.get("source", "")).casefold() == source_ats and str(record.get("company", "")).casefold() == str(source.get("company", "")).casefold()


def deduplicate(records):
    result = []
    seen_ids = {}
    seen_urls = {}
    duplicates = 0
    for record in records:
        job_id, url = record_keys(record)
        previous_index = seen_ids.get(job_id) if job_id else None
        if previous_index is None and url:
            previous_index = seen_urls.get(url)
        if previous_index is None:
            previous_index = len(result)
            result.append(record)
        else:
            duplicates += 1
            previous = result[previous_index]
            if record.get("fetched_at") and not previous.get("fetched_at"):
                result[previous_index] = record
                previous = record
            job_id, url = record_keys(previous)
        if job_id:
            seen_ids[job_id] = previous_index
        if url:
            seen_urls[url] = previous_index
    return result, duplicates


def is_india_listing(record):
    country = str(record.get("country", "")).strip().casefold()
    if country in {"in", "ind", "india"}:
        return True
    location = str(record.get("location", "")).casefold()
    if re.search(r"\bindia\b", location):
        return True
    return any(re.search(rf"\b{re.escape(city)}\b", location) for city in INDIA_CITIES)


def print_dataset_report(jobs, source_reports, before_count, new_count, updated_count, stale_count, duplicate_count, fetched_at, source_missing_descriptions=0, source_missing_urls=0, full_count=None, before_openai_count=0):
    company_counts = Counter(str(job.get("company") or "Unknown") for job in jobs)
    provider_counts = Counter(str(job.get("source") or "Unknown") for job in jobs)
    location_counts = Counter(str(job.get("location") or "Unspecified") for job in jobs)
    india_jobs = [job for job in jobs if is_india_listing(job)]
    remote_india = [job for job in india_jobs if (
        str(job.get("work_mode", "")).casefold() == "remote"
        or ("remote" in str(job.get("location", "")).casefold() and "india" in str(job.get("location", "")).casefold())
    )]
    located = [job for job in jobs if str(job.get("location") or "").strip()]
    print(f"Fetch timestamp: {fetched_at}")
    print(f"Curated listings before: {before_count}; after: {len(jobs)}; uncapped full snapshot: {full_count if full_count is not None else len(jobs)}")
    openai_count = company_counts.get("OpenAI", 0)
    print(f"OpenAI share before caps: {before_openai_count}/{before_count} ({(before_openai_count / before_count * 100) if before_count else 0:.1f}%)")
    print(f"OpenAI share after caps: {openai_count}/{len(jobs)} ({(openai_count / len(jobs) * 100) if jobs else 0:.1f}%)")
    print(f"New: {new_count}; substantively updated: {updated_count}; stale removed after successful refresh: {stale_count}; duplicates removed: {duplicate_count}")
    print(f"Distinct companies: {len(company_counts)}; companies with at least one India-located listing: {sum(1 for company in company_counts if any(job.get('company') == company and is_india_listing(job) for job in jobs))}")
    print(f"India-located listings: {len(india_jobs)}; explicitly remote within India: {len(remote_india)}; elsewhere with known location: {len([job for job in located if not is_india_listing(job)])}; location unknown: {len(jobs) - len(located)}")
    print("Listings by provider:")
    for provider, count in provider_counts.most_common():
        print(f"  {provider}: {count}")
    print("Top 20 companies:")
    for company, count in company_counts.most_common(20):
        print(f"  {company}: {count}")
    print("Top locations:")
    for location, count in location_counts.most_common(20):
        print(f"  {location}: {count}")
    missing_description = sum(not str(job.get("description") or "").strip() for job in jobs)
    missing_url = sum(not str(job.get("apply_url") or "").strip() for job in jobs)
    print(f"Saved records missing descriptions: {missing_description}; saved records missing application URLs: {missing_url}")
    print(f"Fetched source rows missing descriptions: {source_missing_descriptions}; missing application URLs: {source_missing_urls}")
    print("Sources:")
    for report in source_reports:
        if report["success"]:
            print(f"  {report['source_id']} ({report['company']}): fetched {report['raw_count']} postings")
        else:
            print(f"  {report['source_id']} ({report['company']}): FAILED: {report['error']}")


def write_jobs_safely(jobs, destination):
    handle, temporary_path = tempfile.mkstemp(prefix="jobs-", suffix=".json.tmp", dir=destination.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as temporary_file:
            json.dump(jobs, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.write("\n")
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.replace(temporary_path, destination)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def curate_jobs(full_jobs, companies):
    """Apply per-source caps to the matching snapshot; full jobs remain saved."""
    configured_caps = {}
    for company in companies:
        cap = company.get("max_jobs")
        if isinstance(cap, int) and cap > 0:
            configured_caps[f"{company.get('ats', '').casefold()}:{company.get('slug', '').casefold()}"] = cap
    if not configured_caps:
        return list(full_jobs)

    grouped = {}
    for job in full_jobs:
        source_id = f"{str(job.get('source', '')).casefold()}:{str(job.get('source_board', '')).casefold()}"
        grouped.setdefault(source_id, []).append(job)

    selected_ids = set()
    for source_id, rows in grouped.items():
        cap = configured_caps.get(source_id)
        if cap is None or len(rows) <= cap:
            selected_ids.update(str(row.get("id")) for row in rows)
            continue
        # ISO publication dates sort chronologically; stable IDs break ties.
        newest = sorted(
            rows,
            key=lambda row: (str(row.get("posted_at") or ""), str(row.get("id") or "")),
            reverse=True,
        )[:cap]
        selected_ids.update(str(row.get("id")) for row in newest)
    return [job for job in full_jobs if str(job.get("id")) in selected_ids]


def main():
    companies = json.loads(COMPANIES_FILE.read_text(encoding="utf-8-sig"))
    existing_path = FULL_JOBS_FILE if FULL_JOBS_FILE.exists() else JOBS_FILE
    existing = json.loads(existing_path.read_text(encoding="utf-8-sig")) if existing_path.exists() else []
    previous_curated = json.loads(JOBS_FILE.read_text(encoding="utf-8-sig")) if JOBS_FILE.exists() else []
    before_curated_count = len(previous_curated)
    before_openai_count = sum(1 for job in previous_curated if isinstance(job, dict) and job.get("company") == "OpenAI")
    if not isinstance(existing, list):
        raise ValueError("jobs.json must contain a JSON array; refusing to replace it")

    fetched, source_reports = fetch_all_with_report(companies)
    fetched_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    source_missing_descriptions = sum(not str(job.description or "").strip() for job in fetched)
    source_missing_urls = sum(not str(job.url or "").strip() for job in fetched)
    fresh = normalize_jobs(fetched, fetched_at=fetched_at)
    fresh_by_source = {
        source["source_id"]: [record for record in fresh if (
            str(record.get("source", "")).casefold() + ":" + str(record.get("source_board", "")).casefold()
        ) == source["source_id"].casefold()]
        for source in source_reports
    }

    new_count = 0
    updated_count = 0
    stale_count = 0
    refreshed_sources = set()
    retained = list(existing)
    for source in source_reports:
        source_jobs = fresh_by_source.get(source["source_id"], [])
        old_source_jobs = [record for record in existing if belongs_to_source(record, source)]
        if not source["success"]:
            continue
        if not source_jobs:
            # An empty board response is ambiguous; keep its existing snapshot.
            continue
        refreshed_sources.add(source["source_id"])
        old_by_id = {record_keys(record)[0]: record for record in old_source_jobs if record_keys(record)[0]}
        old_by_url = {record_keys(record)[1]: record for record in old_source_jobs if record_keys(record)[1]}
        found_old = set()
        for record in source_jobs:
            job_id, url = record_keys(record)
            previous = old_by_id.get(job_id) if job_id else None
            if previous is None and url:
                previous = old_by_url.get(url)
            if previous is None:
                new_count += 1
            else:
                found_old.add(id(previous))
                comparable = {key: value for key, value in record.items() if key != "fetched_at"}
                old_comparable = {key: value for key, value in previous.items() if key != "fetched_at"}
                if comparable != old_comparable:
                    updated_count += 1
        stale_count += sum(id(record) not in found_old for record in old_source_jobs)
        retained = [record for record in retained if not belongs_to_source(record, source)]

    if not refreshed_sources:
        try:
            persist_refresh(existing, source_reports, fetched_at)
        except Exception as exc:
            print(f"MongoDB ingestion history was not saved: {exc}")
        print("No source returned a non-empty, valid snapshot. Keeping jobs.json unchanged.")
        print_dataset_report(existing, source_reports, before_curated_count, 0, 0, 0, 0, fetched_at, source_missing_descriptions, source_missing_urls, len(existing), before_openai_count)
        return

    merged, duplicates = deduplicate(retained + fresh)
    if not merged:
        print("No valid jobs remain after normalization. Keeping jobs.json unchanged.")
        return
    curated = curate_jobs(merged, companies)
    try:
        database_result = persist_refresh(merged, source_reports, fetched_at)
        if database_result is not None:
            print(f"MongoDB job upsert complete: {database_result}")
    except Exception as exc:
        print(f"MongoDB write failed; keeping JSON snapshot as it is: {exc}")
        raise
    write_jobs_safely(merged, FULL_JOBS_FILE)
    write_jobs_safely(curated, JOBS_FILE)
    print(f"Successfully refreshed {len(refreshed_sources)} of {len(source_reports)} configured sources.")
    caps = {
        str(company.get("name") or company.get("slug")): company["max_jobs"]
        for company in companies
        if isinstance(company.get("max_jobs"), int) and company["max_jobs"] > 0
    }
    print(f"Ingestion caps: {caps}")
    print_dataset_report(curated, source_reports, before_curated_count, new_count, updated_count, stale_count, duplicates, fetched_at, source_missing_descriptions, source_missing_urls, len(merged), before_openai_count)


if __name__ == "__main__":
    main()
