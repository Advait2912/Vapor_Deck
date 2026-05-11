import json
import os
from typing import AsyncIterator

import httpx

from ..base import BaseProvider

OLLAMA_BASE = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")


class OllamaProvider(BaseProvider):
    """
    Ollama local model provider.

    Talks to the Ollama REST API running on localhost:11434.
    Run `ollama serve` before using.

    Text model examples : "llama3.1:8b", "mistral", "phi3"
    Vision model examples: "llava:13b", "llava:7b"  (vision_audit only)
    """

    def __init__(self, model: str):
        self.model = model

    async def stream_text(
        self,
        messages: list[dict],
        system: str,
    ) -> AsyncIterator[str]:
        payload = {
            "model": self.model,
            "messages": (
                [{"role": "system", "content": system}] if system else []
            ) + [
                {"role": m["role"], "content": m["content"]}
                for m in messages
            ],
            "stream": True,
            "options": {
                "num_ctx": 32768  # Coding agent context length
            }
        }

        async with httpx.AsyncClient(timeout=300.0) as client:
            async with client.stream(
                "POST", f"{OLLAMA_BASE}/api/chat", json=payload
            ) as resp:
                if resp.status_code != 200:
                    try:
                        err_json = await resp.json()
                        err_msg = err_json.get("error", "Unknown error")
                    except:
                        err_msg = await resp.aread()
                    raise Exception(f"Ollama Error {resp.status_code}: {err_msg} (model: {self.model})")
                
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if data.get("done"):
                        break
                    content = data.get("message", {}).get("content", "")
                    if content:
                        yield content

    async def vision_audit(self, prompt: str, image_b64: str) -> str:
        """
        Uses LLaVA-style image input via the `images` field.
        Requires a vision-capable Ollama model (e.g. llava:13b).
        Falls back to text-only if model doesn't support images.
        """
        # BUG: gemma models are text-only and crash Ollama with 500 if images are sent.
        # Auto-fallback to the configured vision model if gemma is selected.
        effective_model = self.model
        if "gemma" in self.model:
            vision_env = os.getenv("VAPOR_VISION_MODEL", "ollama/qwen3-vl:235b-cloud")
            effective_model = vision_env.split("/")[-1]

        payload = {
            "model": effective_model,
            "messages": [{
                "role": "user",
                "content": prompt,
                "images": [image_b64],
            }],
            "stream": False,
            "options": {
                "num_ctx": 16384  # Vision context length
            }
        }
        async with httpx.AsyncClient(timeout=180.0) as client:
            resp = await client.post(f"{OLLAMA_BASE}/api/chat", json=payload)
            if resp.status_code != 200:
                try:
                    err_json = resp.json()
                    err_msg = err_json.get("error", "Unknown error")
                except:
                    err_msg = resp.text
                raise Exception(f"Ollama Vision Error {resp.status_code}: {err_msg} (model: {effective_model})")
            return resp.json()["message"]["content"]
