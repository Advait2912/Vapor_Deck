"""
POST /api/session/{id}/slide/{n}/snapshot

Accepts an html2canvas screenshot from the frontend, runs the vision audit,
persists the slide + snapshot to disk, and returns the audit result with
a refine_prompt the user can apply on demand.
"""
import asyncio
import base64
import glob
import logging
import os
import time

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai.router import get_model
from models.audit import VisionAuditResult
from store.sessions import get_session, save_session
from .slide import _update_context_in_background

logger = logging.getLogger("snapshot_route")
router = APIRouter()


class SnapshotRequest(BaseModel):
    html: str
    snapshot_b64: str | None = None
    run_audit: bool = True


@router.post("/session/{session_id}/slide/{n}/snapshot")
async def take_snapshot(session_id: str, n: int, req: SnapshotRequest):
    """
    Receive a frontend screenshot, run vision audit, persist slide, return result.
    """
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if not req.html.strip():
        raise HTTPException(status_code=400, detail="HTML is required")

    vision_model = get_model(session.vision_model)
    text_model = get_model(session.text_model)

    slide_spec = next((item for item in session.outline if item.index == n), None)

    screenshot_b64 = req.snapshot_b64
    audit_result: VisionAuditResult | None = None

    if req.run_audit:
        from services.snapshot import capture_and_audit
        try:
            screenshot_b64, audit_result = await capture_and_audit(
                html=req.html,
                session=session,
                text_model=text_model,
                vision_model=vision_model,
                slide_spec=slide_spec,
                existing_b64=screenshot_b64,
            )
        except Exception as e:
            logger.warning(f"[{session_id}] capture_and_audit failed: {e}")
            audit_result = VisionAuditResult(verdict="audit_failed", visual_issues=[str(e)])

    # Persist snapshot PNG to disk
    snapshot_url = None
    if screenshot_b64:
        try:
            from store.sessions import get_project_dir
            timestamp = int(time.time())
            filename = f"{session_id}_slide_{n}_{timestamp}.png"
            snapshot_dir = get_project_dir() / "snapshots"
            os.makedirs(snapshot_dir, exist_ok=True)

            # Remove previous snapshots for this slide
            for old in glob.glob(str(snapshot_dir / f"{session_id}_slide_{n}_*.png")):
                try:
                    os.remove(old)
                except OSError:
                    pass

            with open(snapshot_dir / filename, "wb") as f:
                f.write(base64.b64decode(screenshot_b64))

            snapshot_url = f"/api/snapshots/{filename}"
            logger.info(f"[{session_id}] Snapshot saved: {filename}")
        except Exception as e:
            logger.warning(f"[{session_id}] Failed to save snapshot: {e}")

    # Persist slide HTML + metadata
    existing_slide = next((s for s in session.slides if s.index == n), None)
    if not existing_slide:
        from models.session import SlideData
        existing_slide = SlideData(
            index=n,
            title=slide_spec.title if slide_spec else f"Slide {n}",
            html=req.html,
            approved=True,
            status="ready",
        )
        session.slides.append(existing_slide)
    else:
        existing_slide.html = req.html
        existing_slide.approved = True
        existing_slide.status = "ready"

    if snapshot_url:
        existing_slide.snapshot_url = snapshot_url
        existing_slide.snapshot_b64 = None
    if audit_result:
        existing_slide.audit = audit_result.model_dump()
    
    save_session(session)

    # Save individual slide files for direct serving / export
    try:
        from store.sessions import get_project_dir
        slides_dir = get_project_dir() / "slides"
        with open(slides_dir / f"slide_{n:02d}.html", "w", encoding="utf-8") as f:
            f.write(req.html)
        with open(slides_dir / f"slide_{n:02d}.json", "w", encoding="utf-8") as f:
            f.write(existing_slide.model_dump_json(indent=2))
        logger.info(f"[{session_id}] slide {n} files saved")
    except Exception as e:
        logger.error(f"[{session_id}] Failed to save slide {n} files: {e}")

    # Trigger background deck-context update
    asyncio.create_task(_update_context_in_background(session_id, req.html, session.text_model))

    verdict = audit_result.verdict if audit_result else "N/A"
    logger.info(f"[{session_id}] slide {n} snapshot complete — verdict={verdict}")

    return {
        "snapshot_b64": screenshot_b64,
        "snapshot_url": snapshot_url,
        "audit": audit_result.model_dump() if audit_result else {"verdict": "good"},
        "refine_prompt": audit_result.refine_prompt if audit_result else None,
        "auto_fixed": False,
    }