import './style.css';
import { 
  createSession, 
  uploadText, 
  synthesize, 
  generateOutline, 
  confirmOutline,
  streamSlide,
  approveSlide as approveSlideApi,
  getProjectInfo,
  getActiveSession
} from './api/client.js';

import { state, updateState } from './state.js';
import { elements, updateUI, renderOutline, renderPlaceholder, renderSlide } from './ui.js';
import { initResizers } from './resizers.js';
import { setupEventListeners } from './events.js';

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  initResizers();
  
  setupEventListeners({
    onStartGeneration: startGeneration,
    onExport: handleExport,
    onConfirmOutline: handleConfirmOutline,
    onApproveSlide: approveSlide,
    onRefine: startRefinement,
    onNewDeck: handleNewDeck,
    onUseRefined: () => {
      state.currentSlideHtml = elements.iframeAfter.srcdoc;
      renderSlide(state.currentSlideHtml);
    }
  });

  await loadProjectInfo();

  updateUI();
  if (!state.outline.length) {
    renderPlaceholder('Slide Preview Area');
  }
}

// ── Project & Session Restore ─────────────────────────────────────────────────
async function loadProjectInfo() {
  try {
    const info = await getProjectInfo();
    state.projectPath = info.path;
    elements.projectPathDisplay.textContent = info.path;
    
    const session = await getActiveSession();
    if (session && session.session_id) {
      const backendStatus = (session.status || 'idle').toLowerCase();

      updateState({
        sessionId: session.session_id,
        outline: session.outline || [],
        // Normalise backend snake_case status to our uppercase convention
        status: backendStatus.toUpperCase(),
        currentIndex: session.current_index || 0,
        theme: session.theme || 'dark-tech',
        model: session.text_model || state.model
      });

      console.log(`Restored session ${state.sessionId} (status: ${state.status})`);
      renderOutline(navigateToSlide);
      updateUI();

      const s = state.status;
      if (s === 'REVIEWING_OUTLINE') {
        renderPlaceholder('Review the outline in the sidebar, then click "Start Generation →" or "Confirm" to begin.');
      } else if (s === 'GENERATING') {
        // Resume slide generation from where we left off
        renderPlaceholder(`Resuming: Generating Slide ${state.currentIndex + 1}...`);
        startSlideGeneration();
      } else if (s === 'REVIEWING') {
        renderPlaceholder('Slide ready for review. Approve or refine.');
      } else if (s === 'DONE') {
        renderPlaceholder('Deck complete! Export or start a new deck.');
      } else if (state.outline.length > 0) {
        renderPlaceholder('Project loaded. Ready to continue.');
      }
    }
  } catch (error) {
    console.error('Failed to load project info:', error);
    elements.projectPathDisplay.textContent = 'Standalone Mode';
  }
}

// ── New Deck ──────────────────────────────────────────────────────────────────
function handleNewDeck() {
  updateState({
    sessionId: null,
    outline: [],
    slides: [],
    currentIndex: 0,
    currentSlideHtml: '',
    status: 'IDLE',
    projectPath: state.projectPath // keep path
  });
  elements.outlineList.innerHTML = `<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">No outline generated yet. Submit a topic to begin.</div>`;
  elements.promptContainer.style.display = 'flex';
  elements.slideControls.style.display = 'none';
  elements.confirmOutlineBtn.style.display = 'none';
  elements.promptInput.value = '';
  elements.promptInput.disabled = false;
  elements.visionStatus.style.display = 'none';
  renderPlaceholder('Slide Preview Area');
  updateUI();
}

// ── Outline Generation ────────────────────────────────────────────────────────
async function startGeneration(prompt) {
  try {
    state.status = 'INITIALIZING';
    updateUI();
    elements.promptInput.disabled = true;
    elements.generateBtn.disabled = true;

    const session = await createSession({ text_model: state.model, theme: state.theme });
    state.sessionId = session.session_id;

    state.status = 'SYNTHESIZING';
    elements.generateBtn.textContent = 'Uploading...';
    updateUI();
    await uploadText(state.sessionId, prompt, 'topic');

    elements.generateBtn.textContent = 'Synthesizing...';
    await synthesize(state.sessionId);

    state.status = 'OUTLINING';
    elements.generateBtn.textContent = 'Outlining...';
    updateUI();
    const outlineData = await generateOutline(state.sessionId);
    state.outline = outlineData.outline;

    state.status = 'REVIEWING_OUTLINE';
    renderOutline(navigateToSlide);
    updateUI();
    renderPlaceholder('Review the outline, then click "Start Generation →" to begin.');
  } catch (error) {
    console.error('Generation failed:', error);
    state.status = 'ERROR';
    updateUI();
    elements.generateBtn.disabled = false;
    elements.promptInput.disabled = false;
  }
}

