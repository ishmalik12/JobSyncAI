"""Small environment loader shared by the API and command line tools."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent


def load_environment() -> None:
    env_file = BASE_DIR / ".env"
    if not env_file.exists():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_environment()

MONGODB_URI = os.getenv("MONGODB_URI", "").strip()
MONGODB_DATABASE = os.getenv("MONGODB_DATABASE", "jobsync_ai").strip() or "jobsync_ai"
JWT_SECRET_KEY = os.getenv("JWT_SECRET_KEY", "").strip()
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173").strip()
ENVIRONMENT = os.getenv("ENVIRONMENT", "development").strip().casefold()
JWT_EXPIRE_MINUTES = max(5, int(os.getenv("JWT_EXPIRE_MINUTES", "10080")))
JOB_REFRESH_INTERVAL_HOURS = max(0, int(os.getenv("JOB_REFRESH_INTERVAL_HOURS", "0")))
