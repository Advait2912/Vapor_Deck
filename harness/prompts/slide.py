"""
Per-slide HTML generation prompt.

The LLM writes a complete <section class="slide"> block
including scoped <style> and interactive <script> tags.
"""

SLIDE_SYSTEM = (
    "You are a senior frontend developer generating slides for a web-native presentation. "
    "The slide is rendered in a FIXED 1280x720 pixel canvas. ALL content must fit within this viewport with NO scrolling — "
    "every element must be visible without any scroll interaction. Be ruthless about content density: fewer, impactful points beat many verbose ones. "
    "Return ONLY the <section> HTML element — nothing else. "
    "No markdown fences. No explanations. No surrounding HTML boilerplate."
)

SLIDE_PROMPT = """Generate one slide as a complete HTML <section class="slide"> element.

=== SLIDE SPEC ===
Slide {n} of {total}
Title: {title}
Intent: {intent}
Key points to cover:
{key_points}
Layout hint: {layout_hint}

=== DECK CONTEXT (what has already been covered — do NOT repeat or contradict) ===
{deck_context_summary}

=== RELEVANT REFERENCE CONTENT (draw from this if helpful) ===
{relevant_chunks}

{asset_list}
{brand_section}
=== STYLE RULES ===
Theme: {theme}
NEVER set width/height in px on the .slide element — it must fill its container fluidly.
All colours MUST be expressed through CSS custom properties — never use raw hex or rgb() on HTML elements directly.
Available variables: --bg, --surface, --text, --text-muted, --accent, --accent-glow, --code-bg, --border, --font-head, --font-body

If a BRAND ENFORCEMENT section appears above:
  → You MUST add a `section.slide {{ }}` block at the VERY TOP of your <style> tag that redefines these variables with the brand palette.
  → This is not optional. Every element that uses var(--accent), var(--bg) etc. will automatically inherit the brand colours.
  → The section-scoped override takes priority over the global theme without breaking any other slide.

=== OUTPUT RULES ===
1. Return ONLY the <section class="slide"> element — no wrapping HTML, no doctype
2. The .slide element MUST use:
     width: 100%; height: 100%;
     min-height: 100vh;
     box-sizing: border-box;
   NO fixed pixel dimensions on the root slide element.
3. All child layout must be responsive — use flexbox or grid with relative/percent/vh/vw units
4. Font sizes: use clamp() or vw-based units (e.g. clamp(1rem, 2.5vw, 2.5rem)) so text scales with viewport
5. Include a scoped <style> block inside the section for layout
6. For interactive elements (tabs, toggles), include a <script> block
7. Add class="reveal" and style="--delay: Xs" to animate elements in staggered sequence
8. Code blocks: use <pre><code class="language-{{lang}}"> with Prism.js class names
9. Images: only use CSS backgrounds or SVG — no external image URLs
10. The slide heading MUST match the title exactly: "{title}"

=== CANVAS CONSTRAINT (CRITICAL — READ CAREFULLY) ===
The slide renders inside a FIXED 1280x720 pixel browser viewport. This is like a PowerPoint slide — there is NO scrollbar and NO overflow.
RULES YOU MUST FOLLOW:
- NEVER set overflow-y: auto, overflow-y: scroll, or overflow: auto on any content container. Content must never need to scroll.
- NEVER use max-height with overflow on content boxes. Every element must be naturally visible.
- LIMIT bullet points: maximum 4 per column. If you have more content, reduce it — do NOT list everything.
- Keep body text SHORT: each bullet point should be one concise sentence, not a paragraph.
- Font sizes: body text minimum 0.9rem, maximum 1.1rem. Do not go smaller trying to fit more content.
- If you have two columns, each column should have at most 3-4 items.
- Headings: clamp(1.5rem, 3vw, 2.5rem). Do not make them larger or they eat into content space.
- Prefer visual hierarchy and white space over cramming in maximum text.
- If the content spec has more points than can fit cleanly, SUMMARIZE and MERGE them — never sacrifice readability for completeness.

=== INTENT GUIDANCE ===
{intent_guidance}
"""

