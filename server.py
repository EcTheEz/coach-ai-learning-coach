"""Coach AI local web app: stdlib HTTP server, SQLite accounts, and Gemini proxy."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.request
from datetime import date
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("COACH_DB_PATH", str(ROOT / "coachai.sqlite3"))).resolve()


def load_dotenv() -> None:
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_dotenv()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys = ON")
    return db


def init_db() -> None:
    with connect() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS assignments (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            title TEXT NOT NULL,
            subject TEXT NOT NULL DEFAULT '',
            due TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'medium',
            duration TEXT NOT NULL DEFAULT '30 min',
            notes TEXT NOT NULL DEFAULT '',
            done INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS assignments_user_due ON assignments(user_id, due);
        CREATE TABLE IF NOT EXISTS user_state (
            user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            data TEXT NOT NULL DEFAULT '{}'
        );
        """)


def password_digest(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    hashed = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310_000)
    return f"{salt.hex()}:{hashed.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        salt_hex, digest_hex = stored.split(":", 1)
        return hmac.compare_digest(password_digest(password, bytes.fromhex(salt_hex)), f"{salt_hex}:{digest_hex}")
    except (ValueError, TypeError):
        return False


class Handler(SimpleHTTPRequestHandler):
    server_version = "CoachAI/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, status: int, payload: dict, headers: dict | None = None) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def body(self) -> dict:
        size = int(self.headers.get("Content-Length", "0"))
        if size > 32_000:
            raise ValueError("Request is too large.")
        try:
            value = json.loads(self.rfile.read(size) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Send valid JSON.")
        if not isinstance(value, dict):
            raise ValueError("Send a JSON object.")
        return value

    def session_user(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("coach_session")
        if not morsel:
            return None
        token_hash = hashlib.sha256(morsel.value.encode()).hexdigest()
        with connect() as db:
            return db.execute("""SELECT users.id, users.email FROM sessions
                JOIN users ON users.id=sessions.user_id
                WHERE sessions.token_hash=? AND sessions.expires_at>?""",
                (token_hash, int(time.time()))).fetchone()

    def require_user(self):
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Please sign in to continue."})
        return user

    def do_GET(self):
        if self.path == "/api/me":
            user = self.session_user()
            if not user:
                return self.send_json(200, {"user": None})
            with connect() as db:
                rows = db.execute("SELECT * FROM assignments WHERE user_id=? ORDER BY due, created_at", (user["id"],)).fetchall()
                state = db.execute("SELECT data FROM user_state WHERE user_id=?", (user["id"],)).fetchone()
            return self.send_json(200, {"user": {"email": user["email"]}, "assignments": [dict(r) | {"done": bool(r["done"])} for r in rows], "state": json.loads(state["data"]) if state else {}})
        if self.path.startswith("/api/"):
            return self.send_json(404, {"error": "Unknown API route."})
        parts = [p for p in unquote(urlsplit(self.path).path).split("/") if p]
        if any(p.startswith(".") or p == "coachai.sqlite3" or p.startswith("coachai.sqlite3-") for p in parts):
            return self.send_error(404)
        return super().do_GET()

    def do_POST(self):
        try:
            data = self.body()
            if self.path == "/api/signup":
                return self.signup(data)
            if self.path == "/api/login":
                return self.login(data)
            if self.path == "/api/logout":
                return self.logout()
            if self.path == "/api/assignments":
                return self.save_assignment(data)
            if self.path == "/api/assignments/delete":
                return self.delete_assignment(data)
            if self.path == "/api/state":
                return self.save_state(data)
            if self.path == "/api/coach":
                return self.ask_coach(data)
            return self.send_json(404, {"error": "Unknown API route."})
        except ValueError as exc:
            return self.send_json(400, {"error": str(exc)})

    def signup(self, data):
        email = str(data.get("email", "")).strip().lower()
        password = str(data.get("password", ""))
        if len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            return self.send_json(400, {"error": "Enter a valid email address."})
        if len(password) < 10 or len(password) > 200:
            return self.send_json(400, {"error": "Use a password with at least 10 characters."})
        try:
            with connect() as db:
                cur = db.execute("INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)", (email, password_digest(password), int(time.time())))
                db.execute("INSERT INTO user_state(user_id,data) VALUES(?,?)", (cur.lastrowid, "{}"))
                user_id = cur.lastrowid
        except sqlite3.IntegrityError:
            return self.send_json(409, {"error": "An account with that email already exists. Sign in instead."})
        return self.create_session(user_id, email)

    def login(self, data):
        email, password = str(data.get("email", "")).strip().lower(), str(data.get("password", ""))
        with connect() as db:
            user = db.execute("SELECT id,email,password_hash FROM users WHERE email=?", (email,)).fetchone()
        if not user or not verify_password(password, user["password_hash"]):
            return self.send_json(401, {"error": "Email and password don't match."})
        return self.create_session(user["id"], user["email"])

    def create_session(self, user_id, email):
        token = secrets.token_urlsafe(32)
        expires = int(time.time()) + 60 * 60 * 24 * 30
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with connect() as db:
            db.execute("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", (token_hash, user_id, expires))
        cookie = f"coach_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000" + ("; Secure" if os.environ.get("COACH_SECURE_COOKIE") == "1" else "")
        return self.send_json(200, {"user": {"email": email}}, {"Set-Cookie": cookie})

    def logout(self):
        cookie = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookie.get("coach_session")
        if morsel:
            token_hash = hashlib.sha256(morsel.value.encode()).hexdigest()
            with connect() as db:
                db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))
        return self.send_json(200, {"ok": True}, {"Set-Cookie": "coach_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"})

    def save_assignment(self, data):
        user = self.require_user()
        if not user:
            return
        task_id = str(data.get("id", ""))[:80]
        title = str(data.get("title", "")).strip()[:90]
        due = str(data.get("due", ""))
        try:
            date.fromisoformat(due)
            valid_due = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", due))
        except ValueError:
            valid_due = False
        if not task_id or not title or not valid_due:
            return self.send_json(400, {"error": "A title and valid due date are required."})
        priority = data.get("priority") if data.get("priority") in ("high", "medium", "low") else "medium"
        with connect() as db:
            db.execute("""INSERT INTO assignments(id,user_id,title,subject,due,priority,duration,notes,done,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,subject=excluded.subject,
                due=excluded.due,priority=excluded.priority,duration=excluded.duration,notes=excluded.notes,done=excluded.done
                WHERE assignments.user_id=excluded.user_id""",
                (task_id,user["id"],title,str(data.get("subject",""))[:60],due,priority,str(data.get("duration","30 min"))[:20],str(data.get("notes",""))[:300],int(bool(data.get("done"))),int(time.time())))
        return self.send_json(200, {"ok": True})

    def delete_assignment(self, data):
        user = self.require_user()
        if not user:
            return
        with connect() as db:
            db.execute("DELETE FROM assignments WHERE id=? AND user_id=?", (str(data.get("id", ""))[:80], user["id"]))
        return self.send_json(200, {"ok": True})

    def save_state(self, data):
        user = self.require_user()
        if not user:
            return
        state = data.get("state")
        if not isinstance(state, dict):
            return self.send_json(400, {"error": "State must be an object."})
        with connect() as db:
            db.execute("INSERT INTO user_state(user_id,data) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET data=excluded.data", (user["id"], json.dumps(state)[:12000]))
        return self.send_json(200, {"ok": True})

    def ask_coach(self, data):
        user = self.require_user()
        if not user:
            return
        api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not api_key or api_key == "paste_your_key_here":
            return self.send_json(503, {"error": "The coach AI isn't configured yet. Add GEMINI_API_KEY to your .env file and restart the server."})
        question = str(data.get("message", "")).strip()[:3000]
        if not question:
            return self.send_json(400, {"error": "Write a question for your coach first."})
        context = str(data.get("context", ""))[:2500]
        model = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
        payload = {"system_instruction": {"parts": [{"text": "You are Coach AI, a warm, practical personal learning coach for a student. Help the student understand rather than simply giving answers. Be concise, ask one useful follow-up when it helps, and adapt to their goal and current work. Distinguish known facts from guesses. Never claim to have updated their saved progress."}]}, "contents": [{"role": "user", "parts": [{"text": f"Student context: {context or 'No extra context supplied.'}\n\nStudent message: {question}"}]}], "generationConfig": {"temperature": 0.6, "maxOutputTokens": 700}}
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": api_key}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=40) as response:
                result = json.loads(response.read().decode())
            parts = result.get("candidates", [{}])[0].get("content", {}).get("parts", [])
            answer = "\n".join(p.get("text", "") for p in parts if p.get("text"))
            if not answer:
                return self.send_json(502, {"error": "The AI returned an empty response. Try again."})
            return self.send_json(200, {"answer": answer, "model": model})
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")[:800]
            print(f"Gemini HTTP {exc.code}: {detail}")
            message = "The Gemini API rejected the request. Check your key, model, and API access in .env."
            return self.send_json(502, {"error": message})
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            print(f"Gemini request failed: {exc}")
            return self.send_json(502, {"error": "Couldn't reach Gemini just now. Check the server's internet connection and try again."})


if __name__ == "__main__":
    init_db()
    host = os.environ.get("COACH_HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    print(f"Coach AI running at http://{host}:{port}")
    ThreadingHTTPServer((host, port), Handler).serve_forever()
