"""
Image extractor.

Handles PNG, JPG, WEBP, SVG.
Does three things:
  1. Sends image to vision LLM for structured dual-purpose analysis:
     - Design signals (palette, layout, fonts, style)
     - Semantic content description (what the image SHOWS — for outline assignment)
  2. Extracts a dominant color palette using Pillow quantize
  3. Stores image as base64 for later slide reference

Retry policy: 1 automatic retry on transient LLM / JSON failures (1s delay).
"""
import asyncio
import base64
import io
import json
import logging
import uuid
from hashlib import sha256
from datetime import datetime, timezone

from models.input_unit import InputUnit
from services.stream_utils import strip_fences

logger = logging.getLogger("image_extractor")

# Dual-purpose vision prompt:
#   Part A — design signals  (layout, palette, fonts, style keywords)
#   Part B — semantic content (what subject matter does this image depict?)
VISION_ANALYSIS_PROMPT = """Analyze this image carefully. It may be a diagram, chart, photo, UI mockup,
brand identity sheet, slide template, or any visual content.

Return ONLY this JSON (no markdown fences, no explanation):
{
  "visual_summary": "one sentence describing the overall visual appearance and style",
  "content_description": "one sentence describing WHAT this image shows — its subject matter, data, or concept (e.g. 'A bar chart comparing model accuracy across three architectures', 'A system diagram of a microservices pipeline'). Be specific and factual.",
  "style_keywords": ["2-5 semantic tags describing content type, e.g. 'architecture-diagram', 'benchmark-chart', 'product-photo', 'logo', 'infographic'"],
  "layout_hints": ["layout observations, e.g. 'two-column', 'hero image left', 'full-bleed'"],
  "font_hints": ["font names if visible, e.g. 'Helvetica Neue'"],
  "suggested_theme": "dark-tech OR clean-light OR brutalist"
}"""


async def extract_image(
    session_id: str,
    file_bytes: bytes,
    filename: str,
    vision_model,
) -> InputUnit:
    """
    Extract design signals and semantic content description from an image file.
    vision_model must implement BaseProvider.vision_audit().

    Retries once on transient LLM / JSON parse failures before using a safe fallback.
    """
    file_hash = sha256(file_bytes).hexdigest()
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
    b64 = base64.b64encode(file_bytes).decode()

    # Vision LLM analysis — with one retry
    audit = await _run_vision_with_retry(vision_model, b64, filename)

    # Color palette via Pillow
    hex_colors = _extract_palette(file_bytes)

    return InputUnit(
        unit_id=str(uuid.uuid4()),
        session_id=session_id,
        file_hash=file_hash,
        input_type=ext,
        role="reference",
        filename=filename,
        raw_path=f"sessions/{session_id}/assets/{filename}",
        # Design signals
        visual_summary=audit.get("visual_summary"),
        layout_hints=audit.get("layout_hints", []),
        font_hints=audit.get("font_hints", []),
        color_palette=hex_colors,
        # Semantic content signals (new — for multimodal outline assignment)
        content_description=audit.get("content_description"),
        style_keywords=audit.get("style_keywords", []),
        chunks=[],      # images have no text chunks
        token_budget=0,
        created_at=datetime.now(timezone.utc).isoformat(),
    )


async def _run_vision_with_retry(vision_model, b64: str, filename: str) -> dict:
    """
    Attempt vision analysis up to 2 times (1 retry on failure).
    Returns a populated audit dict or a graceful fallback — never raises.
    """
    for attempt in range(2):
        try:
            raw_audit = await vision_model.vision_audit(VISION_ANALYSIS_PROMPT, b64)
            audit = json.loads(strip_fences(raw_audit))
            # Validate the critical field we depend on
            if not isinstance(audit, dict):
                raise ValueError("Vision response is not a JSON object")
            logger.info(f"[image_extractor] vision analysis ok for '{filename}' (attempt {attempt + 1})")
            return audit
        except Exception as e:
            if attempt == 0:
                logger.warning(
                    f"[image_extractor] vision analysis attempt 1 failed for '{filename}': {e}. Retrying in 1s…"
                )
                await asyncio.sleep(1)
            else:
                logger.error(
                    f"[image_extractor] vision analysis failed for '{filename}' after 2 attempts: {e}. "
                    "Using fallback metadata."
                )

    # Graceful fallback — all fields present so downstream code never KeyErrors
    return {
        "visual_summary": f"Image uploaded ({filename}). Vision analysis unavailable.",
        "content_description": f"Contents of '{filename}' could not be determined automatically.",
        "style_keywords": [],
        "layout_hints": [],
        "font_hints": [],
        "suggested_theme": None,
    }


def _extract_palette(file_bytes: bytes, n_colors: int = 6) -> list[str]:
    """Extract dominant colors as hex strings using Pillow quantize."""
    try:
        from PIL import Image

        img = Image.open(io.BytesIO(file_bytes)).convert("RGB")
        img_small = img.resize((100, 100), Image.LANCZOS)
        quantized = img_small.quantize(colors=n_colors)
        palette = quantized.getpalette()[:n_colors * 3]
        return [
            f"#{palette[i]:02x}{palette[i+1]:02x}{palette[i+2]:02x}"
            for i in range(0, len(palette), 3)
        ]
    except Exception:
        return []
