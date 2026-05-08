"""
Outline generation prompt.

Reads from the synthesized deck_context (not raw input directly).
"""

OUTLINE_SYSTEM = (
    "You are a presentation architect. "
    "Return only valid JSON — no markdown fences, no explanation."
)

OUTLINE_PROMPT = """You are building a slide deck presentation.

=== SYNTHESIZED CONTEXT ===
Topic: {topic}
Audience: {audience}
Tone: {tone}
Key themes: {key_themes}
Key facts to include: {key_facts}
Narrative arc: {narrative_arc}

=== HARD CONSTRAINTS (NON-NEGOTIABLE — every slide MUST respect ALL of these) ===
{hard_constraints}

=== STYLE ===
Theme: {theme}
Palette: {palette}
Fonts: {fonts}
Layout preference: {layout_preference}

=== TASK ===
Generate a slide outline as a JSON array.
Return ONLY the raw JSON array — no text before or after, no markdown code fences.

Each slide object MUST have these exact keys:
- "index": integer starting at 1
- "title": string, the slide heading
- "intent": one of: title-hero, explain-concept, explain-mechanism, show-example, compare, list-points, code-walkthrough, summary, creative-visual, narrative-break
- "key_points": array of 2-5 strings — what this slide MUST cover
- "layout_hint": string describing the visual arrangement (e.g. "asymmetrical-overlap", "dark-mode-hero", "split-diagonal", etc.)

Rules:
- Generate exactly {preferred_slides} slides total.
- You are a master storyteller. Don't stick to boring corporate structures.
- Use 'creative-visual' for high-impact, low-text slides.
- Use 'narrative-break' for transitional moments or bold quotes.
- Vary the intent and layout frequently to keep the audience engaged.
- Each slide covers different content — never repeat a key point.
"""


def build_outline_prompt(ctx: dict, theme: str, preferred_slides: int = 8) -> str:
    style = ctx.get("style_intent", {})
    constraints = ctx.get("hard_constraints", [])
    
    palette = ", ".join(style.get("extracted_palette", [])) or "not specified"
    fonts = ", ".join(style.get("extracted_fonts", [])) or "not specified"

    return OUTLINE_PROMPT.format(
        topic=ctx.get("topic", ""),
        audience=ctx.get("audience", "general audience"),
        tone=ctx.get("tone", "professional"),
        key_themes=", ".join(ctx.get("key_themes", [])) or "none specified",
        key_facts="\n".join(f"- {f}" for f in ctx.get("key_facts", [])) or "none specified",
        narrative_arc=ctx.get("narrative_arc", ""),
        hard_constraints=(
            "\n".join(f"- {c}" for c in constraints) if constraints else "none"
        ),
        theme=theme,
        palette=palette,
        fonts=fonts,
        layout_preference=style.get("layout_preference", "no preference"),
        preferred_slides=preferred_slides,
    )
