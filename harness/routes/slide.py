"""
Slide generation route.

POST /api/session/{id}/slide/{n}          — generate slide N via SSE stream
POST /api/session/{id}/slide/{n}/approve  — approve and advance
POST /api/session/{id}/slide/{n}/refine   — refine current slide (Day 2)
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
from prompts.slide import build_slide_prompt, SLIDE_SYSTEM
from prompts.context_update import build_context_update_prompt, CONTEXT_UPDATE_SYSTEM

logger = logging.getLogger("slide")
router = APIRouter()


class ApproveSlideRequest(BaseModel):
    html: str


class RefineSlideRequest(BaseModel):
    mode: str  # "simplify" | "expand" | "example" | "interactive"
    current_html: str


@router.post("/session/{session_id}/slide/{n}")
async def generate_slide(session_id: str, n: int):
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
                        safe = token.replace("\n", "\\n")
                        yield f"data: {safe}\n\n"
            except Exception as e:
                import traceback
                traceback.print_exc()
                yield f"data: [ERROR] {str(e)}\n\n"
            finally:
                yield "data: [DONE]\n\n"

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

    model = get_model(session.text_model)
    update_prompt = build_context_update_prompt(req.html, session.deck_context)

    try:
        raw_ctx = await collect_stream(
            model,
            [{"role": "user", "content": update_prompt}],
            CONTEXT_UPDATE_SYSTEM,
        )
        updated_ctx = json.loads(strip_fences(raw_ctx))
        updated_ctx["synthesis"] = session.deck_context.get("synthesis", {})
        session.deck_context = updated_ctx
    except Exception as e:
        logger.warning(f"[{session_id}] context update failed (non-fatal): {e}")

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

    # Save individual HTML file for convenience
    try:
        from store.sessions import get_project_dir
        slide_filename = f"slide_{n:02d}.html"
        slide_path = get_project_dir() / "slides" / slide_filename
        with open(slide_path, "w", encoding="utf-8") as f:
            f.write(req.html)
        logger.info(f"[{session_id}] slide {n} HTML saved to {slide_path}")
    except Exception as e:
        logger.error(f"[{session_id}] failed to save slide {n} HTML file: {e}")

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

    _model = model
    _prompt = prompt

    async def event_stream():
        try:
            async for token in _model.stream_text(
                [{"role": "user", "content": _prompt}],
                SLIDE_SYSTEM,
            ):
                if token:
                    safe = token.replace("\n", "\\n")
                    yield f"data: {safe}\n\n"
        except Exception as e:
            import traceback
            traceback.print_exc()
            yield f"data: [ERROR] {str(e)}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )