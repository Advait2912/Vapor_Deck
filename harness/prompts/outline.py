"""
Outline generation prompt.

Reads from the synthesized deck_context (not raw input directly).

Two builders:
  - build_outline_prompt()           — original, text-only path (unchanged)
  - build_multimodal_outline_prompt() — new path used when images or documents
                                        are present in the session
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


# ── Multimodal outline prompt (new — used when images or docs are uploaded) ───

MULTIMODAL_OUTLINE_PROMPT = """You are building a slide deck presentation.

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

{document_context_section}

{image_assets_section}

=== TASK ===
Generate a slide outline as a JSON array.
Return ONLY the raw JSON array — no text before or after, no markdown code fences.

Each slide object MUST have these exact keys:
- "index": integer starting at 1
- "title": string, the slide heading
- "intent": one of: title-hero, explain-concept, explain-mechanism, show-example, compare, list-points, code-walkthrough, summary, creative-visual, narrative-break
- "key_points": array of 2-5 strings — what this slide MUST cover
- "layout_hint": string describing the visual arrangement (e.g. "asymmetrical-overlap", "dark-mode-hero", "split-diagonal", etc.)
- "assigned_images": array of image filenames (from the UPLOADED IMAGE ASSETS section above) that belong on this slide — use [] if no uploaded image fits this slide

Rules for slide count:
- Generate exactly {preferred_slides} slides.
- Only deviate from this count if the document content is extremely dense and requires more slides to cover the facts accurately.
- Avoid 'fluff' slides just to meet the count; combine or split as needed for logical flow.

Rules for image assignment:
- Assign each image to AT MOST ONE slide (no duplicates across slides).
- Only assign an image to a slide if its content_description is genuinely relevant to that slide's topic.
- If no uploaded image is relevant to a slide, use "assigned_images": [].
- Do not force images onto slides where they do not fit.

Rules for content:
- You are a master storyteller. Don't stick to boring corporate structures.
- Use 'creative-visual' for high-impact, low-text slides.
- Use 'narrative-break' for transitional moments or bold quotes.
- Vary the intent and layout frequently to keep the audience engaged.
- Each slide covers different content — never repeat a key point.
- Ground slide key_points in the actual document facts and key_facts listed above.
"""


def build_outline_prompt(ctx: dict, theme: str, preferred_slides: int = 8) -> str:
    """Original text-only outline prompt builder. Unchanged."""
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


def build_multimodal_outline_prompt(
    ctx: dict,
    theme: str,
    image_units: list,
    doc_units: list,
    preferred_slides: int = 8,
) -> str:
    """
    Multimodal outline prompt builder.

    Used when the session contains uploaded images and/or documents.
    Injects:
      - Compact document semantic summaries (doc_summary)
      - Image content descriptions and filenames (for LLM-driven slide assignment)

    Parameters
    ----------
    ctx            : synthesized deck_context dict
    theme          : session theme string
    image_units    : list of InputUnit objects with input_type in image extensions
    doc_units      : list of InputUnit objects with input_type in doc extensions
    preferred_slides : soft hint for slide count
    """
    style = ctx.get("style_intent", {})
    constraints = ctx.get("hard_constraints", [])

    palette = ", ".join(style.get("extracted_palette", [])) or "not specified"
    fonts = ", ".join(style.get("extracted_fonts", [])) or "not specified"

    # ── Build document context section ────────────────────────────────────────
    document_context_section = _build_document_context_section(doc_units)

    # ── Build image assets section ────────────────────────────────────────────
    image_assets_section = _build_image_assets_section(image_units)

    return MULTIMODAL_OUTLINE_PROMPT.format(
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
        document_context_section=document_context_section,
        image_assets_section=image_assets_section,
        preferred_slides=preferred_slides,
    )


# ── Private helpers ───────────────────────────────────────────────────────────

def _build_document_context_section(doc_units: list) -> str:
    """Build the === DOCUMENT CONTEXT === block from document InputUnits."""
    if not doc_units:
        return ""

    lines = ["=== DOCUMENT CONTEXT (use these facts to ground your slide content) ==="]
    for unit in doc_units:
        fname = unit.filename or "document"
        ds = unit.doc_summary

        if ds and isinstance(ds, dict):
            summary = ds.get("summary", "")
            topics = ds.get("key_topics", [])
            facts = ds.get("key_facts", [])

            lines.append(f"\nDocument: {fname}")
            if summary:
                lines.append(f"  Summary: {summary}")
            if topics:
                lines.append(f"  Key topics: {', '.join(topics[:8])}")
            if facts:
                lines.append("  Key facts:")
                for fact in facts[:12]:
                    lines.append(f"    - {fact}")
        else:
            # No LLM summary available — use visual_summary fallback if any
            lines.append(f"\nDocument: {fname} (no semantic summary available)")

    lines.append("=== END DOCUMENT CONTEXT ===\n")
    return "\n".join(lines)


def _build_image_assets_section(image_units: list) -> str:
    """Build the === UPLOADED IMAGE ASSETS === block from image InputUnits."""
    if not image_units:
        return ""

    lines = [
        "=== UPLOADED IMAGE ASSETS ===",
        "These images are stored in the project's assets/ folder.",
        "Your job is to assign each image to the slide it best belongs on.",
        "Use the filename exactly as shown in the 'assigned_images' key of the slide.",
        "",
    ]

    for unit in image_units:
        fname = unit.filename or "unknown"
        content_desc = unit.content_description or unit.visual_summary or "No description available."
        style_kws = unit.style_keywords or []
        kw_str = ", ".join(style_kws) if style_kws else "none"

        lines.append(f"  Filename: {fname}")
        lines.append(f"  Content: {content_desc}")
        lines.append(f"  Tags: {kw_str}")
        lines.append("")

    lines.append("=== END IMAGE ASSETS ===\n")
    return "\n".join(lines)
