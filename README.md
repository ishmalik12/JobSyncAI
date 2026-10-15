# JobSync AI

JobSync AI is a React/Vite dashboard backed by FastAPI. Resume extraction uses PyMuPDF locally. Matching uses the local `all-MiniLM-L6-v2` Sentence Transformer, cached job embeddings, cosine similarity, extracted skill overlap and employer-diverse ranking. The Greenhouse, Lever, Ashby and SmartRecruiters public career-board adapters are in `backend/job_sources.py`.

## Requirements

- Python 3.11 or newer (3.13 is recommended for the ML dependencies)
- Node.js 20.19+ or 22.12+
- A MongoDB Atlas cluster or local MongoDB for persistent accounts and the migrated job catalog

The checked-in JSON dataset remains a backup and is used before the first successful MongoDB migration. Once `system_state.catalog_migration` exists, configured MongoDB is the live source of job records; a MongoDB outage produces a service error instead of silently switching to old JSON.

## Setup

In PowerShell, from the repository root:

```powershell
cd backend
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
Copy-Item .env.example .env
```

Edit `backend/.env` with your Atlas URI and a random JWT secret. Create an Atlas database user with access only to the `jobsync_ai` database and add your development IP to the Atlas network access list. Do not commit `.env` or put any secret in a `VITE_*` variable. Atlas has a free shared tier in supported regions, subject to current Atlas availability, limits and terms; no paid job API or hosted AI service is used.

Import and verify the existing dataset (safe to run again):

```powershell
python migrate_jobs.py
```

Install and start the frontend in another terminal:

```powershell
cd frontend
npm install
Copy-Item .env.example .env.local
npm run dev
```

Start the API:

```powershell
cd backend
.\.venv\Scripts\Activate.ps1
uvicorn main:app --reload
```

If using a different frontend origin, set `FRONTEND_ORIGIN` in `backend/.env`. The frontend API URL is public configuration in `frontend/.env.local` (`VITE_API_BASE_URL`).

## Ingest job listings

The company board identifiers are configured in `backend/data/companies.json`. They are board slugs, not universal ATS credentials; verify each identifier on the company's official career page. Refresh listings manually:

```powershell
cd backend
python update_jobs.py
```

The fetcher uses Greenhouse's public Job Board endpoint, Lever's public Postings API, Ashby's public job-board endpoint and SmartRecruiters' public postings endpoint, with pagination, timeouts, retries and source-level reports. Greenhouse and Lever are designed for public job-site integrations; SmartRecruiters' endpoints and access behavior vary by API and company, so validate the configured public company identifier and current provider terms before relying on a board. Public endpoint access does not itself grant broad reuse rights. Existing listings are retained for failed boards and ambiguous empty responses. A successful non-empty normalized board snapshot may remove stale postings from that board.

Set `JOB_REFRESH_INTERVAL_HOURS=24` to enable the API's built-in refresh loop (0 disables it). Refresh runs after the configured interval and invokes the same `update_jobs.py` command; the process logs its source reports. Use a single API worker with this in-process scheduler; for multiple workers, keep it disabled and schedule the command once with Windows Task Scheduler.

`GET /ingestion/status` reports the latest recorded board results after the updater has written them to MongoDB.

## API features

- `POST /resume/parse` extracts text from uploaded PDFs in memory; resume contents are not persisted.
- `POST /jobs/match` preserves the existing non-streaming API.
- `POST /jobs/match/stream` sends progressive score batches and final diversity-aware ranking.
- `GET /jobs/stats`, `GET /jobs` and `GET /health` expose catalog, filtering and health information.
- `POST /auth/register`, `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` manage Argon2-hashed accounts and revocable, expiring bearer sessions.
- `/saved-jobs`, `/applications` and `/preferences` require a valid bearer token and scope every database operation to the authenticated user.

Application states are `Saved`, `Applied`, `Interviewing`, `Rejected`, `Offered` and `Withdrawn`. Logging out revokes the current session in MongoDB.

MongoDB collections and indexes are provisioned by the API and migration command: `jobs` (stable `_id`, company/location and posting date indexes), `users` (unique normalized email), `auth_sessions` (unique session id and expiry TTL), `saved_jobs` (unique user/job), `applications` (unique user/job), `user_preferences` (unique user), `ingestion_runs` (date and source history), and `system_state` (migration marker).

## Tests and builds

```powershell
cd backend
python -m unittest discover -s tests -v
python -m compileall -q .
cd ..\frontend
npm run lint
npm run build
```

MongoDB integration tests require a dedicated test database configured as `MONGODB_URI`; never point destructive integration tests at production. `GET /health` reports whether MongoDB is configured and connected. If registration returns a configuration error, confirm `JWT_SECRET_KEY` is at least 32 characters and restart the API. If the database reports disconnected, verify the Atlas URI, database user password encoding, IP allowlist and outbound network access.

## Privacy and limitations

Resume PDF text is processed locally by the API and held only for the request/session in frontend memory. Do not enable request-body logging for resume endpoints. MongoDB stores account credentials as Argon2 hashes and persists sessions, saved jobs, application notes/statuses and preferences. Configure Atlas retention, access control and backups for your deployment. Public ATS endpoints do not imply unrestricted reuse; follow the relevant provider and employer terms and rate limits.

Matching is an estimate of semantic relevance and skill overlap, not a probability of being hired. Job feeds may be incomplete or stale between refresh runs, and remote eligibility is shown only where supported by listing data.
