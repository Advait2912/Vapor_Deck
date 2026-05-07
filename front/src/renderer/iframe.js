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

// ── Buffer state for streaming ────────────────────────────────────────────────

const _buffers = new Map();

function _getBuffer(iframeId) {
  if (!_buffers.has(iframeId)) {
    _buffers.set(iframeId, {
      pending: false,
      accumulated: '',
    });
  }

  return _buffers.get(iframeId);
}

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
  <link
    rel="stylesheet"
    href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css"
  >

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

    #slide-scaler {
      position: absolute;
      top: 0;
      left: 0;

      transform-origin: top left;

      width: max-content;
      height: max-content;
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

  </style>
</head>

<body>

  <div id="slide-scaler">
    ${slideHtml}
  </div>

  <!-- Prism Core -->
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>

  <!-- Prism Languages -->
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-javascript.min.js"></script>
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-python.min.js"></script>
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-typescript.min.js"></script>
  <script defer src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-bash.min.js"></script>

  <script>

    // ─────────────────────────────────────────────────────────────
    // Slide scaler
    // ─────────────────────────────────────────────────────────────

    function fitSlide() {

      const scaler =
        document.getElementById('slide-scaler');

      if (!scaler) return;

      const slide =
        scaler.firstElementChild;

      if (!slide) return;

      const naturalW =
        slide.scrollWidth ||
        slide.offsetWidth ||
        1280;

      const naturalH =
        slide.scrollHeight ||
        slide.offsetHeight ||
        720;

      const scaleX =
        window.innerWidth / naturalW;

      const scaleY =
        window.innerHeight / naturalH;

      const scale =
        Math.min(scaleX, scaleY);

      scaler.style.transform =
        'scale(' + scale + ')';

      const scaledW =
        naturalW * scale;

      const scaledH =
        naturalH * scale;

      scaler.style.marginLeft =
        ((window.innerWidth - scaledW) / 2) + 'px';

      scaler.style.marginTop =
        ((window.innerHeight - scaledH) / 2) + 'px';
    }

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

      const scaler =
        document.getElementById('slide-scaler');

      if (!scaler) return;

      scaler.innerHTML = newHtml;

      requestAnimationFrame(() => {
        fitSlide();
      });

      setTimeout(triggerReveal, 50);
      setTimeout(highlightCode, 100);
    };

    // ─────────────────────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────────────────────

    window.addEventListener('load', function() {

      fitSlide();

      setTimeout(triggerReveal, 100);
      setTimeout(highlightCode, 200);
    });

    window.addEventListener(
      'resize',
      fitSlide
    );

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

// ── Streaming ─────────────────────────────────────────────────────────────────

export function appendStreamToken(
  iframe,
  token,
  theme = 'dark-tech',
  iframeId = 'main'
) {

  const buf =
    _getBuffer(iframeId);

  buf.accumulated += token;

  if (!buf.pending) {

    buf.pending = true;

    setTimeout(() => {

      _patchIframe(
        iframe,
        buf.accumulated,
        theme
      );

      buf.pending = false;

    }, 200);
  }
}

export function finalizeStream(
  iframe,
  theme = 'dark-tech',
  iframeId = 'main'
) {

  const buf =
    _getBuffer(iframeId);

  buf.pending = false;

  if (buf.accumulated) {

    _patchIframe(
      iframe,
      buf.accumulated,
      theme
    );
  }

  _buffers.delete(iframeId);
}

export function clearStreamBuffer(
  iframeId = 'main'
) {
  _buffers.delete(iframeId);
}

// ── Internal patch handler ────────────────────────────────────────────────────

function _patchIframe(
  iframe,
  html,
  theme
) {

  if (
    !iframe ||
    !html?.trim()
  ) {
    return;
  }

  if (
    !html.includes('<section') &&
    !html.includes('<div') &&
    !html.includes('<style')
  ) {
    return;
  }

  patchExistingIframe(
    iframe,
    html,
    theme
  );
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