import json
import hashlib
import logging
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np
from sentence_transformers import SentenceTransformer
from sklearn.metrics.pairwise import cosine_similarity

from skill_extractor import extract_skills

DATA_FILE = Path(__file__).parent / "data" / "jobs.json"
MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MAX_LIMIT = 5000
MATCHING_CONFIG_FILE = Path(__file__).parent / "data" / "matching_config.json"
EMBEDDINGS_FILE = Path(__file__).parent / "data" / "job_embeddings.npz"
logger = logging.getLogger(__name__)


def _load_matching_config() -> dict[str, Any]:
    defaults = {"display_page_size": 20, "company_limit_per_page": 2, "score_window": 2.0}
    try:
        with MATCHING_CONFIG_FILE.open(encoding="utf-8-sig") as config_file:
            supplied = json.load(config_file)
        if isinstance(supplied, dict):
            defaults.update(supplied)
    except (OSError, json.JSONDecodeError):
        logger.warning("Could not read matching config; using safe defaults")
    return defaults


MATCHING_CONFIG = _load_matching_config()

_cache_lock = threading.RLock()
_model_lock = threading.RLock()
model = None
MODEL_INITIALIZATION_SECONDS: float | None = None
_cache_signature: Any = None
_cached_jobs: list[dict[str, Any]] = []
_cached_embeddings = None
_cache_metrics: dict[str, Any] = {
    "dataset_load_seconds": None,
    "job_embedding_seconds": None,
    "persistent_cache_hit": False,
    "last_resume_embedding_seconds": None,
}


def _get_model():
    global model, MODEL_INITIALIZATION_SECONDS
    if model is None:
        with _model_lock:
            if model is None:
                started_at = time.perf_counter()
                model = SentenceTransformer(MODEL_NAME)
                MODEL_INITIALIZATION_SECONDS = time.perf_counter() - started_at
    return model


def _signature() -> tuple[int, int] | None:
    try:
        stat = DATA_FILE.stat()
        return stat.st_mtime_ns, stat.st_size
    except OSError:
        return None


def _normalized_jobs(records: Any) -> list[dict[str, Any]]:
    if not isinstance(records, list):
        logger.warning("Jobs data must be a JSON array; treating it as empty")
        return []

    jobs: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_urls: set[str] = set()

    for index, record in enumerate(records):
        if not isinstance(record, dict):
            continue

        title_value = record.get("title")
        description_value = record.get("description")
        title = title_value.strip() if isinstance(title_value, str) else ""
        description = (
            description_value.strip()
            if isinstance(description_value, str)
            else ""
        )
        if not title and not description:
            continue
        if not title:
            title = "Untitled role"

        raw_id = record.get("id")
        job_id = raw_id if isinstance(raw_id, (str, int)) and not isinstance(raw_id, bool) else None
        if isinstance(job_id, str) and not job_id.strip():
            job_id = None
        apply_url_value = record.get("apply_url")
        apply_url = (
            apply_url_value.strip()
            if isinstance(apply_url_value, str)
            else ""
        )

        if job_id is not None:
            id_key = str(job_id).strip().casefold()
            if id_key and id_key in seen_ids:
                continue
            if id_key:
                seen_ids.add(id_key)
        elif apply_url:
            url_key = apply_url.casefold()
            if url_key in seen_urls:
                continue
            seen_urls.add(url_key)

        raw_skills = record.get("skills")
        if isinstance(raw_skills, list):
            skills = sorted({
                skill.strip()
                for skill in raw_skills
                if isinstance(skill, str) and skill.strip()
            })
        else:
            skills = extract_skills(description)

        company_value = record.get("company")
        location_value = record.get("location")
        company = company_value.strip() if isinstance(company_value, str) else ""
        location = location_value.strip() if isinstance(location_value, str) else ""

        normalized = {
            **record,
            "id": job_id if job_id is not None else (apply_url or f"job-{index}"),
            "title": title,
            "company": company or "Unknown company",
            "location": location,
            "description": description,
            "skills": skills,
            "apply_url": apply_url,
        }
        jobs.append(normalized)

    return jobs


