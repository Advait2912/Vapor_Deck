"""
SSE (Server-Sent Events) response builder.

The frontend consumes this via the native EventSource API or a fetch reader.
Each token is sent as:  data: <token>\n\n
Stream end sentinel:    data: [DONE]\n\n
"""
from fastapi.responses import StreamingResponse
from typing import AsyncIterator


def stream_llm_response(
    generator: AsyncIterator[str],
) -> StreamingResponse:
    """
    Wrap an async token generator into an SSE StreamingResponse.
    """

    async def event_stream():
        try:
            async for token in generator:
                if token:
                    # Escape newlines inside token so SSE framing isn't broken
                    safe = token.replace("\n", "\\n")
                    yield f"data: {safe}\n\n"
        except Exception as e:
            yield f"data: [ERROR] {str(e)}\n\n"
        finally:
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",  # prevents nginx from buffering SSE
        },
    )
