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
    onStartSlideGeneration
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
    } else if (status === 'REVIEWING_OUTLINE') {
      // Already have an outline, just confirm and start generating
      onConfirmOutline();
    }
    // All other states: button is disabled, do nothing
  });

  // Enter key only triggers generation when IDLE or ERROR
  elements.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const status = state.status.toUpperCase();
      if (status === 'IDLE' || status === 'ERROR') {
        const prompt = elements.promptInput.value.trim();
        if (prompt) onStartGeneration(prompt);
      }
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

  // New Deck button — resets session to start fresh
  if (elements.newDeckBtn) {
    elements.newDeckBtn.addEventListener('click', () => {
      if (confirm('Start a new deck? Your current project will be preserved in the folder, but this session will reset.')) {
        onNewDeck();
      }
    });
  }

  elements.approveBtn.addEventListener('click', () => {
    if (state.status.toUpperCase() === 'REVIEWING') {
      onApproveSlide();
    }
  });

  elements.refineButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.id.split('-')[1];
      onRefine(mode);
    });
  });

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
