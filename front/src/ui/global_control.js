/**
 * GLOBAL CONTROL SYSTEM
 * ─────────────────────
 * Handles deck-wide orchestration:
 *   - Add/remove slides
 *   - Reorder slides
 *   - Change deck tone / audience / theme
 *   - Modify narrative structure
 *
 * KEY DESIGN DECISION:
 *   Global controls modify outline state and deck_context,
 *   but NEVER invalidate already-approved (build-phase) slides.
 *   Approved slides are frozen until explicitly regenerated.
 *
 * Architectural note:
 *   This is a SEPARATE layer from localControls.js (per-slide).
 *   Global → deck metadata.  Local → single slide content.
 */

import { state, updateState } from '../state.js';
import { renderOutline } from './outline.js';

// ── State for global deck settings ────────────────────────────────────────────
export const globalState = {
  tone: 'professional',
  audience: 'general',
  narrativeStructure: 'linear', // linear | problem-solution | before-after | listicle
  deckInstructions: '',
};

// ── Render the global control panel ───────────────────────────────────────────
export function renderGlobalControls(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="global-controls" style="
      display: flex; flex-direction: column; gap: 8px;
      padding: 12px; border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
    ">
      <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 4px;">
        Deck Settings
      </div>

      <!-- Tone -->
      <div class="control-row" style="display: flex; align-items: center; gap: 8px;">
        <label style="font-size: 0.75rem; color: var(--text-muted); min-width: 60px;">Tone</label>
        <select id="global-tone" class="global-select" style="
          flex: 1; background: var(--bg-input); border: 1px solid var(--border);
          color: var(--text-main); padding: 3px 6px; border-radius: 3px; font-size: 0.75rem;
        ">
          <option value="professional">Professional</option>
          <option value="technical">Technical</option>
          <option value="casual">Casual</option>
          <option value="executive">Executive</option>
          <option value="educational">Educational</option>
        </select>
      </div>

      <!-- Audience -->
      <div class="control-row" style="display: flex; align-items: center; gap: 8px;">
        <label style="font-size: 0.75rem; color: var(--text-muted); min-width: 60px;">Audience</label>
        <select id="global-audience" class="global-select" style="
          flex: 1; background: var(--bg-input); border: 1px solid var(--border);
          color: var(--text-main); padding: 3px 6px; border-radius: 3px; font-size: 0.75rem;
        ">
          <option value="general">General</option>
          <option value="developers">Developers</option>
          <option value="executives">Executives</option>
          <option value="designers">Designers</option>
          <option value="students">Students</option>
        </select>
      </div>

      <!-- Narrative Structure -->
      <div class="control-row" style="display: flex; align-items: center; gap: 8px;">
        <label style="font-size: 0.75rem; color: var(--text-muted); min-width: 60px;">Structure</label>
        <select id="global-narrative" class="global-select" style="
          flex: 1; background: var(--bg-input); border: 1px solid var(--border);
          color: var(--text-main); padding: 3px 6px; border-radius: 3px; font-size: 0.75rem;
        ">
          <option value="linear">Linear</option>
          <option value="problem-solution">Problem → Solution</option>
          <option value="before-after">Before → After</option>
          <option value="listicle">Top N List</option>
        </select>
      </div>

      <!-- Action Buttons -->
      <div style="display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap;">
        <button id="add-slide-btn" class="global-btn" title="Add a new slide to the deck">
          + Add Slide
        </button>
        <button id="reorder-slides-btn" class="global-btn" title="Drag to reorder slides">
          ⇅ Reorder
        </button>
        <button id="deck-instructions-btn" class="global-btn" title="Add global instructions for all slides">
          ✏ Instructions
        </button>
      </div>

      <!-- Deck Instructions Textarea (hidden by default) -->
      <div id="deck-instructions-panel" style="display: none; margin-top: 4px;">
        <textarea
          id="deck-instructions-input"
          placeholder="Global deck instructions (e.g. 'Use dark humor', 'Include code examples'...)"
          style="
            width: 100%; min-height: 60px; background: var(--bg-input);
            border: 1px solid var(--border); color: var(--text-main);
            padding: 8px; border-radius: 3px; font-size: 0.75rem;
            font-family: inherit; resize: vertical;
          "
        ></textarea>
        <div style="display: flex; gap: 6px; margin-top: 4px;">
          <button id="apply-instructions-btn" class="global-btn primary-small">Apply</button>
          <button id="cancel-instructions-btn" class="global-btn">Cancel</button>
        </div>
      </div>

      <!-- Reorder Mode (shown when active) -->
      <div id="reorder-mode-panel" style="display: none; margin-top: 4px;">
        <div style="font-size: 0.7rem; color: var(--accent); margin-bottom: 6px;">
          Drag slides to reorder. Click Done when finished.
        </div>
        <button id="done-reorder-btn" class="global-btn primary-small">✓ Done Reordering</button>
      </div>
    </div>

    <style>
      .global-btn {
        background: var(--bg-input);
        border: 1px solid var(--border);
        color: var(--text-muted);
        padding: 3px 8px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 0.7rem;
        transition: all 0.15s;
      }
      .global-btn:hover {
        border-color: var(--accent);
        color: var(--text-main);
      }
      .global-btn.primary-small {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
      }
      .global-select:focus {
        outline: none;
        border-color: var(--accent);
      }
    </style>
  `;

  // Restore saved values
  const toneEl = container.querySelector('#global-tone');
  const audienceEl = container.querySelector('#global-audience');
  const narrativeEl = container.querySelector('#global-narrative');

  if (toneEl) toneEl.value = globalState.tone;
  if (audienceEl) audienceEl.value = globalState.audience;
  if (narrativeEl) narrativeEl.value = globalState.narrativeStructure;

  _bindGlobalControlEvents(container);
}

// ── Event binding ──────────────────────────────────────────────────────────────
function _bindGlobalControlEvents(container) {
  // Tone change
  const toneEl = container.querySelector('#global-tone');
  toneEl?.addEventListener('change', (e) => {
    globalState.tone = e.target.value;
    _emitGlobalChange('tone', e.target.value);
  });

  // Audience change
  const audienceEl = container.querySelector('#global-audience');
  audienceEl?.addEventListener('change', (e) => {
    globalState.audience = e.target.value;
    _emitGlobalChange('audience', e.target.value);
  });

  // Narrative structure change
  const narrativeEl = container.querySelector('#global-narrative');
  narrativeEl?.addEventListener('change', (e) => {
    globalState.narrativeStructure = e.target.value;
    _emitGlobalChange('narrativeStructure', e.target.value);
  });

  // Add slide
  container.querySelector('#add-slide-btn')?.addEventListener('click', () => {
    addSlideToOutline();
  });

  // Reorder toggle
  const reorderBtn = container.querySelector('#reorder-slides-btn');
  const reorderPanel = container.querySelector('#reorder-mode-panel');
  reorderBtn?.addEventListener('click', () => {
    const isActive = reorderPanel.style.display !== 'none';
    reorderPanel.style.display = isActive ? 'none' : 'block';
    reorderBtn.style.borderColor = isActive ? '' : 'var(--accent)';
    window.dispatchEvent(new CustomEvent('global:reorder-mode', { detail: { active: !isActive } }));
  });

  container.querySelector('#done-reorder-btn')?.addEventListener('click', () => {
    reorderPanel.style.display = 'none';
    reorderBtn.style.borderColor = '';
    window.dispatchEvent(new CustomEvent('global:reorder-mode', { detail: { active: false } }));
  });

  // Instructions toggle
  const instructionsBtn = container.querySelector('#deck-instructions-btn');
  const instructionsPanel = container.querySelector('#deck-instructions-panel');
  instructionsBtn?.addEventListener('click', () => {
    const isVisible = instructionsPanel.style.display !== 'none';
    instructionsPanel.style.display = isVisible ? 'none' : 'block';
  });

  container.querySelector('#apply-instructions-btn')?.addEventListener('click', () => {
    const text = container.querySelector('#deck-instructions-input')?.value?.trim();
    if (text) {
      globalState.deckInstructions = text;
      _emitGlobalChange('deckInstructions', text);
    }
    instructionsPanel.style.display = 'none';
  });

  container.querySelector('#cancel-instructions-btn')?.addEventListener('click', () => {
    instructionsPanel.style.display = 'none';
  });
}

// ── Add Slide ─────────────────────────────────────────────────────────────────
export function addSlideToOutline() {
  if (!state.outline.length) return;

  const newIndex = state.outline.length + 1;
  const newSlide = {
    index: newIndex,
    title: `New Slide ${newIndex}`,
    intent: 'explain-concept',
    key_points: ['Key point 1', 'Key point 2'],
    layout_hint: 'single-column',
  };

  // IMPORTANT: Do NOT invalidate existing approved slides.
  // Just append to the outline.
  const updatedOutline = [...state.outline, newSlide];
  updateState({ outline: updatedOutline });

  window.dispatchEvent(new CustomEvent('global:outline-changed', {
    detail: { outline: updatedOutline, reason: 'slide-added' }
  }));
}

// ── Remove Slide ──────────────────────────────────────────────────────────────
export function removeSlideFromOutline(index) {
  // Safety: never remove a slide that is approved (in build phase)
  const slidePhase = state.slidePhases?.[index];
  if (slidePhase === 'build') {
    console.warn(`[GlobalControl] Cannot remove slide ${index} — it has been built.`);
    window.dispatchEvent(new CustomEvent('global:error', {
      detail: { message: `Slide ${index + 1} has been built and cannot be removed. Regenerate it instead.` }
    }));
    return false;
  }

  const updatedOutline = state.outline
    .filter((_, i) => i !== index)
    .map((item, i) => ({ ...item, index: i + 1 }));

  updateState({ outline: updatedOutline });

  window.dispatchEvent(new CustomEvent('global:outline-changed', {
    detail: { outline: updatedOutline, reason: 'slide-removed' }
  }));

  return true;
}

// ── Reorder Slides ────────────────────────────────────────────────────────────
export function reorderSlides(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;

  const outline = [...state.outline];
  const [moved] = outline.splice(fromIndex, 1);
  outline.splice(toIndex, 0, moved);

  // Re-number
  const renumbered = outline.map((item, i) => ({ ...item, index: i + 1 }));

  updateState({ outline: renumbered });

  window.dispatchEvent(new CustomEvent('global:outline-changed', {
    detail: { outline: renumbered, reason: 'reordered' }
  }));
}

// ── Internal: emit changes to the backend ────────────────────────────────────
function _emitGlobalChange(field, value) {
  window.dispatchEvent(new CustomEvent('global:setting-changed', {
    detail: { field, value, globalState: { ...globalState } }
  }));
}

// ── Serialize global settings for backend sync ────────────────────────────────
export function getGlobalSettingsPayload() {
  return {
    tone: globalState.tone,
    audience: globalState.audience,
    narrative_structure: globalState.narrativeStructure,
    deck_instructions: globalState.deckInstructions,
  };
}
