/**
 * COMPARISON MODE — Split-View Refinement
 * ─────────────────────────────────────────
 * Implements split-view comparison when the user refines a slide.
 *
 * Behavior:
 *   - Left panel: freezes the CURRENT version immediately
 *   - Right panel: streams the new refinement LIVE
 *   - User can: keep current | use refined | refine again
 *   - History strip: thumbnails of all past attempts
 *
 * KEY DESIGN DECISION:
 *   We use srcdoc iframes for both panels to guarantee isolation.
 *   No CSS can leak between panels or into the app.
 */

// ── Comparison State ──────────────────────────────────────────────────────────
export const comparisonState = {
  active: false,
  before: null,   // { html, label }
  after: null,    // { html, label, streaming }
  history: [],    // [{ html, label }] — rejected attempts
};

// ── Enter Comparison Mode ─────────────────────────────────────────────────────
/**
 * @param {string} currentHtml - The current slide HTML to freeze on the left
 * @param {string} modeLabel - Human-readable label for the refinement type
 */
export function enterComparison(currentHtml, modeLabel = 'Refined') {
  comparisonState.active = true;
  comparisonState.before = { html: currentHtml, label: 'Current' };
  comparisonState.after = { html: '', label: modeLabel, streaming: true };

  const overlay = document.getElementById('comparison-overlay');
  if (!overlay) return;

  overlay.style.display = 'flex';

  // Freeze left panel immediately
  const iframeBefore = document.getElementById('iframe-before');
  if (iframeBefore) iframeBefore.srcdoc = currentHtml;

  // Clear right panel, show streaming indicator
  const iframeAfter = document.getElementById('iframe-after');
  if (iframeAfter) {
    iframeAfter.srcdoc = _streamingPlaceholder();
  }

  // Clear history strip (new comparison session)
  _renderHistoryStrip();
}

// ── Append Token to After Panel ───────────────────────────────────────────────
/**
 * Called for each streamed token. Accumulates HTML and updates the right panel.
 * IMPORTANT: Does NOT inject token-by-token — accumulates first, then patches.
 * This prevents broken DOM from partial HTML.
 *
 * @param {string} token - raw HTML token from SSE stream
 */
export function appendComparisonToken(token) {
  if (!comparisonState.active || !comparisonState.after) return;

  comparisonState.after.html += token;
  comparisonState.after.streaming = true;

  // Buffer: only update iframe every ~200ms to avoid constant repaints
  if (!comparisonState._updatePending) {
    comparisonState._updatePending = true;
    setTimeout(() => {
      _patchAfterPanel(comparisonState.after.html);
      comparisonState._updatePending = false;
    }, 150);
  }
}

// ── Finalize After Panel ──────────────────────────────────────────────────────
/**
 * Called when the stream completes. Renders the final HTML.
 */
export function finalizeComparison() {
  if (!comparisonState.after) return;
  comparisonState.after.streaming = false;
  _patchAfterPanel(comparisonState.after.html);
}

// ── Refine Again ──────────────────────────────────────────────────────────────
/**
 * Push the current "after" into history, make it the new "before",
 * and start a new streaming slot.
 *
 * @returns {string} - the HTML that should now be treated as "before"
 */
export function refineAgain() {
  if (!comparisonState.after?.html) return null;

  // Push current "after" to history
  comparisonState.history.push({
    html: comparisonState.after.html,
    label: comparisonState.after.label,
  });

  // Promote "after" to "before"
  comparisonState.before = {
    html: comparisonState.after.html,
    label: comparisonState.after.label,
  };

  comparisonState.after = {
    html: '',
    label: 'Refined Again',
    streaming: true,
  };

  // Update left panel
  const iframeBefore = document.getElementById('iframe-before');
  if (iframeBefore) iframeBefore.srcdoc = comparisonState.before.html;

  const iframeAfter = document.getElementById('iframe-after');
  if (iframeAfter) iframeAfter.srcdoc = _streamingPlaceholder();

  _renderHistoryStrip();

  return comparisonState.before.html;
}

