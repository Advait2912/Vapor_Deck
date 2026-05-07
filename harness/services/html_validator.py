"""
HTML VALIDATOR SERVICE
───────────────────────
Validates slide HTML for structural correctness and potential rendering issues.

This complements stream_cleanup.py:
  stream_cleanup.py → fixes/cleans HTML
  html_validator.py → reports what's wrong for audit/logging

Used by:
  - snapshot.py (before vision audit)
  - slide.py (before storing approved HTML)
"""
import re
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class ValidationResult:
    valid: bool
    score: int  # 0-100, higher is better
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    info: list[str] = field(default_factory=list)


def validate_slide_html(html: str) -> ValidationResult:
    """
    Full validation of slide HTML.

    Scoring:
      Start at 100.
      Subtract for errors and warnings.
      Valid = score >= 50 and no critical errors.
    """
    if not html or not html.strip():
        return ValidationResult(valid=False, score=0, errors=["Empty HTML"])

    errors = []
    warnings = []
    info = []
    score = 100

    # ── Critical checks (each -20 pts) ───────────────────────────────────────

    if "<section" not in html:
        errors.append("Missing <section> element")
        score -= 20

    if "class=\"slide\"" not in html and "class='slide'" not in html:
        errors.append("Section element missing class='slide'")
        score -= 10

    # ── Structural checks (each -10 pts) ─────────────────────────────────────

    open_styles = html.count("<style")
    close_styles = html.count("</style>")
    if open_styles != close_styles:
        errors.append(f"Unclosed <style> tags ({open_styles} open, {close_styles} close)")
        score -= 10

    open_scripts = html.count("<script")
    close_scripts = html.count("</script>")
    if open_scripts != close_scripts:
        errors.append(f"Unclosed <script> tags ({open_scripts} open, {close_scripts} close)")
        score -= 10

    # ── Warning checks (each -5 pts) ─────────────────────────────────────────

    # LLM should use CSS variables, not hardcoded colors
    hardcoded = re.findall(
        r'(?:color|background(?:-color)?|border-color)\s*:\s*#[0-9a-fA-F]{3,8}',
        html
    )
    if len(hardcoded) > 3:
        warnings.append(f"{len(hardcoded)} hardcoded color values — should use CSS variables")
        score -= 5

    # Fixed px dimensions on root slide element
    if re.search(r'\.slide\s*\{[^}]{0,200}(?:width|height)\s*:\s*\d+px', html, re.DOTALL):
        warnings.append("Slide root has fixed pixel dimensions — may not scale correctly")
        score -= 5

    # External image URLs
    ext_imgs = re.findall(r'<img[^>]+src=["\']https?://', html)
    if ext_imgs:
        warnings.append(f"{len(ext_imgs)} external image URL(s) — slides should use CSS or SVG")
        score -= 5

    # body{} rules in slide CSS
    if re.search(r'\bbody\s*\{', html):
        warnings.append("CSS contains body{} rule — may conflict in iframe")
        score -= 5

    # ── Info (no score change) ────────────────────────────────────────────────

    has_reveal = 'class="reveal"' in html or "class='reveal'" in html
    if has_reveal:
        info.append("Has reveal animations ✓")

    has_interactivity = (
        "addEventListener" in html or
        "onclick" in html or
        "toggle" in html.lower()
    )
    if has_interactivity:
        info.append("Has interactive elements ✓")

    has_code = "<code" in html or "<pre" in html
    if has_code:
        info.append("Has code blocks ✓")

    score = max(0, min(100, score))
    valid = score >= 50 and not any("Missing <section>" in e for e in errors)

    return ValidationResult(
        valid=valid,
        score=score,
        errors=errors,
        warnings=warnings,
        info=info,
    )


def quick_validate(html: str) -> bool:
    """
    Quick boolean check for use in hot paths (e.g., approve route).
    """
    if not html or len(html) < 50:
        return False
    return "<section" in html and "slide" in html
