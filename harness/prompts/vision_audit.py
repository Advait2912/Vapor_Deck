"""
VISION AUDIT PROMPT
────────────────────
Sent to the vision model along with a base64 PNG screenshot of a rendered slide.

The model inspects the screenshot for layout issues and returns a structured verdict.

Checks performed:
  - Overflow (content exceeds slide bounds)
  - Clipped content (text/elements cut off at edges)
  - Unreadable code (code blocks too small, wrong colors)
  - Bad spacing (cramped or empty areas)
  - Empty layout regions (unused space in multi-column layouts)
  - Contrast issues (text hard to read against background)
  - Wrapping issues (headings/text wrapping awkwardly)

Verdicts:
  good       → show to user
  fixable    → attempt one auto-refinement with fix_instructions
  regenerate → too broken, regenerate from scratch

IMPORTANT: max_auto_fix_attempts = 1 (enforced in SlideLifecycle model).
Never loop the regeneration.
"""

VISION_AUDIT_SYSTEM = (
    "You are a world-class slide layout quality auditor. "
    "You receive a screenshot of a rendered HTML presentation slide and identify layout problems. "
    "When issues exist, you write a precise, developer-facing instruction to fix them. "
    "Return only valid JSON — no markdown, no explanation."
)

VISION_AUDIT_PROMPT = """You are auditing a rendered HTML presentation slide screenshot.

=== SLIDE HTML (for reference) ===
{html_snippet}

=== DESIGN INTENT ===
Theme: {theme}
Style Intent: {style_intent}

=== YOUR TASK ===
Look at the attached screenshot carefully. The screenshot is the GROUND TRUTH — if the screenshot looks broken, the slide is broken, regardless of the HTML code. 

Check for these specific issues:

1. OVERFLOW / SCROLLABLE BOXES (CRITICAL): Look at the HTML for any element with `overflow-y: auto`, `overflow-y: scroll`, or `overflow: auto`. Slide content must NEVER require scrolling. If found, this is ALWAYS at least "fixable".
2. CLIPPED CONTENT: Look at the edges of the 1280x720 canvas. Are text or elements partially cut off? Even a few pixels count.
3. OFF-CENTER / LOPSIDED: Is the content awkwardly shifted to one side? Is there a massive empty void (more than 40% of the slide) on one side while the other side is cramped? This is a major failure.
4. TOO MUCH CONTENT: More than 4-5 bullet points, or paragraph-length points (more than ~15 words) are "fixable" — they should be split.
5. UNREADABLE CODE: Code blocks that are too small, overflow, or have poor contrast.
6. FONT SIZE: Body text must be large enough to read. Tiny text is "fixable".
7. VISUAL BALANCE: Elements misaligned or floating in awkward positions.
8. CONTRAST: Text hard to read against the background.
9. WRAPPING: Awkward line breaks (e.g., a single word on a new line, or split words).

Return ONLY this JSON (no extra text):
{{
  "verdict": "good" | "fixable" | "regenerate",
  "visual_issues": ["concise list of specific problems found"],
  "refine_prompt": "A concrete instruction to fix the issues. Example: 'Fix: The content is shifted too far right. Center the .main-container and add padding-left: 5vw.'",
  "has_overflow": false,
  "has_clipped_content": false,
  "has_unreadable_code": false,
  "has_bad_spacing": false,
  "has_empty_regions": false,
  "has_contrast_issues": false,
  "has_wrapping_issues": false,
  "has_lopsided_layout": false
}}

VERDICT RULES:
- "good": Slide is professional, balanced, and fills the space elegantly.
- "fixable": Minor issues (spacing, font size, small alignment tweaks) that can be fixed with 1-2 CSS properties.
- "regenerate": MAJOR failures: 
    - Severe clipping (text cut off mid-sentence).
    - Massive empty voids (e.g., entire left half is empty).
    - Content completely off-canvas.
    - Broken layout (elements overlapping).
    - Failure to load assets (generic fonts, missing icons).

CRITICAL: Be CONSERVATIVE about "regenerate" for minor spacing issues, but be AGGRESSIVE about "regenerate" for severe clipping or massive lopsidedness.
"""


def build_vision_audit_prompt(html: str, theme: str = "dark-tech", style_intent: str = "none") -> str:
    """Build the vision audit prompt with the slide HTML snippet and design context."""
    html_snippet = html[:6000] if len(html) > 6000 else html
    return VISION_AUDIT_PROMPT.format(
        html_snippet=html_snippet,
        theme=theme,
        style_intent=style_intent
    )
