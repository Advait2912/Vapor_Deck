"""
Upload route.

POST /api/session/{session_id}/upload
  - Accepts any file (text, PDF, DOCX, image)
  - Deduplicates by SHA-256 hash
  - Dispatches to the correct extractor
  - Saves raw file to sessions/{id}/assets/

POST /api/session/{session_id}/upload/text
  - Accepts raw text in JSON body (topic, reference, or instruction)
"""
import logging
import os
from hashlib import sha256
from pathlib import Path

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session, get_project_dir
from services.extractors.text_extractor import extract_text
from services.extractors.document_extractor import extract_document
from services.extractors.image_extractor import extract_image

logger = logging.getLogger("upload")
router = APIRouter()

IMAGE_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "svg"}
DOC_EXTS = {"pdf", "docx", "doc"}


class TextUploadRequest(BaseModel):
    text: str
    role: str | None = None  # "topic" | "reference" | "instruction" | None (auto-detect)


@router.post("/session/{session_id}/upload/text")
async def upload_text(session_id: str, req: TextUploadRequest):
    """Upload raw text content — topic, reference, or instruction."""
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if not req.text.strip():
        raise HTTPException(status_code=400, detail="Text content is empty")

    file_hash = sha256(req.text.encode("utf-8")).hexdigest()

    # Dedup check
    if file_hash in session.input_hash_index:
        existing_id = session.input_hash_index[file_hash]
        return {"status": "duplicate", "unit_id": existing_id, "skipped": True}

    model = get_model(session.text_model)

    # Validate role if provided
    valid_roles = {"topic", "reference", "instruction", None}
    role = req.role if req.role in valid_roles else None

    unit = await extract_text(session_id, req.text, model, role=role)

    session.input_units.append(unit)
    session.input_hash_index[file_hash] = unit.unit_id
    save_session(session)

    logger.info(
        f"[{session_id}] text uploaded: role={unit.role} "
        f"chunks={len(unit.chunks)} tokens={unit.token_budget}"
    )

    return {
        "status": "ok",
        "unit_id": unit.unit_id,
        "role": unit.role,
        "type": unit.input_type,
        "chunks": len(unit.chunks),
        "token_budget": unit.token_budget,
    }


@router.post("/session/{session_id}/upload")
async def upload_file(
    session_id: str,
    file: UploadFile = File(...),
    role: str = Form(default="reference"),
):
    """Upload a file — PDF, DOCX, or image."""
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    raw_bytes = await file.read()
    if not raw_bytes:
        raise HTTPException(status_code=400, detail="Uploaded file is empty")

    file_hash = sha256(raw_bytes).hexdigest()

    # Dedup check
    if file_hash in session.input_hash_index:
        existing_id = session.input_hash_index[file_hash]
        return {"status": "duplicate", "unit_id": existing_id, "skipped": True}

    filename = file.filename or "upload"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    # Save raw file to disk in the project assets folder
    project_dir = get_project_dir()
    asset_dir = project_dir / "assets"
    asset_dir.mkdir(parents=True, exist_ok=True)
    asset_path = asset_dir / filename
    asset_path.write_bytes(raw_bytes)

    # Dispatch to extractor
    model = get_model(session.text_model)
    vision_model = get_model(session.vision_model)

    if ext in DOC_EXTS:
        valid_roles = {"reference", "instruction"}
        effective_role = role if role in valid_roles else "reference"
        # Pass model so document extractor can produce a semantic summary at upload time
        unit = await extract_document(session_id, raw_bytes, filename, role=effective_role, model=model)
    elif ext in IMAGE_EXTS:
        # Images are always references now
        unit = await extract_image(session_id, raw_bytes, filename, vision_model)
        unit.role = "reference"
    else:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type .{ext}. Supported: PDF, DOCX, PNG, JPG, WEBP, SVG"
        )

    unit.raw_path = str(asset_path)
    session.input_units.append(unit)
    session.input_hash_index[file_hash] = unit.unit_id
    save_session(session)

    logger.info(
        f"[{session_id}] file uploaded: {filename} role={unit.role} "
        f"chunks={len(unit.chunks)} tokens={unit.token_budget}"
    )

    return {
        "status": "ok",
        "unit_id": unit.unit_id,
        "role": unit.role,
        "type": unit.input_type,
        "filename": filename,
        "chunks": len(unit.chunks),
        "token_budget": unit.token_budget,
    }


@router.get("/session/{session_id}/inputs")
async def list_inputs(session_id: str):
    """List all input units for a session."""
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    return {
        "session_id": session_id,
        "units": [
            {
                "unit_id": u.unit_id,
                "input_type": u.input_type,
                "role": u.role,
                "filename": u.filename,
                "chunks": len(u.chunks),
                "token_budget": u.token_budget,
                "created_at": u.created_at,
            }
            for u in session.input_units
        ],
        "total_tokens": sum(u.token_budget for u in session.input_units),
    }


