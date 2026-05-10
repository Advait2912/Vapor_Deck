
import asyncio
import base64
import json
import logging
import sys
import os
from pathlib import Path

# Add harness to path
sys.path.append(str(Path(__file__).parent.parent))

from ai.router import get_model
from store.sessions import get_session, save_session
from services.extractors.image_extractor import extract_image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("re_audit")

async def re_audit_session(session_id: str):
    try:
        session = get_session(session_id)
    except KeyError:
        print(f"Session {session_id} not found")
        return

    vision_model = get_model(session.vision_model)
    text_model = get_model(session.text_model)
    
    project_dir = Path(os.environ.get("VAPOR_PROJECT_DIR", "."))
    
    modified = False
    for unit in session.input_units:
        if unit.input_type in {"png", "jpg", "jpeg", "webp"} and "vision analysis failed" in (unit.visual_summary or ""):
            print(f"[*] Re-auditing failed unit: {unit.filename}")
            
            # Find the file
            # In Vapor Deck, raw_path is relative to the workspace usually
            file_path = project_dir / unit.raw_path
            if not file_path.exists():
                # Try relative to project assets
                file_path = project_dir / "assets" / (unit.filename or "")
            
            if not file_path.exists():
                print(f"[!] Could not find file for {unit.filename} at {file_path}")
                continue
                
            file_bytes = file_path.read_bytes()
            
            # Re-run extraction
            new_unit = await extract_image(session_id, file_bytes, unit.filename, vision_model, text_model)
            
            # Update the existing unit
            unit.visual_summary = new_unit.visual_summary
            unit.layout_hints = new_unit.layout_hints
            unit.font_hints = new_unit.font_hints
            unit.style_keywords = new_unit.style_keywords
            unit.color_palette = new_unit.color_palette
            modified = True
            print(f"[+] Fixed! New summary: {unit.visual_summary[:100]}...")

    if modified:
        save_session(session)
        print("[*] Session updated and saved.")
    else:
        print("[*] No failed units found to re-audit.")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python re_audit.py <session_id> [project_dir]")
        sys.exit(1)
        
    sid = sys.argv[1]
    if len(sys.argv) > 2:
        os.environ["VAPOR_PROJECT_DIR"] = sys.argv[2]
        
    asyncio.run(re_audit_session(sid))
