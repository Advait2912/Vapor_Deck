"""
Session route — UPDATED with global deck control endpoints.

Added routes:
  PUT /api/session/{id}/deck-settings  — tone, audience, narrative structure
  POST /api/session/{id}/outline/reorder — reorder slides (non-destructive)
  POST /api/session/{id}/outline/add    — add a new slide to outline
  DELETE /api/session/{id}/outline/{n}  — remove a slide (only if not built)

All existing routes preserved exactly as-is.
"""
import json
import logging
import os

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai.router import get_model
from models.session import DeckSession, OutlineItem
from store.sessions import sessions, get_session, save_session, delete_session
from services.stream_utils import collect_stream, strip_fences
from services.context_synthesis import synthesize_context
from prompts.outline import build_outline_prompt, build_multimodal_outline_prompt, OUTLINE_SYSTEM
from prompts.context_update import initial_deck_context

logger = logging.getLogger("session")
router = APIRouter()

def sync_session_indices(session: DeckSession):
    """Ensure slide content (HTML) follows the outline's new order using IDs (stable) or titles (fallback)."""
    # Map IDs to new indices
    id_to_new_index = {item.id: item.index for item in session.outline}
    title_to_new_index = {item.title: item.index for item in session.outline}
    
    # Update indices in the slides array
    for slide in session.slides:
        if slide.id in id_to_new_index:
            slide.index = id_to_new_index[slide.id]
        elif slide.title in title_to_new_index:
            # Fallback for old sessions without IDs
            slide.index = title_to_new_index[slide.title]
            # Capture the ID from the outline for future stability
            outline_item = next((it for it in session.outline if it.title == slide.title), None)
            if outline_item:
                slide.id = outline_item.id
    
    # Sort slides by their new indices
    session.slides.sort(key=lambda x: x.index)



# ── Request models ─────────────────────────────────────────────────────────────

class CreateSessionRequest(BaseModel):
    text_model: str = "ollama/gemma4:31b"
    vision_model: str = "ollama/qwen3-vl:32b"
    theme: str = "dark-tech"


class ConfirmOutlineRequest(BaseModel):
    outline: list[OutlineItem]


class DeckSettingsRequest(BaseModel):
    """Global deck settings — tone, audience, narrative structure."""
    tone: str | None = None
    audience: str | None = None
    narrative_structure: str | None = None
    deck_instructions: str | None = None


class UpdateTitleRequest(BaseModel):
    title: str

class ReorderRequest(BaseModel):
    """New slide order as a list of current indices (0-based)."""
    order: list[int]


class AddSlideRequest(BaseModel):
    """New slide to insert into the outline."""
    title: str
    intent: str = "explain-concept"
    key_points: list[str] = []
    layout_hint: str = "single-column"
    insert_at: int | None = None  # None = append at end


# ── Existing routes (UNCHANGED) ────────────────────────────────────────────────

@router.post("/session")
async def create_session(req: CreateSessionRequest):
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
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.input_units:
        raise HTTPException(status_code=400, detail="No inputs uploaded yet.")

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
    session.status = "synthesized"
    save_session(session)

    return {
        "status": "ok",
        "context_summary": {
            "topic": session.topic,
            "audience": ctx.get("audience"),
            "tone": ctx.get("tone"),
            "key_themes": ctx.get("key_themes", []),
            "constraints": len(session.hard_constraints),
            "units_processed": len(session.input_units),
            "reference_tokens_used": ctx.get("reference_tokens_used", 0),
        },
    }


