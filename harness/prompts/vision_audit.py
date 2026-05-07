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
    "You are a slide layout quality auditor. "
    "You receive a screenshot of a rendered HTML slide and identify layout problems. "
    "Return only valid JSON — no markdown, no explanation."
)

VISION_AUDIT_PROMPT = """You are auditing a rendered slide screenshot.

=== SLIDE HTML (for reference) ===
{html_snippet}

=== YOUR TASK ===
Look at the attached screenshot. Identify any of these issues:

1. OVERFLOW: Any content that extends beyond the slide boundary or is cut off
2. CLIPPED: Text or elements that are partially visible at the edges
3. UNREADABLE CODE: Code blocks that are too small, overflow, or have poor contrast
4. BAD SPACING: Regions that are dramatically over-crowded OR nearly empty
5. EMPTY REGIONS: Multi-column layout where one column has very little content
6. CONTRAST: Text that is hard to read against the background color
7. WRAPPING: Headings or key text that wraps in an awkward / unintended way

Return ONLY this JSON:
{{
  "verdict": "good" | "fixable" | "regenerate",
  "visual_issues": ["list of specific problems found, or empty array if none"],
  "fix_instructions": "string with specific CSS/HTML changes to fix issues, or null if good",
  "has_overflow": false,
  "has_clipped_content": false,
  "has_unreadable_code": false,
  "has_bad_spacing": false,
  "has_empty_regions": false,
  "has_contrast_issues": false,
  "has_wrapping_issues": false
}}

VERDICT RULES:
- "good": No significant issues. Slide looks clean and professional.
- "fixable": 1-2 minor issues that can be fixed with small CSS tweaks. Provide fix_instructions.
- "regenerate": Major structural problems (overflow, clipping, broken layout). Better to regenerate.

Be conservative — only flag "regenerate" for clearly broken slides.
"""


def build_vision_audit_prompt(html: str) -> str:
    """Build the vision audit prompt with the slide HTML snippet."""
    # Truncate HTML for the prompt — we only need enough for context
    html_snippet = html[:2000] if len(html) > 2000 else html
    return VISION_AUDIT_PROMPT.format(html_snippet=html_snippet)