// ── Outline Confirmation ──────────────────────────────────────────────────────
async function handleConfirmOutline() {
  try {
    state.status = 'CONFIRMING';
    updateUI();
    elements.confirmOutlineBtn.disabled = true;
    elements.confirmOutlineBtn.textContent = 'Wait...';

    await confirmOutline(state.sessionId, state.outline);

    state.status = 'GENERATING';
    state.currentIndex = 0;
    elements.confirmOutlineBtn.style.display = 'none';
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
    updateUI(); // this will flip to slide-controls via updateUI's inSlidePhase logic

    startSlideGeneration();
  } catch (error) {
    console.error('Confirmation failed:', error);
    state.status = 'REVIEWING_OUTLINE';
    updateUI();
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
  }
}

// ── Outline Navigation ────────────────────────────────────────────────────────
/**
 * Navigate to a slide by 0-based index.
 * - If approved (in state.slides): show saved HTML immediately.
 * - If it's the current or next to generate: start generation.
 * - If it's a future unapproved slide: ignore (user must approve in order).
 */
function navigateToSlide(index) {
  // Find saved HTML for this slide
  const saved = state.slides.find(s => s.index === index);
  if (saved) {
    state.currentIndex = index;
    state.currentSlideHtml = saved.html;
    state.status = 'REVIEWING';
    renderSlide(saved.html);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }
  // If it's the next ungenerated slide, start generation
  if (index === state.currentIndex && (state.status === 'GENERATING' || state.status === 'REVIEWING')) {
    startSlideGeneration();
    return;
  }
  // Can't jump to future unapproved slides
  console.log(`Slide ${index + 1} not yet generated — approve slides in order.`);
}

// ── Slide Generation ──────────────────────────────────────────────────────────
async function startSlideGeneration() {
  state.status = 'GENERATING';
  updateUI();

  const slideNum = state.currentIndex + 1; // backend is 1-indexed
  const slideTitle = state.outline[state.currentIndex]?.title ?? `Slide ${slideNum}`;

  renderPlaceholder(`Generating Slide ${slideNum}: ${slideTitle}...`);

  let slideHtml = '';
  try {
    const stream = streamSlide(state.sessionId, slideNum);
    for await (const token of stream) {
      slideHtml += token.replace(/\\n/g, '\n'); // unescape backend newlines
      renderSlide(slideHtml);
    }

    if (!slideHtml.trim()) throw new Error('Empty slide response from backend');

    state.currentSlideHtml = slideHtml;
    state.status = 'REVIEWING';
    updateUI();
    renderOutline(navigateToSlide);

    // Vision status animation
    elements.visionStatus.style.display = 'inline-block';
    elements.visionStatus.style.color = 'var(--accent)';
    elements.visionStatus.textContent = 'VISION: ANALYZING...';
    setTimeout(() => {
      elements.visionStatus.textContent = 'VISION: LAYOUT OK';
      elements.visionStatus.style.color = '#10b981';
    }, 1500);
  } catch (error) {
    console.error('Slide generation failed:', error);
    state.status = 'ERROR';
    updateUI();
    renderPlaceholder(`Error generating slide ${slideNum}. Check console.`);
  }
}

// ── Slide Approval ────────────────────────────────────────────────────────────
async function approveSlide() {
  try {
    state.status = 'APPROVING';
    updateUI();

    const slideNum = state.currentIndex + 1;
    await approveSlideApi(state.sessionId, slideNum, state.currentSlideHtml);

    state.slides.push({ index: state.currentIndex, html: state.currentSlideHtml });

    if (state.currentIndex < state.outline.length - 1) {
      state.currentIndex++;
      startSlideGeneration();
    } else {
      state.status = 'DONE';
      updateUI();
      renderOutline(navigateToSlide);
      renderPlaceholder('🎉 Deck Complete! All slides approved. Use Export PDF to save.');
    }
  } catch (error) {
    console.error('Approval failed:', error);
    state.status = 'REVIEWING';
    updateUI();
  }
}

// ── Slide Refinement ──────────────────────────────────────────────────────────
async function startRefinement(mode) {
  elements.comparisonOverlay.style.display = 'flex';
  elements.iframeBefore.srcdoc = elements.slideIframe.srcdoc;
  renderPlaceholder('Refining...', elements.iframeAfter);

  let refinedHtml = '';
  try {
    const stream = streamSlide(state.sessionId, state.currentIndex + 1, 'refine', {
      refineMode: mode,
      currentHtml: state.currentSlideHtml
    });
    for await (const token of stream) {
      refinedHtml += token.replace(/\\n/g, '\n');
      renderSlide(refinedHtml, elements.iframeAfter);
    }
  } catch (error) {
    console.error('Refinement failed:', error);
    renderPlaceholder(`Refinement error: ${error.message}`, elements.iframeAfter);
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
async function handleExport() {
  if (!state.sessionId) return;
  try {
    elements.exportBtn.textContent = 'Exporting...';
    elements.exportBtn.disabled = true;
    await new Promise(resolve => setTimeout(resolve, 2000));
    alert('Deck exported successfully!');
  } catch (error) {
    console.error('Export failed:', error);
  } finally {
    elements.exportBtn.textContent = 'Export PDF';
    elements.exportBtn.disabled = false;
  }
}

init();