INTENT_GUIDANCE = {
    "title-hero": "Large centered title. Subtitle with 1-2 short sentences. Optional decorative element. NO bullet points.",
    "explain-concept": "Clear heading. Maximum 2 short paragraphs or 3 callout boxes. Keep each text block to 1-2 sentences.",
    "explain-mechanism": "Step-by-step flow with maximum 4 steps. Use a visual diagram in CSS if possible. Each step: label + one sentence.",
    "show-example": "Heading + one concrete example. Code snippet if relevant. Maximum 3 annotations. No long explanations.",
    "compare": "Two-column layout. Maximum 3 items per column. Each item: bold label + one short sentence.",
    "list-points": "Heading + MAXIMUM 4 bullet points. Each bullet is ONE short sentence (under 15 words). Prioritize the most impactful points.",
    "code-walkthrough": "Code block takes 60% of space. Maximum 3 annotation callouts. Keep annotations brief.",
    "summary": "Heading 'Key Takeaways'. MAXIMUM 4 bullet points. One short sentence each. Optional closing statement.",
}


def _build_brand_section(style_intent: dict, theme: str = "dark-tech", topic: str = "", is_refinement: bool = False) -> str:
    """
    Build a BRAND ENFORCEMENT or THEMATIC STYLING prompt block.
    """
    palette      = style_intent.get("extracted_palette", [])
    fonts        = style_intent.get("extracted_fonts", [])
    color_notes  = style_intent.get("color_notes", "")
    layout_pref  = style_intent.get("layout_preference", "")

    is_dark_theme = any(t in theme.lower() for t in ["dark", "black", "night", "tech", "glass"])

    # Case A: Brand signals exist
    if palette or color_notes:
        status_text = "(GUIDELINE — maintain consistency)" if is_refinement else "(MANDATORY — apply to this slide)"
        lines = [
            "",
            f"=== BRAND ENFORCEMENT {status_text} ===",
            "A design reference image was provided. The visual identity below MUST be reflected.",
            "",
        ]
        if palette:
            palette_str = ", ".join(palette[:6])
            lines += [
                f"Extracted colour palette: {palette_str}",
                "",
                "ACTION: At the VERY TOP of your <style> block, define/override these variables:",
                "  section.slide {",
            ]
            
            if is_dark_theme:
                lines += [
                    "    /* Theme: DARK - ensure background is very dark for tech feel */",
                    f"    --bg:          {palette[0] if palette[0].startswith('#0') or palette[0].startswith('#1') else '#0a0b1e'}; /* Use darkest brand color or deep tech-black */",
                    f"    --surface:     {palette[0]}; /* Dark brand surface */",
                    f"    --accent:      {palette[1] if len(palette)>1 else palette[0]}; /* Vibrant brand highlight */",
                    f"    --text:        {palette[-1]}; /* Lightest brand colour */",
                ]
            else:
                lines += [
                    "    --bg:          <darkest palette colour — slide background>;",
                    "    --surface:     <second-darkest — panel / card backgrounds>;",
                    "    --accent:      <most vibrant / saturated brand colour>;",
                    "    --text:        <lightest colour readable as foreground text>;",
                ]
                
            lines += [
                "    --accent-glow: <rgba() version of accent at 0.3 opacity>;",
                "    --text-muted:  <muted text, 60–70% opacity blend of --text>;",
                "    --border:      <low-opacity palette colour>;",
                "  }",
            ]
        if color_notes:
            lines += [f"Colour intent from brand analysis: {color_notes}"]
    
    # Case B: No brand signals — infer from topic
    else:
        lines = [
            "",
            "=== THEMATIC STYLING (MANDATORY — apply to this slide) ===",
            f"Topic: {topic}",
            "No design reference provided. Infer a custom professional palette for this topic.",
            "",
            "REQUIRED ACTION: Define variables at the top of <style>:",
            "  section.slide {",
            "    --bg:          <thematic background>;",
            "    --surface:     <thematic panel/card background>;",
            "    --accent:      <vibrant thematic accent>;",
            "    --text:        <high contrast text>;",
            "    --accent-glow: <rgba() version of accent at 0.3 opacity>;",
            "    --border:      <divider/border colour>;",
            "  }",
        ]

    if is_refinement:
        lines += [
            "",
            "NOTE: Since this is a REFINEMENT, you may deviate from the specific palette mappings above",
            "if the user's specific instruction requires a different mood (e.g., 'make it darker' or 'change the accent').",
        ]

    if fonts:
        font_list = ", ".join(f"'{f}'" for f in fonts[:3])
        lines += ["", f"Font guidance: prefer {font_list} where available."]

    if layout_pref:
        lines += ["", f"Layout directive: {layout_pref}"]

    lines += ["", "=== END STYLING SECTION ===\n"]
    return "\n".join(lines)


