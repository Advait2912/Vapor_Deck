from models.session import DeckSession

# Simple in-memory store. Replace with Redis or SQLite on Day 5 if needed.
sessions: dict[str, DeckSession] = {}


def get_session(session_id: str) -> DeckSession:
    if session_id not in sessions:
        raise KeyError(f"Session '{session_id}' not found")
    return sessions[session_id]


def save_session(session: DeckSession) -> None:
    sessions[session.session_id] = session


def delete_session(session_id: str) -> None:
    sessions.pop(session_id, None)


def list_sessions() -> list[str]:
    return list(sessions.keys())
