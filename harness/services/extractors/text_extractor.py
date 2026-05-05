"""
Text extractor.

Handles plain strings: topic descriptions, pasted articles, pasted instructions.
Makes a fast LLM call to classify the role if not provided.
"""
import json
import uuid
from hashlib import sha256
from datetime import datetime, timezone

from models.input_unit import InputUnit, InputRole
from services.extractors.chunker import chunk_text
from services.stream_utils import collect_stream, strip_fences


async def extract_text(
    session_id: str,
    raw_text: str,
    model,
    role: InputRole | None = None,
) -> InputUnit:
    """
    Extract an InputUnit from a plain text string.

    If role is None, we make a quick LLM call to classify it.
    """
    file_hash = sha256(raw_text.encode("utf-8")).hexdigest()

    # Auto-detect role if not provided
    if role is None:
        role_prompt = f"""Classify this text into exactly one role:
- topic: a subject, concept, or question to build a presentation about
- reference: factual content, articles, transcripts to draw from
- instruction: rules, constraints, or requirements the deck must follow

Text (first 600 chars):
{raw_text[:600]}

Return ONE word only: topic, reference, or instruction"""

        raw_role = await collect_stream(
            model,
            [{"role": "user", "content": role_prompt}],
            "",
        )
        detected = raw_role.strip().lower().split()[0] if raw_role.strip() else ""
        role = detected if detected in ("topic", "reference", "instruction") else "reference"

    chunks = chunk_text(raw_text)

    # For instruction role: also parse the rules as a clean list
    instructions_parsed: list[str] = []
    if role == "instruction":
        parse_prompt = f"""Extract all explicit rules, constraints, and requirements from this text.
Return them as a JSON array of short strings. Each item is ONE rule.
Text: {raw_text}
Return ONLY the JSON array — no markdown fences, no explanation."""
        raw_rules = await collect_stream(
            model,
            [{"role": "user", "content": parse_prompt}],
            "",
        )
        try:
            instructions_parsed = json.loads(strip_fences(raw_rules))
        except Exception:
            # Fallback: split on newlines
            instructions_parsed = [
                line.lstrip("•-* ").strip()
                for line in raw_rules.splitlines()
                if line.strip()
            ]

    return InputUnit(
        unit_id=str(uuid.uuid4()),
        session_id=session_id,
        file_hash=file_hash,
        input_type="text",
        role=role,
        chunks=chunks,
        instructions_parsed=instructions_parsed,
        token_budget=sum(c.token_count for c in chunks),
        created_at=datetime.now(timezone.utc).isoformat(),
    )
