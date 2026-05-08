from fastapi import APIRouter
from pathlib import Path
from store.sessions import get_project_dir

router = APIRouter()

@router.get("/assets")
async def list_assets():
    """
    List all files in the {project}/assets/ directory.
    The LLM uses these filenames to insert <img src='/assets/filename'> tags.
    """
    asset_dir = get_project_dir() / "assets"
    if not asset_dir.exists():
        return {"assets": []}
    
    # Return filenames of all actual files (not directories)
    files = [f.name for f in asset_dir.iterdir() if f.is_file()]
    return {"assets": sorted(files)}
