#!/usr/bin/env python3
"""
Test any provider independently — no HTTP, no FastAPI.

Usage:
  python scripts/test_provider.py
  python scripts/test_provider.py --model "google/gemini-2.0-flash"
  python scripts/test_provider.py --model "ollama/gemma4:31b-cloud"
"""
import asyncio
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from dotenv import load_dotenv
load_dotenv()

from ai.router import get_model

TEST_SYSTEM = "You are a helpful assistant. Be extremely brief."
TEST_MESSAGES = [{"role": "user", "content": "Say exactly: 'Provider working.' — nothing else."}]


async def test(model_string: str):
    print(f"\nTesting provider: {model_string}")
    print("─" * 50)

    try:
        model = get_model(model_string)
    except Exception as e:
        print(f"✗ Failed to initialize provider: {e}")
        return

    full = ""
    try:
        async for token in model.stream_text(TEST_MESSAGES, TEST_SYSTEM):
            print(token, end="", flush=True)
            full += token
    except Exception as e:
        print(f"\n✗ Stream failed: {e}")
        return

    print(f"\n\nTotal chars received: {len(full)}")
    if full.strip():
        print("✓ Provider OK — streaming works")
    else:
        print("✗ Empty response — check API key and model name")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Test an AI provider")
    parser.add_argument(
        "--model",
        default="google/gemini-2.0-flash",
        help="Model string, e.g. 'google/gemini-2.0-flash' or 'ollama/llama3.1:8b'",
    )
    args = parser.parse_args()
    asyncio.run(test(args.model))
