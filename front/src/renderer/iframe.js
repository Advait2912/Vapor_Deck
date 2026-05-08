/**
 * ISOLATED SLIDE RENDERER — iframe.js
 * ─────────────────────────────────────
 *
 * FINAL ARCHITECTURE:
 *   1. Prism loads ONLY ONCE per iframe lifecycle
 *   2. Streaming patches DOM instead of rebuilding srcdoc
 *   3. No Prism race conditions
 *   4. Theme propagation preserved
 *   5. Safer iframe recovery logic
 *   6. Stable resize/render timing
 *
 * A small miracle by frontend standards.
 */

import prismTheme from 'prismjs/themes/prism-tomorrow.css?raw';
import prismCore from 'prismjs/prism.js?raw';
import prismJS from 'prismjs/components/prism-javascript?raw';
import prismPy from 'prismjs/components/prism-python?raw';
import prismTS from 'prismjs/components/prism-typescript?raw';
import prismBash from 'prismjs/components/prism-bash?raw';

// Escape backticks and ${ so they don't break the template literal in buildBaseDocument
const _esc = (s) => s.replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const safePrismCore = _esc(prismCore);
const safePrismJS = _esc(prismJS);
const safePrismPy = _esc(prismPy);
const safePrismTS = _esc(prismTS);
const safePrismBash = _esc(prismBash);

// ── Core iframe initialization ────────────────────────────────────────────────

export function renderSlideInIframe(
  iframe,
  html,
  theme = 'dark-tech',
  fonts = []
) {
  if (!iframe) return;

  const cleanHtml = _stripMarkdownFences(html);

  // Safer initialization check
  if (
    !iframe.dataset.initialized ||
    !iframe.contentWindow ||
    !iframe.contentDocument
  ) {
    iframe.srcdoc = buildBaseDocument(cleanHtml, theme, fonts);
    iframe.dataset.initialized = 'true';
    return;
  }

  // Patch existing iframe
  patchExistingIframe(
    iframe,
    cleanHtml,
    theme,
    fonts
  );
}

// ── Base iframe document (created ONCE) ──────────────────────────────────────

