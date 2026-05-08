"""
SNAPSHOT SERVICE
─────────────────
Captures a slide screenshot via the frontend (html2canvas) and runs a
vision audit via the LLM.

Pipeline:
  1. Frontend captures a base64 PNG using html2canvas and sends it here
  2. Vision model receives the screenshot + slide HTML + audit prompt
  3. Audit result returned: verdict (good | fixable | regenerate) + refine_prompt

The refine_prompt is returned to the UI so the user can trigger a targeted
refinement on demand — no silent auto-fixing.
"""
import base64
import json
import logging
import os
import time
from typing import Optional, Tuple

from models.audit import VisionAuditResult
from prompts.vision_audit import build_vision_audit_prompt, VISION_AUDIT_SYSTEM
from services.stream_utils import collect_stream, strip_fences

logger = logging.getLogger("snapshot")


def _log_raw_audit(session_id: str, slide_index: int, raw_response: str, verdict: str):
    """Persist raw vision model response for debugging."""
    from store.sessions import get_project_dir
    log_dir = get_project_dir() / "debug" / "audits"
    os.makedirs(log_dir, exist_ok=True)
    timestamp = int(time.time())
    filename = f"{session_id}_slide_{slide_index}_{verdict}_{timestamp}.txt"
    filepath = os.path.join(log_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(raw_response)
    logger.info(f"[{session_id}] Audit log saved: {filepath}")


async def _run_vision_audit(
    screenshot_b64: str,
    html: str,
    vision_model,
    theme: str = "dark-tech",
    style_intent: str = "none",
    slide_index: Optional[int] = None,
    session_id: str = "unknown",
) -> VisionAuditResult:
    """
    Send a base64 screenshot to the vision model for layout audit.
    Returns VisionAuditResult. Fails with verdict='audit_failed' on error.
    """
    prompt = build_vision_audit_prompt(html, theme=theme, style_intent=style_intent)
    raw = ""
    try:
        raw = await vision_model.vision_audit(prompt, screenshot_b64)

        # Robust JSON extraction: strip fences and locate the JSON object
        cleaned = strip_fences(raw).strip()
        if not cleaned.startswith("{") or not cleaned.endswith("}"):
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start != -1 and end != -1:
                cleaned = cleaned[start:end + 1]

        # Strip non-printable control characters that break json.loads
        sanitized = "".join(c for c in cleaned if c.isprintable() or c in "\n\r\t")
        data = json.loads(sanitized, strict=False)

        verdict = data.get("verdict", "good")
        _log_raw_audit(session_id, slide_index or 0, raw, verdict)

        return VisionAuditResult(
            verdict=verdict,
            visual_issues=data.get("visual_issues", []),
            refine_prompt=data.get("refine_prompt") or data.get("fix_instructions"),
            has_overflow=data.get("has_overflow", False),
            has_clipped_content=data.get("has_clipped_content", False),
            has_unreadable_code=data.get("has_unreadable_code", False),
            has_bad_spacing=data.get("has_bad_spacing", False),
            has_empty_regions=data.get("has_empty_regions", False),
            has_contrast_issues=data.get("has_contrast_issues", False),
            has_wrapping_issues=data.get("has_wrapping_issues", False),
            snapshot_b64=screenshot_b64,
        )

    except Exception as e:
        logger.warning(f"Vision audit failed: {e}")
        if raw:
            logger.debug(f"Raw model response: {raw}")
            try:
                sanitized = "".join(
                    c for c in strip_fences(raw).strip()
                    if c.isprintable() or c in "\n\r\t"
                )
                logger.debug(f"Sanitized response: {sanitized}")
            except Exception:
                pass
            _log_raw_audit(session_id, slide_index or 0, raw, "parse_error")

        return VisionAuditResult(
            verdict="audit_failed",
            visual_issues=[f"Audit engine error: {str(e)}"],
            snapshot_b64=screenshot_b64,
        )


async def capture_and_audit(
    html: str,
    session,
    text_model,
    vision_model,
    slide_spec,
    auto_fix: bool = False,  # kept for API compatibility; always ignored
    existing_b64: Optional[str] = None,
) -> Tuple[Optional[str], VisionAuditResult]:
    """
    Run a vision audit using the provided screenshot (html2canvas b64).

    Returns (screenshot_b64, audit_result).

    If no screenshot is provided the audit is skipped and verdict='good' is returned.
    The auto_fix parameter is ignored — fixes are always user-triggered from the UI.
    """
    screenshot_b64 = existing_b64

    if not screenshot_b64:
        # No screenshot from frontend — skip audit gracefully
        return None, VisionAuditResult(
            verdict="good",
            visual_issues=["No screenshot provided — skipping visual audit"],
        )

    import json
    style_intent_str = json.dumps(session.deck_context.get("style_intent", {})) if hasattr(session, "deck_context") else "none"

    audit = await _run_vision_audit(
        screenshot_b64=screenshot_b64,
        html=html,
        vision_model=vision_model,
        theme=getattr(session, "theme", "dark-tech"),
        style_intent=style_intent_str,
        slide_index=slide_spec.index if slide_spec else None,
        session_id=session.session_id if hasattr(session, "session_id") else "unknown",
    )
    audit.slide_index = slide_spec.index if slide_spec else None
    audit.model_used = getattr(vision_model, "model_name", None)

    return screenshot_b64, audit