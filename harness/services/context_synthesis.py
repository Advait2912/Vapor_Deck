"""
Context synthesis service.

Converts a session's list of InputUnits into a single structured deck_context dict.
This is the bridge between "raw inputs" and "slide generation".

Pipeline:
  1. Separate units by role
  2. Extract hard constraints verbatim (no LLM needed)
  3. Gather style signals from design_style units
  4. Collect reference text chunks (token-budget aware)
  5. Single LLM synthesis call → returns structured JSON
"""
import json
import logging
from models.session import DeckSession
from models.input_unit import InputUnit
from services.stream_utils import collect_stream, strip_fences

logger = logging.getLogger("synthesis")

SYNTHESIS_SYSTEM = (
    "You synthesize inputs for a slide deck generation pipeline. "
    "Return only valid JSON — no markdown, no explanation."
)

SYNTHESIS_PROMPT = """You are synthesizing diverse inputs to build a presentation.

=== TOPIC / SUBJECT ===
{topic_text}

=== REFERENCE CONTENT (draw facts and examples from this) ===
{reference_text}

=== HARD CONSTRAINTS (NON-NEGOTIABLE — every slide must follow ALL of these) ===
{constraints_text}

=== STYLE SIGNALS FROM UPLOADED DESIGN FILES ===
Color palette detected: {palette}
Font hints: {fonts}
Layout patterns observed: {layout_hints}

Return ONLY this JSON:
{{
  "topic": "concise topic title",
  "audience": "inferred target audience",
  "tone": "inferred tone (e.g. technical, casual, executive)",
  "key_themes": ["3-6 major themes found in the references"],
  "key_facts": ["important facts, stats, or claims to include"],
  "narrative_arc": "1-2 sentences describing the story the deck should tell",
  "hard_constraints": {constraints_json},
  "style_intent": {{
    "suggested_theme": "dark-tech OR clean-light OR brutalist",
    "color_notes": "brief note on colors",
    "layout_preference": "brief note on preferred layout style"
  }}
}}"""


async def synthesize_context(session: DeckSession, model) -> dict:
    """
    Build deck_context from all InputUnits in the session.
    Returns the structured context dict.
    """
    units_by_role: dict[str, list[InputUnit]] = {}
    for unit in session.input_units:
        units_by_role.setdefault(unit.role, []).append(unit)

    # 1. Topic text
    topic_parts = []
    for unit in units_by_role.get("topic", []):
        topic_parts.extend(c.text for c in unit.chunks[:3])
    topic_text = "\n".join(topic_parts) or "(not provided — infer from references)"

    # 2. Hard constraints (verbatim — no LLM processing)
    constraints: list[str] = []
    for unit in units_by_role.get("instruction", []):
        constraints.extend(unit.instructions_parsed)
    constraints_text = (
        "\n".join(f"- {c}" for c in constraints) if constraints else "none"
    )

    # 3. Style signals
    palette: list[str] = []
    fonts: list[str] = []
    layout_hints: list[str] = []
    for unit in units_by_role.get("design_style", []):
        palette.extend(unit.color_palette)
        fonts.extend(unit.font_hints)
        layout_hints.extend(unit.layout_hints)

    # 4. Reference content — token-budget aware (max 6000 tokens)
    ref_chunks: list[str] = []
    budget_used = 0
    BUDGET = 6000
    for unit in units_by_role.get("reference", []):
        for chunk in unit.chunks:
            if budget_used + chunk.token_count > BUDGET:
                break
            ref_chunks.append(chunk.text)
            budget_used += chunk.token_count

    reference_text = "\n\n---\n\n".join(ref_chunks) or "(no reference documents uploaded)"

    logger.info(
        f"Synthesis: topic_units={len(units_by_role.get('topic', []))} "
        f"ref_units={len(units_by_role.get('reference', []))} "
        f"ref_tokens={budget_used} "
        f"constraints={len(constraints)} "
        f"design_units={len(units_by_role.get('design_style', []))}"
    )

    # 5. LLM synthesis call
    prompt = SYNTHESIS_PROMPT.format(
        topic_text=topic_text,
        reference_text=reference_text[:24000],  # char safety cap
        constraints_text=constraints_text,
        constraints_json=json.dumps(constraints),
        palette=palette[:6] or "none detected",
        fonts=fonts[:4] or "none detected",
        layout_hints=layout_hints[:4] or "none detected",
    )

    raw = await collect_stream(
        model,
        [{"role": "user", "content": prompt}],
        SYNTHESIS_SYSTEM,
    )

    try:
        ctx = json.loads(strip_fences(raw))
    except Exception as e:
        logger.error(f"Synthesis JSON parse failed: {e}\nRaw: {raw[:500]}")
        # Fallback: construct minimal context from what we have
        ctx = {
            "topic": topic_text[:100] or "Untitled Presentation",
            "audience": "general",
            "tone": "professional",
            "key_themes": [],
            "key_facts": [],
            "narrative_arc": "",
            "hard_constraints": constraints,
            "style_intent": {
                "suggested_theme": session.theme,
                "color_notes": "",
                "layout_preference": "",
            },
        }

    # Merge raw extracted style signals into the LLM output
    ctx.setdefault("style_intent", {})
    ctx["style_intent"]["extracted_palette"] = palette[:6]
    ctx["style_intent"]["extracted_fonts"] = fonts[:4]
    ctx["input_unit_count"] = len(session.input_units)
    ctx["reference_tokens_used"] = budget_used

    return ctx


def get_relevant_chunks(
    session: DeckSession,
    slide_intent: str,
    max_tokens: int = 1500,
) -> str:
    """
    Return reference text chunks most relevant to a specific slide's intent.
    Uses simple keyword overlap scoring (replace with embeddings later).
    """
    intent_words = set(slide_intent.lower().split())
    scored: list[tuple[int, str]] = []

    for unit in session.input_units:
        if unit.role not in ("reference",):
            continue
        for chunk in unit.chunks:
            overlap = len(intent_words & set(chunk.text.lower().split()))
            scored.append((overlap, chunk.text, chunk.token_count))

    scored.sort(key=lambda x: -x[0])

    result, used = [], 0
    for _, text, token_count in scored:
        if used + token_count > max_tokens:
            break
        result.append(text)
        used += token_count

    return "\n\n".join(result)
