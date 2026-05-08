"""
Slide generation route.

POST /api/session/{id}/slide/{n}          — generate slide N via SSE stream
POST /api/session/{id}/slide/{n}/approve  — approve and advance
POST /api/session/{id}/slide/{n}/refine   — refine current slide (Day 2)
"""
import json
import logging
import os
import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session
from models.session import SlideData, OutlineItem
from services.stream_utils import collect_stream, strip_fences, validate_slide_html
from services.context_synthesis import get_relevant_chunks
from prompts.slide import build_slide_prompt, SLIDE_SYSTEM
from prompts.context_update import build_context_update_prompt, CONTEXT_UPDATE_SYSTEM

logger = logging.getLogger("slide")
router = APIRouter()


async def _update_context_in_background(session_id: str, html: str, model_name: str):
    """Update deck context without blocking approve response."""
    try:
        session = get_session(session_id)
        model = get_model(model_name)
        update_prompt = build_context_update_prompt(html, session.deck_context)
        raw_ctx = await collect_stream(
            model,
            [{"role": "user", "content": update_prompt}],
            CONTEXT_UPDATE_SYSTEM
        )
        updated_ctx = json.loads(strip_fences(raw_ctx))
        updated_ctx["synthesis"] = session.deck_context.get("synthesis", {})
        session.deck_context = updated_ctx
        save_session(session)
    except Exception as e:
        logger.warning(f"[{session_id}] background context update failed (non-fatal): {e}")


class ApproveSlideRequest(BaseModel):
    html: str


class ChangeModeRequest(BaseModel):
    mode: str # "plan" | "build"

class ChatRequest(BaseModel):
    message: str
    current_slide_index: int | None = None

class RefineSlideRequest(BaseModel):
    mode: str  # "simplify" | "expand" | "example" | "interactive"
    current_html: str
    instruction: str | None = None


@router.put("/session/{session_id}/mode")
async def change_mode(session_id: str, req: ChangeModeRequest):
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
    
    if req.mode not in ("plan", "build"):
        raise HTTPException(status_code=400, detail="Invalid mode")
    
    session.mode = req.mode
    save_session(session)
    return {"status": "ok", "mode": session.mode}


