"""
Session route.

POST /api/session             — create a new session
POST /api/session/{id}/synthesize — process all inputs → deck_context
POST /api/session/{id}/outline    — generate outline from deck_context
POST /api/session/{id}/confirm    — confirm (possibly edited) outline, mark ready
GET  /api/session/{id}            — get session status
"""
import json
import logging
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai.router import get_model
from models.session import DeckSession, OutlineItem
from store.sessions import sessions, get_session, save_session
from services.stream_utils import collect_stream, strip_fences
from services.context_synthesis import synthesize_context
from prompts.outline import build_outline_prompt, OUTLINE_SYSTEM
from prompts.context_update import initial_deck_context

logger = logging.getLogger("session")
router = APIRouter()


# ── Request models ─────────────────────────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    text_model: str = "google/gemini-2.0-flash"
    vision_model: str = "google/gemini-2.0-flash"
    theme: str = "dark-tech"


class ConfirmOutlineRequest(BaseModel):
    outline: list[OutlineItem]


# ── Routes ─────────────────────────────────────────────────────────────────────

@router.post("/session")
async def create_session(req: CreateSessionRequest):
    """
    Create a new session. Returns session_id.
    Upload inputs next via POST /session/{id}/upload or /upload/text.
    """
    session = DeckSession(
        text_model=req.text_model,
        vision_model=req.vision_model,
        theme=req.theme,
        status="idle",
    )
    save_session(session)
    logger.info(f"[{session.session_id}] session created: model={req.text_model} theme={req.theme}")

    return {
        "session_id": session.session_id,
        "status": session.status,
        "text_model": session.text_model,
        "vision_model": session.vision_model,
        "theme": session.theme,
    }


@router.post("/session/{session_id}/synthesize")
async def synthesize(session_id: str):
    """
    Process all uploaded InputUnits into a structured deck_context.
    Must be called after all inputs are uploaded and before outline generation.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.input_units:
        raise HTTPException(
            status_code=400,
            detail="No inputs uploaded yet. Use POST /session/{id}/upload/text or /upload first."
        )

    session.status = "synthesizing"
    save_session(session)

    model = get_model(session.text_model)

    try:
        ctx = await synthesize_context(session, model)
    except Exception as e:
        logger.error(f"[{session_id}] synthesis failed: {e}")
        raise HTTPException(status_code=500, detail=f"Context synthesis failed: {e}")

    session.deck_context = ctx
    session.topic = ctx.get("topic", "")
    session.hard_constraints = ctx.get("hard_constraints", [])
    session.derived_color_palette = ctx.get("style_intent", {}).get("extracted_palette", [])
    session.derived_font_hints = ctx.get("style_intent", {}).get("extracted_fonts", [])
    session.status = "synthesized"
    save_session(session)

    logger.info(
        f"[{session_id}] synthesized: topic='{session.topic}' "
        f"constraints={len(session.hard_constraints)} "
        f"units={len(session.input_units)}"
    )

    return {
        "status": "ok",
        "context_summary": {
            "topic": session.topic,
            "audience": ctx.get("audience"),
            "tone": ctx.get("tone"),
            "key_themes": ctx.get("key_themes", []),
            "constraints": len(session.hard_constraints),
            "style": ctx.get("style_intent", {}).get("suggested_theme"),
            "units_processed": len(session.input_units),
            "reference_tokens_used": ctx.get("reference_tokens_used", 0),
        },
    }


@router.post("/session/{session_id}/outline")
async def generate_outline(session_id: str):
    """
    Generate the slide outline from the synthesized deck_context.
    Returns a JSON array of OutlineItem objects.
    Must be called after /synthesize.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status not in ("synthesized", "reviewing_outline"):
        raise HTTPException(
            status_code=400,
            detail=f"Session status is '{session.status}'. Call /synthesize first."
        )

    if not session.deck_context:
        raise HTTPException(status_code=400, detail="No deck_context found. Call /synthesize first.")

    session.status = "outlining"
    save_session(session)

    model = get_model(session.text_model)
    prompt = build_outline_prompt(session.deck_context, session.theme)

    # Debug: dump prompt to disk
    if os.getenv("DEBUG_PROMPTS", "0") == "1":
        os.makedirs("debug", exist_ok=True)
        with open(f"debug/outline_prompt_{session_id[:8]}.txt", "w") as f:
            f.write(prompt)

    raw_outline = await collect_stream(
        model,
        [{"role": "user", "content": prompt}],
        OUTLINE_SYSTEM,
    )

    # Debug: dump response to disk
    if os.getenv("DEBUG_PROMPTS", "0") == "1":
        with open(f"debug/outline_response_{session_id[:8]}.txt", "w") as f:
            f.write(raw_outline)

    logger.info(f"[{session_id}] raw outline length: {len(raw_outline)} chars")

    try:
        cleaned = strip_fences(raw_outline)
        outline_data = json.loads(cleaned)
        session.outline = [OutlineItem(**item) for item in outline_data]
    except Exception as e:
        logger.error(f"[{session_id}] outline parse failed: {e}\nRaw: {raw_outline[:500]}")
        raise HTTPException(
            status_code=500,
            detail=f"Outline JSON parse failed: {e}. Check debug/ directory if DEBUG_PROMPTS=1."
        )

    session.status = "reviewing_outline"
    save_session(session)

    logger.info(f"[{session_id}] outline ready: {len(session.outline)} slides")

    return {
        "session_id": session_id,
        "topic": session.topic,
        "outline": [item.model_dump() for item in session.outline],
        "total_slides": len(session.outline),
    }


@router.post("/session/{session_id}/confirm")
async def confirm_outline(session_id: str, req: ConfirmOutlineRequest):
    """
    Confirm the outline (possibly edited by the user) and mark session ready for generation.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    session.outline = req.outline
    session.current_index = 0

    # Initialize the deck_context memory structure
    ctx = session.deck_context
    session.deck_context = initial_deck_context(
        topic=session.topic,
        theme=session.theme,
        total_slides=len(session.outline),
        audience=ctx.get("audience", "general"),
        tone=ctx.get("tone", "professional"),
    )
    # Preserve the synthesized context fields (key_themes, key_facts etc.) under a separate key
    session.deck_context["synthesis"] = ctx

    session.status = "generating"
    save_session(session)

    logger.info(f"[{session_id}] outline confirmed: {len(session.outline)} slides, generation ready")

    return {
        "status": "ready",
        "total_slides": len(session.outline),
        "first_slide": session.outline[0].model_dump() if session.outline else None,
    }


@router.get("/session/{session_id}")
async def get_session_status(session_id: str):
    """Get the current status and summary of a session."""
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id": session_id,
        "status": session.status,
        "topic": session.topic,
        "theme": session.theme,
        "text_model": session.text_model,
        "vision_model": session.vision_model,
        "input_units": len(session.input_units),
        "outline_slides": len(session.outline),
        "approved_slides": len([s for s in session.slides if s.approved]),
        "current_index": session.current_index,
        "hard_constraints": session.hard_constraints,
    }
