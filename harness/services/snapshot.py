"""
SNAPSHOT SERVICE
─────────────────
Renders slide HTML using Playwright headless Chromium, captures a PNG screenshot,
and runs a vision audit via the LLM.

IMPORTANT:
  - max_auto_fix_attempts = 1 (never infinite loop)
  - Playwright is optional — graceful fallback if not installed
  - Vision audit is also optional — fails open (returns "good")

Pipeline/VERDICT RULES:
- "good": No significant issues. Slide looks clean and professional.
- "fixable": 1-2 minor issues that can be fixed with small CSS tweaks. Provide fix_instructions.
- "regenerate": Major structural problems (overflow, clipping, broken layout). Better to regenerate.

CRITICAL: Be extremely strict about OVERFLOW. If ANY text is cut off or extends beyond the visible slide boundaries, you MUST return "regenerate".

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
import base64
import json
import logging
from typing import Optional, Tuple

from models.audit import VisionAuditResult
from prompts.vision_audit import build_vision_audit_prompt, VISION_AUDIT_SYSTEM
from services.stream_utils import collect_stream, strip_fences

import os
import time
import asyncio

logger = logging.getLogger("snapshot")

def _log_raw_audit(session_id: str, slide_index: int, raw_response: str, verdict: str):
    """Log raw vision audit response for debugging."""
    from store.sessions import get_project_dir
    log_dir = get_project_dir() / "debug" / "audits"
    os.makedirs(log_dir, exist_ok=True)
    timestamp = int(time.time())
    filename = f"{session_id}_slide_{slide_index}_{verdict}_{timestamp}.txt"
    filepath = os.path.join(log_dir, filename)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(raw_response)
    logger.info(f"[{session_id}] Audit log saved: {filepath}")

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
    
    /* Audit Mode: No animations */
    body.audit-mode *,
    body.audit-mode *::before,
    body.audit-mode *::after {{
      animation: none !important;
      transition: none !important;
    }}
  </style>
  <style>
    /* Base slide container styles */
    #slide-scaler {{
      transform-origin: top left;
      width: 1280px;
      height: 720px;
      position: relative;
    }}
  </style>
</head>
<body class="audit-mode">
  <div id="slide-scaler">
    {slide_html}
  </div>
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

    # Load local Prism assets for injection
    try:
        # Resolve absolute path to front/public/lib/prism relative to this file
        from pathlib import Path
        root = Path(__file__).parent.parent.parent
        prism_base = root / "front" / "public" / "lib" / "prism"
        
        with open(prism_base / "prism-tomorrow.css", "r", encoding="utf-8") as f:
            prism_css = f.read()
        with open(prism_base / "prism.js", "r", encoding="utf-8") as f:
            prism_js = f.read()
        
        # Load theme CSS
        theme_path = root / "front" / "public" / "themes" / f"{theme}.css"
        if theme_path.exists():
            with open(theme_path, "r", encoding="utf-8") as f:
                theme_css = f.read()
        else:
            theme_css = ""

        prism_langs = ""
        for lang in ["javascript", "python", "typescript", "bash"]:
            lang_path = prism_base / "components" / f"prism-{lang}.js"
            if lang_path.exists():
                with open(lang_path, "r", encoding="utf-8") as f:
                    prism_langs += f.read() + "\n"
    except Exception as e:
        logger.warning(f"Failed to load local Prism or theme assets for Playwright: {e}")
        prism_css = ""
        prism_js = ""
        prism_langs = ""
        theme_css = ""

    wrapped = PLAYWRIGHT_SLIDE_TEMPLATE.format(
        slide_html=html
    )

    # BUG 15: Retry policy for transient failures
    max_retries = 3
    last_error = None
    
    for attempt in range(max_retries):
        try:
            async with async_playwright() as p:
                browser = await p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage"])
                page = await browser.new_page(viewport={"width": 1280, "height": 720})
                
                # Load content
                await page.set_content(wrapped, wait_until="domcontentloaded")

                # Inject Styles
                if theme_css: await page.add_style_tag(content=theme_css)
                if prism_css: await page.add_style_tag(content=prism_css)
                
                # Inject Scripts (Order is critical: Prism Core -> Languages -> Lifecycle)
                if prism_js: await page.add_script_tag(content=prism_js)
                if prism_langs: await page.add_script_tag(content=prism_langs)
                
                # Inject Slide Scaling & Lifecycle Logic
                await page.add_script_tag(content="""
                    function fitSlide() {
                        const scaler = document.getElementById('slide-scaler');
                        if (!scaler) return;
                        const slide = scaler.firstElementChild;
                        if (!slide) return;

                        const naturalW = slide.scrollWidth || slide.offsetWidth || 1280;
                        const naturalH = slide.scrollHeight || slide.offsetHeight || 720;

                        const scaleX = 1280 / naturalW;
                        const scaleY = 720 / naturalH;
                        const scale = Math.min(scaleX, scaleY);

                        scaler.style.transform = 'scale(' + scale + ')';
                        
                        const scaledW = naturalW * scale;
                        const scaledH = naturalH * scale;

                        scaler.style.marginLeft = ((1280 - scaledW) / 2) + 'px';
                        scaler.style.marginTop = ((720 - scaledH) / 2) + 'px';
                    }

                    function highlightCode() {
                        if (typeof Prism !== 'undefined' && Prism.highlightAll) {
                            Prism.highlightAll();
                        }
                    }

                    window.__VAPOR_READY__ = false;
                    // Run immediately and also on DOMContentLoaded
                    fitSlide();
                    highlightCode();
                    setTimeout(() => { window.__VAPOR_READY__ = true; }, 200);
                """)

                # BUG 13: Disable animations for deterministic audit
                await page.add_script_tag(content="document.body.classList.add('audit-mode');")
                
                # BUG 1: Wait for deterministic ready signal instead of fixed timeout
                try:
                    await page.wait_for_function("window.__VAPOR_READY__ === true", timeout=3000)
                except Exception:
                    logger.warning(f"Playwright (attempt {attempt+1}): window.__VAPOR_READY__ timeout, capturing anyway.")
                
                # Final pause for layout stabilization
                await asyncio.sleep(0.5)
                
                screenshot_bytes = await page.screenshot(
                    type="png",
                    clip={"x": 0, "y": 0, "width": 1280, "height": 720}
                )
                await browser.close()
            return base64.b64encode(screenshot_bytes).decode("utf-8")
        except Exception as e:
            last_error = e
            logger.warning(f"Playwright capture attempt {attempt+1} failed: {e}")
            if attempt < max_retries - 1:
                await asyncio.sleep(1) # Wait before retry
    
    logger.error(f"Playwright capture failed after {max_retries} attempts: {last_error}")
    return None


async def _run_vision_audit(
    screenshot_b64: str,
    html: str,
    vision_model,
    slide_index: Optional[int] = None,
    session_id: str = "unknown"
) -> VisionAuditResult:
    """
    Send screenshot to vision model for layout audit.
    Returns VisionAuditResult. Fails with "audit_failed" on error.
    """
    prompt = build_vision_audit_prompt(html)
    raw = ""
    try:
        raw = await vision_model.vision_audit(prompt, screenshot_b64)
        # Robust parsing: handle code fences and malformed JSON
        cleaned = strip_fences(raw).strip()
        if not cleaned.startswith("{") or not cleaned.endswith("}"):
            # Try to find JSON within the text if model added chatter
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start != -1 and end != -1:
                cleaned = cleaned[start:end+1]

        data = json.loads(cleaned)
        verdict = data.get("verdict", "good")
        _log_raw_audit(session_id, slide_index or 0, raw, verdict)

        return VisionAuditResult(
            verdict=verdict,
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
        logger.warning(f"Vision audit failed: {e}")
        if raw:
            _log_raw_audit(session_id, slide_index or 0, raw, "parse_error")
        # BUG 5: Stop failing open as "good". Return "audit_failed"
        return VisionAuditResult(
            verdict="audit_failed",
            visual_issues=[f"Audit engine error: {str(e)}"],
            snapshot_b64=screenshot_b64
        )


def _check_content_preservation(original: str, fixed: str) -> bool:
    """
    BUG 6: Sanity check to ensure auto-fix didn't delete half the slide.
    Checks if major headings and a reasonable amount of text are preserved.
    """
    try:
        # Simple heuristic: look for headings
        # We don't want to add bs4 dependency if not already there, 
        # so we'll use regex for a lightweight check
        import re
        
        orig_headings = re.findall(r'<h[1-3][^>]*>(.*?)</h[1-3]>', original, re.IGNORECASE | re.DOTALL)
        fixed_headings = re.findall(r'<h[1-3][^>]*>(.*?)</h[1-3]>', fixed, re.IGNORECASE | re.DOTALL)
        
        # If original had headings and fixed doesn't, it's probably bad
        if orig_headings and not fixed_headings:
            return False
            
        # Check text length reduction
        # Strip tags and compare
        def get_text(h):
            return re.sub(r'<[^>]*>', '', h).strip()
            
        text_orig = get_text(original)
        text_fixed = get_text(fixed)
        
        if len(text_orig) > 200 and len(text_fixed) < len(text_orig) * 0.4:
            return False
            
        return True
    except Exception:
        return True


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

    audit = await _run_vision_audit(
        screenshot_b64=screenshot_b64,
        html=html,
        vision_model=vision_model,
        slide_index=slide_spec.index if slide_spec else None,
        session_id=session.session_id if hasattr(session, "session_id") else "unknown"
    )
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
    Convenience wrapper: capture → audit → optional one-shot auto-fix → re-audit.

    Returns (final_html, audit_result).
    final_html is the fixed version if auto-fix ran, otherwise the original.
    audit_result is the final audit (either original or re-audit).
    """
    screenshot_b64, audit = await capture_and_audit(
        html=html,
        session=session,
        text_model=text_model,
        vision_model=vision_model,
        slide_spec=slide_spec,
        auto_fix=False,
    )

    if not audit.needs_regeneration() or not slide_spec:
        return html, audit

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

    if not fixed:
        logger.warning(f"[slide {slide_spec.index}] auto-fix failed, returning original")
        return html, audit

    # BUG 6: Content preservation check
    if not _check_content_preservation(html, fixed):
        logger.warning(f"[slide {slide_spec.index}] auto-fix rejected: content destruction detected")
        return html, audit

    logger.info(f"[slide {slide_spec.index}] auto-fix produced {len(fixed)} chars — re-auditing...")

    # BUG 9: Re-audit after auto-fix
    re_screenshot, re_audit = await capture_and_audit(
        html=fixed,
        session=session,
        text_model=text_model,
        vision_model=vision_model,
        slide_spec=slide_spec,
        auto_fix=False,
    )

    return fixed, re_audit