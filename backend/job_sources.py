"""Fetch public job-board listings from configured ATS boards."""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from html import unescape
from typing import Any

import requests

from skill_extractor import extract_skills

logger = logging.getLogger(__name__)
REQUEST_TIMEOUT = (5, 20)
MAX_RETRIES = 3
LEVER_PAGE_SIZE = 100
SMARTRECRUITERS_PAGE_SIZE = 100
SMARTRECRUITERS_REQUEST_INTERVAL = 0.55
_smartrecruiters_last_request = 0.0


@dataclass
class Job:
    job_id: str
    ats: str
    title: str
    company: str
    location: str
    description: str
    url: str
    posted_at: str | None = None
    salary: str | None = None
    country: str | None = None
    work_mode: str | None = None
    fetched_at: str | None = None
    source_board: str | None = None


def _text(value: Any) -> str:
    if not value:
        return ""
    return unescape(re.sub(r"<[^>]+>", " ", str(value))).strip()


def parse_greenhouse(payload: dict[str, Any], company: str) -> list[Job]:
    jobs = []
    for row in payload.get("jobs", []):
        jobs.append(Job(
            job_id=f"greenhouse:{row.get('id')}", ats="greenhouse",
            title=row.get("title", ""), company=company,
            location=(row.get("location") or {}).get("name", ""),
            description=_text(row.get("content")),
            url=row.get("absolute_url", ""),
            posted_at=row.get("updated_at"),
            work_mode=(row.get("workplace_type") or row.get("work_mode")),
        ))
    return jobs


def parse_lever(payload: list[dict[str, Any]], company: str) -> list[Job]:
    jobs = []
    for row in payload:
        categories = row.get("categories") or {}
        jobs.append(Job(
            job_id=f"lever:{row.get('id')}", ats="lever",
            title=row.get("text", ""), company=company,
            location=categories.get("location", ""),
            description=_text(row.get("descriptionPlain") or row.get("description")),
            url=row.get("hostedUrl", ""), posted_at=row.get("createdAt"),
            salary=_text((row.get("salaryRange") or {}).get("text")),
            country=row.get("country"),
            work_mode=(row.get("workplaceType") or "").replace("-", " ").title() or None,
        ))
    return jobs


def parse_ashby(payload: dict[str, Any], company: str) -> list[Job]:
    jobs = []
    for row in payload.get("jobs", []):
        jobs.append(Job(
            job_id=f"ashby:{row.get('jobId') or row.get('id')}", ats="ashby",
            title=row.get("title", ""), company=company,
            location=row.get("location", ""),
            description=_text(row.get("descriptionPlain") or row.get("description")),
            url=row.get("jobUrl", ""), posted_at=row.get("publishedAt"),
            salary=_text(row.get("compensation", "")),
            work_mode=(row.get("workplaceType") or row.get("workplace_type")),
        ))
    return jobs


def parse_smartrecruiters(payload: dict[str, Any], company: str) -> Job:
    location = payload.get("location") or {}
    job_ad = payload.get("jobAd") or {}
    sections = job_ad.get("sections") or {}
    description = "\n\n".join(
        str((sections.get(section) or {}).get("text", ""))
        for section in ("jobDescription", "qualifications", "additionalInformation")
        if (sections.get(section) or {}).get("text")
    )
    remote = location.get("remote")
    hybrid = location.get("hybrid")
    work_mode = "Remote" if remote is True else "Hybrid" if hybrid is True else None
    if work_mode is None and remote is False and hybrid is False:
        work_mode = "On-site"

    identifier = ((payload.get("company") or {}).get("identifier") or company).strip()
    job_id = str(payload.get("id") or payload.get("uuid") or "")
    return Job(
        job_id=f"smartrecruiters:{identifier}:{job_id}",
        ats="smartrecruiters",
        title=payload.get("name", ""),
        company=company,
        location=location.get("fullLocation") or ", ".join(
            part for part in (location.get("city"), location.get("region"), location.get("country")) if part
        ),
        description=_text(description),
        url=payload.get("applyUrl") or payload.get("postingUrl", ""),
        posted_at=payload.get("releasedDate"),
        country=location.get("country"),
        work_mode=work_mode,
    )


def _request_json(url: str, *, params: dict[str, Any] | None = None) -> Any:
    for attempt in range(MAX_RETRIES):
        try:
            response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT)
            if response.status_code == 429 or response.status_code >= 500:
                if attempt + 1 == MAX_RETRIES:
                    response.raise_for_status()
                retry_after = response.headers.get("Retry-After", "")
                try:
                    delay = min(15.0, max(0.5, float(retry_after)))
                except ValueError:
                    delay = 0.5 * (2 ** attempt)
                time.sleep(delay)
                continue
            response.raise_for_status()
            return response.json()
        except requests.RequestException as exc:
            status_code = exc.response.status_code if exc.response is not None else None
            if attempt + 1 == MAX_RETRIES or (status_code is not None and status_code < 500 and status_code != 429):
                raise
            time.sleep(0.5 * (2 ** attempt))
    raise RuntimeError(f"Could not fetch {url}")


