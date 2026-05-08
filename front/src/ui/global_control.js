/**
 * GLOBAL CONTROL SYSTEM
 * ─────────────────────
 * Handles deck-wide orchestration:
 *   - Add slides (with inline title + description form)
 *   - Remove slides
 *   - Reorder slides (HTML5 drag-and-drop)
 *   - Global deck instructions
 *
 * KEY DESIGN DECISION:
 *   Global controls modify outline state and deck_context,
 *   but NEVER invalidate already-approved (build-phase) slides.
 *   Approved slides are frozen until explicitly regenerated.
 */

import { state, updateState } from '../state.js';

// ── State for global deck settings (instructions only — tone/audience removed) ─────
export const globalState = {
  deckInstructions: '',
};

// ── Render the global control panel ───────────────────────────────────────────
export function renderGlobalControls(container) {
  if (!container) return;

  container.innerHTML = `
    <div class="global-controls" style="
      display: flex; flex-direction: column; gap: 6px;
      padding: 10px 12px; border-bottom: 1px solid var(--border);
      background: var(--bg-panel);
    ">
      <div style="font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 2px;">
        Deck Actions
      </div>

      <!-- Action Buttons Row -->
      <div style="display: flex; gap: 6px; flex-wrap: wrap;">
        <button id="add-slide-btn" class="global-btn" title="Add a new slide to the deck">
          + Add Slide
        </button>
        <button id="reorder-slides-btn" class="global-btn" title="Drag slides to reorder">
          ⇅ Reorder
        </button>
        <button id="present-btn" class="global-btn" title="Fullscreen slideshow preview (F)">
          ▶ Present
        </button>
        <button id="generate-all-btn" class="global-btn" title="Generate all slides that haven't been built yet">
          ✧ Generate All
        </button>
      </div>

      <!-- Inline Add Slide Panel (hidden by default) -->
      <div id="add-slide-panel" style="
        display: none; flex-direction: column; gap: 6px;
        padding: 10px; margin-top: 2px;
        background: var(--bg-input); border: 1px solid var(--border);
        border-radius: 4px; animation: slideDown 0.15s ease;
      ">
        <div style="font-size: 0.7rem; color: var(--accent); font-weight: 600; letter-spacing: 0.04em;">
          New Slide
        </div>
        <input
          id="new-slide-title"
          type="text"
          placeholder="Title (e.g. Market Opportunity)"
          maxlength="80"
          style="
            width: 100%; background: var(--bg-dark); border: 1px solid var(--border);
            color: var(--text-main); padding: 6px 8px; border-radius: 3px;
            font-size: 0.8rem; font-family: inherit; outline: none;
          "
        />
        <textarea
          id="new-slide-desc"
          placeholder="What should this slide cover? (2-3 key points, used as slide intent)"
          rows="2"
          style="
            width: 100%; background: var(--bg-dark); border: 1px solid var(--border);
            color: var(--text-main); padding: 6px 8px; border-radius: 3px;
            font-size: 0.8rem; font-family: inherit; resize: none; outline: none;
          "
        ></textarea>
        <div style="display: flex; gap: 6px;">
          <button id="confirm-add-slide-btn" class="global-btn primary-small" style="flex: 1;">+ Add Slide</button>
          <button id="cancel-add-slide-btn" class="global-btn">Cancel</button>
        </div>
      </div>

      <!-- Reorder Mode Banner (shown when active) -->
      <div id="reorder-mode-panel" style="display: none; margin-top: 2px;">
        <div style="
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 8px; background: rgba(59,130,246,0.1);
          border: 1px solid rgba(59,130,246,0.25); border-radius: 3px;
        ">
          <span style="font-size: 0.7rem; color: #60a5fa;">⠿ Drag slides to reorder</span>
          <button id="done-reorder-btn" class="global-btn primary-small" style="padding: 2px 8px;">✓ Done</button>
        </div>
      </div>


    </div>

    <style>
      .global-btn {
        background: var(--bg-input);
        border: 1px solid var(--border);
        color: var(--text-muted);
        padding: 4px 10px;
        border-radius: 3px;
        cursor: pointer;
        font-size: 0.7rem;
        transition: all 0.15s;
        white-space: nowrap;
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
      .global-btn.primary-small:hover {
        filter: brightness(1.1);
      }
      .global-btn.active-mode {
        border-color: var(--accent);
        color: var(--accent);
      }
      #new-slide-title:focus,
      #new-slide-desc:focus,
      #deck-instructions-input:focus {
        border-color: var(--accent);
      }
      @keyframes slideDown {
        from { opacity: 0; transform: translateY(-6px); }
        to   { opacity: 1; transform: translateY(0); }
      }
    </style>
  `;

  // Restore instructions if set
  const instrInput = container.querySelector('#deck-instructions-input');
  if (instrInput && globalState.deckInstructions) {
    instrInput.value = globalState.deckInstructions;
  }

  _bindGlobalControlEvents(container);
}

