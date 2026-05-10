"""
Document extractor.

Handles PDF and DOCX files.
- PDF: uses pymupdf (fitz) — preserves page numbers
- DOCX: uses python-docx

After raw text extraction, makes ONE LLM call to produce a compact semantic
summary (summary, key_topics, key_facts) stored in InputUnit.doc_summary.
This is used during multimodal outline generation so the LLM knows the
document's content without needing to re-read all chunks.

Retry policy: 1 automatic retry on transient LLM / JSON failures (1s delay).
Falls back to a plaintext excerpt on persistent failure — never crashes upload.
"""
import asyncio
import io
import json
import logging
import uuid
from hashlib import sha256
from datetime import datetime, timezone

from models.input_unit import InputUnit, InputRole
from services.extractors.chunker import chunk_text, estimate_tokens
from services.stream_utils import collect_stream, strip_fences

logger = logging.getLogger("document_extractor")

DOC_SUMMARY_SYSTEM = (
    "You extract structured semantic summaries from document text for a slide deck pipeline. "
    "Return only valid JSON — no markdown fences, no explanation."
)

DOC_SUMMARY_PROMPT = """Analyze the following document content and return a compact semantic summary.

=== DOCUMENT TEXT (excerpt) ===
{text_excerpt}

Return ONLY this JSON:
{{
  "summary": "2-3 sentence overview of what this document is about",
  "key_topics": ["4-8 major topics or concepts covered"],
  "key_facts": ["6-12 important facts, statistics, claims, or data points from the document"]
}}"""


async def extract_document(
    session_id: str,
    file_bytes: bytes,
    filename: str,
    role: InputRole = "reference",
    model=None,
) -> InputUnit:
    """
    Extract text from a PDF or DOCX file into an InputUnit.
    If a model is provided, also generates a compact semantic summary (doc_summary).
    Role must be provided by the caller (no auto-detection for documents).
    """
    file_hash = sha256(file_bytes).hexdigest()
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "bin"
    raw_chunks = []

    if ext == "pdf":
        raw_chunks = _extract_pdf(file_bytes)
    elif ext in ("docx", "doc"):
        raw_chunks = _extract_docx(file_bytes)
    else:
        raise ValueError(f"Unsupported document format: .{ext}. Use PDF or DOCX.")

    # Build semantic summary if a model is provided
    doc_summary = None
    if model is not None and raw_chunks:
        doc_summary = await _build_doc_summary(raw_chunks, filename, model)

    return InputUnit(
        unit_id=str(uuid.uuid4()),
        session_id=session_id,
        file_hash=file_hash,
        input_type=ext,
        role=role,
        filename=filename,
        chunks=raw_chunks,
        token_budget=sum(c.token_count for c in raw_chunks),
        doc_summary=doc_summary,
        created_at=datetime.now(timezone.utc).isoformat(),
    )


async def _build_doc_summary(raw_chunks, filename: str, model) -> dict | None:
    """
    Call the LLM once to produce a compact semantic summary of the document.
    Retries once on failure before falling back to a plaintext excerpt.
    Returns a dict with keys: summary, key_topics, key_facts.
    """
    # Build a ~4000-char excerpt from the first few chunks (token-budget aware)
    excerpt_parts = []
    char_budget = 4000
    for chunk in raw_chunks:
        if len("\n\n".join(excerpt_parts)) >= char_budget:
            break
        excerpt_parts.append(chunk.text)
    text_excerpt = "\n\n".join(excerpt_parts)[:char_budget]

    prompt = DOC_SUMMARY_PROMPT.format(text_excerpt=text_excerpt)

    for attempt in range(2):
        try:
            raw = await collect_stream(
                model,
                [{"role": "user", "content": prompt}],
                DOC_SUMMARY_SYSTEM,
            )
            result = json.loads(strip_fences(raw))
            if not isinstance(result, dict):
                raise ValueError("Doc summary response is not a JSON object")
            logger.info(f"[document_extractor] semantic summary ok for '{filename}' (attempt {attempt + 1})")
            return result
        except Exception as e:
            if attempt == 0:
                logger.warning(
                    f"[document_extractor] summary attempt 1 failed for '{filename}': {e}. Retrying in 1s…"
                )
                await asyncio.sleep(1)
            else:
                logger.error(
                    f"[document_extractor] summary failed for '{filename}' after 2 attempts: {e}. "
                    "Using plaintext fallback."
                )

    # Graceful fallback — use the raw text excerpt so outline still benefits
    return {
        "summary": text_excerpt[:500],
        "key_topics": [],
        "key_facts": [],
    }


def _extract_pdf(file_bytes: bytes):
    """Extract text from PDF, preserving page numbers in each chunk."""
    import fitz  # pymupdf

    doc = fitz.open(stream=file_bytes, filetype="pdf")
    all_chunks = []

    for page_num, page in enumerate(doc, start=1):
        text = page.get_text()
        if not text.strip():
            continue
        page_chunks = chunk_text(text)
        for chunk in page_chunks:
            chunk.source_page = page_num
        all_chunks.extend(page_chunks)

    doc.close()
    return all_chunks


def _extract_docx(file_bytes: bytes):
    """Extract text from DOCX, paragraph by paragraph."""
    from docx import Document

    doc = Document(io.BytesIO(file_bytes))
    full_text = "\n".join(
        p.text for p in doc.paragraphs if p.text.strip()
    )
    return chunk_text(full_text)
