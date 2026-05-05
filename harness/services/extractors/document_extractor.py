"""
Document extractor.

Handles PDF and DOCX files.
- PDF: uses pymupdf (fitz) — preserves page numbers
- DOCX: uses python-docx
"""
import io
import uuid
from hashlib import sha256
from datetime import datetime, timezone

from models.input_unit import InputUnit, InputRole
from services.extractors.chunker import chunk_text, estimate_tokens


async def extract_document(
    session_id: str,
    file_bytes: bytes,
    filename: str,
    role: InputRole = "reference",
) -> InputUnit:
    """
    Extract text from a PDF or DOCX file into an InputUnit.
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

    return InputUnit(
        unit_id=str(uuid.uuid4()),
        session_id=session_id,
        file_hash=file_hash,
        input_type=ext,
        role=role,
        filename=filename,
        chunks=raw_chunks,
        token_budget=sum(c.token_count for c in raw_chunks),
        created_at=datetime.now(timezone.utc).isoformat(),
    )


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
