"""
Per-slide HTML generation prompt.

The LLM writes a complete <section class="slide"> block
including scoped <style> and interactive <script> tags.
"""

SLIDE_SYSTEM = (
    "You are a visionary presentation designer and expert frontend developer. "
    "Your goal is to create web-native slides that look like high-end editorial magazines or premium tech landing pages. "
    "You have full creative freedom to use modern web APIs (CSS masks, filters, gradients, mix-blend-mode, SVG, transitions). "
    "Think in 'scenes' and 'visual narrative' rather than just slides and bullet points. "
    "Return ONLY the <section> HTML element — no fences, no chatter."
)

SLIDE_PROMPT = """Generate one stunning, web-native presentation slide as a complete <section class="slide"> element.

=== THE SCENE ===
Slide {n} of {total}
Title: {title}
Intent: {intent}
Key points to cover:
{key_points}
Visual Narrative Hint: {layout_hint}

=== DECK CONTEXT (ensure narrative flow) ===
{deck_context_summary}

=== REFERENCE KNOWLEDGE ===
{relevant_chunks}

{asset_list}
{brand_section}

=== DESIGN PRINCIPLES ===
1. THE VIEWPORT: The canvas is 1280x720. While you should avoid global scrolling, feel free to use overflow: auto for specific blocks (like code or long lists) if it enhances the "pro-tool" feel.
2. CREATIVE FREEDOM: Break the grid. Use asymmetrical layouts, overlapping elements, and bold typography. Avoid generic bullet-point lists; use callout cards, data-visualization metaphors, or interactive highlights instead.
3. MOTION & DEPTH: Use `class="reveal"` with `--delay: Xs` for staggered entry animations. CRITICAL: All animations MUST complete within 2 seconds (ensure delay + duration <= 2s) so the visual audit can capture a stable state. Use depth effects (blur, shadows, gradients) to create a premium atmosphere.
4. TYPOGRAPHY: Use `clamp()` for fluid text. Headlines should be bold and expressive; body text should be elegant and readable.
5. CODE & DATA: Render code in `<pre><code class="language-{{lang}}">`. Use SVG or CSS-based charts to represent data visually where possible.

=== OUTPUT RULES ===
- Return ONLY the <section class="slide"> element.
- Define a scoped `<style>` block at the top of the section.
- If interactivity is needed, include a `<script>` block.
- All colours MUST use CSS variables: --bg, --surface, --text, --text-muted, --accent, --accent-glow, --border.

=== INTENT EXECUTION ===
{intent_guidance}
"""

INTENT_GUIDANCE = {
    "title-hero": "Create a high-impact cinematic moment. Dramatic typography, large negative space, and a single unforgettable visual element.",
    "explain-concept": "Educational but elegant. Use visual metaphors (callout cards, floating boxes) to break down the idea. Avoid more than 3 blocks of text.",
    "explain-mechanism": "A visual flow or architectural overview. Use CSS borders/lines to connect steps. Stagger the reveal of the mechanism steps.",
    "show-example": "Focus on the artifact. A large code block or a visual mockup. Add subtle annotations that 'point' to key features.",
    "compare": "A high-contrast side-by-side view. Use different background intensities for the two sides to create a visual 'clash' or 'harmony'.",
    "list-points": "Modern listing. Not bullets—think 'feature grid' or 'staggered cards'. Each point should feel like a distinct component.",
    "code-walkthrough": "Developer-centric. Deep-focus code blocks with interactive callouts or highlighted lines. Use --code-bg for contrast.",
    "summary": "Key Takeaways as a final punch. Use a simplified, high-clarity layout that reinforces the main message of the deck.",
    "creative-visual": "PURE AESTHETICS. Use a bold, artistic layout with minimal text (max 1 sentence). Focus on a high-end visual metaphor or a stunning background effect.",
    "narrative-break": "A dramatic pause in the presentation. Use a bold quote, a massive single word, or a simple question. High contrast, maximum impact.",
}


