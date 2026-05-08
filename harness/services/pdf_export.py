"""
PDF Export Service — Unified 1280×720 Pipeline
───────────────────────────────────────────────

Architecture:
  1. Frontend sends raw slide HTML (the <section class="slide"> blocks + inline <style>)
  2. We load the theme CSS from disk and inline it
  3. Each slide is wrapped in a fixed 1280×720 .slide-page container
  4. Playwright renders the HTML at 1280×720 viewport → PDF

Key design decisions:
  - sync_playwright in run_in_executor (avoids Windows asyncio subprocess bug)
  - Each slide is isolated in its own <iframe srcdoc="..."> guaranteeing 100% CSS isolation
  - The #slide-scaler logic is embedded inside the iframe to flawlessly downscale oversized content
  - All .reveal animations are forced visible (for static PDF viewing)
  - The <base> tag points at the Vite dev server so fonts/assets resolve perfectly
"""

import asyncio
import logging
import os
import re
from pathlib import Path
from typing import List, Optional
from playwright.sync_api import sync_playwright

logger = logging.getLogger("services.pdf_export")

# Resolve project root (harness/ is inside Vapor_Deck/)
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
THEMES_DIR = PROJECT_ROOT / "front" / "public" / "themes"

SLIDE_VIEWPORT = {"width": 1280, "height": 720}


class PDFExportService:

    # ── Public API ─────────────────────────────────────────────────────────

    async def export_slides_to_pdf(
        self,
        slides_html: List[str],
        theme: str = "dark-tech",
        session_id: Optional[str] = None,
    ) -> bytes:
        if not slides_html:
            raise ValueError("No slides provided for export")

        logger.info(f"[PDF] Starting export: {len(slides_html)} slide(s), theme={theme}")

        # 1. Load theme CSS (raw, unmodified — same as what the iframe uses)
        theme_css = self._load_theme_css(theme)

        # 2. Build the complete HTML document
        doc = self._build_document(slides_html, theme_css, theme)

        # 3. Render via sync Playwright in a thread pool
        loop = asyncio.get_event_loop()
        pdf_bytes = await loop.run_in_executor(None, self._render_pdf_sync, doc)
        logger.info(f"[PDF] Done — {len(pdf_bytes)} bytes")
        return pdf_bytes

    # ── Sync Playwright renderer ───────────────────────────────────────────

    def _render_pdf_sync(self, html_content: str) -> bytes:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            page = browser.new_page()
            page.set_viewport_size(SLIDE_VIEWPORT)

            page.set_content(html_content, wait_until="networkidle")

            # Wait for fonts to load in both main document and all iframes
            try:
                page.wait_for_function(
                    """() => {
                        if (document.fonts.status !== 'loaded') return false;
                        const iframes = Array.from(document.querySelectorAll('iframe'));
                        return iframes.every(f => {
                            try { return f.contentDocument.fonts.status === 'loaded'; }
                            catch (e) { return true; }
                        });
                    }""",
                    timeout=5000
                )
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

    # ── HTML document construction ─────────────────────────────────────────

    def _build_document(self, slides: List[str], theme_css: str, theme: str = "dark-tech") -> str:
        """
        Assemble the full HTML document for PDF rendering.
        Each slide is embedded in its own <iframe srcdoc="..."> to guarantee
        100% CSS isolation, exactly mirroring the frontend's iframe architecture.
        """
        import html

        slides_markup = ""
        for raw_html in slides:
            # Clean up the raw html
            slide_html = re.sub(r"<script[^>]*>[\s\S]*?</script>", "", raw_html, flags=re.IGNORECASE)
            slide_html = slide_html.replace('class="reveal', 'class="reveal visible')
            slide_html = slide_html.replace("class='reveal", "class='reveal visible")

            # Build the isolated iframe document for this slide
            iframe_doc = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <base href="http://localhost:5173/">
  <!-- Theme CSS from Vite -->
  <link rel="stylesheet" href="/themes/{theme}.css">
  <link rel="stylesheet" href="/lib/prism/prism-tomorrow.css">
  
  <!-- Inline fallback -->
  <style>{theme_css}</style>
  
  <style>
    /* Exact match to iframe.js base styles */
    *, *::before, *::after {{ box-sizing: border-box; }}
    html, body {{
      margin: 0; padding: 0;
      width: 100%; height: 100%;
      overflow: hidden;
      background: transparent;
    }}
    
    #slide-scaler {{
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: top left;
      width: max-content;
      height: max-content;
    }}
    
    /* Disable animations for PDF */
    *, *::before, *::after {{
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
    }}
    .reveal, .reveal.visible {{
      opacity: 1 !important;
      visibility: visible !important;
      transform: none !important;
    }}
  </style>
</head>
<body>
  <div id="slide-scaler">
    {slide_html}
  </div>

  <script>
    function fitSlide() {{
      const scaler = document.getElementById('slide-scaler');
      if (!scaler) return;
      const slide = scaler.firstElementChild;
      if (!slide) return;

      const naturalW = slide.scrollWidth || slide.offsetWidth || 1280;
      const naturalH = slide.scrollHeight || slide.offsetHeight || 720;
      const scaleX = window.innerWidth / naturalW;
      const scaleY = window.innerHeight / naturalH;
      const scale = Math.min(scaleX, scaleY);

      scaler.style.transform = 'scale(' + scale + ')';
      const scaledW = naturalW * scale;
      const scaledH = naturalH * scale;
      scaler.style.marginLeft = ((window.innerWidth - scaledW) / 2) + 'px';
      scaler.style.marginTop = ((window.innerHeight - scaledH) / 2) + 'px';
    }}

    window.addEventListener('load', fitSlide);
    // Call immediately just in case
    fitSlide();
  </script>
</body>
</html>"""
            
            # Escape the document for the srcdoc attribute
            escaped_doc = html.escape(iframe_doc, quote=True)
            
            slides_markup += f"""
            <div class="slide-page">
              <iframe srcdoc="{escaped_doc}"></iframe>
            </div>
            """

        return f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    @page {{
      margin: 0;
      size: {SLIDE_VIEWPORT["width"]}px {SLIDE_VIEWPORT["height"]}px;
    }}

    html, body {{
      margin: 0;
      padding: 0;
      background: #000;
      width: {SLIDE_VIEWPORT["width"]}px;
    }}

    .slide-page {{
      width: {SLIDE_VIEWPORT["width"]}px;
      height: {SLIDE_VIEWPORT["height"]}px;
      overflow: hidden;
      page-break-after: always;
      page-break-inside: avoid;
    }}

    .slide-page:last-child {{
      page-break-after: auto;
    }}

    iframe {{
      width: 1280px;
      height: 720px;
      border: none;
      margin: 0;
      padding: 0;
      display: block;
    }}
  </style>
</head>
<body>
  {slides_markup}
</body>
</html>"""

    # ── Theme loading ──────────────────────────────────────────────────────

    def _load_theme_css(self, theme: str) -> str:
        """Read the actual theme CSS file from disk."""
        css_path = THEMES_DIR / f"{theme}.css"
        try:
            if css_path.exists():
                return css_path.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning(f"Could not read theme CSS at {css_path}: {exc}")

        logger.warning(f"[PDF] Theme '{theme}' not found at {css_path}, using empty")
        return ""


# Singleton
pdf_service = PDFExportService()
