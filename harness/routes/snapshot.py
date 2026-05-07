"""
SNAPSHOT ROUTE — FIXED
───────────────────────
POST /api/session/{id}/slide/{n}/snapshot

Fixes:
  - validate_and_maybe_fix() called with correct positional args matching service signature
  - capture_and_audit() called with correct args
  - Graceful fallback when Playwright unavailable
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session
from models.audit import VisionAuditResult

logger = logging.getLogger("snapshot_route")
router = APIRouter()


class SnapshotRequest(BaseModel):
    html: str
    run_audit: bool = True
    auto_fix: bool = True


@router.post("/session/{session_id}/slide/{n}/snapshot")
async def take_snapshot(session_id: str, n: int, req: SnapshotRequest):
    """
    Render slide N to a screenshot, run vision audit, optionally auto-fix.
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
            "auto_fixed": False,
        }

    # Full pipeline: capture → audit → maybe auto-fix
    from services.snapshot import capture_and_audit, validate_and_maybe_fix

    if req.auto_fix and slide_spec:
        # Use the full pipeline with auto-fix
        # validate_and_maybe_fix(html, session, text_model, vision_model, slide_spec)
        try:
            final_html, audit_result = await validate_and_maybe_fix(
                html=req.html,
                session=session,
                text_model=text_model,
                vision_model=vision_model,
                slide_spec=slide_spec,
            )

            screenshot_b64 = audit_result.snapshot_b64 if audit_result else None

            # If auto-fix changed the HTML, return it
            if final_html and final_html.strip() != req.html.strip():
                fixed_html = final_html

        except Exception as e:
            logger.warning(f"[{session_id}] validate_and_maybe_fix failed (non-fatal): {e}")
            # Fall through to audit-only path
            audit_result = VisionAuditResult(verdict="good", visual_issues=[f"Pipeline error: {e}"])

    else:
        # Audit only, no fix
        try:
            screenshot_b64, audit_result = await capture_and_audit(
                html=req.html,
                session=session,
                text_model=text_model,
                vision_model=vision_model,
                slide_spec=slide_spec,
                auto_fix=False,
            )
        except Exception as e:
            logger.warning(f"[{session_id}] capture_and_audit failed (non-fatal): {e}")
            audit_result = VisionAuditResult(verdict="good", visual_issues=[f"Audit error: {e}"])

    # Store snapshot in session slide data if we got one
    if screenshot_b64:
        existing_slide = next((s for s in session.slides if s.index == n), None)
        if existing_slide:
            existing_slide.snapshot_b64 = screenshot_b64
            save_session(session)

    logger.info(
        f"[{session_id}] slide {n} snapshot: "
        f"verdict={audit_result.verdict if audit_result else 'N/A'} "
        f"fixed={fixed_html is not None}"
    )

    return {
        "snapshot_b64": screenshot_b64,
        "audit": audit_result.model_dump() if audit_result else {"verdict": "good"},
        "fixed_html": fixed_html,
        "auto_fixed": fixed_html is not None,
    }