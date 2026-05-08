"""
Image extractor.

Handles PNG, JPG, WEBP, SVG.
Does three things:
  1. Sends image to vision LLM for structured design analysis
  2. Extracts a dominant color palette using Pillow quantize
  3. Stores image as base64 for later slide reference
"""
import base64
import io
import json
import uuid
from hashlib import sha256
from datetime import datetime, timezone

from models.input_unit import InputUnit
from services.stream_utils import strip_fences


VISION_DESIGN_PROMPT = """Analyze this design image. It may be a brand identity sheet, UI mockup,
slide template, color swatch, or any visual reference.

Return ONLY this JSON (no markdown fences, no explanation):
{
  "visual_summary": "one sentence describing what this image shows",
  "layout_hints": ["list of layout observations, e.g. 'two-column', 'hero image left'"],
  "font_hints": ["font names if visible, e.g. 'Helvetica Neue'"],
  "style_keywords": ["e.g. 'minimal', 'bold', 'dark', 'corporate'"],
  "suggested_theme": "dark-tech OR clean-light OR brutalist"
}"""


async def extract_image(
    session_id: str,
    file_bytes: bytes,
    filename: str,
    vision_model,
) -> InputUnit:
    """
    Extract design signals from an image file.
    vision_model must implement BaseProvider.vision_audit().
    """
    file_hash = sha256(file_bytes).hexdigest()
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else "png"
    b64 = base64.b64encode(file_bytes).decode()

    # 1. Vision LLM analysis
    try:
        raw_audit = await vision_model.vision_audit(VISION_DESIGN_PROMPT, b64)
        audit = json.loads(strip_fences(raw_audit))
    except Exception as e:
        audit = {
            "visual_summary": f"Image uploaded ({filename}), vision analysis failed: {e}",
            "layout_hints": [],
            "font_hints": [],
            "style_keywords": [],
            "suggested_theme": None,
        }

    # 2. Color palette via Pillow
    hex_colors = _extract_palette(file_bytes)

    return InputUnit(
        unit_id=str(uuid.uuid4()),
        session_id=session_id,
        file_hash=file_hash,
        input_type=ext,
        role="reference",
        filename=filename,
        raw_path=f"sessions/{session_id}/assets/{filename}",
        visual_summary=audit.get("visual_summary"),
        layout_hints=audit.get("layout_hints", []),
        font_hints=audit.get("font_hints", []),
        color_palette=hex_colors,
        chunks=[],         # images have no text chunks
        token_budget=0,
        created_at=datetime.now(timezone.utc).isoformat(),
    )


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