@router.post("/session/{session_id}/outline")
async def generate_outline(session_id: str, preferred_slides: int = 8):
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status not in ("synthesized", "reviewing_outline"):
        raise HTTPException(status_code=400, detail=f"Call /synthesize first.")

    if not session.deck_context:
        raise HTTPException(status_code=400, detail="No deck_context found.")

    session.status = "outlining"
    save_session(session)

    model = get_model(session.text_model)

    # ── Multimodal routing ───────────────────────────────────────────────────
    # Detect whether the session has uploaded images or documents.
    # Image extensions match those in upload.py IMAGE_EXTS.
    IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "svg"}
    DOC_EXTS   = {"pdf", "docx", "doc"}

    image_units = [
        u for u in session.input_units
        if (u.input_type or "").lower() in IMAGE_EXTS
    ]
    doc_units = [
        u for u in session.input_units
        if (u.input_type or "").lower() in DOC_EXTS
    ]

    has_multimodal = bool(image_units or doc_units)

    if has_multimodal:
        logger.info(
            f"[{session_id}] multimodal outline: "
            f"{len(image_units)} image(s), {len(doc_units)} doc(s)"
        )
        prompt = build_multimodal_outline_prompt(
            session.deck_context,
            session.theme,
            image_units=image_units,
            doc_units=doc_units,
            preferred_slides=preferred_slides,
        )
    else:
        logger.info(f"[{session_id}] standard outline (no images/docs)")
        prompt = build_outline_prompt(session.deck_context, session.theme, preferred_slides)

    if os.getenv("DEBUG_PROMPTS", "0") == "1":
        os.makedirs("debug", exist_ok=True)
        with open(f"debug/outline_prompt_{session_id[:8]}.txt", "w") as f:
            f.write(prompt)

    raw_outline = await collect_stream(
        model,
        [{"role": "user", "content": prompt}],
        OUTLINE_SYSTEM,
    )

    try:
        cleaned = strip_fences(raw_outline)
        if not cleaned.startswith("[") or not cleaned.endswith("]"):
            # Try to find array within the text if model added chatter
            start = cleaned.find("[")
            end = cleaned.rfind("]")
            if start != -1 and end != -1:
                cleaned = cleaned[start:end+1]
        
        # Sanitize: Keep only printable chars and standard whitespace
        sanitized = "".join(c for c in cleaned if c.isprintable() or c in "\n\r\t")
        outline_data = json.loads(sanitized, strict=False)
        # Parse outline items — read assigned_images if present (multimodal path)
        parsed_items = []
        for item in outline_data:
            # assigned_images is optional — defaults to [] for backward compat
            assigned_images = item.pop("assigned_images", []) or []
            outline_item = OutlineItem(**item)
            outline_item.assigned_images = list(assigned_images)
            parsed_items.append(outline_item)
        session.outline = parsed_items
    except Exception as e:
        logger.error(f"[{session_id}] outline parse failed: {e}")
        logger.debug(f"[{session_id}] raw_outline: {raw_outline[:1000]}")
        raise HTTPException(status_code=500, detail=f"Outline JSON parse failed: {e}")

    session.status = "reviewing_outline"
    save_session(session)

    return {
        "session_id": session_id,
        "topic": session.topic,
        "outline": [item.model_dump() for item in session.outline],
        "total_slides": len(session.outline),
    }


@router.post("/session/{session_id}/confirm")
async def confirm_outline(session_id: str, req: ConfirmOutlineRequest):
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    # Smart Merge: Preserve existing IDs if titles match
    existing_items = {item.title: item.id for item in session.outline}
    
    new_outline = []
    for item in req.outline:
        # If the incoming item has no ID or its ID isn't in our current outline,
        # but the title matches an existing item, preserve the old ID.
        if item.title in existing_items:
            item.id = existing_items[item.title]
        new_outline.append(item)
    
    session.outline = new_outline
    session.current_index = 0

    # Build initial deck context (metadata)
    ctx = session.deck_context
    new_ctx = initial_deck_context(
        topic=session.topic,
        theme=session.theme,
        total_slides=len(session.outline),
        audience=ctx.get("audience", "general"),
        tone=ctx.get("tone", "professional"),
    )
    
    # Merge existing synthesis data into the top level to keep it flat
    for k, v in ctx.items():
        if k not in new_ctx:
            new_ctx[k] = v
            
    session.deck_context = new_ctx
    session.status = "generating"
    save_session(session)

    return {
        "status": "ready",
        "total_slides": len(session.outline),
        "first_slide": session.outline[0].model_dump() if session.outline else None,
    }


@router.get("/session/{session_id}")
async def get_session_status(session_id: str):
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


@router.delete("/session/{session_id}")
async def remove_session(session_id: str):
    delete_session(session_id)
    logger.info(f"[{session_id}] session deleted")
    return {"status": "deleted", "session_id": session_id}


# ── NEW: Global Deck Controls ──────────────────────────────────────────────────

