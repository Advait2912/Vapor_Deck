"""
AUDIT MODEL
────────────
Result type for vision-model slide audits.

Verdicts:
  good       → layout looks clean and professional
  fixable    → minor issues; refine_prompt is set for user-triggered fix
  regenerate → significant layout problems; refine_prompt explains the issues
  audit_failed → vision model errored or timed out
"""
from __future__ import annotations
from pydantic import BaseModel


class VisionAuditResult(BaseModel):
    """Result of a vision model inspecting a slide screenshot."""

    verdict: str = "good"  # "good" | "fixable" | "regenerate"
    visual_issues: list[str] = []
    refine_prompt: str | None = None  # Ready-to-use refinement instruction for the user

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

    def needs_fix(self) -> bool:
        return self.verdict in ("fixable", "regenerate")

