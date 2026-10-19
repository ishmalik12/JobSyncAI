"""Interview Debrief & Career Coach powered by Google Gemini 2.5 Flash.

Allows candidates to debrief after an interview, receive empathetic morale boosts,
automatically memorize interview experiences, extract weaknesses & growth points,
and query for future targeting advice.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import requests

from config import GEMINI_API_KEY, GEMINI_MODEL

logger = logging.getLogger("jobsync.interview_coach")

GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

# Order of candidate models to try for maximum availability on free keys
FALLBACK_MODELS = [
    GEMINI_MODEL or "gemini-2.5-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
]


def get_effective_api_key(db_key: str | None = None) -> str:
    """Return active Gemini API key from DB preference, env, or config."""
    if db_key and db_key.strip():
        return db_key.strip()
    env_key = os.getenv("GEMINI_API_KEY", "").strip()
    if env_key:
        return env_key
    return (GEMINI_API_KEY or "").strip()


def build_coach_system_prompt(
    user_name: str,
    memories: list[dict[str, Any]],
    growth_logs: list[dict[str, Any]],
    applications: list[dict[str, Any]],
) -> str:
    """Build a rich personalized system prompt with historical interview memories and weaknesses."""
    memories_summary = []
    for mem in memories[:10]:
        company = mem.get("company") or "Unknown Company"
        role = mem.get("role") or "Role"
        date = mem.get("created_at") or ""
        gaps = ", ".join(mem.get("weaknesses", [])) or "None specified"
        takeaways = mem.get("takeaways") or mem.get("notes") or ""
        memories_summary.append(
            f"- {company} ({role}) [{date}]: Gaps identified: {gaps}. Key notes: {takeaways}"
        )
    memories_text = (
        "\n".join(memories_summary)
        if memories_summary
        else "No previous interview debriefs recorded yet. This might be their first logged debrief."
    )

    growth_summary = []
    for g in growth_logs[:12]:
        growth_summary.append(
            f"- [{g.get('status', 'Identified')}] {g.get('title', '')} ({g.get('category', '')}): {g.get('action_plan', '')}"
        )
    growth_text = (
        "\n".join(growth_summary)
        if growth_summary
        else "No tracked weaknesses or growth items recorded yet."
    )

    apps_summary = []
    for a in applications[:8]:
        job = a.get("job", {})
        status = a.get("status", "Applied")
        apps_summary.append(f"- {job.get('company', '')} - {job.get('title', '')}: Status [{status}]")
    apps_text = "\n".join(apps_summary) if apps_summary else "No active tracked applications."

    return f"""You are the JobSync AI Career Coach & Interview Debrief Mentor, powered by Gemini 2.5 Flash.
The candidate ({user_name or 'Friend'}) is talking to you after completing an interview or while preparing for upcoming rounds.

CORE COACHING PHILOSOPHY & PERSONA:
1. Warm, Uplifting & Empathetic Morale Booster:
   - Remind the candidate: "No need to be sad or discouraged. Everything is a learning until you win. Be patient to achieve big."
   - Rejections and tough rounds are data points, not verdicts on worth.
   - Always validate their feelings first, then inspire them with actionable optimism.

2. Deep Interview Detective & Analyzer:
   - Ask thoughtful, specific questions to understand what really happened:
     * What specific coding questions, algorithms, or edge cases did they ask?
     * In system design: What scale, bottlenecks, or trade-offs were discussed?
     * In behavioral: What STAR questions did they ask, and how did you frame your answers?
     * What moments felt smooth, and where did you feel hesitant or stumble?

3. Long-Term Memory & Targeting Advisor:
   - The candidate can ask you: "What should I target?", "What are my recurring weaknesses?", or "What should I practice before my next interview?"
   - Cross-reference their historical debriefs and current tracked weaknesses to give razor-sharp, prioritized advice.

CANDIDATE'S HISTORICAL MEMORY (FROM PREVIOUS INTERVIEWS):
{memories_text}

CANDIDATE'S CURRENT WEAKNESSES & GROWTH ITEMS IN TRACKER:
{growth_text}

CANDIDATE'S APPLICATION PIPELINE:
{apps_text}