export function buildBaseDocument(
  slideHtml,
  theme = 'dark-tech',
  fonts = []
) {
  const fontLink = _buildGoogleFontsLink(fonts);

  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

  <!-- Dynamic Typography -->
  ${fontLink}

  <!-- Theme CSS -->
  <link
    rel="stylesheet"
    href="/themes/${theme}.css"
  >

  <!-- Prism Theme -->
  <style>
    ${prismTheme}
  </style>

  <style>

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    html,
    body {
      margin: 0;
      padding: 0;

      width: 100%;
      height: 100%;

      overflow: hidden;

      background: transparent;
    }



    .reveal {
      opacity: 0;

      transform: translateY(20px);

      transition:
        opacity 0.5s cubic-bezier(0.16,1,0.3,1),
        transform 0.5s cubic-bezier(0.16,1,0.3,1);

      transition-delay: var(--delay, 0s);
    }

    .reveal.visible {
      opacity: 1;
      transform: translateY(0);
    }

    /* Audit Mode: Stop all animations for a stable capture */
    body.audit-mode *,
    body.audit-mode *::before,
    body.audit-mode *::after {
      animation: none !important;
      transition: none !important;
    }

    /* Force content to be visible even if animations haven't finished */
    body.audit-mode .reveal {
      opacity: 1 !important;
      visibility: visible !important;
      transform: none !important;
    }

  </style>
</head>

<body>

  <div id="slide-container" style="width: 100%; height: 100%;">
    ${slideHtml}
  </div>

  <!-- Prism Core & Languages -->
  <script>
    (function() {
      ${prismCore}
      ${prismJS}
      ${prismPy}
      ${prismTS}
      ${prismBash}
    })();
  </script>

  <script>



    // ─────────────────────────────────────────────────────────────
    // Reveal animations
    // ─────────────────────────────────────────────────────────────

    function triggerReveal() {

      document
        .querySelectorAll('.reveal')
        .forEach(function(el) {
          el.classList.add('visible');
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Syntax highlighting
    // ─────────────────────────────────────────────────────────────

    function highlightCode() {

      if (
        typeof Prism !== 'undefined' &&
        Prism.highlightAll
      ) {

        try {

          Prism.highlightAll();

        } catch (err) {

          console.warn(
            'Prism highlight failed:',
            err
          );
        }
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Safe content patcher
    // ─────────────────────────────────────────────────────────────

    window.__PATCH_SLIDE__ = function(newHtml) {
      const container = document.getElementById('slide-container');
      if (!container) return;
      window.__VAPOR_READY__ = false;
      container.innerHTML = newHtml;

      setTimeout(() => {
        triggerReveal();
        highlightCode();
        if (typeof window.parent.scaleIframe === 'function') window.parent.scaleIframe();
        // Signal ready for audit after a small delay to ensure layout stability
        setTimeout(() => { window.__VAPOR_READY__ = true; }, 300);
      }, 50);
    };

    // ─────────────────────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────────────────────

    window.addEventListener('load', function() {
      window.__VAPOR_READY__ = false;

      setTimeout(() => {
        triggerReveal();
        highlightCode();
        if (typeof window.parent.scaleIframe === 'function') window.parent.scaleIframe();
        setTimeout(() => { window.__VAPOR_READY__ = true; }, 300);
      }, 100);
    });

  </script>

</body>
</html>`;
}

// ── Patch existing iframe WITHOUT recreating srcdoc ──────────────────────────

function patchExistingIframe(
  iframe,
  html,
  theme,
  fonts = []
) {

  try {

    const win =
      iframe.contentWindow;

    if (
      !win ||
      !win.__PATCH_SLIDE__
    ) {

      // iframe not ready yet
      iframe.srcdoc =
        buildBaseDocument(
          html,
          theme,
          fonts
        );

      iframe.dataset.initialized = 'true';

      return;
    }

    // If fonts changed, we might need a full rebuild or dynamic link injection.
    // For simplicity and stability, if fonts are provided, we ensure the link exists.
    ensureFontsInDocument(win.document, fonts);

    win.__PATCH_SLIDE__(html);

  } catch (err) {

    console.warn(
      'Iframe patch failed, rebuilding:',
      err
    );

    iframe.srcdoc =
      buildBaseDocument(
        html,
        theme
      );

    iframe.dataset.initialized = 'true';
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

export function _stripMarkdownFences(text) {

  if (!text) return '';

  text = text.trim();

  if (text.startsWith('```')) {

    const firstNewline =
      text.indexOf('\n');

    if (firstNewline !== -1) {

      text =
        text.slice(firstNewline + 1);

    } else {

      text =
        text.slice(3);
    }
  }

  if (text.endsWith('```')) {

    text =
      text.slice(
        0,
        text.lastIndexOf('```')
      );
  }

  return text.trim();
}

export function validateSlideHtml(html) {

  if (
    !html ||
    typeof html !== 'string'
  ) {
    return false;
  }

  return (
    html.includes('<section') &&
    html.includes('slide')
  );
}

// ── Private Font Helpers ──────────────────────────────────────────────────────

function _buildGoogleFontsLink(fonts = []) {
  const core = ['Inter:wght@300;400;600;700', 'JetBrains+Mono:wght@400;700'];
  
  // Clean and deduplicate fonts
  const cleanFonts = (fonts || []).map(f => {
    // Remove "serif", "sans-serif" etc. and take the first family name
    const family = f.split(',')[0].trim().replace(/['"]/g, '');
    return family.replace(/ /g, '+');
  }).filter(f => f && !['serif', 'sans-serif', 'monospace', 'inherit', 'initial'].includes(f.toLowerCase()));

  const allFamilies = [...new Set([...core, ...cleanFonts])];
  
  // Request a range of weights (400, 700, 900) for each family to ensure 'true' weights
  // Note: some fonts might not support all weights, but Google Fonts handles this gracefully
  const queryParts = allFamilies.map(f => {
    // If it already has weights (like core fonts), use as is
    if (f.includes(':wght@')) return `family=${f}`;
    // Otherwise add our standard broad range
    return `family=${f}:wght@400;700;900`;
  });

  const url = `https://fonts.googleapis.com/css2?${queryParts.join('&')}&display=swap`;

  return `
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="${url}" rel="stylesheet">
  `;
}

export function ensureFontsInDocument(doc, fonts = []) {
  if (!fonts || !fonts.length) return;
  const linkId = 'dynamic-google-fonts';
  
  // Clean and deduplicate fonts
  const requested = fonts.map(f => {
    // Better cleaning: remove quotes and generic families
    const family = f.split(',')[0].trim().replace(/['"]/g, '');
    return family;
  }).filter(f => f && !['serif', 'sans-serif', 'monospace', 'inherit', 'initial'].includes(f.toLowerCase()));

  if (!requested.length) return;

  const html = _buildGoogleFontsLink(requested);
  const temp = doc.createElement('div');
  temp.innerHTML = html;
  
  Array.from(temp.children).forEach(node => {
    if (node.tagName === 'LINK' && node.rel === 'stylesheet') {
      node.id = linkId;
    }
    doc.head.appendChild(node);
  });
}

// ── Placeholder renderer ──────────────────────────────────────────────────────

export function renderPlaceholderInIframe(
  iframe,
  message = 'Loading...'
) {

  if (!iframe) return;

  iframe.srcdoc = `<!DOCTYPE html>
<html>

<head>
  <style>

    body {
      background: #000;
      color: #444;

      display: flex;
      align-items: center;
      justify-content: center;

      height: 100vh;
      margin: 0;

      font-family: system-ui, sans-serif;
      font-size: 0.8rem;

      text-transform: uppercase;
      letter-spacing: 0.15em;
    }

    .msg {
      border: 1px dashed #222;

      padding: 32px 48px;

      border-radius: 4px;

      text-align: center;
    }

  </style>
</head>

<body>
  <div class="msg">${message}</div>
</body>

</html>`;
}
export const buildSlideDocument = buildBaseDocument;