// ── Event binding ──────────────────────────────────────────────────────────────
function _bindGlobalControlEvents(container) {
  // ── Add Slide — open/close the inline form ───────────────────────────────────
  const addBtn       = container.querySelector('#add-slide-btn');
  const addPanel     = container.querySelector('#add-slide-panel');
  const titleInput   = container.querySelector('#new-slide-title');
  const descInput    = container.querySelector('#new-slide-desc');
  const confirmBtn   = container.querySelector('#confirm-add-slide-btn');
  const cancelAddBtn = container.querySelector('#cancel-add-slide-btn');

  addBtn?.addEventListener('click', () => {
    const isOpen = addPanel.style.display !== 'none';
    addPanel.style.display = isOpen ? 'none' : 'flex';
    if (!isOpen) {
      titleInput?.focus();
    }
  });

  cancelAddBtn?.addEventListener('click', () => {
    addPanel.style.display = 'none';
    if (titleInput) titleInput.value = '';
    if (descInput) descInput.value = '';
  });

  // Confirm add via AI
  confirmBtn?.addEventListener('click', () => {
    const title = titleInput?.value?.trim();
    const description = descInput?.value?.trim();
    if (!title) {
      titleInput?.focus();
      titleInput?.classList.add('input-error');
      setTimeout(() => titleInput?.classList.remove('input-error'), 800);
      return;
    }
    
    // Trigger direct addition (backend synced via global:outline-changed handler)
    addSlideToOutline({ title, description });

    // Reset and hide
    addPanel.style.display = 'none';
    if (titleInput) titleInput.value = '';
    if (descInput) descInput.value = '';
  });

  titleInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); descInput?.focus(); }
    if (e.key === 'Escape') { cancelAddBtn?.click(); }
  });
  descInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmBtn?.click(); }
    if (e.key === 'Escape') { cancelAddBtn?.click(); }
  });

  // ── Reorder Mode toggle ──────────────────────────────────────────────────────
  const reorderBtn   = container.querySelector('#reorder-slides-btn');
  const reorderPanel = container.querySelector('#reorder-mode-panel');
  const doneBtn      = container.querySelector('#done-reorder-btn');

  reorderBtn?.addEventListener('click', () => {
    const nowActive = !state.isReorderMode;
    updateState({ isReorderMode: nowActive });
    reorderPanel.style.display = nowActive ? 'block' : 'none';
    reorderBtn.classList.toggle('active-mode', nowActive);
    window.dispatchEvent(new CustomEvent('global:reorder-mode', { detail: { active: nowActive } }));
  });

  doneBtn?.addEventListener('click', () => {
    updateState({ isReorderMode: false });
    reorderPanel.style.display = 'none';
    reorderBtn?.classList.remove('active-mode');
    window.dispatchEvent(new CustomEvent('global:reorder-mode', { detail: { active: false } }));
  });

  // ── Present (Slideshow) ───────────────────────────────────────────────────────
  const presentBtn = container.querySelector('#present-btn');
  presentBtn?.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('global:present'));
  });

  // ── Generate All ─────────────────────────────────────────────────────────────
  const generateAllBtn = container.querySelector('#generate-all-btn');
  generateAllBtn?.addEventListener('click', () => {
    if (state.status === 'REVIEWING_OUTLINE') return; // not in generate phase yet
    window.dispatchEvent(new CustomEvent('global:generate-all'));
  });
}

// ── Add Slide ─────────────────────────────────────────────────────────────────
/**
 * Add a new slide to the outline.
 * @param {{ title: string, description?: string }} opts
 */
