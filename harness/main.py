"""
Updated main.py — adds snapshot route registration.
All other functionality preserved exactly as-is.
"""
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

# ── Logging setup ──────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)

# ── Startup key check ──────────────────────────────────────────────────────────
_logger = logging.getLogger("startup")

CHECKED_KEYS = {
    "GOOGLE_API_KEY": "Google Gemini/Gemma provider",
}
for key, label in CHECKED_KEYS.items():
    if not os.getenv(key):
        _logger.warning(f"⚠️  {key} not set — {label} will fail at runtime")

app = FastAPI(
    title="AI Slide Generator",
    version="0.2.0",
    description="Generate interactive web-native slide decks with LLMs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ─────────────────────────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "0.2.0",
        "providers": ["ollama"],
        "features": [
            "sse_streaming",
            "per_slide_lifecycle",
            "comparison_mode",
            "pdf_export",
            "snapshot_audit",   # NEW: Playwright validation pipeline
            "global_controls",  # NEW: Deck-wide orchestration
            "local_controls",   # NEW: Per-slide refinement controls
        ],
    }


@app.get("/api/project")
def get_project_info():
    """Return info about the current working project."""
    return {
        "path": os.getenv("VAPOR_PROJECT_DIR", "No project loaded"),
        "name": os.path.basename(os.getenv("VAPOR_PROJECT_DIR", "Vapor Deck"))
    }

@app.get("/api/session/active")
def get_active_session():
    """Return the currently loaded session in the project directory (always 200)."""
    from store.sessions import list_sessions, get_session
    session_ids = list_sessions()
    if session_ids:
        try:
            session = get_session(session_ids[0])
            try:
                return session.model_dump()
            except AttributeError:
                return session.dict()
        except KeyError:
            pass
    return {"session_id": None}


@app.get("/api/models")
def list_models():
    """List available model strings for the frontend model picker."""
    return {
        "text_models": [
            # {"id": "google/gemini-2.0-flash", "label": "Gemini 2.0 Flash (Google)", "provider": "google"},
            # {"id": "google/gemini-1.5-pro", "label": "Gemini 1.5 Pro (Google)", "provider": "google"},
            # {"id": "google/gemma-4", "label": "Gemma 4 (Google)", "provider": "google"},
            {"id": "ollama/gemma4:31b-cloud", "label": "Gemma 4 31B (cloud)", "provider": "ollama"},
            {"id": "ollama/llama3.1:8b", "label": "Llama 3.1 8B (local)", "provider": "ollama"},
            {"id": "ollama/mistral", "label": "Mistral 7B (local)", "provider": "ollama"},
        ],
        "vision_models": [
            # {"id": "google/gemini-2.0-flash", "label": "Gemini 2.0 Flash (Google)", "provider": "google"},
            # {"id": "google/gemini-1.5-pro", "label": "Gemini 1.5 Pro (Google)", "provider": "google"},
            {"id": "ollama/gemma4:31b-cloud", "label": "Gemma 4 31B (cloud)", "provider": "ollama"},
        ],
    }

# ── Router Inclusion ──────────────────────────────────────────────────────────
from routes.session import router as session_router
from routes.upload import router as upload_router
from routes.slide import router as slide_router
from routes.snapshot import router as snapshot_router  # NEW

app.include_router(session_router, prefix="/api")
app.include_router(upload_router, prefix="/api")
app.include_router(slide_router, prefix="/api")
app.include_router(snapshot_router, prefix="/api")  # NEW: Snapshot & vision audit pipeline
