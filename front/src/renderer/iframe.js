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
  theme = 'dark-tech'
) {
  if (!iframe) return;

  const cleanHtml = _stripMarkdownFences(html);

  // Safer initialization check
  if (
    !iframe.dataset.initialized ||
    !iframe.contentWindow ||
    !iframe.contentDocument
  ) {
    iframe.srcdoc = buildBaseDocument(cleanHtml, theme);
    iframe.dataset.initialized = 'true';
    return;
  }

  // Patch existing iframe
  patchExistingIframe(
    iframe,
    cleanHtml,
    theme
  );
}

// ── Base iframe document (created ONCE) ──────────────────────────────────────

export function buildBaseDocument(
  slideHtml,
  theme = 'dark-tech'
) {
  return `<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  >

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

    /* Audit Mode: Stop all animations for instant capture */
    body.audit-mode *,
    body.audit-mode *::before,
    body.audit-mode *::after {
      animation: none !important;
      transition: none !important;
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
  theme
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
          theme
        );

      iframe.dataset.initialized = 'true';

      return;
    }

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