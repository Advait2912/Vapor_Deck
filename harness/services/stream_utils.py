"""
Shared utilities for working with LLM streams.
"""
from ai.base import BaseProvider


async def collect_stream(
    model: BaseProvider,
    messages: list[dict],
    system: str,
) -> str:
    """Collect all tokens from an async stream into a single string."""
    result = ""
    async for token in model.stream_text(messages, system):
        result += token
    return result


def strip_fences(text: str) -> str:
    """
    Remove markdown code fences that LLMs sometimes wrap their output in.
    Handles ```json, ```html, ``` etc.
    """
    text = text.strip()
    # Remove opening fence line (e.g. "```json\n" or "```\n")
    if text.startswith("```"):
        first_newline = text.find("\n")
        if first_newline != -1:
            text = text[first_newline + 1:]
        else:
            text = text[3:]  # just "```" with nothing after
    # Remove closing fence
    if text.endswith("```"):
        text = text[: text.rfind("```")]
    return text.strip()


def validate_slide_html(html: str) -> bool:
    """Minimal check: ensure LLM returned an actual slide section."""
    return '<section' in html and 'slide' in html
