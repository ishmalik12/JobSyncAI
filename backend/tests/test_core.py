from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

import database
import main
import migrate_jobs
import security
from matcher import rank_jobs, score_match_batch
from security import hash_password, verify_password


class CatalogTests(unittest.TestCase):
    def test_migration_deduplicates_stable_ids_and_urls(self):
        records = [
            {"id": "gh:1", "title": "Engineer", "apply_url": "https://jobs.test/one/", "description": "Python"},
            {"id": "gh:2", "title": "Duplicate URL", "apply_url": "https://jobs.test/one", "description": "Python"},
            {"id": "gh:1", "title": "Duplicate ID", "apply_url": "https://jobs.test/two", "description": "SQL"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "jobs.json"
            source.write_text(json.dumps(records), encoding="utf-8")
            with patch.object(migrate_jobs, "DATA_FILE", source):
                jobs, duplicates = migrate_jobs.load_unique_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(duplicates, 2)
        self.assertEqual(jobs[0]["id"], "gh:1")

    def test_normalized_document_uses_stable_mongo_id(self):
        document = database.normalize_job_document({"id": 123, "title": "Engineer"})
        self.assertEqual(document["id"], "123")
        self.assertEqual(document["_id"], "123")

    def test_unconfigured_database_reports_json_mode(self):
        with patch.object(database, "MONGODB_URI", ""):
            self.assertEqual(database.database_health(), {
                "configured": False, "connected": False, "mode": "json-fallback",
            })

    def test_mongodb_connection_error_is_reported_without_a_fallback_claim(self):
        with patch.object(database, "MONGODB_URI", "mongodb://invalid.test"), \
             patch("pymongo.MongoClient", side_effect=RuntimeError("connection refused")), \
             patch.object(database, "_database", None), patch.object(database, "_client", None):
            self.assertFalse(database.connect_database())
            health = database.database_health()
        self.assertTrue(health["configured"])
        self.assertFalse(health["connected"])
        self.assertIn("MongoDB is configured but unavailable", health["error"])

    def test_api_health_and_catalog_work_without_atlas(self):
        with patch.object(main, "MONGODB_URI", ""), TestClient(main.app) as client:
            health = client.get("/health")
            stats = client.get("/jobs/stats")
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json()["status"], "ok")
        self.assertEqual(stats.status_code, 200)
        self.assertGreater(stats.json()["job_count"], 0)

    def test_migrated_catalog_uses_mongo_and_fails_closed(self):
        sample = [{"id": "mongo-job", "title": "Atlas role"}]
        with patch.object(main, "MONGODB_URI", "mongodb://configured"), \
             patch.object(main, "catalog_migrated", return_value=True), \
             patch.object(main, "list_jobs", return_value=sample):
            self.assertEqual(main.catalog_jobs(), sample)
        with patch.object(main, "MONGODB_URI", "mongodb://configured"), \
             patch.object(main, "catalog_migrated", return_value=True), \
             patch.object(main, "list_jobs", side_effect=RuntimeError("offline")):
            with self.assertRaises(Exception) as raised:
                main.catalog_jobs()
        self.assertEqual(raised.exception.status_code, 503)

    def test_job_search_filters_by_company_location_and_remote(self):
        records = [
            {"id": "1", "title": "Python Engineer", "company": "North", "location": "Delhi, India", "work_mode": "Remote"},
            {"id": "2", "title": "Data Analyst", "company": "South", "location": "Pune, India", "work_mode": "On-site"},
        ]
        with patch.object(main, "catalog_jobs", return_value=records), TestClient(main.app) as client:
            targeted = client.get("/jobs", params={"q": "python", "location": "delhi"}).json()
            remote = client.get("/jobs", params={"remote": "true"}).json()
            empty = client.get("/jobs", params={"q": "missing-company"}).json()
        self.assertEqual([job["id"] for job in targeted["jobs"]], ["1"])
        self.assertEqual([job["id"] for job in remote["jobs"]], ["1"])
        self.assertEqual(empty["total"], 0)


class MatchingTests(unittest.TestCase):
    def test_batch_scoring_preserves_formula_and_skills(self):
        jobs = [{"id": "j1", "title": "Python developer", "company": "A",
                 "description": "Build with Python and SQL", "skills": ["python", "sql"]}]
        result = score_match_batch(jobs, np.array([[1.0, 0.0]]), np.array([[1.0, 0.0]]), {"python"}, 0, 1)[0]
        self.assertEqual(result["match_score"], 80.0)
        self.assertEqual(result["matched_skills"], ["python"])
        self.assertEqual(result["missing_skills"], ["sql"])

    def test_diversity_ranking_keeps_relevance_and_rotates_employers(self):
        results = [
            {"id": "a1", "company": "A", "match_score": 90},
            {"id": "a2", "company": "A", "match_score": 89.5},
            {"id": "b1", "company": "B", "match_score": 89},
        ]
        ranked = rank_jobs(results, score_window=2, page_size=2, company_cap=1)
        self.assertEqual([job["id"] for job in ranked[:2]], ["a1", "b1"])
        self.assertEqual({job["id"] for job in ranked}, {"a1", "a2", "b1"})


class AuthenticationTests(unittest.TestCase):
    def test_password_hash_is_one_way_and_verifiable(self):
        encoded = hash_password("this is a test password")
        self.assertNotEqual(encoded, "this is a test password")
        self.assertTrue(verify_password("this is a test password", encoded))
        self.assertFalse(verify_password("incorrect password", encoded))

    def test_account_saved_jobs_applications_preferences_and_logout(self):
        class Cursor(list):
            def sort(self, key, direction=1):
                super().sort(key=lambda row: row.get(key), reverse=direction < 0)
                return self

        class Collection:
            def __init__(self):
                self.rows = []

            def find_one(self, query, projection=None):
                return next((row for row in self.rows if all(row.get(key) == value for key, value in query.items())), None)

            def insert_one(self, document):
                self.rows.append(dict(document))

            def find(self, query, projection=None):
                return Cursor(row for row in self.rows if all(row.get(key) == value for key, value in query.items()))

            def distinct(self, key):
                return list(dict.fromkeys(row.get(key) for row in self.rows if row.get(key) is not None))

            def update_one(self, query, update, upsert=False):
                row = self.find_one(query)
                matched = row is not None
                if row is None and upsert:
                    row = dict(query)
                    self.rows.append(row)
                if row is not None:
                    if not matched:
                        row.update(update.get("$setOnInsert", {}))
                    row.update(update.get("$set", {}))
                return type("Result", (), {"matched_count": int(matched)})()

            def delete_one(self, query):
                before = len(self.rows)
                self.rows[:] = [row for row in self.rows if not all(row.get(key) == value for key, value in query.items())]
                return type("Result", (), {"deleted_count": before - len(self.rows)})()

        class FakeDatabase:
            def __init__(self):
                self.collections = {}

            def __getattr__(self, name):
                return self.collections.setdefault(name, Collection())

            def __getitem__(self, name):
                return getattr(self, name)

        fake_db = FakeDatabase()
        job = {"id": "job-1", "title": "Python Engineer", "company": "Example", "apply_url": "https://example.test/job"}
        with patch.object(main, "get_database", return_value=fake_db), \
             patch.object(security, "get_database", return_value=fake_db), \
             patch.object(main, "catalog_jobs", return_value=[job]), \
             patch.object(security, "JWT_SECRET_KEY", "test-secret-that-is-long-enough-for-hmac"):
            with TestClient(main.app) as client:
                registered = client.post("/auth/register", json={"email": "Person@example.test", "password": "a secure password", "name": "Person"})
                self.assertEqual(registered.status_code, 200, registered.text)
                logged_in = client.post("/auth/login", json={"email": "PERSON@example.test", "password": "a secure password"})
                self.assertEqual(logged_in.status_code, 200, logged_in.text)
                token = registered.json()["access_token"]
                headers = {"Authorization": "Bearer " + token}
                self.assertEqual(client.get("/auth/me", headers=headers).status_code, 200)
                self.assertEqual(client.post("/saved-jobs/job-1", headers=headers).status_code, 200)
                self.assertEqual(client.get("/saved-jobs", headers=headers).json()[0]["job"]["id"], "job-1")
                self.assertEqual(client.post("/applications", headers=headers, json={"job_id": "job-1", "status": "Applied"}).status_code, 200)
                self.assertEqual(client.patch("/applications/job-1", headers=headers, json={"status": "Interviewing"}).status_code, 200)
                self.assertEqual(client.get("/applications", headers=headers).json()[0]["status"], "Interviewing")
                preferences = {"required_skills": ["Python"], "min_score": 35, "theme": "dark"}
                self.assertEqual(client.put("/preferences", headers=headers, json=preferences).json(), preferences)
                profile = client.get("/users/me", headers=headers)
                self.assertEqual(profile.status_code, 200)
                self.assertEqual(profile.json()["email"], "Person@example.test")
                changed_profile = client.patch("/users/me", headers=headers, json={
                    "name": "Updated Person", "preferred_titles": ["Engineer"],
                    "preferred_locations": ["Remote"], "remote_preference": "remote",
                    "employment_types": ["Full-time"], "interests": ["Python"],
                })
                self.assertEqual(changed_profile.status_code, 200, changed_profile.text)
                self.assertEqual(changed_profile.json()["name"], "Updated Person")
                self.assertEqual(client.get("/users/me", headers={"Authorization": "Bearer " + ""}).status_code, 401)
                other = client.post("/auth/register", json={"email": "other@example.test", "password": "another secure password"})
                other_headers = {"Authorization": "Bearer " + other.json()["access_token"]}
                self.assertEqual(client.get("/saved-jobs", headers=other_headers).json(), [])
                self.assertEqual(client.get("/applications", headers=other_headers).json(), [])
                self.assertEqual(client.delete("/applications/job-1", headers=other_headers).status_code, 404)
                self.assertEqual(client.delete("/applications/job-1", headers=headers).status_code, 200)
                self.assertEqual(client.post("/auth/logout", headers=headers).status_code, 200)
                self.assertEqual(client.get("/auth/me", headers=headers).status_code, 401)


if __name__ == "__main__":
    unittest.main()
