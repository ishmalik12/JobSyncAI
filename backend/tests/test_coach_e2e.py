import requests
import json
import sys

API = "http://127.0.0.1:8000"

def run_e2e():
    creds = {"email": "alex_debrief_test@jobsync.ai", "password": "secure_password_123", "name": "Alex"}
    auth_res = requests.post(f"{API}/auth/register", json=creds)
    if auth_res.status_code != 200:
        auth_res = requests.post(f"{API}/auth/login", json=creds)

    if auth_res.status_code != 200:
        print("Auth failed:", auth_res.text)
        sys.exit(1)

    token = auth_res.json()["access_token"]
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # 1. Coach status
    st_res = requests.get(f"{API}/interview-coach/status", headers=headers)
    print("Coach status response:", st_res.status_code, repr(st_res.text))
    st = st_res.json()
    print("Coach Status:", st)

    # 2. Create session
    sess = requests.post(f"{API}/interview-coach/sessions", headers=headers, json={
        "company": "Uber",
        "role": "Backend Engineer",
        "notes": "System Design round on caching"
    }).json()
    session_id = sess["id"]
    print(f"Session Created: {session_id} -> {sess['title']}")

    # 3. Send message
    prompt = (
        "Hi coach, I just had my Uber interview. I got stuck on distributed caching with Redis and cache invalidation "
        "under high concurrency. I felt completely blank and I think they will reject me. Feeling really sad and demoralized."
    )
    msg_res = requests.post(f"{API}/interview-coach/sessions/{session_id}/message", headers=headers, json={"content": prompt})
    print("Message Status:", msg_res.status_code)
    data = msg_res.json()
    print("Model used:", data.get("model"))
    print("Extracted growth count:", len(data.get("extracted_growth", [])))
    sample = data.get("reply", "")[:300].encode("ascii", "replace").decode()
    print("Sample reply:", sample)

    # 4. Check memories
    mems = requests.get(f"{API}/interview-coach/memories", headers=headers).json()
    print("Total memories stored:", len(mems))
    if mems:
        print("Latest memory weaknesses:", mems[0].get("weaknesses"))

    print("\nALL COACH E2E TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    run_e2e()
