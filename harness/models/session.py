from __future__ import annotations
from pydantic import BaseModel, Field
import uuid

from .input_unit import InputUnit


class OutlineItem(BaseModel):
    index: int
    title: str
    intent: str  # title-hero | explain-concept | explain-mechanism | show-example | compare | list-points | code-walkthrough | summary
    key_points: list[str]
    layout_hint: str  # single-column | two-column | code-left | hero-centered | bullet-list


class SlideData(BaseModel):
    index: int
    title: str
    html: str
    snapshot_b64: str | None = None
    approved: bool = False
    status: str = "draft"  # draft | approved | refining
    metadata: dict = {}    # stores state, planning, etc.


class DeckSession(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))

    # Status lifecycle:
    # idle → synthesizing → synthesized → outlining → reviewing_outline → generating → done
    status: str = "idle"

    # Model config
    text_model: str = "google/gemini-2.0-flash"
    vision_model: str = "google/gemini-2.0-flash"
    theme: str = "dark-tech"

    # ── Input layer ────────────────────────────────────────────────────────────
    input_units: list[InputUnit] = []
    input_hash_index: dict[str, str] = {}  # file_hash → unit_id (dedup)

    # ── Derived context (built by POST /synthesize) ────────────────────────────
    topic: str = ""
    derived_color_palette: list[str] = []
    derived_font_hints: list[str] = []
    hard_constraints: list[str] = []       # from instruction-role units
    deck_context: dict = {}                # full synthesized context JSON

    # ── Deck generation state ──────────────────────────────────────────────────
    outline: list[OutlineItem] = []
    slides: list[SlideData] = []
    current_index: int = 0
