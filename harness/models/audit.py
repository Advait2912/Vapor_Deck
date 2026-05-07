"""
AUDIT MODEL
────────────
Represents the result of a vision audit on a rendered slide.

Used by the Playwright validation pipeline (Goal 3).

Verdict options:
  good       → slide looks fine, show to user
  fixable    → minor issues detected, auto-fix attempted
  regenerate → major layout problems, trigger one auto-regeneration
"""
from __future__ import annotations
from pydantic import BaseModel


class VisionAuditResult(BaseModel):
    """Result of a vision model inspecting a slide screenshot."""

    verdict: str = "good"  # "good" | "fixable" | "regenerate"
    visual_issues: list[str] = []
    fix_instructions: str | None = None

    # Specific checks
    has_overflow: bool = False
    has_clipped_content: bool = False
    has_unreadable_code: bool = False
    has_bad_spacing: bool = False
    has_empty_regions: bool = False
    has_contrast_issues: bool = False
    has_wrapping_issues: bool = False

    # Source metadata
    slide_index: int | None = None
    snapshot_b64: str | None = None  # base64 PNG that was audited
    model_used: str | None = None    # which vision model performed the audit

    def is_clean(self) -> bool:
        return self.verdict == "good"

    def needs_regeneration(self) -> bool:
        return self.verdict == "regenerate"


class SlideLifecycle(BaseModel):
    """
    Per-slide lifecycle state object.

    States (in order):
      PLANNING   → outline defined, not yet built
      BUILDING   → HTML generation in progress
      VALIDATING → Playwright snapshot + vision audit running
      REVIEWING  → User is looking at the slide
      APPROVED   → User approved, slide is locked
      REFINING   → User triggered a refinement
      ERROR      → Something failed

    NOTE: PLANNING → BUILDING is a ONE-WAY transition.
    Once a slide enters BUILDING, it cannot return to PLANNING.
    This is enforced in state.js via lockSlideIntoBuild().
    """

    status: str = "PLANNING"

    # Snapshot + audit
    snapshot_b64: str | None = None
    audit: VisionAuditResult | None = None

    # History of HTML versions (for comparison view)
    history: list[str] = []   # list of past HTML versions

    # Locked = approved, no more changes except explicit regeneration
    locked: bool = False

    # Auto-fix attempt count (max = 1 to prevent infinite loops)
    auto_fix_attempts: int = 0
    max_auto_fix_attempts: int = 1

    def can_auto_fix(self) -> bool:
        return self.auto_fix_attempts < self.max_auto_fix_attempts

    def record_auto_fix(self) -> None:
        self.auto_fix_attempts += 1
