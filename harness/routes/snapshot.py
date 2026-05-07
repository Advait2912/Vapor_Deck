"""
SNAPSHOT ROUTE
───────────────
POST /api/session/{id}/slide/{n}/snapshot

Takes slide HTML, renders it headlessly, runs vision audit,
and optionally auto-fixes layout issues (once max).

Response:
{
  "snapshot_b64": "...",
  "audit": {
    "verdict": "good" | "fixable" | "regenerate",
    "visual_issues": [...],
    "fix_instructions": "...",
    ...
  },
  "fixed_html": "..." | null  // only if auto-fix was triggered
}
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session
from models.audit import VisionAuditResult
from services.snapshot import capture_and_audit, validate_and_maybe_fix
from prompts.slide import build_slide_prompt, SLIDE_SYSTEM

logger = logging.getLogger("snapshot_route")
router = APIRouter()


class SnapshotRequest(BaseModel):
    html: str
    run_audit: bool = True       # Set False to skip vision audit (faster)
    auto_fix: bool = True        # Set False to skip auto-fix even if audit fails


@router.post("/session/{session_id}/slide/{n}/snapshot")
async def take_snapshot(session_id: str, n: int, req: SnapshotRequest):
    """
    Render slide N to a screenshot, run vision audit, optionally auto-fix.

    This is called BEFORE showing the slide to the user (hidden validation).
    The frontend calls this after each slide finishes generating.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if not req.html.strip():
        raise HTTPException(status_code=400, detail="HTML is required")

    vision_model = get_model(session.vision_model)
    text_model = get_model(session.text_model)

    slide_spec = next(
        (item for item in session.outline if item.index == n), None
    )

    fixed_html = None
    audit_result = None
    screenshot_b64 = None

    if not req.run_audit:
        # Fast path: just take screenshot, no audit
        from services.snapshot import _playwright_capture
        try:
            screenshot_b64 = await _playwright_capture(req.html, session.theme)
        except Exception as e:
            logger.warning(f"[{session_id}] Playwright unavailable: {e}")

        return {
            "snapshot_b64": screenshot_b64,
            "audit": {"verdict": "good", "visual_issues": [], "skipped": True},
            "fixed_html": None,
        }

    if req.auto_fix and slide_spec:
        # Full pipeline: capture → audit → maybe auto-fix
        from services.context_synthesis import get_relevant_chunks

        original_prompt = build_slide_prompt(
            n=n,
            total=len(session.outline),
            title=slide_spec.title,
            intent=slide_spec.intent,
            key_points=slide_spec.key_points,
            layout_hint=slide_spec.layout_hint,
            theme=session.theme,
            deck_context=session.deck_context,
            relevant_chunks=get_relevant_chunks(
                session,
                slide_intent=f"{slide_spec.title} {' '.join(slide_spec.key_points)}",
                max_tokens=1500,
            ),
        )

        final_html, audit_result = await validate_and_maybe_fix(
            slide_html=req.html,
            theme=session.theme,
            vision_model=vision_model,
            text_model=text_model,
            slide_prompt=original_prompt,
        )

        screenshot_b64 = audit_result.snapshot_b64

        # If the HTML changed (auto-fix happened), return it
        if final_html.strip() != req.html.strip():
            fixed_html = final_html

        # Store snapshot in session slide data
        existing_slide = next((s for s in session.slides if s.index == n), None)
        if existing_slide:
            existing_slide.snapshot_b64 = screenshot_b64
            save_session(session)

    else:
        # Audit only, no fix
        screenshot_b64, audit_result = await capture_and_audit(
            slide_html=req.html,
            theme=session.theme,
            vision_model=vision_model,
        )

    logger.info(
        f"[{session_id}] slide {n} snapshot: "
        f"verdict={audit_result.verdict if audit_result else 'N/A'} "
        f"fixed={fixed_html is not None}"
    )

    return {
        "snapshot_b64": screenshot_b64,
        "audit": audit_result.model_dump() if audit_result else {"verdict": "good"},
        "fixed_html": fixed_html,
    }
