import json
import logging
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ai.router import get_model
from store.sessions import get_session, save_session, get_project_dir
from services.stream_utils import collect_stream, strip_fences

logger = logging.getLogger("design")
router = APIRouter()


class DesignChatRequest(BaseModel):
    message: str


def get_design_skill_content() -> str:
    """Read the design_skill.md file from the project root."""
    try:
        skill_path = get_project_dir() / "design_skill.md"
        if skill_path.exists():
            return skill_path.read_text(encoding="utf-8")
        return "Apply high-end, modern web aesthetics. Avoid generic templates."
    except Exception as e:
        logger.error(f"Failed to read design_skill.md: {e}")
        return "Apply high-end, modern web aesthetics."


DESIGN_SYSTEM = """You are Vapor Deck's Design AI.
Your goal is to manage the visual aesthetics and brand identity of the presentation.
You maintain a JSON configuration (`design_config`) that dictates the color palette, fonts, tone, and detailed design intent.

Current Design Config:
{current_config}

The user will provide requests or feedback regarding the design.

You MUST adhere strictly to the following aesthetic guidelines when making decisions:
---
{design_skill}
---

You must respond with a JSON object containing EXACTLY two keys:
1. "message": A short, conversational response to the user explaining what you updated and why.
2. "design_config": The complete updated design configuration object. This must include:
   - "color_palette": List of 5-6 hex codes (Primary, Secondary, Accent, Muted, Background, Surface).
   - "font_hints": List of 1-3 font family names.
   - "tone": A 1-3 word evocative name for the style.
   - "atmospheric_feel": A detailed description of the emotional impact.
   - "color_theory_intent": Explanation of why this palette was chosen and how to use it.
   - "component_styles": Description of the visual DNA for UI elements (buttons, cards, borders).
   - "layout_preferences": Rules for spacing, grids, and composition.
   - "visual_elements": Specific decorative motifs to include (e.g. "grainy gradients", "0.5pt hairlines").

Respond ONLY with valid JSON. Do not use markdown code blocks like ```json ... ```, just output the raw JSON object.
"""


@router.post("/session/{session_id}/chat/design")
async def chat_design(session_id: str, req: DesignChatRequest):
    try:
        session = get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    model = get_model(session.text_model)
    design_skill = get_design_skill_content()
    current_config = json.dumps(session.design_config, indent=2)

    system_prompt = DESIGN_SYSTEM.format(
        design_skill=design_skill,
        current_config=current_config
    )

    raw_response = await collect_stream(
        model,
        [{"role": "user", "content": req.message}],
        system_prompt,
    )

    try:
        cleaned = strip_fences(raw_response)
        
        # Fallback to extract JSON if model adds chatter
        if not (cleaned.startswith("{") and cleaned.endswith("}")):
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start != -1 and end != -1:
                cleaned = cleaned[start:end+1]
                
        # Sanitize whitespace
        sanitized = "".join(c for c in cleaned if c.isprintable() or c in "\n\r\t")
        data = json.loads(sanitized, strict=False)
        
        message = data.get("message", "Design config updated.")
        new_config = data.get("design_config", {})
        
        if new_config:
            session.design_config = new_config
            save_session(session)
            
        return {
            "status": "ok",
            "message": message,
            "design_config": session.design_config
        }
    except Exception as e:
        logger.error(f"[{session_id}] design chat parse failed: {e}")
        logger.debug(f"[{session_id}] raw_response: {raw_response[:1000]}")
        raise HTTPException(status_code=500, detail=f"Failed to process design AI response: {e}")
