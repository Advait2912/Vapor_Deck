from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
import logging
import asyncio

from services.pdf_export import pdf_service
from store.sessions import get_session

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/export", tags=["export"])

class ExportRequest(BaseModel):
    slides: List[str]
    theme: Optional[str] = "dark-tech"

@router.post("/test")
async def test_export():
    """Simple test endpoint to verify JSON parsing works"""
    return {"status": "ok", "message": "Export service is working"}

@router.post("/session/{session_id}/pdf")
async def export_session_pdf(session_id: str, request: ExportRequest):
    """
    Server-side PDF export using Playwright headless Chromium.
    Renders all slide HTML to a single multi-page PDF.
    """
    logger.info(f"PDF export request: session={session_id} slides={len(request.slides)} theme={request.theme}")

    if not request.slides:
        raise HTTPException(status_code=400, detail="No slides provided for export")

    try:
        pdf_bytes = await pdf_service.export_slides_to_pdf(
            slides=request.slides,
            theme=request.theme or "dark-tech",
        )
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="vapor_deck_{session_id}.pdf"'
            },
        )
    except Exception as exc:
        import traceback
        tb = traceback.format_exc()
        logger.error(f"PDF export failed for session {session_id}:\n{tb}")
        # Send full traceback in detail so the frontend can show it
        raise HTTPException(status_code=500, detail=f"Export failed: {type(exc).__name__}: {exc}\n\n{tb}")


@router.post("/session/{session_id}/debug-html")
async def debug_export_html(session_id: str, request: ExportRequest):
    """
    DEBUG: Return the HTML document that would be rendered to PDF.
    Use this to inspect the generated markup when PDF export fails.
    """
    logger.info(f"DEBUG HTML request: session={session_id}")
    try:
        html = pdf_service.build_html(
            slides=request.slides,
            theme=request.theme or "dark-tech",
        )
        return Response(
            content=html,
            media_type="text/html",
            headers={"Content-Disposition": f'attachment; filename="debug_{session_id}.html"'},
        )
    except Exception as exc:
        import traceback
        raise HTTPException(status_code=500, detail=traceback.format_exc())

@router.get("/session/{session_id}/preview")
async def preview_export(session_id: str):
    """
    Get export preview info (number of slides, theme, etc.)
    """
    try:
        session = get_session(session_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found")
        
        # All slides in session are considered approved for export
        approved_slides = session.slides or []
        
        return {
            "session_id": session_id,
            "total_slides": len(session.outline or []),
            "approved_slides": len(approved_slides),
            "theme": session.theme or "dark-tech",
            "ready_for_export": len(approved_slides) > 0
        }
        
    except Exception as e:
        logger.error(f"Preview failed for session {session_id}: {e}")
        raise HTTPException(status_code=500, detail=f"Preview failed: {str(e)}")