def _build_brand_section(design_config: dict, theme: str = "dark-tech", topic: str = "", is_refinement: bool = False) -> str:
    """
    Build a BRAND ENFORCEMENT or THEMATIC STYLING prompt block.
    """
    palette      = design_config.get("color_palette", [])
    fonts        = design_config.get("font_hints", [])
    tone         = design_config.get("tone", "")
    layout_pref  = design_config.get("layout_preferences", "")

    is_dark_theme = any(t in theme.lower() for t in ["dark", "black", "night", "tech", "glass"])

    # Extract rich design signals
    palette = design_config.get("color_palette", [])
    fonts = design_config.get("font_hints", [])
    tone = design_config.get("tone", "")
    layout_pref = design_config.get("layout_preferences", "")
    atmospheric_feel = design_config.get("atmospheric_feel", "")
    color_theory_intent = design_config.get("color_theory_intent", "")
    component_styles = design_config.get("component_styles", "")
    visual_elements = design_config.get("visual_elements", "")

    # Case A: Brand signals exist
    if palette or tone or atmospheric_feel:
        status_text = "(GUIDELINE — maintain consistency)" if is_refinement else "(MANDATORY — apply to this slide)"
        lines = [
            "",
            f"=== BRAND & DESIGN ENFORCEMENT {status_text} ===",
            "A persistent design system is in effect. You must execute this specific aesthetic vision.",
            "",
        ]

        if atmospheric_feel:
            lines += [f"ATMOSPHERIC FEEL: {atmospheric_feel}", ""]

        if tone:
            lines += [f"DESIGN TONE: {tone}", ""]

        if palette:
            palette_str = ", ".join(palette[:6])
            lines += [
                f"COLOUR PALETTE: {palette_str}",
                f"COLOUR THEORY INTENT: {color_theory_intent or 'Use these colors harmoniously.'}",
                "",
                "ACTION: At the VERY TOP of your <style> block, define these variables:",
                "  section.slide {",
            ]
            
            if is_dark_theme:
                lines += [
                    "    /* Theme: DARK */",
                    f"    --bg:          {palette[4] if len(palette)>4 else palette[0]}; /* Background */",
                    f"    --surface:     {palette[5] if len(palette)>5 else palette[0]}; /* Surface/Card */",
                    f"    --accent:      {palette[2] if len(palette)>2 else palette[0]}; /* Accent Highlight */",
                    f"    --text:        {palette[0] if not palette[0].startswith('#0') and not palette[0].startswith('#1') else '#ffffff'}; /* Foreground */",
                ]
            else:
                lines += [
                    f"    --bg:          {palette[4] if len(palette)>4 else '#ffffff'};",
                    f"    --surface:     {palette[5] if len(palette)>5 else '#f9fafb'};",
                    f"    --accent:      {palette[2] if len(palette)>2 else palette[0]};",
                    f"    --text:        {palette[0]};",
                ]
                
            lines += [
                "    --accent-glow: <rgba() version of --accent at 0.3 opacity>;",
                "    --text-muted:  <muted text, 60–70% opacity blend of --text>;",
                "    --border:      <low-opacity border based on palette>;",
                "  }",
            ]

        if component_styles:
            lines += ["", f"COMPONENT DNA: {component_styles}"]

        if visual_elements:
            lines += ["", f"RECURRING MOTIFS: {visual_elements}"]

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
            "if the user's specific instruction requires a different mood.",
        ]

    if fonts:
        font_list = ", ".join(f"'{f}'" for f in fonts[:3])
        lines += ["", f"TYPOGRAPHY GUIDANCE: prefer {font_list} where available."]

    if layout_pref:
        lines += ["", f"COMPOSITION & LAYOUT: {layout_pref}"]

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
    design_config: dict,
    relevant_chunks: str = "",
    asset_filenames: list[str] | None = None,
    is_refinement: bool = False,
) -> str:
    # Summarize deck context (narrative / terms / facts) — brand signals are
    # now handled by _build_brand_section, NOT included here to avoid duplication.
    ctx_summary  = _summarize_context(deck_context)
    key_points_str = "\n".join(f"- {p}" for p in key_points)
    guidance     = INTENT_GUIDANCE.get(intent, "Follow the intent as described.")

    # Extract topic from deck_context
    synthesis = deck_context.get("synthesis", {})
    topic = synthesis.get("topic", deck_context.get("topic", ""))
    
    brand_section = _build_brand_section(design_config, theme, topic, is_refinement)

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
        "=== MANDATORY LOCAL ASSETS ===",
        "These specific images have been assigned to THIS slide for grounding.",
        "You MUST include them in your layout using exactly: <img src=\"/assets/filename\">",
        "Integrate them elegantly into the design (e.g., as a hero image, in a feature card, or as a floating visual artifact).",
        "",
        "Available filenames to render:"
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