export function addSlideToOutline({ title = 'New Slide', description = '' } = {}) {
  if (!state.outline.length) return;

  const newIndex = state.outline.length; // 0-based index for state
  // Parse description into key_points (split on ., ;, or newline)
  const rawPoints = description
    ? description.split(/[.;\n]+/).map(s => s.trim()).filter(Boolean).slice(0, 4)
    : ['Key point 1', 'Key point 2'];
  const keyPoints = rawPoints.length ? rawPoints : ['Key point 1', 'Key point 2'];

  const newSlide = {
    index: newIndex + 1, // 1-based for OutlineItem
    title,
    intent: 'explain-concept',
    key_points: keyPoints,
    layout_hint: 'single-column',
  };

  const updatedOutline = [...state.outline, newSlide];
  updateState({ outline: updatedOutline });

  window.dispatchEvent(new CustomEvent('global:outline-changed', {
    detail: {
      outline: updatedOutline,
      reason: 'slide-added',
      newSlide, // pass the full slide data so the handler can POST it
    }
  }));
}

// ── Remove Slide ──────────────────────────────────────────────────────────────
export function removeSlideFromOutline(index) {
  const slidePhase = state.slidePhases?.[index];
  if (slidePhase === 'build') {
    window.dispatchEvent(new CustomEvent('global:error', {
      detail: { message: `Slide ${index + 1} has been built and cannot be removed. Regenerate it instead.` }
    }));
    return false;
  }

  const removedSlide = state.outline[index];
  const updatedOutline = state.outline
    .filter((_, i) => i !== index)
    .map((item, i) => ({ ...item, index: i + 1 }));

  updateState({ outline: updatedOutline });

  window.dispatchEvent(new CustomEvent('global:outline-changed', {
    detail: {
      outline: updatedOutline,
      reason: 'slide-removed',
      removedIndex: index + 1, // 1-based for backend DELETE
    }
  }));

  return true;
}

// ── Reorder Slides ────────────────────────────────────────────────────────────
export function reorderSlides(fromIndex, toIndex) {
  if (fromIndex === toIndex) return;

  const outline = [...state.outline];
  const [moved] = outline.splice(fromIndex, 1);
  outline.splice(toIndex, 0, moved);

  // Enforce invariant: outline[i].index === i + 1, always.
  // This guarantees the AI can never re-sort back to pre-reorder positions.
  const renumbered = outline.map((item, i) => ({ ...item, index: i + 1 }));

  // Build permutation: permutation[newPos] = oldPos (0-based positions)
  const permutation = Array.from({ length: renumbered.length }, (_, i) => i);
  const [movedPerm] = permutation.splice(fromIndex, 1);
  permutation.splice(toIndex, 0, movedPerm);

  // Remap a position-keyed map: newMap[newPos] = oldMap[oldPos]
  const remapByIndex = (oldMap) => {
    const newMap = {};
    permutation.forEach((oldPos, newPos) => {
      if (oldMap[oldPos] !== undefined) {
        newMap[newPos] = oldMap[oldPos];
      }
    });
    return newMap;
  };

  // Convert state.slides (array with .index === 0-based position) to a
  // position-keyed map, remap it, then convert back to array.
  const slidesMap = {};
  state.slides.forEach(s => { slidesMap[s.index] = s; });
  const remappedSlidesMap = remapByIndex(slidesMap);
  const remappedSlides = Object.entries(remappedSlidesMap).map(([newPos, s]) => ({
    ...s,
    index: Number(newPos),
  }));

  updateState({
    outline: renumbered,
    latestSlides: remapByIndex(state.latestSlides),
    draftSlides: remapByIndex(state.draftSlides),
    slideAudits: remapByIndex(state.slideAudits),
    generatingSlides: remapByIndex(state.generatingSlides),
    promptApplyingSlides: remapByIndex(state.promptApplyingSlides),
    slides: remappedSlides,
  });

  window.dispatchEvent(new CustomEvent('global:outline-changed', {
    detail: {
      outline: renumbered,
      reason: 'reordered',
      permutation,
    }
  }));
}

// ── Serialize for backend ─────────────────────────────────────────────────────
export function getGlobalSettingsPayload() {
  return {
    deck_instructions: globalState.deckInstructions || null,
  };
}