def _smartrecruiters_request(url: str, *, params: dict[str, Any] | None = None) -> Any:
    global _smartrecruiters_last_request
    elapsed = time.monotonic() - _smartrecruiters_last_request
    if elapsed < SMARTRECRUITERS_REQUEST_INTERVAL:
        time.sleep(SMARTRECRUITERS_REQUEST_INTERVAL - elapsed)
    result = _request_json(url, params=params)
    _smartrecruiters_last_request = time.monotonic()
    return result


def fetch_board(board: dict[str, str]) -> list[Job]:
    ats = board["ats"].lower()
    slug = board["slug"]
    company = board["name"]

    if ats == "greenhouse":
        url = f"https://boards-api.greenhouse.io/v1/boards/{slug}/jobs"
        parser = parse_greenhouse
    elif ats == "lever":
        url = f"https://api.lever.co/v0/postings/{slug}?mode=json"
        parser = parse_lever
    elif ats == "ashby":
        url = f"https://api.ashbyhq.com/posting-api/job-board/{slug}"
        parser = parse_ashby
    elif ats == "smartrecruiters":
        base_url = f"https://api.smartrecruiters.com/v1/companies/{slug}/postings"
        postings: list[dict[str, Any]] = []
        offset = 0
        total_found: int | None = None
        while total_found is None or offset < total_found:
            page = _smartrecruiters_request(base_url, params={
                "limit": SMARTRECRUITERS_PAGE_SIZE,
                "offset": offset,
                "destination": "PUBLIC",
            })
            page_items = page.get("content")
            if not isinstance(page_items, list):
                raise ValueError("SmartRecruiters response did not contain a postings list")
            postings.extend(page_items)
            try:
                total_found = int(page.get("totalFound", len(postings)))
            except (TypeError, ValueError):
                raise ValueError("SmartRecruiters response contained an invalid totalFound")
            if not page_items:
                break
            offset += len(page_items)

        jobs = []
        for posting in postings:
            detail_url = posting.get("ref")
            if not isinstance(detail_url, str) or not detail_url.startswith("https://api.smartrecruiters.com/"):
                raise ValueError("SmartRecruiters posting is missing a trusted detail URL")
            detail = _smartrecruiters_request(detail_url)
            jobs.append(parse_smartrecruiters(detail, company))
        return jobs
    else:
        raise ValueError(f"Unsupported ATS: {ats}")

    if ats == "lever":
        jobs: list[Job] = []
        skip = 0
        while True:
            payload = _request_json(url, params={
                "skip": skip,
                "limit": LEVER_PAGE_SIZE,
            })
            if not isinstance(payload, list):
                raise ValueError("Lever response was not a postings array")
            jobs.extend(parser(payload, company))
            if len(payload) < LEVER_PAGE_SIZE:
                break
            skip += len(payload)
        return jobs

    return parser(_request_json(url, params={"content": "true"} if ats == "greenhouse" else None), company)


def fetch_all_with_report(companies: list[dict[str, str]]) -> tuple[list[Job], list[dict[str, Any]]]:
    jobs = []
    reports = []
    for board in companies:
        source_id = f"{board.get('ats', '').lower()}:{board.get('slug', '')}"
        try:
            board_jobs = fetch_board(board)
            for job in board_jobs:
                job.source_board = board.get("slug")
            jobs.extend(board_jobs)
            reports.append({"source_id": source_id, "company": board.get("name", ""), "success": True, "raw_count": len(board_jobs), "error": None})
        except Exception as exc:
            logger.warning("Could not fetch %s board %s: %s", board.get("ats"), board.get("slug"), exc)
            reports.append({"source_id": source_id, "company": board.get("name", ""), "success": False, "raw_count": 0, "error": str(exc)})
    return jobs, reports


def fetch_all(companies: list[dict[str, str]]) -> list[Job]:
    jobs, _ = fetch_all_with_report(companies)
    return jobs


def normalize_jobs(jobs: list[Job], fetched_at: str | None = None) -> list[dict[str, Any]]:
    normalized = []
    for job in jobs:
        if not job.title or not job.url:
            continue
        record = {
            "id": job.job_id,
            "title": job.title,
            "company": job.company,
            "location": job.location,
            "description": job.description,
            "skills": extract_skills(job.description),
            "apply_url": job.url,
            "source": job.ats,
            "posted_at": job.posted_at,
            "salary": job.salary,
            "country": job.country,
            "work_mode": job.work_mode,
            "fetched_at": job.fetched_at or fetched_at,
            "source_board": job.source_board,
        }
        normalized.append({key: value for key, value in record.items() if value is not None})
    return normalized
