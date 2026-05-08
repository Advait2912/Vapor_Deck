"""
Theme Compiler — Self-Contained Slide HTML
==========================================

Reads a compiled theme CSS file from front/public/themes/ and embeds it
inline inside a full HTML document so that slide_NN_standalone.html files
render correctly when opened directly in a browser, outside the Vite dev
server.

The live iframe preview is completely unaffected — it continues to load the
theme via the Vite-served /themes/ URL.  Only the on-disk saved copies use
this module.

Path resolution:
  harness/services/theme_compiler.py  (this file)
  ├── ../  → harness/
  └── ../../ → repo root → front/public/themes/
"""
import logging
from pathlib import Path

logger = logging.getLogger("theme_compiler")

# Resolve the themes directory relative to this source file so the path
# works regardless of the process working directory.
_HARNESS_DIR = Path(__file__).parent.parent           # harness/
_REPO_ROOT   = _HARNESS_DIR.parent                    # repo root
_THEME_DIR   = _REPO_ROOT / "front" / "public" / "themes"


def get_theme_css(theme: str) -> str:
    """
    Read and return the raw CSS text for *theme*.

    Falls back to an empty string (and logs a warning) if the file is missing
    so callers never have to handle exceptions for this non-critical step.
    """
    path = _THEME_DIR / f"{theme}.css"
    if path.exists():
        try:
            return path.read_text(encoding="utf-8")
        except OSError as exc:
            logger.warning(f"Could not read theme file {path}: {exc}")
    else:
        logger.warning(
            f"Theme '{theme}' not found at {path}. "
            "Standalone HTML will have no theme CSS."
        )
    return ""


def make_standalone_html(slide_html: str, theme: str) -> str:
    """
    Wrap a bare ``<section class="slide">`` fragment in a fully self-contained
    HTML document with the theme CSS embedded inline.

    The resulting file can be opened directly in any browser without a web
    server.  Prism syntax-highlighting is **not** embedded here — it is only
    relevant in the live preview where Vite serves the library.

    Args:
        slide_html: The raw HTML fragment produced by the LLM (the
                    ``<section class="slide"> … </section>`` block).
        theme:      One of ``dark-tech``, ``clean-light``, or ``brutalist``.

    Returns:
        A complete ``<!DOCTYPE html>`` string ready to be written to disk.
    """
    css = get_theme_css(theme)
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Slide</title>
  <style>
    *, *::before, *::after {{ box-sizing: border-box; }}
    html, body {{
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }}
  </style>
  <style>
{css}
  </style>
</head>
<body style="margin:0;width:100%;height:100%;">
{slide_html}
</body>
</html>"""
