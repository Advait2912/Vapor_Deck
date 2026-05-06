import os
import json
from pathlib import Path
from models.session import DeckSession

def get_project_dir() -> Path:
    return Path(os.getenv("VAPOR_PROJECT_DIR", "."))

def get_session_path() -> Path:
    return get_project_dir() / "vapor_deck.json"

# In-memory cache
sessions: dict[str, DeckSession] = {}

def _serialize(session: DeckSession) -> str:
    """Serialize a session to pretty-printed JSON (Pydantic v1 & v2 compatible)."""
    try:
        # Pydantic v2
        return session.model_dump_json(indent=2)
    except AttributeError:
        # Pydantic v1 fallback
        return session.json(indent=2)

def get_session(session_id: str) -> DeckSession:
    # 1. In-memory cache hit
    if session_id in sessions:
        return sessions[session_id]

    # 2. Load from project file
    path = get_session_path()
    if path.exists():
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("session_id") == session_id:
            session = DeckSession(**data)
            sessions[session_id] = session
            return session

    raise KeyError(f"Session '{session_id}' not found")

def save_session(session: DeckSession) -> None:
    sessions[session.session_id] = session

    # Ensure project structure exists
    project_dir = get_project_dir()
    (project_dir / "slides").mkdir(parents=True, exist_ok=True)
    (project_dir / "assets").mkdir(parents=True, exist_ok=True)

    path = get_session_path()
    with open(path, "w", encoding="utf-8") as f:
        f.write(_serialize(session))

def delete_session(session_id: str) -> None:
    sessions.pop(session_id, None)
    project_dir = get_project_dir()
    
    # 1. Remove main state file
    path = get_session_path()
    if path.exists():
        os.remove(path)
    
    # 2. Clear slides directory (metadata and HTML)
    slides_dir = project_dir / "slides"
    if slides_dir.exists():
        import shutil
        for item in slides_dir.iterdir():
            if item.is_file():
                os.remove(item)
            elif item.is_dir():
                shutil.rmtree(item)

def list_sessions() -> list[str]:
    """Return all known session IDs (from file + memory)."""
    ids = set(sessions.keys())
    path = get_session_path()
    if path.exists():
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if sid := data.get("session_id"):
                ids.add(sid)
        except (json.JSONDecodeError, OSError):
            pass
    return list(ids)
