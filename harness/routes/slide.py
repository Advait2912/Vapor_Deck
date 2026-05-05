"""
Slide generation route.

POST /api/session/{id}/slide/{n}          — generate slide N via SSE stream
POST /api/session/{id}/slide/{n}/approve  — approve and advance
POST /api/session/{id}/slide/{n}/refine   — refine current slide (Day 2)

Note: SSE streaming is wired but returns full HTML in one chunk for Step 1.
Full streaming will be connected in Day 2.
"""
import json
import logging
import os

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session
from models.session import SlideData
from services.stream_utils import collect_stream, strip_fences, validate_slide_html
from services.context_synthesis import get_relevant_chunks
from services.sse import stream_llm_response
from prompts.slide import build_slide_prompt, SLIDE_SYSTEM
from prompts.context_update import build_context_update_prompt, CONTEXT_UPDATE_SYSTEM

logger = logging.getLogger("slide")
router = APIRouter()


class ApproveSlideRequest(BaseModel):
    html: str  # the final approved HTML


class RefineSlideRequest(BaseModel):
    mode: str  # "simplify" | "expand" | "example" | "interactive"
    current_html: str


@router.post("/session/{session_id}/slide/{n}")
async def generate_slide(session_id: str, n: int):
    """
    Generate slide N as an SSE stream of HTML tokens.

    n is 1-indexed (matches outline).
    The frontend reads the stream via EventSource and injects tokens into the preview iframe.
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

    # Find the slide spec in the outline
    slide_spec = next(
        (item for item in session.outline if item.index == n), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide {n} not found in outline")

    try:
        model = get_model(session.text_model)

        # Get relevant reference chunks for this slide
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

        # Stream the LLM response via SSE
        generator = model.stream_text(
            [{"role": "user", "content": prompt}],
            SLIDE_SYSTEM,
        )
        return stream_llm_response(generator)
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

    # Update deck_context via LLM
    model = get_model(session.text_model)
    update_prompt = build_context_update_prompt(req.html, session.deck_context)

    try:
        raw_ctx = await collect_stream(
            model,
            [{"role": "user", "content": update_prompt}],
            CONTEXT_UPDATE_SYSTEM,
        )
        updated_ctx = json.loads(strip_fences(raw_ctx))
        # Preserve the synthesis block
        updated_ctx["synthesis"] = session.deck_context.get("synthesis", {})
        session.deck_context = updated_ctx
    except Exception as e:
        logger.warning(f"[{session_id}] context update failed (non-fatal): {e}")
        # Non-fatal: deck_context stays as-is

    # Store the approved slide
    slide_data = SlideData(
        index=n,
        title=slide_spec.title,
        html=req.html,
        approved=True,
    )
    # Replace or append
    existing = next((s for s in session.slides if s.index == n), None)
    if existing:
        session.slides = [s if s.index != n else slide_data for s in session.slides]
    else:
        session.slides.append(slide_data)

    session.current_index = n  # last approved index
    is_done = n >= len(session.outline)
    session.status = "done" if is_done else "generating"
    save_session(session)

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
    Full implementation in Day 2 — this is a basic stub that re-generates.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    valid_modes = {"simplify", "expand", "example", "interactive"}
    if req.mode not in valid_modes:
        raise HTTPException(status_code=400, detail=f"mode must be one of: {valid_modes}")

    # TODO Day 2: build mode-specific refinement prompt
    # For now: re-generate the slide with an extra instruction appended
    slide_spec = next(
        (item for item in session.outline if item.index == n), None
    )
    if not slide_spec:
        raise HTTPException(status_code=404, detail=f"Slide {n} not found")

    MODE_INSTRUCTIONS = {
        "simplify": "Make this slide SIMPLER. Fewer words, fewer elements. Keep only the most essential point.",
        "expand": "Expand this slide. Add more detail, more explanation, or a deeper example.",
        "example": "Add a concrete real-world example to this slide. Make it the centerpiece.",
        "interactive": "Make this slide interactive. Add tabs, toggles, or hover reveals using vanilla JS.",
    }

    model = get_model(session.text_model)
    prompt = build_slide_prompt(
        n=n,
        total=len(session.outline),
        title=slide_spec.title,
        intent=slide_spec.intent,
        key_points=slide_spec.key_points,
        layout_hint=slide_spec.layout_hint,
        theme=session.theme,
        deck_context=session.deck_context,
    ) + f"\n\n=== REFINEMENT INSTRUCTION ===\n{MODE_INSTRUCTIONS[req.mode]}"

    logger.info(f"[{session_id}] refining slide {n} mode={req.mode}")

    generator = model.stream_text(
        [{"role": "user", "content": prompt}],
        SLIDE_SYSTEM,
    )
    return await stream_llm_response(generator)
