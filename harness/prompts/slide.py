"""
Per-slide HTML generation prompt.

The LLM writes a complete <section class="slide"> block
including scoped <style> and interactive <script> tags.
"""

SLIDE_SYSTEM = (
    "You are a senior frontend developer generating slides for a web-native presentation. "
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

=== STYLE RULES ===
Theme: {theme}
NEVER use hardcoded colors — ONLY CSS custom properties:
  --bg, --surface, --text, --text-muted, --accent, --accent-glow,
  --code-bg, --border, --font-head, --font-body

=== OUTPUT RULES ===
1. Return ONLY the <section class="slide"> element — no wrapping HTML, no doctype
2. Content MUST fit within 1280×720px — max 4 body content blocks
3. Include a scoped <style> block inside the section for layout
4. For interactive elements (tabs, toggles), include a <script> block
5. Add class="reveal" and style="--delay: Xs" to animate elements in staggered sequence
6. Code blocks: use <pre><code class="language-{lang}"> with Prism.js class names
7. Images: only use CSS backgrounds or SVG — no external image URLs
8. The slide heading MUST match the title exactly: "{title}"

=== INTENT GUIDANCE ===
{intent_guidance}
"""

INTENT_GUIDANCE = {
    "title-hero": "Large centered title. Subtitle with 1-2 sentences. Optional decorative element. No bullet points.",
    "explain-concept": "Clear heading. 2-3 paragraphs or callout boxes explaining the concept. Keep text minimal.",
    "explain-mechanism": "Step-by-step flow or numbered process. Use a visual diagram in CSS if possible.",
    "show-example": "Heading + concrete real-world example. Code snippet if relevant. Before/after if applicable.",
    "compare": "Two-column layout. Left vs Right. Use a table or side-by-side cards.",
    "list-points": "Heading + 4-6 bullet points. Each bullet is one short statement.",
    "code-walkthrough": "Code block on left or full width. Annotations or highlights on the key lines.",
    "summary": "Heading 'Key Takeaways'. 3-5 bullet points. Optional CTA or closing statement.",
}


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
) -> str:
    # Summarize deck context to avoid token bloat
    ctx_summary = _summarize_context(deck_context)
    key_points_str = "\n".join(f"- {p}" for p in key_points)
    guidance = INTENT_GUIDANCE.get(intent, "Follow the intent as described.")

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
        intent_guidance=guidance,
    )


def _summarize_context(ctx: dict) -> str:
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
