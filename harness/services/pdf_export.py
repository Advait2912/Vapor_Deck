import asyncio
import re
from pathlib import Path
from typing import List
from playwright.sync_api import sync_playwright
import logging

logger = logging.getLogger(__name__)

# Resolve project root (harness/ is inside Vapor_Deck/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
THEMES_DIR = PROJECT_ROOT / "front" / "public" / "themes"

SLIDE_VIEWPORT = {"width": 1280, "height": 720}


class PDFExportService:

    # ── Public API ─────────────────────────────────────────────────────────

    def build_html(self, slides: List[str], theme: str = "dark-tech") -> str:
        """Return the raw HTML document that would be rendered (for debugging)."""
        theme_css = self._load_theme_css(theme)
        # Ensure theme styles (like padding/bg) apply to each slide page
        scoped_theme_css = theme_css.replace("body", ".slide-page")
        return self._build_document(slides, scoped_theme_css)

    async def export_slides_to_pdf(self, slides: List[str], theme: str = "dark-tech") -> bytes:
        """
        Render a list of slide HTML strings into a single multi-page PDF.

        Offloads the blocking sync Playwright work to a background thread so
        FastAPI stays responsive and avoids the Windows asyncio subprocess bug.
        """
        if not slides:
            raise ValueError("No slides provided for export")

        logger.info(f"[PDF] Starting export: {len(slides)} slide(s), theme={theme}")

        # 1. Load theme
        logger.info("[PDF] Loading theme CSS...")
        theme_css = self._load_theme_css(theme)
        # Scope body styles to .slide-page
        scoped_theme_css = theme_css.replace("body", ".slide-page")
        logger.info(f"[PDF] Theme CSS loaded and scoped: {len(scoped_theme_css)} chars")

        # 2. Build document
        logger.info("[PDF] Building HTML document...")
        doc = self._build_document(slides, scoped_theme_css)
        logger.info(f"[PDF] Document built: {len(doc)} chars")

        # 3. Run sync Playwright in thread pool (avoids Windows asyncio subprocess bug)
        logger.info("[PDF] Delegating to sync Playwright thread...")
        loop = asyncio.get_event_loop()
        pdf_bytes = await loop.run_in_executor(None, self._render_pdf_sync, doc, len(slides))
        logger.info(f"[PDF] PDF ready: {len(pdf_bytes)} bytes")
        return pdf_bytes

    def _render_pdf_sync(self, doc: str, slide_count: int) -> bytes:
        """
        Synchronous Playwright PDF generation.
        Run via run_in_executor so it doesn't block the event loop.
        """
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_viewport_size(SLIDE_VIEWPORT)

            page.set_content(doc, wait_until="networkidle")

            # Wait for fonts
            try:
                page.wait_for_function("() => document.fonts.ready", timeout=5000)
            except Exception:
                logger.warning("[PDF] Font-loading timeout, proceeding anyway")



            page.wait_for_timeout(300)
            page.emulate_media(media="print")

            pdf_bytes = page.pdf(
                print_background=True,
                width=f"{SLIDE_VIEWPORT['width']}px",
                height=f"{SLIDE_VIEWPORT['height']}px",
                prefer_css_page_size=True,
                display_header_footer=False,
                margin={"top": "0px", "right": "0px", "bottom": "0px", "left": "0px"},
            )

            browser.close()
        return pdf_bytes

    # ── HTML construction ──────────────────────────────────────────────────

    def _build_document(self, slides: List[str], theme_css: str) -> str:
        """
        Assemble the full HTML document:
          1. Inline theme CSS
          2. Extract per-slide <style> blocks to <head>
          3. Wrap each slide in a scaler div (replicates the app's iframe fitSlide())
          4. Inject a script that measures natural size and scales to fit 1280×720
        """
        extracted_styles: List[str] = []
        processed_slides: List[str] = []

        for raw_html in slides:
            html = raw_html

            # Pull out <style> blocks → move to <head>
            styles_found = re.findall(r"<style[^>]*>([\s\S]*?)</style>", html, flags=re.IGNORECASE)
            for s in styles_found:
                extracted_styles.append(s.strip())
            html = re.sub(r"<style[^>]*>[\s\S]*?</style>", "", html, flags=re.IGNORECASE)

            # Strip <script> tags
            html = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", html, flags=re.IGNORECASE)

            # Force reveal animations visible
            html = html.replace('class="reveal', 'class="reveal visible')
            html = html.replace("class='reveal", "class='reveal visible")

            processed_slides.append(html)

        per_slide_style_block = ""
        if extracted_styles:
            per_slide_style_block = "<style>\n" + "\n\n".join(extracted_styles) + "\n</style>"

        # Build slides markup
        slides_markup = ""
        for i, html in enumerate(processed_slides):
            slides_markup += (
                f'<div class="slide-page">\n'
                f'  {html}\n'
                f'</div>\n'
            )

        return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Vapor Deck Export</title>
  <style>
{theme_css}
  </style>
  {per_slide_style_block}
  <style>
    @page {{
      margin: 0;
      size: {SLIDE_VIEWPORT["width"]}px {SLIDE_VIEWPORT["height"]}px;
    }}

    html, body {{
      margin: 0 !important;
      padding: 0 !important;
      background: #000;
    }}

    .slide-page {{
      display: block;
      width: {SLIDE_VIEWPORT["width"]}px;
      height: {SLIDE_VIEWPORT["height"]}px;
      page-break-after: always;
      page-break-inside: avoid;
      position: relative;
      overflow: hidden;
      box-sizing: border-box;
    }}

    .slide-page:last-child {{
      page-break-after: auto;
    }}

    .reveal, .reveal.visible {{
      opacity: 1 !important;
      transform: none !important;
      transition: none !important;
    }}

    .deco-ring, [class*="pulse"], [class*="animate"] {{
      animation: none !important;
    }}
  </style>
</head>
<body>
{slides_markup}
</body>
</html>"""

    # ── Theme loading ────────────────────────────────────────────────────────

    def _load_theme_css(self, theme: str) -> str:
        """Read the actual theme CSS from disk."""
        css_path = THEMES_DIR / f"{theme}.css"
        try:
            if css_path.exists():
                return css_path.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning(f"Could not read theme CSS at {css_path}: {exc}")

        # Fallback — match dark-tech values exactly
        logger.warning(f"Theme '{theme}' not found, using dark-tech fallback")
        return """:root {{
  --bg: #000000;
  --surface: #111111;
  --text: #ffffff;
  --accent: #8b5cf6;
  --font-head: 'Inter', sans-serif;
  --font-body: 'Inter', sans-serif;
}}
body {{
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-body);
  margin: 0;
  padding: 60px;
  height: 100vh;
  box-sizing: border-box;
}}
h1 {{
  font-family: var(--font-head);
  color: var(--accent);
  font-size: 3.5rem;
  margin-bottom: 30px;
}}
p {{
  font-size: 1.5rem;
  line-height: 1.6;
  color: #ccc;
}}
.reveal {{
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1), transform 0.6s cubic-bezier(0.16, 1, 0.3, 1);
  transition-delay: var(--delay, 0s);
}}
.reveal.visible {{
  opacity: 1;
  transform: translateY(0);
}}"""


# Singleton
pdf_service = PDFExportService()
