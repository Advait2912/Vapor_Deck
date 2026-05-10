from __future__ import annotations
from pydantic import BaseModel, Field
import uuid

from .input_unit import InputUnit


class OutlineItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    index: int
    title: str
    intent: str  # title-hero | explain-concept | explain-mechanism | show-example | compare | list-points | code-walkthrough | summary
    key_points: list[str]
    layout_hint: str  # single-column | two-column | code-left | hero-centered | bullet-list
    assigned_images: list[str] = []  # filenames assigned by LLM during multimodal outline generation


class SlideData(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    index: int
    title: str
    html: str
    snapshot_b64: str | None = Field(default=None, exclude=True)
    snapshot_url: str | None = None  # BUG 17: FS-based storage
    audit: dict | None = None  # BUG 3: Persistent VisionAuditResult
    approved: bool = False
    status: str = "draft"  # draft | approved | refining
    metadata: dict = {}    # stores state, planning, etc.
    refinements: list[str] = Field(default_factory=list) # Persisted list of manual user instructions


class DeckSession(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

    # Status lifecycle:
    # idle → synthesizing → synthesized → outlining → reviewing_outline → generating → done
    status: str = "idle"
    mode: str = "plan"  # plan | build

    # Model config
    text_model: str = "ollama/deepseek-v4-flash:cloud"
    vision_model: str = "ollama/qwen3-vl:235b-cloud"
    theme: str = "dark-tech"

    # ── Input layer ────────────────────────────────────────────────────────────
    input_units: list[InputUnit] = []
    input_hash_index: dict[str, str] = {}  # file_hash → unit_id (dedup)

    # ── Derived context (built by POST /synthesize) ────────────────────────────
    topic: str = ""
    hard_constraints: list[str] = []       # from instruction-role units
    deck_context: dict = {}                # full synthesized context JSON

    # ── Design Config ──────────────────────────────────────────────────────────
    design_config: dict = {}               # Loaded from / saved to design.json

    # ── Deck generation state ──────────────────────────────────────────────────
    outline: list[OutlineItem] = []
    slides: list[SlideData] = []
    current_index: int = 0
