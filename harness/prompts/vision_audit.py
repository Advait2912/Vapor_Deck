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
Look at the attached screenshot carefully AND inspect the HTML. Check for these specific issues:

1. OVERFLOW / SCROLLABLE BOXES (CRITICAL): Look at the HTML for any element with `overflow-y: auto`, `overflow-y: scroll`, or `overflow: auto`. If found, this is ALWAYS a "fixable" issue — content must never require scrolling on a slide. Also check if any content boxes appear clipped or cut off at the bottom of the slide.
2. CLIPPED: Text or elements partially cut off at the slide's outer edges
3. TOO MUCH CONTENT: If a column or section has more than 4 bullet points, or if bullet text is paragraph-length (more than ~15 words per point), report it as "fixable".
4. UNREADABLE CODE: Code blocks that are too small, overflow, or have poor contrast
5. BAD SPACE UTILIZATION: Content that is too small and "lost" in empty space, OR areas that are severely cramped
6. FONT SIZE: Body text that is too small to comfortably read from a distance
7. VISUAL BALANCE: Elements misaligned, off-center without purpose, or a lopsided layout
8. CONTRAST: Text that is hard to read against the background
9. WRAPPING: Headings or key labels wrapping awkwardly mid-word or splitting unevenly

Return ONLY this JSON (no extra text):
{{
  "verdict": "good" | "fixable" | "regenerate",
  "visual_issues": ["concise list of specific problems found, or empty array"],
  "refine_prompt": "A single, specific instruction for a developer to fix the issues. Start with 'Fix:'. Be concrete — mention element names, CSS properties, and values where possible. Example: 'Fix: The right column text is wrapping at narrow widths. Set min-width: 300px on .right-col and reduce font-size from 1.1rem to 0.95rem.' Set to null if verdict is good.",
  "has_overflow": false,
  "has_clipped_content": false,
  "has_unreadable_code": false,
  "has_bad_spacing": false,
  "has_empty_regions": false,
  "has_contrast_issues": false,
  "has_wrapping_issues": false
}}

VERDICT RULES:
- "good": No significant issues. Slide is clean, professional, and fills the space elegantly.
- "fixable": 1-3 minor issues (spacing, font size, alignment, wrapping) that can be fixed with targeted CSS tweaks.
- "regenerate": Major structural failures: severe overflow, entire layout broken, content completely illegible, more than 60%% of slide space is wasted, or if the slide appears to have failed to load assets (e.g., text is in a generic fallback font when it should be styled, or images/icons are missing).

CRITICAL: Be CONSERVATIVE about "regenerate" — only use it for truly broken layouts. Minor issues should be "fixable". A slide with two columns where one has slightly more content than the other is "good".
"""


def build_vision_audit_prompt(html: str, theme: str = "dark-tech", style_intent: str = "none") -> str:
    """Build the vision audit prompt with the slide HTML snippet and design context."""
    html_snippet = html[:6000] if len(html) > 6000 else html
    return VISION_AUDIT_PROMPT.format(
        html_snippet=html_snippet,
        theme=theme,
        style_intent=style_intent
    )
