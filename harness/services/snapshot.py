"""
SNAPSHOT SERVICE
─────────────────
Renders slide HTML using Playwright headless Chromium, captures a PNG screenshot,
and runs a vision audit via the LLM.

IMPORTANT:
  - max_auto_fix_attempts = 1 (never infinite loop)
  - Playwright is optional — graceful fallback if not installed
  - Vision audit is also optional — fails open (returns "good")

Pipeline:
  1. Playwright renders slide HTML in a 1280×720 headless browser
  2. Screenshot captured as base64 PNG
  3. Vision model receives screenshot + audit prompt
  4. Audit result returned (verdict: good | fixable | regenerate)
  5. If "regenerate" and auto_fix=True and attempts < max:
     → Re-run LLM generation with fix instructions appended
     → Return fixed HTML alongside audit

Usage:
  from services.snapshot import capture_and_audit
  result = await capture_and_audit(html, session, text_model, vision_model, slide_spec)
"""
"""
SNAPSHOT SERVICE — FIXED
─────────────────────────
Fixes:
  - capture_and_audit() now returns (screenshot_b64, audit_result) tuple
    consistently so validate_and_maybe_fix can unpack it correctly.
  - validate_and_maybe_fix() signature is clean and matches route caller.
  - _auto_fix_slide() no longer requires full session object.
"""
import base64
import json
import logging
from typing import Optional, Tuple

from models.audit import VisionAuditResult
from prompts.vision_audit import build_vision_audit_prompt, VISION_AUDIT_SYSTEM
from services.stream_utils import collect_stream, strip_fences

logger = logging.getLogger("snapshot")

PLAYWRIGHT_SLIDE_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    html, body {{
      margin: 0; padding: 0;
      width: 1280px; height: 720px;
      overflow: hidden;
      background: #000;
    }}
    :root {{
      --bg: #000; --surface: #111; --text: #fff;
      --accent: #8b5cf6; --accent-glow: rgba(139,92,246,0.3);
      --border: #222; --font-head: sans-serif; --font-body: sans-serif;
    }}
    .reveal {{ opacity: 1; transform: none; }}
  </style>
</head>
<body>
  {slide_html}
</body>
</html>"""


async def _playwright_capture(html: str, theme: str = "dark-tech") -> Optional[str]:
    """
    Render slide HTML in headless Chromium and capture a screenshot.
    Returns base64-encoded PNG, or None if Playwright is unavailable.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        logger.warning("Playwright not installed — snapshot capture unavailable.")
        return None

    wrapped = PLAYWRIGHT_SLIDE_TEMPLATE.format(slide_html=html)

    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
            page = await browser.new_page(viewport={"width": 1280, "height": 720})
            await page.set_content(wrapped, wait_until="networkidle")
            await page.wait_for_timeout(400)
            screenshot_bytes = await page.screenshot(
                type="png",
                clip={"x": 0, "y": 0, "width": 1280, "height": 720}
            )
            await browser.close()
        return base64.b64encode(screenshot_bytes).decode("utf-8")
    except Exception as e:
        logger.warning(f"Playwright capture failed: {e}")
        return None


async def _run_vision_audit(
    screenshot_b64: str,
    html: str,
    vision_model,
) -> VisionAuditResult:
    """
    Send screenshot to vision model for layout audit.
    Returns VisionAuditResult. Fails open on error.
    """
    prompt = build_vision_audit_prompt(html)
    try:
        raw = await vision_model.vision_audit(prompt, screenshot_b64)
        data = json.loads(strip_fences(raw))
        return VisionAuditResult(
            verdict=data.get("verdict", "good"),
            visual_issues=data.get("visual_issues", []),
            fix_instructions=data.get("fix_instructions"),
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
        logger.warning(f"Vision audit failed (non-fatal): {e}")
        return VisionAuditResult(verdict="good", visual_issues=[], snapshot_b64=screenshot_b64)


async def _auto_fix_slide(
    html: str,
    audit: VisionAuditResult,
    slide_spec,
    theme: str,
    deck_context: dict,
    outline_length: int,
    text_model,
) -> Optional[str]:
    """
    Attempt one automatic fix of a slide based on audit feedback.
    Returns fixed HTML, or None if fix failed.
    """
    from prompts.slide import build_slide_prompt, SLIDE_SYSTEM

    if not slide_spec:
        return None

    fix_instruction = audit.fix_instructions or (
        "Fix layout issues: " + "; ".join(audit.visual_issues[:3])
    )

    base_prompt = build_slide_prompt(
        n=slide_spec.index,
        total=outline_length,
        title=slide_spec.title,
        intent=slide_spec.intent,
        key_points=slide_spec.key_points,
        layout_hint=slide_spec.layout_hint,
        theme=theme,
        deck_context=deck_context,
        relevant_chunks="",
    )

    fix_prompt = (
        base_prompt
        + f"\n\n=== AUTO-FIX INSTRUCTION ===\n"
        + f"The previous version had these layout issues: {fix_instruction}\n"
        + f"Fix these issues while preserving all content.\n"
        + f"Current HTML to fix:\n{html[:3000]}"
    )

    try:
        fixed = await collect_stream(
            text_model,
            [{"role": "user", "content": fix_prompt}],
            SLIDE_SYSTEM,
        )
        if fixed and "<section" in fixed:
            return fixed
    except Exception as e:
        logger.warning(f"Auto-fix failed: {e}")

    return None


async def capture_and_audit(
    html: str,
    session,
    text_model,
    vision_model,
    slide_spec,
    auto_fix: bool = True,
) -> Tuple[Optional[str], VisionAuditResult]:
    """
    Full pipeline: capture → audit → optional auto-fix.

    Returns (screenshot_b64, audit_result).
    Note: auto-fix is handled in validate_and_maybe_fix — this function
    returns the audit result only, not the fixed HTML.

    NEVER runs more than one auto-fix attempt.
    """
    screenshot_b64 = await _playwright_capture(html, session.theme)

    if not screenshot_b64:
        return None, VisionAuditResult(
            verdict="good",
            visual_issues=["Playwright unavailable — skipping visual audit"]
        )

    audit = await _run_vision_audit(screenshot_b64, html, vision_model)
    audit.slide_index = slide_spec.index if slide_spec else None
    audit.model_used = getattr(vision_model, "model_name", None)

    return screenshot_b64, audit


async def validate_and_maybe_fix(
    html: str,
    session,
    text_model,
    vision_model,
    slide_spec,
) -> Tuple[str, VisionAuditResult]:
    """
    Convenience wrapper: capture → audit → optional one-shot auto-fix.

    Returns (final_html, audit_result).
    final_html is the fixed version if auto-fix ran, otherwise the original.
    """
    screenshot_b64, audit = await capture_and_audit(
        html=html,
        session=session,
        text_model=text_model,
        vision_model=vision_model,
        slide_spec=slide_spec,
        auto_fix=False,  # we handle auto-fix below
    )

    final_html = html

    if audit.needs_regeneration() and slide_spec:
        logger.info(f"[slide {slide_spec.index}] verdict=regenerate — attempting one auto-fix")
        fixed = await _auto_fix_slide(
            html=html,
            audit=audit,
            slide_spec=slide_spec,
            theme=session.theme,
            deck_context=session.deck_context,
            outline_length=len(session.outline),
            text_model=text_model,
        )
        if fixed:
            final_html = fixed
            logger.info(f"[slide {slide_spec.index}] auto-fix produced {len(fixed)} chars")
        else:
            logger.warning(f"[slide {slide_spec.index}] auto-fix failed, returning original")

    return final_html, audit