def build_slide_prompt(
    n: int,
    total: int,
    title: str,
    intent: str,
    key_points: list[str],
    layout_hint: str,
    theme: str,
    deck_context: dict,
    relevant_chunks: str = "",
    asset_filenames: list[str] | None = None,
    is_refinement: bool = False,
) -> str:
    # Summarize deck context (narrative / terms / facts) — brand signals are
    # now handled by _build_brand_section, NOT included here to avoid duplication.
    ctx_summary  = _summarize_context(deck_context)
    key_points_str = "\n".join(f"- {p}" for p in key_points)
    guidance     = INTENT_GUIDANCE.get(intent, "Follow the intent as described.")

    # Extract brand signals from deck_context (look in 'synthesis' for Phase 1 output)
    synthesis = deck_context.get("synthesis", {})
    style_intent = synthesis.get("style_intent", deck_context.get("style_intent", {}))
    topic = synthesis.get("topic", deck_context.get("topic", ""))
    
    brand_section = _build_brand_section(style_intent, theme, topic, is_refinement)

    # Format the asset list section
    asset_section = _build_asset_section(asset_filenames)

    return SLIDE_PROMPT.format(
        n=n,
        total=total,
        title=title,
        intent=intent,
        key_points=key_points_str,
        layout_hint=layout_hint,
        deck_context_summary=ctx_summary or "This is the first slide.",
        relevant_chunks=relevant_chunks or "No reference content available.",
        theme=theme,
        brand_section=brand_section,
        asset_list=asset_section,
        intent_guidance=guidance,
    )


def _build_asset_section(filenames: list[str] | None) -> str:
    """Format the list of available local image assets for the prompt."""
    if not filenames:
        return ""
    
    asset_lines = [
        "=== AVAILABLE LOCAL ASSETS ===",
        "These images are stored locally in the project's assets/ folder.",
        "To include one in this slide, use exactly: <img src=\"/assets/filename\">",
        "Only use an image if it is directly relevant to this slide's content.",
        "",
        "Available filenames:"
    ]
    for f in filenames:
        asset_lines.append(f" - {f}")
    
    asset_lines.append("=== END ASSETS ===\n")
    return "\n".join(asset_lines)


def _summarize_context(ctx: dict) -> str:
    """
    Summarise the running deck narrative, defined terms, and facts already stated.
    Brand/design signals are intentionally excluded here — they live in the
    dedicated BRAND ENFORCEMENT section built by _build_brand_section().
    """
    if not ctx:
        return ""
    lines = []

    # Handle nested structure (from initial_deck_context)
    inner_ctx = ctx.get("context", ctx)

    slides = ctx.get("slides_summary", [])
    if slides:
        lines.append("Slides covered so far:")
        for s in slides:
            lines.append(f"  Slide {s['index']}: {s['title']} — covered: {', '.join(s.get('covered', []))}")

    terms = inner_ctx.get("key_terms_defined", [])
    if terms:
        lines.append(f"Terms already defined: {', '.join(terms)}")

    facts = inner_ctx.get("facts_stated", [])
    if facts:
        lines.append(f"Facts already stated: {'; '.join(facts[:3])}")

    narrative = inner_ctx.get("running_narrative", "")
    if narrative and narrative != "Presentation not yet started.":
        lines.append(f"Narrative so far: {narrative}")

    return "\n".join(lines)
