"""
Context update prompt.

After a slide is approved, this prompt asks the LLM to summarize
what the slide covered and append it to deck_context.json.
"""

CONTEXT_UPDATE_SYSTEM = (
    "You update a running JSON context for a slide deck. "
    "Return only valid JSON — same schema, new entries appended."
)

CONTEXT_UPDATE_PROMPT = """A slide was just approved. Update the deck context JSON.

=== APPROVED SLIDE HTML ===
{html}

=== CURRENT DECK CONTEXT ===
{current_context}

=== INSTRUCTIONS ===
Return ONLY the updated context JSON with the same schema.
- Append to slides_summary (do NOT remove existing entries)
- Add any new terms defined to key_terms_defined
- Add any facts or stats stated to facts_stated
- Update running_narrative to reflect progress
- Do NOT change any existing entries — only append

Required schema:
{{
  "deck": {{ "title": "...", "theme": "...", "total_slides": N, "audience": "...", "tone": "..." }},
  "context": {{
    "key_terms_defined": [...],
    "concepts_covered": [...],
    "facts_stated": [...],
    "running_narrative": "..."
  }},
  "slides_summary": [
    {{ "index": N, "title": "...", "covered": [...], "layout_style": "..." }}
  ]
}}
"""


def build_context_update_prompt(html: str, current_context: dict) -> str:
    import json
    return CONTEXT_UPDATE_PROMPT.format(
        html=html[:3000],  # cap to avoid token overflow
        current_context=json.dumps(current_context, indent=2)[:2000],
    )


def initial_deck_context(topic: str, theme: str, total_slides: int, audience: str, tone: str) -> dict:
    """Create the initial empty deck context."""
    return {
        "deck": {
            "title": topic,
            "theme": theme,
            "total_slides": total_slides,
            "audience": audience,
            "tone": tone,
        },
        "context": {
            "key_terms_defined": [],
            "concepts_covered": [],
            "facts_stated": [],
            "running_narrative": "Presentation not yet started.",
        },
        "slides_summary": [],
    }
