"""
Slide generation route.

POST /api/session/{id}/slide/{n}          — generate slide N via SSE stream
POST /api/session/{id}/slide/{n}/approve  — approve and advance
POST /api/session/{id}/slide/{n}/refine   — refine current slide (Day 2)
"""
import base64
import json
import logging
import os
import asyncio

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session, get_project_dir
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
        # Flatten synthesis to prevent recursive nesting madness
        old_synthesis = session.deck_context.get("synthesis", {})
        if isinstance(old_synthesis, dict):
            # Merge keys instead of nesting the whole dict
            updated_ctx.update({k: v for k, v in old_synthesis.items() if k not in updated_ctx})
        
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
    
    if req.mode not in ("plan", "build", "design"):
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
    previous_status = session.status
    session.status = "outlining"
    save_session(session)

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
        
        # Smart Merge: Match updates to existing items to preserve IDs
        # 1. Map existing items by title for lookup
        existing_items_by_title = {item.title: item for item in session.outline}
        existing_items_by_index = {item.index: item for item in session.outline}
        
        for update in updates:
            idx = update.get("index")
            title = update.get("title")
            if idx is None: continue

            # Try to find match by title first (most stable bridge when AI reorders)
            target_item = existing_items_by_title.get(title)
            
            # If not found by title, maybe it's an update to an existing index
            if not target_item:
                target_item = existing_items_by_index.get(idx)
            
            if target_item:
                # UPDATE existing: preserve ID, update fields
                if "title" in update: target_item.title = str(update["title"])
                if "intent" in update: target_item.intent = str(update["intent"])
                if "key_points" in update: target_item.key_points = list(update["key_points"])
                if "layout_hint" in update: target_item.layout_hint = str(update["layout_hint"])
                target_item.index = idx  # Update to new suggested index
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
        
        # Build a mapping of titles/IDs to new indices to help sync content
        id_to_new_index = {}
        title_to_new_index = {}
        for i, item in enumerate(session.outline):
            new_idx = i + 1
            id_to_new_index[item.id] = new_idx
            title_to_new_index[item.title] = new_idx
            item.index = new_idx
            
        # Re-sync session.slides indices so content follows the outline
        for slide in session.slides:
            if slide.id in id_to_new_index:
                slide.index = id_to_new_index[slide.id]
            elif slide.title in title_to_new_index:
                slide.index = title_to_new_index[slide.title]
        
        session.status = "reviewing_outline"
        save_session(session)
        return {
            "status": "ok", 
            "session_status": session.status,
            "outline": [item.model_dump() for item in session.outline],
            "message": data.get("message") or "I've updated the outline according to your request. Please review the changes in the sidebar."
        }
        
    except Exception as e:
        session.status = previous_status
        save_session(session)
        import traceback
        logger.error(f"[{session_id}] chat failed: {e}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/session/{session_id}/slide/{slide_id}")