OUTPUT FORMAT RULES:
- Provide supportive, motivational, conversational feedback in friendly Markdown.
- If the conversation reveals concrete skill blindspots or takeaways from this interview, add a structured JSON block at the very end of your reply inside a ```GROWTH_EXTRACT code block so the platform can automatically log it for the candidate:

```GROWTH_EXTRACT
[
  {{
    "title": "Concise Weakness / Gap Title",
    "category": "Technical Skills | System Design | Behavioral & Soft Skills | Resume & Portfolio | Interview Mindset",
    "reflection": "What tripped the candidate up in the interview",
    "action_plan": "Concrete practice step, algorithm to drill, or resource to study"
  }}
]
```
Keep the reply natural, motivating, and focused on helping them win.
"""


def extract_growth_blocks(text: str) -> tuple[str, list[dict[str, Any]]]:
    """Extract ```GROWTH_EXTRACT [...] ``` JSON blocks from the response text."""
    pattern = r"```GROWTH_EXTRACT\s*([\s\S]*?)\s*```"
    match = re.search(pattern, text)
    extracted: list[dict[str, Any]] = []

    if match:
        raw_json = match.group(1).strip()
        try:
            parsed = json.loads(raw_json)
            if isinstance(parsed, list):
                extracted = parsed
            elif isinstance(parsed, dict):
                extracted = [parsed]
        except Exception:
            logger.warning("Could not parse GROWTH_EXTRACT block as JSON: %s", raw_json[:200])

        clean_text = re.sub(pattern, "", text).strip()
    else:
        clean_text = text.strip()

    return clean_text, extracted


def call_gemini_chat(
    messages: list[dict[str, str]],
    system_prompt: str,
    api_key: str | None = None,
) -> tuple[str, list[dict[str, Any]], str]:
    """Call Google Gemini 2.5 Flash API with multi-turn conversation and fallback sequence.

    Returns:
        (assistant_reply, extracted_growth_items, model_used)
    """
    key = get_effective_api_key(api_key)
    if not key:
        return _fallback_mentor_reply(messages)

    # Format contents for Gemini REST API
    contents: list[dict[str, Any]] = []
    for msg in messages:
        role = "user" if msg.get("role") == "user" else "model"
        text = msg.get("content", "").strip()
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})

    if not contents:
        contents = [{"role": "user", "parts": [{"text": "Hello, I want to debrief my recent interview."}]}]

    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": contents,
        "generationConfig": {
            "temperature": 0.7,
            "maxOutputTokens": 2048,
        },
    }

    # Deduplicate candidate models
    models_to_try = []
    for m in FALLBACK_MODELS:
        if m and m not in models_to_try:
            models_to_try.append(m)

    last_error: Exception | None = None
    for model_name in models_to_try:
        url = f"{GEMINI_API_BASE}/{model_name}:generateContent?key={key}"
        try:
            resp = requests.post(url, json=payload, headers={"Content-Type": "application/json"}, timeout=30)
            if resp.status_code == 200:
                data = resp.json()
                candidates = data.get("candidates", [])
                if candidates:
                    parts = candidates[0].get("content", {}).get("parts", [])
                    reply_text = "".join(p.get("text", "") for p in parts)
                    clean_reply, growth_items = extract_growth_blocks(reply_text)
                    return clean_reply, growth_items, model_name
            elif resp.status_code == 404:
                # Model name not supported in this region/key tier, try next
                logger.info("Model %s returned 404, attempting fallback...", model_name)
                continue
            else:
                err_text = resp.text[:400]
                logger.warning("Gemini %s returned status %d: %s", model_name, resp.status_code, err_text)
                last_error = RuntimeError(f"Gemini API returned {resp.status_code}: {err_text}")
        except Exception as exc:
            logger.exception("Error calling Gemini model %s", model_name)
            last_error = exc

    # If all models failed or key had invalid permissions, fall back to offline mentor mode
    logger.warning("All Gemini models failed, falling back to built-in mentor mode. Last error: %s", last_error)
    reply, items, model = _fallback_mentor_reply(messages)
    warning_note = (
        f"\n\n> *Note: Connected with built-in mentor mode. To enable real-time Gemini 2.5 Flash intelligence, "
        f"please check your free Gemini API key in settings or backend/.env.*"
    )
    return reply + warning_note, items, "mentor-fallback"


def _fallback_mentor_reply(messages: list[dict[str, str]]) -> tuple[str, list[dict[str, Any]], str]:
    """Built-in inspirational career coach response when API key is not yet configured."""
    last_user_msg = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user_msg = m.get("content", "").lower()
            break

    if "target" in last_user_msg or "what next" in last_user_msg or "what should i" in last_user_msg:
        reply = (
            "### 🎯 What You Should Target Next\n\n"
            "Here is your personalized high-impact game plan:\n\n"
            "1. **Core Problem-Solving & Algorithmic Patterns:**\n"
            "   - Focus on graph traversals (BFS/DFS, Topological Sort) and dynamic programming subproblems.\n"
            "   - Practice explaining your thought process out loud before writing any code.\n\n"
            "2. **System Design & Trade-Offs:**\n"
            "   - Drill distributed caching patterns (Cache-Aside vs. Write-Through) and database indexing.\n"
            "   - Practice drawing high-level architectures under 15 minutes.\n\n"
            "3. **Behavioral Alignment:**\n"
            "   - Prepare 3 solid STAR stories demonstrating resilience, cross-functional collaboration, and technical leadership.\n\n"
            "**Remember:** Every interview you go through is data, not defeat. Everything is a learning until you win. "
            "Stay patient, keep consistent, and you will achieve big things!"
        )
        return reply, [], "mentor-fallback"

    if "reject" in last_user_msg or "failed" in last_user_msg or "sad" in last_user_msg:
        reply = (
            "### 💙 Breathe and Reset — You're Closer Than You Think\n\n"
            "First of all, give yourself credit for stepping into the arena. Interviewing at top companies is challenging, "
            "and a single interview never defines your potential or your career.\n\n"
            "**\"Everything is a learning until you win. Be patient to achieve big.\"**\n\n"
            "Let's turn this experience into your biggest competitive advantage:\n"
            "- What specific questions or technical problems did the interviewer ask?\n"
            "- At what point did you feel stuck or hesitant?\n"
            "- Was there any question you wish you answered differently?\n\n"
            "Tell me the details, and together we will break it down step-by-step into a bulletproof growth plan!"
        )
        return reply, [], "mentor-fallback"

    reply = (
        "### 🚀 Welcome to Your Interview Debrief\n\n"
        "I'm here to listen, break down the experience with you, and help you turn every insight into a stepping stone.\n\n"
        "**Tell me about the interview:**\n"
        "1. Which company and role was this for?\n"
        "2. What questions or coding/system challenges were thrown your way?\n"
        "3. How did your explanations feel, and where do you think you can level up?\n\n"
        "Remember: no need to be sad or anxious. Every challenge you dissect today makes your next interview unstoppable!"
    )
    return reply, [], "mentor-fallback"
