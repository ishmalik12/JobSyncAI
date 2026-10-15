"""Password hashing and database-backed short-lived bearer sessions."""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import Header, HTTPException
from pwdlib import PasswordHash

from config import JWT_EXPIRE_MINUTES, JWT_SECRET_KEY
from database import get_database

password_hash = PasswordHash.recommended()
ALGORITHM = "HS256"


def _secret() -> str:
    if len(JWT_SECRET_KEY) < 32:
        raise HTTPException(status_code=503, detail="Set JWT_SECRET_KEY to at least 32 characters in backend/.env.")
    return JWT_SECRET_KEY


def validate_auth_config() -> None:
    _secret()


def hash_password(password: str) -> str:
    if len(password) < 10:
        raise HTTPException(status_code=422, detail="Password must contain at least 10 characters.")
    return password_hash.hash(password)


def verify_password(password: str, encoded: str) -> bool:
    try:
        return password_hash.verify(password, encoded)
    except Exception:
        return False


def create_session(user_id: str) -> str:
    now = datetime.now(timezone.utc)
    expires = now + timedelta(minutes=JWT_EXPIRE_MINUTES)
    token_id = secrets.token_urlsafe(24)
    token = jwt.encode({"sub": user_id, "jti": token_id, "iat": now, "exp": expires}, _secret(), algorithm=ALGORITHM)
    get_database().auth_sessions.insert_one({"jti": token_id, "user_id": user_id, "expires_at": expires})
    return token


def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Sign in to continue.", headers={"WWW-Authenticate": "Bearer"})
    try:
        claims = jwt.decode(authorization[7:], _secret(), algorithms=[ALGORITHM])
    except HTTPException:
        raise
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Your session is invalid or expired. Sign in again.", headers={"WWW-Authenticate": "Bearer"})
    try:
        db = get_database()
        session = db.auth_sessions.find_one({"jti": claims["jti"], "user_id": claims["sub"]})
        user = db.users.find_one({"_id": claims["sub"]})
        if not session or not user:
            raise HTTPException(status_code=401, detail="Your session has ended. Sign in again.", headers={"WWW-Authenticate": "Bearer"})
        return {"id": str(user["_id"]), "email": user["email"], "name": user.get("name", "")}
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(status_code=503, detail="Authentication storage is temporarily unavailable.")


def revoke_session(authorization: str | None) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        return
    try:
        claims = jwt.decode(authorization[7:], _secret(), algorithms=[ALGORITHM])
        get_database().auth_sessions.delete_one({"jti": claims["jti"], "user_id": claims["sub"]})
    except Exception:
        return