@router.post("/session/{session_id}/chat")
async def session_chat(session_id: str, req: ChatRequest):
    """
    Plan Mode Chat: Refine metadata/outline based on conversation.
    Returns updated metadata for the deck or specific slide.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    # Allow chat in any mode to enable fluid additions/refinements

    model = get_model(session.text_model)
    
    # System prompt for Plan Mode refinement
    PLAN_SYSTEM = """
    You are the Content Architect for Vapor Deck. 
    Your goal is to refine the slide outline (metadata) based on the user's request.
    
    You can:
    1. UPDATE existing slides (by using their current index).
    2. ADD new slides (by using an index that doesn't exist yet, or appending to the end).
    3. REORDER slides (by shifting their indices).
    
    You MUST output a JSON object with two fields:
    - "updates": An array of slide objects (index, title, intent, key_points, layout_hint).
    - "message": A brief, friendly explanation of what you did (e.g., "I've added a new slide about X and adjusted the flow...").
    
    Example Output:
    {
        "updates": [
            { "index": 8, "title": "New Insights", "intent": "list-points", "key_points": ["A", "B"], "layout_hint": "bullet-list" }
        ],
        "message": "I added a slide for the new insights as requested."
    }
    """
    
    context = {
        "topic": session.topic,
        "outline": [item.model_dump() for item in session.outline],
        "current_slide_index": req.current_slide_index
    }
    
    prompt = f"Current Outline: {json.dumps(context['outline'])}\n\nUser Message: {req.message}"
    
    try:
        raw_response = await collect_stream(
            model,
            [{"role": "user", "content": prompt}],
            PLAN_SYSTEM
        )
        
        data = json.loads(strip_fences(raw_response))
        updates = data.get("updates", [])
        
        # Track which indices we've seen to handle additions vs updates
        existing_indices = {item.index for item in session.outline}
        
        for update in updates:
            idx = update.get("index")
            if idx is None:
                continue
                
            if idx in existing_indices:
                # UPDATE existing
                for item in session.outline:
                    if item.index == idx:
                        if "title" in update: item.title = str(update["title"])
                        if "intent" in update: item.intent = str(update["intent"])
                        if "key_points" in update: item.key_points = list(update["key_points"])
                        if "layout_hint" in update: item.layout_hint = str(update["layout_hint"])
            else:
                # ADD new slide
                new_item = OutlineItem(
                    index=idx,
                    title=str(update.get("title", "New Slide")),
                    intent=str(update.get("intent", "explain-concept")),
                    key_points=list(update.get("key_points", ["Key point 1"])),
                    layout_hint=str(update.get("layout_hint", "single-column"))
                )
                session.outline.append(new_item)
        
        # Always re-sort and re-number to ensure consistency
        session.outline.sort(key=lambda x: (x.index or 999))
        for i, item in enumerate(session.outline):
            item.index = i + 1
        
        save_session(session)
        return {
            "status": "ok", 
            "session_status": session.status,
            "outline": [item.model_dump() for item in session.outline],
            "message": data.get("message") or "I've updated the outline according to your request. Please review the changes in the sidebar."
        }
        
    except Exception as e:
        import traceback
        logger.error(f"[{session_id}] chat failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/session/{session_id}/slide/{n}")
async def generate_slide(session_id: str, n: int, force: bool = False):
    """
    Generate slide N as an SSE stream of HTML tokens.
    n is 1-indexed (matches outline).
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status not in ("generating", "reviewing"):
        raise HTTPException(
            status_code=400,
            detail=f"Session status is '{session.status}'. Confirm outline first."
        )

    slide_spec = next(
        (item for item in session.outline if item.index == n), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide {n} not found in outline")

    # Check if slide already exists and is approved or has content
    existing = next((s for s in session.slides if s.index == n), None)
    if existing and existing.html and not force:
        logger.info(f"[{session_id}] slide {n} already exists, streaming from cache")
        async def cached_stream():
            safe = existing.html.replace("\n", "\\n")
            yield f"data: {safe}\n\n"
            yield "data: [DONE]\n\n"
        
        return StreamingResponse(
            cached_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        model = get_model(session.text_model)

        relevant = get_relevant_chunks(
            session,
            slide_intent=f"{slide_spec.title} {' '.join(slide_spec.key_points)}",
            max_tokens=1500,
        )

        prompt = build_slide_prompt(
            n=n,
            total=len(session.outline),
            title=slide_spec.title,
            intent=slide_spec.intent,
            key_points=slide_spec.key_points,
            layout_hint=slide_spec.layout_hint,
            theme=session.theme,
            deck_context=session.deck_context,
            relevant_chunks=relevant,
        )

        if os.getenv("DEBUG_PROMPTS", "0") == "1":
            os.makedirs("debug", exist_ok=True)
            with open(f"debug/slide_{n}_prompt_{session_id[:8]}.txt", "w") as f:
                f.write(prompt)

        logger.info(f"[{session_id}] generating slide {n}: '{slide_spec.title}'")

        _model = model
        _prompt = prompt

        async def event_stream():
            try:
                async for token in _model.stream_text(
                    [{"role": "user", "content": _prompt}],
                    SLIDE_SYSTEM,
                ):
                    if token:
                        # Standard flat SSE
                        yield f"data: {token}\n\n"
                
                yield "data: [DONE]\n\n"
            except Exception as e:
                import traceback
                traceback.print_exc()
                yield f"data: [ERROR] {str(e)}\n\n"

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
            },
        )

    except Exception as e:
        logger.error(f"[{session_id}] slide {n} generation failed: {type(e).__name__}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Slide generation failed: {str(e)}")


@router.post("/session/{session_id}/slide/{n}/approve")
async def approve_slide(session_id: str, n: int, req: ApproveSlideRequest):
    """
    Approve slide N. Updates deck_context and advances current_index.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    slide_spec = next(
        (item for item in session.outline if item.index == n), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide {n} not found in outline")

    if not validate_slide_html(req.html):
        raise HTTPException(
            status_code=400,
            detail="HTML does not appear to contain a valid slide section"
        )

    slide_data = SlideData(
        index=n,
        title=slide_spec.title,
        html=req.html,
        approved=True,
    )
    existing = next((s for s in session.slides if s.index == n), None)
    if existing:
        session.slides = [s if s.index != n else slide_data for s in session.slides]
    else:
        session.slides.append(slide_data)

    session.current_index = n
    is_done = n >= len(session.outline)
    session.status = "done" if is_done else "generating"
    save_session(session)
    asyncio.create_task(_update_context_in_background(session_id, req.html, session.text_model))

    # Save individual HTML and JSON files for convenience
    try:
        from store.sessions import get_project_dir
        slide_filename = f"slide_{n:02d}.html"
        slide_path = get_project_dir() / "slides" / slide_filename
        with open(slide_path, "w", encoding="utf-8") as f:
            f.write(req.html)
        
        json_filename = f"slide_{n:02d}.json"
        json_path = get_project_dir() / "slides" / json_filename
        with open(json_path, "w", encoding="utf-8") as f:
            try:
                f.write(slide_data.model_dump_json(indent=2))
            except AttributeError:
                f.write(slide_data.json(indent=2))

        logger.info(f"[{session_id}] slide {n} files saved to {slide_path.parent}")
    except Exception as e:
        logger.error(f"[{session_id}] failed to save slide {n} files: {e}")

    logger.info(
        f"[{session_id}] slide {n} approved. "
        f"{'Done!' if is_done else f'Next: slide {n+1}'}"
    )

    return {
        "status": "approved",
        "slide_index": n,
        "next_index": n + 1 if not is_done else None,
        "is_done": is_done,
    }


@router.post("/session/{session_id}/slide/{n}/refine")
async def refine_slide(session_id: str, n: int, req: RefineSlideRequest):
    """
    Refine slide N with a specific mode. Returns SSE stream.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    valid_modes = {"simplify", "expand", "example", "interactive"}
    if req.mode not in valid_modes:
        raise HTTPException(status_code=400, detail=f"mode must be one of: {valid_modes}")

    slide_spec = next(
        (item for item in session.outline if item.index == n), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide {n} not found")

    from models.session import SlideData
    slide_data = next((s for s in session.slides if s.index == n), None)
    if not slide_data:
        slide_data = SlideData(
            index=n,
            title=slide_spec.title,
            html=req.current_html or "",
            status="refining"
        )
        session.slides.append(slide_data)
        
    if req.instruction and req.instruction.strip():
        slide_data.refinements.append(req.instruction.strip())
        save_session(session)

    MODE_INSTRUCTIONS = {
        "simplify": "Make this slide SIMPLER. Fewer words, fewer elements. Keep only the most essential point.",
        "expand": "Expand this slide. Add more detail, more explanation, or a deeper example.",
        "example": "Add a concrete real-world example to this slide. Make it the centerpiece.",
        "interactive": "Make this slide interactive. Add tabs, toggles, or hover reveals using vanilla JS.",
    }

    model = get_model(session.text_model)
    relevant = get_relevant_chunks(
        session,
        slide_intent=f"{slide_spec.title} {' '.join(slide_spec.key_points)} {req.instruction or ''}",
        max_tokens=1500,
    )

    prompt = build_slide_prompt(
        n=n,
        total=len(session.outline),
        title=slide_spec.title,
        intent=slide_spec.intent,
        key_points=slide_spec.key_points,
        layout_hint=slide_spec.layout_hint,
        theme=session.theme,
        deck_context=session.deck_context,
        relevant_chunks=relevant,
    )

    if req.current_html:
        prompt += f"\n\n=== CURRENT SLIDE HTML ===\n{req.current_html}\n"

    if slide_data.refinements:
        prompt += "\n=== PREVIOUS USER REFINEMENTS (DO NOT REVERT THESE) ===\n"
        for i, ref in enumerate(slide_data.refinements[:-1] if req.instruction else slide_data.refinements, 1):
            prompt += f"{i}. {ref}\n"

    prompt += f"\n=== REFINEMENT INSTRUCTION ===\n{MODE_INSTRUCTIONS.get(req.mode, 'Refine the slide.')}"

    if req.instruction and req.instruction.strip():
        prompt += f"\nAdditional user instruction: {req.instruction.strip()}"

    prompt += "\n\nCRITICAL: Your task is to modify the provided CURRENT SLIDE HTML. You MUST preserve the existing structural design, layout, background elements (like grids and glows), and ALL Previous User Refinements listed above, unless the current instruction explicitly asks you to change them. Return ONLY the modified HTML block."

    logger.info(f"[{session_id}] refining slide {n} mode={req.mode}")

    _model = model
    _prompt = prompt

    async def event_stream():
        try:
            async for token in _model.stream_text(
                [{"role": "user", "content": _prompt}],
                SLIDE_SYSTEM,
            ):
                if token:
                    yield f"data: {token}\n\n"
            
            yield "data: [DONE]\n\n"
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: [ERROR] {str(e)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )