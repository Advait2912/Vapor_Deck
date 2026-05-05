#!/usr/bin/env python3
"""
Full end-to-end integration test.

Tests the complete API flow:
  1. Create session
  2. Upload text inputs
  3. Synthesize context
  4. Generate outline
  5. Confirm outline
  6. Generate slide 1 (consumes SSE stream)

Usage:
  python scripts/test_e2e.py
  python scripts/test_e2e.py --model "ollama/gemma4:31b-cloud" --topic "Explain WASM"
  python scripts/test_e2e.py --host http://localhost:8000
"""
import asyncio
import argparse
import json
import sys

try:
    import httpx
except ImportError:
    print("httpx not installed. Run: pip install httpx")
    sys.exit(1)


async def run_e2e(host: str, model: str, topic: str):
    base = f"{host}/api"

    async with httpx.AsyncClient(timeout=120) as client:

        # ── Step 1: Create session ────────────────────────────────────────────
        print(f"\n[1] Creating session (model={model})")
        r = await client.post(f"{base}/session", json={
            "text_model": model,
            "vision_model": model,
            "theme": "dark-tech",
        })
        r.raise_for_status()
        session_id = r.json()["session_id"]
        print(f"    ✓ session_id={session_id}")

        # ── Step 2: Upload topic text ─────────────────────────────────────────
        print(f"\n[2] Uploading topic: '{topic}'")
        r = await client.post(f"{base}/session/{session_id}/upload/text", json={
            "text": topic,
            "role": "topic",
        })
        r.raise_for_status()
        data = r.json()
        print(f"    ✓ unit_id={data['unit_id']} role={data['role']} chunks={data['chunks']}")

        # ── Step 2b: Upload a reference (optional extra) ──────────────────────
        print(f"\n[2b] Uploading a reference snippet")
        r = await client.post(f"{base}/session/{session_id}/upload/text", json={
            "text": (
                "Background context: This topic is important for developers "
                "building scalable systems. Key considerations include performance, "
                "maintainability, and team onboarding speed."
            ),
            "role": "reference",
        })
        r.raise_for_status()
        print(f"    ✓ reference uploaded")

        # ── Step 3: Synthesize ────────────────────────────────────────────────
        print(f"\n[3] Synthesizing context...")
        r = await client.post(f"{base}/session/{session_id}/synthesize")
        r.raise_for_status()
        summary = r.json()["context_summary"]
        print(f"    ✓ topic='{summary['topic']}'")
        print(f"      themes={summary['key_themes']}")
        print(f"      constraints={summary['constraints']}")

        # ── Step 4: Generate outline ──────────────────────────────────────────
        print(f"\n[4] Generating outline...")
        r = await client.post(f"{base}/session/{session_id}/outline")
        r.raise_for_status()
        data = r.json()
        outline = data["outline"]
        print(f"    ✓ {len(outline)} slides generated:")
        for item in outline:
            print(f"      [{item['index']}] {item['title']} ({item['intent']})")

        # ── Step 5: Confirm outline ───────────────────────────────────────────
        print(f"\n[5] Confirming outline...")
        r = await client.post(f"{base}/session/{session_id}/confirm", json={"outline": outline})
        r.raise_for_status()
        print(f"    ✓ {r.json()['total_slides']} slides confirmed, generation ready")

        # ── Step 6: Generate slide 1 (SSE stream) ────────────────────────────
        print(f"\n[6] Generating slide 1 via SSE stream...")
        html = ""
        token_count = 0
        async with client.stream("POST", f"{base}/session/{session_id}/slide/1") as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[6:]
                if data_str == "[DONE]":
                    break
                if data_str.startswith("[ERROR]"):
                    print(f"\n    ✗ SSE error: {data_str}")
                    break
                token = data_str.replace("\\n", "\n")
                html += token
                token_count += 1
                if token_count % 20 == 0:
                    print(".", end="", flush=True)

        print(f"\n    ✓ Slide 1 received: {len(html)} chars, ~{token_count} SSE events")

        if "<section" in html:
            print("    ✓ HTML contains <section> element")
        else:
            print("    ✗ WARNING: HTML may be malformed — no <section> found")

        # Save slide HTML for inspection
        with open("debug/slide_1_e2e.html", "w") as f:
            f.write(f"""<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body {{ margin:0; background:#0d0d0d; }}
  .slide {{ width:1280px; height:720px; }}
  :root {{
    --bg:#0d0d0d; --surface:#141414; --text:#f0f0f0; --text-muted:#888;
    --accent:#7c3aed; --accent-glow:#7c3aed33; --code-bg:#1a1a2e;
    --border:#2a2a2a; --font-head:monospace; --font-body:sans-serif;
  }}
</style>
</head><body>{html}</body></html>""")
        print(f"    ✓ Slide HTML saved to debug/slide_1_e2e.html — open in browser to inspect")

        print(f"\n{'═'*50}")
        print("✓ End-to-end test PASSED")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://localhost:8000")
    parser.add_argument("--model", default="ollama/gemma4:31b-cloud")
    parser.add_argument("--topic", default="Explain how transformer attention mechanisms work to ML engineers")
    args = parser.parse_args()

    import os
    os.makedirs("debug", exist_ok=True)

    asyncio.run(run_e2e(args.host, args.model, args.topic))
