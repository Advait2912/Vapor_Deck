/**
 * PDF EXPORT
 * ──────────
 * Exports the approved slide deck as a PDF using window.print().
 *
 * Strategy: First version uses window.print() + print CSS.
 * No dependencies. Works everywhere.
 *
 * TODO: Upgrade to Playwright server-side PDF for higher fidelity.
 *
 * How it works:
 *   1. Gather all approved slide HTML from state
 *   2. Inject into a hidden #print-container
 *   3. Apply print CSS (landscape, page-breaks, theme preservation)
 *   4. Call window.print()
 *   5. Clean up
 */

import { state } from './state.js';

/**
 * Export all approved slides as PDF.
 * Falls back to including draft slides if no approved slides exist.
 */
export function exportDeckAsPDF() {
  // Collect slides in order
  const orderedSlides = _collectSlidesInOrder();

  if (!orderedSlides.length) {
    alert('No slides to export. Generate and approve some slides first.');
    return;
  }

  _injectPrintStyles();
  const container = _buildPrintContainer(orderedSlides, state.theme || 'dark-tech');

  document.body.appendChild(container);

  // Brief delay so browser paints the container before print dialog
  requestAnimationFrame(() => {
    setTimeout(() => {
      window.print();
      // Cleanup after print dialog closes
      setTimeout(() => {
        document.body.removeChild(container);
        _removePrintStyles();
      }, 500);
    }, 100);
  });
}

// ── Collect slides in outline order ──────────────────────────────────────────
function _collectSlidesInOrder() {
  const slides = [];

  state.outline.forEach((item, index) => {
    // Prefer approved → draft → latest
    const approved = state.slides?.find(s => s.index === index);
    const latest = state.latestSlides?.[index];
    const draft = state.draftSlides?.[index];

    const html = approved?.html || latest || draft;
    if (html) {
      slides.push({ index, title: item.title, html });
    }
  });

  return slides;
}

// ── Build the print container ─────────────────────────────────────────────────
function _buildPrintContainer(slides, theme) {
  const container = document.createElement('div');
  container.id = 'vapor-print-container';
  container.style.cssText = 'display:none;';

  container.innerHTML = slides.map((slide, i) => `
    <div class="vapor-print-slide" data-slide="${i + 1}" data-title="${slide.title}">
      <!--
        Each slide is wrapped in a full document context.
        The theme link is inlined as a data attribute so print CSS can reference it.
      -->
      <link rel="stylesheet" href="/themes/${theme}.css">
      ${slide.html}
    </div>
  `).join('');

  return container;
}

// ── Inject print-only styles ──────────────────────────────────────────────────
function _injectPrintStyles() {
  const style = document.createElement('style');
  style.id = 'vapor-print-styles';
  style.textContent = `
    @media print {
      /* Hide everything except our print container */
      body > *:not(#vapor-print-container) {
        display: none !important;
      }

      #vapor-print-container {
        display: block !important;
      }

      /* Each slide = one page */
      .vapor-print-slide {
        page-break-after: always;
        page-break-inside: avoid;
        width: 100vw;
        height: 100vh;
        overflow: hidden;
        position: relative;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      /* Last slide: no trailing page break */
      .vapor-print-slide:last-child {
        page-break-after: auto;
      }

      /* Slide section fills the page */
      .vapor-print-slide .slide,
      .vapor-print-slide section.slide {
        width: 100% !important;
        height: 100% !important;
        min-height: unset !important;
        max-width: 100% !important;
        margin: 0 !important;
        padding: 40px !important;
        box-shadow: none !important;
        border-radius: 0 !important;
      }

      /* Preserve backgrounds */
      * {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
        color-adjust: exact !important;
      }
    }

    /* Page setup: landscape A4 */
    @page {
      size: A4 landscape;
      margin: 0;
    }
  `;
  document.head.appendChild(style);
}

function _removePrintStyles() {
  document.getElementById('vapor-print-styles')?.remove();
}

/**
 * Get a count of exportable slides.
 * Useful for enabling/disabling the Export button.
 */
export function getExportableSlideCount() {
  return state.outline?.filter((_, index) => {
    return !!(
      state.slides?.some(s => s.index === index) ||
      state.latestSlides?.[index] ||
      state.draftSlides?.[index]
    );
  }).length || 0;
}
