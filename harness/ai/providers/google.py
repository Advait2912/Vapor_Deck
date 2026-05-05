import os
from typing import AsyncIterator

import google.genai as genai
import google.genai.types as gtypes

from ..base import BaseProvider


class GoogleProvider(BaseProvider):
    """
    Google Gemini / Gemma provider using the new google-genai SDK.

    Works for both text generation and vision (natively multimodal).
    model examples: "gemini-2.0-flash", "gemini-1.5-pro", "gemma-3-27b-it"
    """

    def __init__(self, model: str):
        api_key = os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise EnvironmentError("GOOGLE_API_KEY is not set in .env")
        self.model_name = model
        self.client = genai.Client(api_key=api_key)

    async def stream_text(
        self,
        messages: list[dict],
        system: str,
    ) -> AsyncIterator[str]:
        """
        messages: list of {"role": "user"|"assistant"|"model", "content": "..."}
        Streams text tokens via the new aio (async) interface.
        """
        # Convert to google-genai Content format
        # Google uses "model" for assistant role
        contents = []
        for m in messages:
            role = "model" if m["role"] in ("assistant", "model") else "user"
            contents.append(
                gtypes.Content(
                    role=role,
                    parts=[gtypes.Part(text=m["content"])],
                )
            )

        config = gtypes.GenerateContentConfig(
            temperature=0.5,
            system_instruction=system if system else None,
        )

        async for chunk in await self.client.aio.models.generate_content_stream(
            model=self.model_name,
            contents=contents,
            config=config,
        ):
            if chunk.text:
                yield chunk.text

    async def vision_audit(self, prompt: str, image_b64: str) -> str:
        """Send image + prompt to the vision model, return full text response."""
        contents = [
            gtypes.Part(
                inline_data=gtypes.Blob(
                    mime_type="image/png",
                    data=image_b64,
                )
            ),
            gtypes.Part(text=prompt),
        ]

        response = await self.client.aio.models.generate_content(
            model=self.model_name,
            contents=contents,
        )
        return response.text