@router.put("/session/{session_id}/deck-settings")
async def update_deck_settings(session_id: str, req: DeckSettingsRequest):
    """
    Update global deck settings: tone, audience, narrative structure.

    IMPORTANT:
      These changes update deck_context metadata only.
      They do NOT invalidate or regenerate already-approved slides.
      Only future slide generations will use the new settings.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    changes = {}

    if req.tone is not None:
        if "deck" in session.deck_context:
            session.deck_context["deck"]["tone"] = req.tone
        changes["tone"] = req.tone

    if req.audience is not None:
        if "deck" in session.deck_context:
            session.deck_context["deck"]["audience"] = req.audience
        changes["audience"] = req.audience

    if req.narrative_structure is not None:
        session.deck_context.setdefault("global_settings", {})
        session.deck_context["global_settings"]["narrative_structure"] = req.narrative_structure
        changes["narrative_structure"] = req.narrative_structure

    if req.deck_instructions is not None:
        session.deck_context.setdefault("global_settings", {})
        session.deck_context["global_settings"]["deck_instructions"] = req.deck_instructions
        # Add to hard_constraints so the LLM prompt picks them up
        instruction_marker = f"[GLOBAL INSTRUCTION] {req.deck_instructions}"
        if instruction_marker not in session.hard_constraints:
            session.hard_constraints.append(instruction_marker)
        changes["deck_instructions"] = req.deck_instructions

    save_session(session)
    logger.info(f"[{session_id}] deck settings updated: {changes}")

    return {
        "status": "ok",
        "changes_applied": changes,
        "note": "Changes apply to future slide generations only. Approved slides are unaffected.",
    }


@router.post("/session/{session_id}/outline/add")
async def add_slide_to_outline(session_id: str, req: AddSlideRequest):
    """
    Add a new slide to the outline.
    Can be inserted at a specific position or appended at the end.
    Does NOT affect already-approved slides.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status not in ("reviewing_outline", "generating", "reviewing", "done"):
        raise HTTPException(status_code=400, detail="Can only add slides after outline is generated")

    new_index = req.insert_at if req.insert_at is not None else len(session.outline) + 1

    # Insert at position, re-number everything
    outline_list = [item.model_dump() for item in session.outline]

    new_slide = {
        "index": new_index,
        "title": req.title,
        "intent": req.intent,
        "key_points": req.key_points or ["Key point 1", "Key point 2"],
        "layout_hint": req.layout_hint,
    }

    if req.insert_at is not None:
        # Insert at position (shift everything after)
        insert_pos = req.insert_at - 1  # convert to 0-based
        outline_list.insert(insert_pos, new_slide)
    else:
        outline_list.append(new_slide)

    # Re-number
    for i, item in enumerate(outline_list):
        item["index"] = i + 1

    session.outline = [OutlineItem(**item) for item in outline_list]
    sync_session_indices(session)
    save_session(session)

    logger.info(f"[{session_id}] slide added: '{req.title}' at position {new_index}")

    return {
        "status": "ok",
        "outline": [item.model_dump() for item in session.outline],
        "total_slides": len(session.outline),
        "added_at": new_index,
    }


@router.post("/session/{session_id}/outline/reorder")
async def reorder_outline(session_id: str, req: ReorderRequest):
    """
    Reorder slides by providing a new order of 0-based indices.

    Example:
      Current: [0, 1, 2, 3, 4]
      Request: { "order": [0, 2, 1, 3, 4] } → slides 1 and 2 swap

    SAFETY: Does NOT affect already-approved (built) slides' content.
    The reorder only changes outline metadata — approved HTML is preserved.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if len(req.order) != len(session.outline):
        raise HTTPException(
            status_code=400,
            detail=f"Order length {len(req.order)} doesn't match outline length {len(session.outline)}"
        )

    if set(req.order) != set(range(len(session.outline))):
        raise HTTPException(
            status_code=400,
            detail="Order must contain each index exactly once"
        )

    original_outline = list(session.outline)
    new_outline = [original_outline[i] for i in req.order]

    # Re-number
    for i, item in enumerate(new_outline):
        item.index = i + 1

    session.outline = new_outline
    sync_session_indices(session)
    save_session(session)

    logger.info(f"[{session_id}] outline reordered: {req.order}")

    return {
        "status": "ok",
        "outline": [item.model_dump() for item in session.outline],
        "note": "Approved slide content is preserved. Only ordering metadata changed.",
    }


@router.delete("/session/{session_id}/outline/{n}")
async def remove_slide_from_outline(session_id: str, n: int):
    """
    Remove slide N from the outline (1-indexed).

    SAFETY: Cannot remove a slide that has already been approved (built).
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    slide_index = n - 1  # convert to 0-based for comparison

    # Check if this slide was approved
    is_approved = any(s.index == n for s in session.slides if s.approved)
    if is_approved:
        raise HTTPException(
            status_code=409,
            detail=f"Slide {n} has been approved and cannot be removed. Regenerate it instead."
        )

    original_len = len(session.outline)
    session.outline = [item for item in session.outline if item.index != n]

    if len(session.outline) == original_len:
        raise HTTPException(status_code=404, detail=f"Slide {n} not found in outline")

    # Re-number remaining slides
    for i, item in enumerate(session.outline):
        item.index = i + 1
    
    sync_session_indices(session)
    save_session(session)

    logger.info(f"[{session_id}] slide {n} removed from outline")

    return {
        "status": "ok",
        "outline": [item.model_dump() for item in session.outline],
        "total_slides": len(session.outline),
    }
@router.put("/session/{session_id}/slide/{slide_id}/title")
async def update_slide_title(session_id: str, slide_id: str, req: UpdateTitleRequest):
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
    
    item = next((s for s in session.outline if s.id == slide_id), None)
    if not item:
        raise HTTPException(status_code=404, detail="Slide ID not found")
        
    item.title = req.title
    save_session(session)
    logger.info(f"[{session_id}] slide {slide_id} title updated to: {req.title}")
    return {"status": "ok"}
