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

# ── App ────────────────────────────────────────────────────────────────────────
from routes.session import router as session_router
from routes.upload import router as upload_router
from routes.slide import router as slide_router

app = FastAPI(
    title="AI Slide Generator",
    version="0.1.0",
    description="Generate interactive web-native slide decks with LLMs",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",  # Vite dev server
        "http://localhost:3000",
        "http://localhost:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Routes ─────────────────────────────────────────────────────────────────────
app.include_router(session_router, prefix="/api")
app.include_router(upload_router, prefix="/api")
app.include_router(slide_router, prefix="/api")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": "0.1.0",
        "providers": ["google", "ollama"],
    }


@app.get("/api/models")
def list_models():
    """List available model strings for the frontend model picker."""
    return {
        "text_models": [
            {"id": "google/gemini-2.0-flash", "label": "Gemini 2.0 Flash (Google)", "provider": "google"},
            {"id": "google/gemini-1.5-pro", "label": "Gemini 1.5 Pro (Google)", "provider": "google"},
            {"id": "google/gemma-4", "label": "Gemma 4 (Google)", "provider": "google"},
            {"id": "ollama/llama3.1:8b", "label": "Llama 3.1 8B (local)", "provider": "ollama"},
            {"id": "ollama/mistral", "label": "Mistral 7B (local)", "provider": "ollama"},
        ],
        "vision_models": [
            {"id": "google/gemini-2.0-flash", "label": "Gemini 2.0 Flash (Google)", "provider": "google"},
            {"id": "google/gemini-1.5-pro", "label": "Gemini 1.5 Pro (Google)", "provider": "google"},
            {"id": "ollama/llava:13b", "label": "LLaVA 13B (local)", "provider": "ollama"},
        ],
    }