def _dataset_fingerprint(jobs: list[dict[str, Any]]) -> str:
    encoded = json.dumps(
        [(str(job["id"]), job["title"], job["description"]) for job in jobs],
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256((MODEL_NAME + "\\0").encode("utf-8") + encoded).hexdigest()


def _job_cache_signature(jobs: list[dict[str, Any]]) -> str:
    fields = ("id", "title", "company", "location", "description", "skills", "apply_url",
              "source", "source_board", "country", "work_mode", "posted_at", "salary")
    encoded = json.dumps(
        [{field: job.get(field) for field in fields} for job in jobs],
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _load_persistent_embeddings(fingerprint: str, expected_rows: int):
    try:
        with np.load(EMBEDDINGS_FILE, allow_pickle=False) as saved:
            embeddings = saved["embeddings"]
            saved_fingerprint = str(saved["fingerprint"].item())
            saved_model = str(saved["model"].item())
        if (
            saved_fingerprint != fingerprint
            or saved_model != MODEL_NAME
            or embeddings.ndim != 2
            or embeddings.shape[0] != expected_rows
            or not np.isfinite(embeddings).all()
        ):
            return None
        return embeddings
    except (OSError, ValueError, KeyError, EOFError):
        return None


def _save_persistent_embeddings(embeddings: Any, fingerprint: str) -> None:
    handle, temporary_path = tempfile.mkstemp(
        prefix="job-embeddings-", suffix=".npz", dir=EMBEDDINGS_FILE.parent
    )
    os.close(handle)
    try:
        np.savez(
            temporary_path,
            embeddings=np.asarray(embeddings, dtype=np.float32),
            fingerprint=np.asarray(fingerprint),
            model=np.asarray(MODEL_NAME),
        )
        os.replace(temporary_path, EMBEDDINGS_FILE)
    finally:
        if os.path.exists(temporary_path):
            os.unlink(temporary_path)


def _get_job_cache(records: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], Any]:
    global _cache_signature, _cached_jobs, _cached_embeddings

    with _cache_lock:
        supplied_jobs = _normalized_jobs(records) if records is not None else None
        current_signature = (
            "mongo:" + _job_cache_signature(supplied_jobs)
            if supplied_jobs is not None
            else _signature()
        )
        if current_signature == _cache_signature:
            return _cached_jobs, _cached_embeddings

        data_started_at = time.perf_counter()
        if supplied_jobs is not None:
            jobs = supplied_jobs
        else:
            try:
                with DATA_FILE.open(encoding="utf-8-sig") as data_file:
                    file_records = json.load(data_file)
            except (OSError, json.JSONDecodeError) as exc:
                logger.warning("Could not read %s: %s", DATA_FILE, exc)
                if _cache_signature is not None:
                    # Keep serving the last complete file snapshot during an atomic refresh.
                    return _cached_jobs, _cached_embeddings
                _cache_signature = current_signature
                _cached_jobs, _cached_embeddings = [], None
                return _cached_jobs, _cached_embeddings
            jobs = _normalized_jobs(file_records)
        _cache_metrics["dataset_load_seconds"] = time.perf_counter() - data_started_at
        if jobs:
            fingerprint = _dataset_fingerprint(jobs)
            embedding_started_at = time.perf_counter()
            embeddings = _load_persistent_embeddings(fingerprint, len(jobs))
            _cache_metrics["persistent_cache_hit"] = embeddings is not None
            if embeddings is None:
                job_texts = [f"{job['title']}. {job['description']}" for job in jobs]
                with _model_lock:
                    embeddings = _get_model().encode(
                        job_texts,
                        batch_size=64,
                        normalize_embeddings=True,
                        convert_to_numpy=True,
                        show_progress_bar=False,
                    )
                try:
                    _save_persistent_embeddings(embeddings, fingerprint)
                except OSError:
                    logger.exception("Could not save persistent job embeddings")
            _cache_metrics["job_embedding_seconds"] = time.perf_counter() - embedding_started_at
        else:
            embeddings = None

        _cached_jobs = jobs
        _cached_embeddings = embeddings
        # Store the signature observed before reading. If the file changed
        # while it was being parsed/embedded, the next request will reload it.
        _cache_signature = current_signature
        return _cached_jobs, _cached_embeddings


def prepare_match(resume_text: str, records: list[dict[str, Any]] | None = None):
    """Prepare one resume vector and fetch the current cached job vectors."""
    if not isinstance(resume_text, str) or not resume_text.strip():
        raise ValueError("Resume text cannot be empty.")

    jobs, job_embeddings = _get_job_cache(records)
    if not jobs or job_embeddings is None:
        return jobs, job_embeddings, None, set()

    resume_embedding_started_at = time.perf_counter()
    with _model_lock:
        resume_embedding = _get_model().encode(
            [resume_text.strip()],
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
    _cache_metrics["last_resume_embedding_seconds"] = time.perf_counter() - resume_embedding_started_at
    resume_skills = {skill.lower() for skill in extract_skills(resume_text)}
    return jobs, job_embeddings, resume_embedding, resume_skills


def score_match_batch(
    jobs: list[dict[str, Any]],
    job_embeddings: Any,
    resume_embedding: Any,
    resume_skills: set[str],
    start: int,
    end: int,
) -> list[dict[str, Any]]:
    """Score one slice using the same formula as the JSON matcher."""
    similarities = cosine_similarity(
        resume_embedding,
        job_embeddings[start:end],
    )[0]
    results: list[dict[str, Any]] = []

    for job, similarity in zip(jobs[start:end], similarities):
        required_skills = {skill.lower() for skill in job["skills"]}
        matched = sorted(resume_skills & required_skills)
        missing = sorted(required_skills - resume_skills)
        skill_score = (
            len(matched) / len(required_skills) * 100
            if required_skills
            else 0.0
        )
        semantic_score = max(0.0, min(100.0, float(similarity) * 100))
        match_score = max(
            0.0,
            min(100.0, 0.6 * semantic_score + 0.4 * skill_score),
        )
        results.append({
            **job,
            "match_score": round(match_score, 1),
            "semantic_score": round(semantic_score, 1),
            "skill_score": round(skill_score, 1),
            "matched_skills": matched,
            "missing_skills": missing,
        })
    return results


def rank_jobs(
    results: list[dict[str, Any]],
    score_window: float | None = None,
    page_size: int | None = None,
    company_cap: int | None = None,
) -> list[dict[str, Any]]:
    """Apply a stable per-page employer cap within a close-score window."""
    score_window = float(score_window if score_window is not None else MATCHING_CONFIG["score_window"])
    page_size = max(1, int(page_size if page_size is not None else MATCHING_CONFIG["display_page_size"]))
    company_cap = max(1, int(company_cap if company_cap is not None else MATCHING_CONFIG["company_limit_per_page"]))
    ordered = sorted(
        results,
        key=lambda job: (-job["match_score"], str(job.get("company", "")).casefold(), str(job.get("id", ""))),
    )
    ranked: list[dict[str, Any]] = []
    remaining = list(ordered)
    while remaining:
        page: list[dict[str, Any]] = []
        cutoff = remaining[0]["match_score"] - score_window
        close_matches = [job for job in remaining if job["match_score"] >= cutoff]
        close_ids = {id(job) for job in close_matches}
        company_counts: dict[str, int] = {}

        # Select one job per employer first, then a second per employer. This
        # keeps the first page diverse while staying within the configured
        # score window. If that does not fill the page, relax the cap only for
        # the remaining close matches, then continue into lower score bands.
        for _ in range(company_cap):
            selected = {id(job) for job in page}
            for job in close_matches:
                employer = str(job.get("company") or "Unknown company").casefold()
                if id(job) in selected or company_counts.get(employer, 0) != _:
                    continue
                page.append(job)
                company_counts[employer] = company_counts.get(employer, 0) + 1
                if len(page) >= page_size:
                    break
            if len(page) >= page_size:
                break

        if len(page) < page_size:
            # When the close-score pool cannot fill a page at the target cap,
            # relax it one listing per employer at a time.
            for relaxed_count in range(company_cap, len(close_matches)):
                selected = {id(job) for job in page}
                added = False
                for job in close_matches:
                    employer = str(job.get("company") or "Unknown company").casefold()
                    if id(job) in selected or company_counts.get(employer, 0) != relaxed_count:
                        continue
                    page.append(job)
                    company_counts[employer] = relaxed_count + 1
                    added = True
                    if len(page) >= page_size:
                        break
                if len(page) >= page_size or not added:
                    break

        if len(page) < page_size:
            selected = {id(job) for job in page}
            for job in remaining:
                if id(job) in close_ids or id(job) in selected:
                    continue
                page.append(job)
                if len(page) >= page_size:
                    break

        selected = {id(job) for job in page}
        remaining = [job for job in remaining if id(job) not in selected]
        ranked.extend(page)
    return ranked


def performance_snapshot() -> dict[str, Any]:
    return {
        "model_initialization_seconds": MODEL_INITIALIZATION_SECONDS,
        **_cache_metrics,
    }


def match_jobs(resume_text: str, limit: int = 100, records: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """Compatibility matcher: score the full dataset and return its top results."""
    try:
        result_limit = max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        result_limit = 100

    jobs, job_embeddings, resume_embedding, resume_skills = prepare_match(resume_text, records)
    if not jobs or job_embeddings is None or resume_embedding is None:
        return []

    results: list[dict[str, Any]] = []
    for start in range(0, len(jobs), 256):
        results.extend(score_match_batch(
            jobs,
            job_embeddings,
            resume_embedding,
            resume_skills,
            start,
            min(start + 256, len(jobs)),
        ))

    return rank_jobs(results)[:result_limit]
