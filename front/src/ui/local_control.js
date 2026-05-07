/**
 * LOCAL CONTROL SYSTEM
 * ─────────────────────
 * Per-slide refinement controls.
 * These affect ONLY the current slide being viewed.
 *
 * Local actions:
 *   - regenerate: fresh generation from outline spec
 *   - simplify: fewer words, fewer elements
 *   - expand: more detail, deeper explanation
 *   - add-example: add a concrete real-world example
 *   - make-interactive: add tabs/toggles/reveals via JS
 *
 * KEY DESIGN DECISION:
 *   Local controls NEVER touch other slides.
 *   Already-approved slides in other positions remain frozen.
 *   Only the *current* slide is modified.
 *
 * TODO: Wire up keyboard shortcuts (e.g. Ctrl+Enter = regenerate)
 */

import { state } from '../state.js';

// Refinement modes with labels and descriptions
export const REFINE_MODES = {
  simplify:    { label: 'Simplify',     icon: '⊖', desc: 'Fewer words, keep only the essentials' },
  expand:      { label: 'Expand',       icon: '⊕', desc: 'Add depth, more explanation' },
  example:     { label: 'Add Example',  icon: '◈', desc: 'Insert a concrete real-world example' },
  interactive: { label: 'Interactive',  icon: '⊙', desc: 'Add tabs, toggles, or hover reveals' },
};

/**
 * Render local slide controls into a container element.
 * @param {HTMLElement} container - element to render into
 * @param {object} callbacks - { onRefine(mode), onRegenerate(), onApprove() }
 */
export function renderLocalControls(container, callbacks = {}) {
  if (!container) return;

  const { onRefine, onRegenerate, onApprove } = callbacks;

  const hasSlide = !!(state.draftSlides?.[state.currentIndex] || state.currentSlideHtml);
  const isGenerating = !!state.generatingSlides?.[state.currentIndex];

  container.innerHTML = `
    <div class="local-controls" style="
      display: flex; flex-direction: column; gap: 8px; padding: 12px;
    ">
      <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em;
                  color: var(--text-muted); margin-bottom: 2px;">
        Slide ${state.currentIndex + 1} Controls
      </div>

      <!-- Refinement buttons -->
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">
        ${Object.entries(REFINE_MODES).map(([mode, { label, icon, desc }]) => `
          <button
            class="local-refine-btn"
            data-mode="${mode}"
            title="${desc}"
            ${(!hasSlide || isGenerating) ? 'disabled' : ''}
            style="
              flex: 1; min-width: 80px;
              background: var(--bg-input); border: 1px solid var(--border);
              color: ${hasSlide ? 'var(--text-muted)' : '#444'};
              padding: 5px 8px; border-radius: 3px; cursor: ${hasSlide ? 'pointer' : 'not-allowed'};
              font-size: 0.72rem; display: flex; align-items: center; gap: 4px;
              transition: all 0.15s;
            "
          >
            <span>${icon}</span> ${label}
          </button>
        `).join('')}
      </div>

      <!-- Custom instruction input -->
      <div style="display: flex; gap: 6px; align-items: stretch; margin-top: 4px;">
        <textarea
          id="local-instruction-input"
          placeholder="Custom instruction for this slide..."
          style="
            flex: 1; min-height: 36px; max-height: 80px;
            background: var(--bg-input); border: 1px solid var(--border);
            color: var(--text-main); padding: 6px 8px; border-radius: 3px;
            font-size: 0.8rem; font-family: inherit; resize: vertical;
          "
        ></textarea>
      </div>

      <!-- Primary actions -->
      <div style="display: flex; gap: 6px; margin-top: 2px;">
        <button
          id="local-regen-btn"
          ${isGenerating ? 'disabled' : ''}
          style="
            background: var(--bg-input); border: 1px solid var(--border);
            color: var(--text-muted); padding: 5px 10px; border-radius: 3px;
            cursor: pointer; font-size: 0.8rem; transition: all 0.15s;
          "
          title="Regenerate this slide from scratch"
        >↻ Regen</button>

        <button
          id="local-approve-btn"
          ${(!hasSlide || isGenerating) ? 'disabled' : ''}
          style="
            flex: 1;
            background: ${hasSlide ? 'var(--accent)' : 'var(--bg-input)'};
            border: 1px solid ${hasSlide ? 'var(--accent)' : 'var(--border)'};
            color: ${hasSlide ? 'white' : '#444'};
            padding: 5px 10px; border-radius: 3px;
            cursor: ${hasSlide ? 'pointer' : 'not-allowed'};
            font-size: 0.8rem; font-weight: 600; transition: all 0.15s;
          "
          title="Approve this slide and mark it complete"
        >Approve Slide →</button>
      </div>

      <!-- Lifecycle state indicator -->
      <div id="local-lifecycle-badge" style="
        font-size: 0.65rem; padding: 3px 8px; border-radius: 10px; align-self: flex-start;
        ${_getLifecycleBadgeStyle()}
      ">
        ${_getLifecycleBadgeText()}
      </div>
    </div>

    <style>
      .local-refine-btn:hover:not([disabled]) {
        border-color: var(--accent) !important;
        color: var(--text-main) !important;
        background: rgba(59,130,246,0.08) !important;
      }
      #local-regen-btn:hover:not([disabled]) {
        border-color: var(--accent);
        color: var(--text-main);
      }
      #local-approve-btn:hover:not([disabled]) {
        filter: brightness(1.1);
        box-shadow: 0 0 12px var(--accent-glow);
      }
    </style>
  `;

  // Bind refinement buttons
  container.querySelectorAll('.local-refine-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const instruction = container.querySelector('#local-instruction-input')?.value?.trim() || '';
      onRefine?.(mode, instruction);
    });
  });

  // Bind regen
  container.querySelector('#local-regen-btn')?.addEventListener('click', () => {
    onRegenerate?.();
  });

  // Bind approve
  container.querySelector('#local-approve-btn')?.addEventListener('click', () => {
    onApprove?.();
  });

  // Enter key on custom instruction → trigger expand (sensible default)
  container.querySelector('#local-instruction-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const instruction = e.target.value.trim();
      if (instruction) onRefine?.('expand', instruction);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _getLifecycleBadgeText() {
  const status = state.status?.toUpperCase();
  const index = state.currentIndex;

  if (state.generatingSlides?.[index]) return '⟳ BUILDING';
  if (state.slides?.some(s => s.index === index)) return '✓ APPROVED';
  if (state.draftSlides?.[index] || state.currentSlideHtml) return '○ REVIEWING';
  return '· PENDING';
}

function _getLifecycleBadgeStyle() {
  const index = state.currentIndex;
  if (state.generatingSlides?.[index]) {
    return 'background: rgba(251,191,36,0.15); color: #fbbf24; border: 1px solid rgba(251,191,36,0.3);';
  }
  if (state.slides?.some(s => s.index === index)) {
    return 'background: rgba(16,185,129,0.15); color: #10b981; border: 1px solid rgba(16,185,129,0.3);';
  }
  if (state.draftSlides?.[index] || state.currentSlideHtml) {
    return 'background: rgba(59,130,246,0.15); color: #60a5fa; border: 1px solid rgba(59,130,246,0.3);';
  }
  return 'background: var(--bg-input); color: var(--text-muted); border: 1px solid var(--border);';
}

/**
 * Get the current instruction from the local controls input, if rendered.
 */
export function getLocalInstruction() {
  return document.querySelector('#local-instruction-input')?.value?.trim() || '';
}