async def generate_slide(session_id: str, slide_id: str, force: bool = False):
    """
    Generate slide by ID as an SSE stream of HTML tokens.
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
        (item for item in session.outline if item.id == slide_id), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide ID {slide_id} not found in outline")

    n = slide_spec.index

    # Check if slide already exists
    existing = next((s for s in session.slides if s.id == slide_id), None)
    
    if existing and existing.html and not force:
        logger.info(f"[{session_id}] slide {n} already exists, streaming from cache")
        async def cached_stream():
            b64_html = base64.b64encode(existing.html.encode("utf-8")).decode("utf-8")
            yield f"data: {b64_html}\n\n"
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

        # Get available local assets
        asset_dir = get_project_dir() / "assets"
        all_asset_filenames = [f.name for f in asset_dir.iterdir() if f.is_file()] if asset_dir.exists() else []

        # Use assigned_images from outline if available (multimodal path);
        # fall back to all assets for text-only sessions or pre-multimodal outlines.
        if slide_spec.assigned_images:
            # Filter to only files that actually exist on disk
            assigned_set = set(slide_spec.assigned_images)
            asset_filenames = [f for f in all_asset_filenames if f in assigned_set]
            logger.info(
                f"[{session_id}] slide {n}: using {len(asset_filenames)} assigned image(s) "
                f"from outline: {asset_filenames}"
            )
        else:
            asset_filenames = all_asset_filenames

        prompt = build_slide_prompt(
            n=n,
            total=len(session.outline),
            title=slide_spec.title,
            intent=slide_spec.intent,
            key_points=slide_spec.key_points,
            layout_hint=slide_spec.layout_hint,
            theme=session.theme,
            deck_context=session.deck_context,
            design_config=session.design_config,
            relevant_chunks=relevant,
            asset_filenames=asset_filenames,
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
                        # Use Base64 to prevent ANY character-level corruption in SSE
                        b64_token = base64.b64encode(token.encode("utf-8")).decode("utf-8")
                        yield f"data: {b64_token}\n\n"
                
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


@router.post("/session/{session_id}/slide/{slide_id}/approve")
async def approve_slide(session_id: str, slide_id: str, req: ApproveSlideRequest):
    """
    Approve slide HTML for slide_id.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    slide_spec = next(
        (item for item in session.outline if item.id == slide_id), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide ID {slide_id} not found")

    n = slide_spec.index
    # Find existing slide data to preserve refinements/metadata
    existing = next((s for s in session.slides if s.id == slide_id), None)
    
    slide_data = SlideData(
        id=slide_id,
        index=n,
        title=slide_spec.title,
        html=req.html,
        status="ready",
        approved=True,
        refinements=existing.refinements if existing else [],
        metadata=existing.metadata if existing else {}
    )

    # Replace existing slide with same ID
    session.slides = [s if s.id != slide_id else slide_data for s in session.slides]
    if not any(s.id == slide_id for s in session.slides):
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

    # Phase 2 — Self-Contained CSS: save a portable standalone version with
    # the theme CSS embedded inline. Written alongside the bare fragment so
    # the file renders correctly when opened outside the Vite dev server.
    try:
        from store.sessions import get_project_dir as _gpd
        from services.theme_compiler import make_standalone_html
        _slides_dir = _gpd() / "slides"
        standalone_html = make_standalone_html(req.html, session.theme)
        with open(_slides_dir / f"slide_{n:02d}_standalone.html", "w", encoding="utf-8") as f:
            f.write(standalone_html)
        logger.info(f"[{session_id}] slide {n} standalone file saved (theme={session.theme})")
    except Exception as e:
        logger.warning(f"[{session_id}] failed to save standalone slide {n}: {e}")

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


@router.post("/session/{session_id}/slide/{slide_id}/refine")
async def refine_slide(session_id: str, slide_id: str, req: RefineSlideRequest):
    """
    Refine slide by ID with a specific mode. Returns SSE stream.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    valid_modes = {"simplify", "expand", "example", "interactive"}
    if req.mode not in valid_modes:
        raise HTTPException(status_code=400, detail=f"mode must be one of: {valid_modes}")

    slide_spec = next(
        (item for item in session.outline if item.id == slide_id), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide ID {slide_id} not found")

    n = slide_spec.index
    from models.session import SlideData
    slide_data = next((s for s in session.slides if s.id == slide_id), None)
    if not slide_data:
        slide_data = SlideData(
            id=slide_spec.id,
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

    # Get available local assets
    asset_dir = get_project_dir() / "assets"
    all_asset_filenames = [f.name for f in asset_dir.iterdir() if f.is_file()] if asset_dir.exists() else []

    # Use assigned_images from outline if available (multimodal path);
    # fall back to all assets for text-only sessions or pre-multimodal outlines.
    if slide_spec.assigned_images:
        assigned_set = set(slide_spec.assigned_images)
        asset_filenames = [f for f in all_asset_filenames if f in assigned_set]
        logger.info(
            f"[{session_id}] refine slide {n}: using {len(asset_filenames)} assigned image(s) "
            f"from outline: {asset_filenames}"
        )
    else:
        asset_filenames = all_asset_filenames

    prompt = build_slide_prompt(
        n=n,
        total=len(session.outline),
        title=slide_spec.title,
        intent=slide_spec.intent,
        key_points=slide_spec.key_points,
        layout_hint=slide_spec.layout_hint,
        theme=session.theme,
        deck_context=session.deck_context,
        design_config=session.design_config,
        relevant_chunks=relevant,
        asset_filenames=asset_filenames,
        is_refinement=True,
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
                    # Use Base64 to prevent ANY character-level corruption in SSE
                    b64_token = base64.b64encode(token.encode("utf-8")).decode("utf-8")
                    yield f"data: {b64_token}\n\n"
            
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