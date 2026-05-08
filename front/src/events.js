/**
 * Event Listener Orchestration
 */
import { state } from './state.js';
import { elements } from './ui.js';

export function setupEventListeners(actions) {
  const { 
    onStartGeneration, 
    onTopicImagesSelected,
    onRefineImagesSelected,
    onExport, 
    onConfirmOutline, 
    onApproveSlide, 
    onRefine,
    onCustomRegenerate,
    onRegenerate,
    onStopGeneration,
    onUseRefined,
    onNewDeck,
    onStartSlideGeneration,
    onSwitchMode,
    onPlanChat
  } = actions;

  elements.themeSelect.addEventListener('change', (e) => {
    state.theme = e.target.value;
  });

  elements.modelSelect.addEventListener('change', (e) => {
    state.model = e.target.value;
  });

  // Smart generate button — behaviour depends on current status
  elements.generateBtn.addEventListener('click', () => {
    const status = state.status.toUpperCase();

    if (status === 'IDLE' || status === 'ERROR') {
      const prompt = elements.promptInput.value.trim();
      if (prompt) onStartGeneration(prompt);
    } else if (state.mode === 'plan' && (status === 'REVIEWING_OUTLINE' || status === 'GENERATING' || status === 'DONE' || status === 'REVIEWING')) {
      const msg = elements.promptInput.value.trim();
      if (msg) onPlanChat(msg);
    }
  });

  // Enter key handling
  elements.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const status = state.status.toUpperCase();
      if (status === 'IDLE' || status === 'ERROR') {
        const prompt = elements.promptInput.value.trim();
        if (prompt) onStartGeneration(prompt);
      } else if (state.mode === 'plan') {
        const msg = elements.promptInput.value.trim();
        if (msg) onPlanChat(msg);
      }
    }
  });

  // Build Mode: Refine Prompt handling
  elements.refineInstructionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onRegenerate?.();
    }
  });

  elements.exportBtn.addEventListener('click', () => {
    onExport();
  });

  if (elements.topicImageInput) {
    elements.topicImageInput.addEventListener('change', (e) => {
      onTopicImagesSelected?.(Array.from(e.target.files || []));
    });
  }

  if (elements.refineImageInput) {
    elements.refineImageInput.addEventListener('change', (e) => {
      onRefineImagesSelected?.(Array.from(e.target.files || []));
    });
  }

  // Confirm button in sidebar header
  elements.confirmOutlineBtn.addEventListener('click', () => {
    onConfirmOutline();
  });

  if (elements.newDeckBtn) {
    elements.newDeckBtn.addEventListener('click', () => {
      if (confirm('Start a new deck? Your current project will be preserved in the folder, but this session will reset.')) {
        onNewDeck();
      }
    });
  }

  // Mode Pill Toggle (new UI — two pill buttons)
  const modePillBtns = document.querySelectorAll('.mode-pill-btn');
  modePillBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const newMode = btn.dataset.mode;
      if (newMode !== state.mode) onSwitchMode(newMode);
    });
  });

  // Auto-resize both textareas as user types
  [elements.promptInput, elements.refineInstructionInput].forEach(ta => {
    if (!ta) return;
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 110) + 'px';
    });
  });

  // Global Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Ctrl + P for Mode Toggle
    if (e.ctrlKey && e.key.toLowerCase() === 'p') {
      e.preventDefault(); // Prevent print dialog
      const newMode = state.mode === 'plan' ? 'build' : 'plan';
      onSwitchMode(newMode);
    }
  });

  if (elements.endSessionBtn) {
    elements.endSessionBtn.addEventListener('click', () => {
      if (confirm('Are you sure you want to completely end this session? All unexported progress will be cleared.')) {
        onNewDeck();
      }
    });
  }

  // Mode Toggles
  if (elements.planModeBtn) {
    elements.planModeBtn.addEventListener('click', () => onSwitchMode('plan'));
  }
  if (elements.buildModeBtn) {
    elements.buildModeBtn.addEventListener('click', () => onSwitchMode('build'));
  }

  // Custom Event for per-slide generation
  window.addEventListener('generate-slide', (e) => {
    onStartSlideGeneration(e.detail.index);
  });

  // Approval removed in favor of live flow ──────────────────────────────────


  if (elements.regenBtn) {
    elements.regenBtn.addEventListener('click', () => {
      onRegenerate?.();
    });
  }
  if (elements.customRegenBtn) {
    elements.customRegenBtn.addEventListener('click', () => {
      onCustomRegenerate?.();
    });
  }

  if (elements.refineInstructionInput) {
    elements.refineInstructionInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onCustomRegenerate?.();
      }
    });
  }

  if (elements.stopBtn) {
    elements.stopBtn.addEventListener('click', () => {
      onStopGeneration?.();
    });
  }

  elements.closeComparison.addEventListener('click', () => {
    elements.comparisonOverlay.style.display = 'none';
  });

  elements.keepCurrentBtn.addEventListener('click', () => {
    elements.comparisonOverlay.style.display = 'none';
  });

  elements.useRefinedBtn.addEventListener('click', () => {
    onUseRefined();
    elements.comparisonOverlay.style.display = 'none';
  });
}
