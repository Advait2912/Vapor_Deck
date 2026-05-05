from abc import ABC, abstractmethod
from typing import AsyncIterator


class BaseProvider(ABC):
    """
    Common interface every AI provider must implement.

    stream_text  → async generator yielding raw text tokens
    vision_audit → single non-streaming call that returns a full string
                   (send image + prompt, get structured feedback back)
    """

    @abstractmethod
    async def stream_text(
        self,
        messages: list[dict],
        system: str,
    ) -> AsyncIterator[str]:
        """Stream text tokens from the model."""
        pass

    @abstractmethod
    async def vision_audit(self, prompt: str, image_b64: str) -> str:
        """Send a base64-encoded PNG + text prompt, return full response."""
        pass
