from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field
import uuid
from datetime import datetime, timezone


InputRole = Literal[
    "topic",        # the core subject — always one per session
    "reference",    # factual content to draw from (PDFs, docs, URLs, text)
    "instruction",  # hard rules the LLM must follow
]


class TextChunk(BaseModel):
    chunk_id: str = Field(default_factory=lambda: str(uuid.uuid4())[:8])
    text: str
    token_count: int
    source_page: int | None = None  # for PDFs


class InputUnit(BaseModel):
    unit_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    file_hash: str                          # SHA-256 — used for dedup
    input_type: str                         # "text", "pdf", "docx", "image", "url"
    role: InputRole
    filename: str | None = None
    raw_path: str | None = None             # path on disk in sessions/{id}/assets/

    # Extracted text content
    chunks: list[TextChunk] = []
    token_budget: int = 0                   # sum of all chunk token counts

    # Vision / design signals (images only)
    visual_summary: str | None = None
    content_description: str | None = None  # what the image SHOWS semantically (for outline assignment)
    style_keywords: list[str] = []          # semantic tags from vision analysis
    layout_hints: list[str] = []
    color_palette: list[str] = []           # hex colors
    font_hints: list[str] = []

    # Document semantic summary (documents only — produced once at upload time)
    doc_summary: dict | None = None         # {"summary": str, "key_topics": [...], "key_facts": [...]}

    # Instruction role only
    instructions_parsed: list[str] = []    # clean bullet-point rules

    created_at: str = Field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
