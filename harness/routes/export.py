import logging
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel
from typing import List, Optional
from store.sessions import get_session
from services.pdf_export import pdf_service

router = APIRouter(tags=["export"])
logger = logging.getLogger("routes.export")

class ExportPDFRequest(BaseModel):
    slides: List[str]
    theme: Optional[str] = "dark-tech"

@router.post("/session/{session_id}/export/pdf")
async def export_session_pdf(session_id: str, request: ExportPDFRequest):
    """
    Export specific slides to PDF. 
    Expects the EXACT HTML from the frontend (WYSIWYG).
    """
    logger.info(f"PDF export request: session={session_id} slides={len(request.slides)} theme={request.theme}")
    
    try:
        pdf_bytes = await pdf_service.export_slides_to_pdf(
            slides_html=request.slides,
            theme=request.theme or "dark-tech",
            session_id=session_id
        )
        
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f"attachment; filename=vapor_deck_{session_id}.pdf"
            }
        )
    except Exception as e:
        logger.error(f"Export failed for session {session_id}: {e}")
        import traceback
        raise HTTPException(status_code=500, detail=traceback.format_exc())