// ── Keep Current (close comparison, discard after) ────────────────────────────
export function keepCurrent() {
  _closeComparison();
  return comparisonState.before?.html || null;
}

// ── Use Refined (close comparison, adopt after) ───────────────────────────────
export function useRefined() {
  const html = comparisonState.after?.html || null;
  _closeComparison();
  return html;
}

// ── Restore History Item ──────────────────────────────────────────────────────
export function restoreHistoryItem(index) {
  const item = comparisonState.history[index];
  if (!item) return;

  // Push current "before" into history (rotating it out)
  comparisonState.history.splice(index, 1);

  comparisonState.before = { html: item.html, label: item.label };

  const iframeBefore = document.getElementById('iframe-before');
  if (iframeBefore) iframeBefore.srcdoc = item.html;

  _renderHistoryStrip();
}

// ── Private helpers ───────────────────────────────────────────────────────────
function _closeComparison() {
  comparisonState.active = false;
  const overlay = document.getElementById('comparison-overlay');
  if (overlay) overlay.style.display = 'none';
}

function _patchAfterPanel(html) {
  const iframe = document.getElementById('iframe-after');
  if (!iframe || !html) return;
  iframe.srcdoc = html;
}

function _streamingPlaceholder() {
  return `
    <html><body style="background:#000;color:#444;display:flex;align-items:center;
      justify-content:center;height:100vh;margin:0;font-family:monospace;
      font-size:0.8rem;text-transform:uppercase;letter-spacing:0.2em;">
      <div>Streaming...</div>
    </body></html>
  `;
}

function _renderHistoryStrip() {
  const strip = document.getElementById('history-strip');
  if (!strip) return;

  if (!comparisonState.history.length) {
    strip.innerHTML = '<div style="color: var(--text-muted); font-size: 0.75rem; align-self: center; padding: 0 10px;">Past refinements will appear here</div>';
    return;
  }

  strip.innerHTML = comparisonState.history.map((item, i) => `
    <div
      class="history-thumb"
      data-index="${i}"
      title="${item.label}"
      style="
        width: 120px; height: 80px; flex-shrink: 0;
        border: 1px solid var(--border); border-radius: 3px;
        cursor: pointer; overflow: hidden; position: relative;
        transition: border-color 0.2s;
      "
    >
      <iframe
        srcdoc="${_escapeSrcdoc(item.html)}"
        style="width:192px;height:108px;transform:scale(0.625);transform-origin:top left;border:none;pointer-events:none;"
      ></iframe>
      <div style="
        position:absolute;bottom:0;left:0;right:0;
        background:rgba(0,0,0,0.8);color:#aaa;
        font-size:0.55rem;padding:2px 4px;text-transform:uppercase;
      ">${item.label}</div>
    </div>
  `).join('');

  strip.querySelectorAll('.history-thumb').forEach(thumb => {
    thumb.addEventListener('mouseenter', () => thumb.style.borderColor = 'var(--accent)');
    thumb.addEventListener('mouseleave', () => thumb.style.borderColor = 'var(--border)');
    thumb.addEventListener('click', () => {
      const idx = parseInt(thumb.dataset.index);
      restoreHistoryItem(idx);
    });
  });
}

function _escapeSrcdoc(html) {
  return html.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Initialize comparison overlay button bindings.
 * Call once on app startup.
 * @param {object} callbacks - { onUseRefined(html), onKeepCurrent() }
 */
export function initComparisonOverlay(callbacks = {}) {
  const { onUseRefined, onKeepCurrent } = callbacks;

  document.getElementById('keep-before-btn')?.addEventListener('click', () => {
    const html = keepCurrent();
    onKeepCurrent?.(html);
  });

  document.getElementById('use-after-btn')?.addEventListener('click', () => {
    const html = useRefined();
    if (html) onUseRefined?.(html);
  });

  document.getElementById('close-comparison')?.addEventListener('click', () => {
    keepCurrent();
    onKeepCurrent?.();
  });
}
export function resetComparison() {
  comparisonState.active = false;
  comparisonState.before = null;
  comparisonState.after = null;
  comparisonState.history = [];
}
export const useRefinedVersion = useRefined;