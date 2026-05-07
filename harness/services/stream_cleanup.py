"""
STREAM CLEANUP SERVICE
───────────────────────
Cleans up LLM output before rendering.

Problems this solves:
  1. LLMs sometimes wrap output in markdown code fences (```html...```)
  2. Partial HTML mid-stream may have unclosed tags
  3. Invalid sections (script errors, broken CSS) need detection

This module is used by the frontend renderer (iframe.js also has a client-side
version). This server-side version is used for audit/storage before saving.

IMPORTANT:
  We do NOT do token-by-token injection.
  The frontend accumulates chunks and renders at a controlled rate.
  This is enforced in iframe.js::appendStreamToken().
"""
import re
from typing import Optional


def strip_markdown_fences(text: str) -> str:
    """
    Remove markdown code fences from LLM output.

    Handles:
      ```html\n...\n```
      ```\n...\n```
      ```html...``` (no newlines, rare)
    """
    if not text:
        return text

    text = text.strip()

    # Opening fence: ```html or ```
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        else:
            text = text[3:]  # Just "```" with nothing after

    # Closing fence
    if text.endswith("```"):
        last_fence = text.rfind("```")
        text = text[:last_fence]

    return text.strip()


def clean_partial_html(html: str) -> str:
    """
    Clean up partial HTML from mid-stream state.

    Handles common issues:
      - Unclosed <style> blocks
      - Unclosed <script> blocks
      - Trailing incomplete tags

    NOTE: This is intentionally lenient — we just want to avoid crashes.
    The browser will handle most partial HTML gracefully.
    """
    if not html:
        return html

    # Strip markdown fences first
    html = strip_markdown_fences(html)

    # If the HTML looks complete enough, return as-is
    if "<section" in html and "</section>" in html:
        return html

    # Close any unclosed <style> blocks (prevents CSS from bleeding out)
    open_style = html.count("<style")
    close_style = html.count("</style>")
    if open_style > close_style:
        html += "</style>" * (open_style - close_style)

    # Close any unclosed <script> blocks
    open_script = html.count("<script")
    close_script = html.count("</script>")
    if open_script > close_script:
        html += "</script>" * (open_script - close_script)

    return html


def validate_slide_html(html: str) -> dict:
    """
    Validate that slide HTML looks usable.

    Returns:
        { valid: bool, issues: list[str], has_section: bool, has_style: bool }
    """
    if not html or not html.strip():
        return {"valid": False, "issues": ["Empty HTML"], "has_section": False, "has_style": False}

    issues = []
    has_section = "<section" in html and "slide" in html
    has_style = "<style" in html
    has_script = "<script" in html

    if not has_section:
        issues.append("Missing <section class='slide'> element")

    # Check for unclosed critical tags
    if html.count("<style") != html.count("</style>"):
        issues.append("Unclosed <style> block")

    if html.count("<script") != html.count("</script>"):
        issues.append("Unclosed <script> block")

    # Check for hardcoded colors (LLM was supposed to use CSS vars)
    hardcoded_color_pattern = r'(?:color|background(?:-color)?)\s*:\s*#[0-9a-fA-F]{3,6}'
    hardcoded_count = len(re.findall(hardcoded_color_pattern, html))
    if hardcoded_count > 5:
        issues.append(f"Too many hardcoded colors ({hardcoded_count}) — should use CSS variables")

    # Check for fixed pixel dimensions on the slide element
    if re.search(r'\.slide\s*\{[^}]*(?:width|height)\s*:\s*\d+px', html):
        issues.append("Slide element has fixed pixel dimensions")

    return {
        "valid": has_section and len([i for i in issues if "Missing" in i]) == 0,
        "issues": issues,
        "has_section": has_section,
        "has_style": has_style,
        "has_script": has_script,
    }


def detect_invalid_sections(html: str) -> list[str]:
    """
    Detect specific patterns that are known to cause rendering problems.
    Returns a list of detected problem descriptions.
    """
    problems = []

    if not html:
        return problems

    # External image URLs (not allowed — slides use CSS backgrounds or SVG only)
    external_imgs = re.findall(r'<img[^>]+src=["\']https?://', html)
    if external_imgs:
        problems.append(f"External image URLs detected ({len(external_imgs)}) — slides should use CSS backgrounds or SVG")

    # Very long lines (may cause horizontal overflow)
    lines = html.split("\n")
    long_content_lines = [l for l in lines if len(l) > 500 and not l.strip().startswith("//")]
    if long_content_lines:
        problems.append(f"{len(long_content_lines)} very long content lines — may cause overflow")

    # Nested section tags (LLM hallucination)
    section_opens = html.count("<section")
    section_closes = html.count("</section>")
    if section_opens > 1:
        problems.append(f"Multiple <section> tags ({section_opens}) — slide should have exactly one")
    if section_opens != section_closes:
        problems.append(f"Mismatched <section> tags (opens: {section_opens}, closes: {section_closes})")

    # document-relative CSS (using body{} etc. from LLM — conflicts with iframe)
    if re.search(r'\bbody\s*\{', html):
        problems.append("Slide CSS contains body{} rule — may conflict with iframe container")

    return problems


def prepare_slide_for_storage(raw_html: str) -> str:
    """
    Final cleanup before storing slide HTML to disk/session.
    Applied after stream completes.
    """
    cleaned = strip_markdown_fences(raw_html)
    cleaned = clean_partial_html(cleaned)
    return cleaned.strip()
