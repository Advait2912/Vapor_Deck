#!/usr/bin/env python3
"""
Test input extractors independently — no HTTP, no FastAPI.

Usage:
  python scripts/test_extractor.py
  python scripts/test_extractor.py --pdf path/to/file.pdf
  python scripts/test_extractor.py --docx path/to/file.docx
  python scripts/test_extractor.py --image path/to/image.png
  python scripts/test_extractor.py --model "ollama/llama3.1:8b"
"""
import asyncio
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv
load_dotenv()

from ai.router import get_model
from services.extractors.text_extractor import extract_text
from services.extractors.document_extractor import extract_document
from services.extractors.image_extractor import extract_image


def print_unit(unit):
    print(f"  unit_id    : {unit.unit_id}")
    print(f"  input_type : {unit.input_type}")
    print(f"  role       : {unit.role}")
    print(f"  chunks     : {len(unit.chunks)}")
    print(f"  token_budget: {unit.token_budget}")
    if unit.chunks:
        print(f"  first chunk: {unit.chunks[0].text[:120]}...")
    if unit.visual_summary:
        print(f"  visual_summary: {unit.visual_summary}")
    if unit.color_palette:
        print(f"  color_palette: {unit.color_palette}")
    if unit.instructions_parsed:
        print(f"  instructions: {unit.instructions_parsed}")


async def main(args):
    model = get_model(args.model)
    vision_model = get_model(args.vision_model or args.model)

    # Test 1: plain text (topic)
    print("\n[1] Text extractor — topic string")
    print("─" * 50)
    unit = await extract_text(
        "test-session",
        "Explain how transformer attention mechanisms work to ML engineers.",
        model,
    )
    print_unit(unit)

    # Test 2: plain text (instruction)
    print("\n[2] Text extractor — instruction text")
    print("─" * 50)
    unit = await extract_text(
        "test-session",
        "Keep all slides under 50 words. Use only dark background. Never use the word 'leverage'.",
        model,
        role="instruction",
    )
    print_unit(unit)

    # Test 3: PDF
    if args.pdf:
        print(f"\n[3] Document extractor — PDF: {args.pdf}")
        print("─" * 50)
        with open(args.pdf, "rb") as f:
            raw = f.read()
        unit = await extract_document("test-session", raw, os.path.basename(args.pdf), role="reference")
        print_unit(unit)

    # Test 4: DOCX
    if args.docx:
        print(f"\n[4] Document extractor — DOCX: {args.docx}")
        print("─" * 50)
        with open(args.docx, "rb") as f:
            raw = f.read()
        unit = await extract_document("test-session", raw, os.path.basename(args.docx), role="reference")
        print_unit(unit)

    # Test 5: Image
    if args.image:
        print(f"\n[5] Image extractor: {args.image}")
        print("─" * 50)
        with open(args.image, "rb") as f:
            raw = f.read()
        unit = await extract_image("test-session", raw, os.path.basename(args.image), vision_model)
        print_unit(unit)

    print("\n✓ Extractor tests complete")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test input extractors")
    parser.add_argument("--model", default="google/gemini-2.0-flash")
    parser.add_argument("--vision-model", default=None, help="Defaults to --model")
    parser.add_argument("--pdf", default=None)
    parser.add_argument("--docx", default=None)
    parser.add_argument("--image", default=None)
    args = parser.parse_args()
    asyncio.run(main(args))
