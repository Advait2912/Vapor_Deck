"""
Phase 2: Asset Router

After an image is uploaded (role=asset) and an outline already exists,
this service asks the vision model to assign the image to the most
relevant slide(s) in the outline.

Returns (primary_index, [secondary_indices]) — all 0-based.
"""
import json
import logging
from models.session import OutlineItem
from models.input_unit import InputUnit
from services.stream_utils import collect_stream, strip_fences

logger = logging.getLogger("asset_router")

ROUTER_SYSTEM = "You are a presentation asset router. Reply with JSON only."

ROUTER_PROMPT = """Assign this uploaded image to the most relevant slides in a presentation outline.

=== IMAGE ===
Filename: {filename}
Visual description: {visual_summary}
Style keywords: {style_keywords}

=== SLIDE OUTLINE ===
{slide_list}

Which slide(s) should this image appear in?
- "primary": the single best matching slide number (1-N), or null if no good match
- "secondary": up to 2 other slide numbers where it could also appear (can be empty)

Reply with JSON only — no markdown, no explanation:
{{"primary": 3, "secondary": [5]}}"""


async def route_asset(
    outline_items: list[OutlineItem],
    unit: InputUnit,
    model,
) -> tuple[int | None, list[int]]:
    """
    Returns (primary_0based_index, [secondary_0based_indices]).
    Returns (None, []) if no relevant slide found.
    """
    if not outline_items:
        logger.debug("[asset_router] no outline items — skipping routing")
        return None, []

    slide_list = "\n".join(
        f"  {i+1}. [{item.arc_position or 'middle'}] {item.title}: "
        f"{item.key_points[0] if item.key_points else '(no key points)'}"
        for i, item in enumerate(outline_items)
    )

    prompt = ROUTER_PROMPT.format(
        filename=unit.filename or "unknown",
        visual_summary=unit.visual_summary or "(no vision analysis available)",
        style_keywords=", ".join(unit.style_keywords) or "(none)",
        slide_list=slide_list,
    )

    logger.debug(
        f"[asset_router] routing '{unit.filename}' across {len(outline_items)} slides"
    )

    try:
        raw = await collect_stream(
            model,
            [{"role": "user", "content": prompt}],
            ROUTER_SYSTEM,
        )
        data = json.loads(strip_fences(raw))

        primary_1based = data.get("primary")
        secondary_1based = data.get("secondary", []) or []

        # Convert to 0-based, validate bounds
        n = len(outline_items)
        primary_idx = (
            int(primary_1based) - 1
            if primary_1based and 1 <= int(primary_1based) <= n
            else None
        )
        secondary_idx = [
            int(s) - 1
            for s in secondary_1based
            if s and 1 <= int(s) <= n
        ]

        logger.info(
            f"[asset_router] '{unit.filename}' → "
            f"primary=slide{(primary_idx+1) if primary_idx is not None else 'None'} "
            f"secondary={[s+1 for s in secondary_idx]}"
        )
        return primary_idx, secondary_idx

    except Exception as e:
        logger.warning(
            f"[asset_router] routing failed for '{unit.filename}': {e} "
            f"— raw response: {raw[:200] if 'raw' in dir() else '(no response)'}"
        )
        return None, []
