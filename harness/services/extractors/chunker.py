"""
Text chunking utility.

Splits text into overlapping chunks of a target token size.
Token count is approximated as len(text) // 4 (good enough for prompt budgeting).
"""
from models.input_unit import TextChunk
import uuid


def estimate_tokens(text: str) -> int:
    """Rough token count: ~4 chars per token."""
    return max(1, len(text) // 4)


def chunk_text(
    text: str,
    chunk_size: int = 400,    # target tokens per chunk
    overlap: int = 50,        # overlap tokens between chunks
) -> list[TextChunk]:
    """
    Split text into overlapping chunks.
    chunk_size and overlap are in approximate tokens.
    """
    if not text.strip():
        return []

    char_size = chunk_size * 4
    char_overlap = overlap * 4

    chunks = []
    start = 0
    while start < len(text):
        end = start + char_size
        chunk_text_str = text[start:end]
        if chunk_text_str.strip():
            chunks.append(TextChunk(
                chunk_id=str(uuid.uuid4())[:8],
                text=chunk_text_str.strip(),
                token_count=estimate_tokens(chunk_text_str),
            ))
        if end >= len(text):
            break
        start = end - char_overlap

    return chunks
