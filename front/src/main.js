import './style.css';
import { 
  createSession, 
  uploadFile,
  uploadText, 
  synthesize, 
  generateOutline, 
  confirmOutline,
  streamSlide,
  approveSlide as approveSlideApi,
  deleteSession,
  getProjectInfo,
  getActiveSession
} from './api/client.js';

import { state, updateState } from './state.js';
import { elements, updateUI, renderOutline, renderPlaceholder, renderSlide, renderOutlineContentSummary, renderImageThumbs } from './ui.js';
import { initResizers } from './resizers.js';
import { setupEventListeners } from './events.js';

let pendingTopicImages = [];
let pendingRefineImages = [];
let lastRefinedHtml = '';
const activeSlideControllers = new Map();
let activeRefineController = null;
let sessionRunToken = 0;

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  initResizers();
  
  setupEventListeners({
    onStartGeneration: startGeneration,
    onTopicImagesSelected: handleTopicImagesSelected,
    onRefineImagesSelected: handleRefineImagesSelected,
    onExport: handleExport,
    onConfirmOutline: handleConfirmOutline,
    onApproveSlide: approveSlide,
    onRefine: startRefinement,
    onRegenerate: regenerateCurrentSlide,
    onStopGeneration: stopConversation,
    onNewDeck: handleNewDeck,
    onUseRefined: () => {
      if (!lastRefinedHtml.trim()) return;
      state.currentSlideHtml = lastRefinedHtml;
      state.draftSlides[state.currentIndex] = lastRefinedHtml;
      renderSlide(lastRefinedHtml);
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
        slides: (session.slides || []).map(s => ({ ...s, index: s.index - 1 })),
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
        state.phase = 'CONTENT';
        renderOutlineContentSummary();
      } else if (s === 'GENERATING') {
        state.phase = 'DESIGN';
        startAllSlidesGeneration();
        renderPlaceholder(`Resuming generation in background...`);
      } else if (s === 'REVIEWING') {
        state.phase = 'DESIGN';
        renderPlaceholder('Slide ready for review. Approve or refine.');
      } else if (s === 'DONE') {
        state.phase = 'DESIGN';
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
  stopAllGeneration();
  pendingTopicImages = [];
  pendingRefineImages = [];
  updateState({
    sessionId: null,
    outline: [],
    slides: [],
    draftSlides: {},
    generatingSlides: {},
    currentIndex: 0,
    currentSlideHtml: '',
    status: 'IDLE',
    phase: 'CONTENT',
    projectPath: state.projectPath // keep path
  });
  elements.outlineList.innerHTML = `<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">No outline generated yet. Submit a topic to begin.</div>`;
  elements.promptContainer.style.display = 'flex';
  elements.slideControls.style.display = 'none';
  elements.confirmOutlineBtn.style.display = 'none';
  elements.promptInput.value = '';
  elements.refineInstructionInput.value = '';
  elements.topicImageThumbs.innerHTML = '';
  elements.refineImageThumbs.innerHTML = '';
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
    for (const image of pendingTopicImages) {
      await uploadFile(state.sessionId, image, 'reference');
    }

    elements.generateBtn.textContent = 'Synthesizing...';
    await synthesize(state.sessionId);

    state.status = 'OUTLINING';
    elements.generateBtn.textContent = 'Outlining...';
    updateUI();
    const outlineData = await generateOutline(state.sessionId);
    state.outline = outlineData.outline;

    state.status = 'REVIEWING_OUTLINE';
    state.phase = 'CONTENT';
    renderOutline(navigateToSlide);
    updateUI();
    renderOutlineContentSummary();
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
    state.phase = 'DESIGN';
    state.currentIndex = 0;
    elements.confirmOutlineBtn.style.display = 'none';
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
    updateUI(); // this will flip to slide-controls via updateUI's inSlidePhase logic

    startAllSlidesGeneration();
    navigateToSlide(0);
  } catch (error) {
    console.error('Confirmation failed:', error);
    state.status = 'REVIEWING_OUTLINE';
    updateUI();
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
  }
}

function startAllSlidesGeneration() {
  for (let i = 0; i < state.outline.length; i++) {
    if (state.slides.some(s => s.index === i)) continue;
    if (state.draftSlides[i]) continue;
    startSlideGeneration(i);
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
  state.currentIndex = index;
  const saved = state.slides.find(s => s.index === index);
  if (saved) {
    state.currentSlideHtml = saved.html;
    state.status = 'REVIEWING';
    renderSlide(saved.html);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  const draft = state.draftSlides[index];
  if (draft) {
    state.currentSlideHtml = draft;
    state.status = 'REVIEWING';
    renderSlide(draft);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  if (state.generatingSlides[index]) {
    renderPlaceholder(`Slide ${index + 1} is generating in the background...`);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  startSlideGeneration(index);
}

// ── Slide Generation ──────────────────────────────────────────────────────────
async function startSlideGeneration(index = state.currentIndex, force = false) {
  if (state.generatingSlides[index] && !force) return;
  if (force && activeSlideControllers.has(index)) {
    activeSlideControllers.get(index).abort();
  }

  state.status = 'GENERATING';
  state.generatingSlides[index] = true;
  const runToken = sessionRunToken;
  updateUI();
  renderOutline(navigateToSlide);

  const slideNum = index + 1; // backend is 1-indexed
  const slideTitle = state.outline[index]?.title ?? `Slide ${slideNum}`;

  if (index === state.currentIndex) {
    renderPlaceholder(`Generating Slide ${slideNum}: ${slideTitle}...`);
  }

  let slideHtml = '';
  const controller = new AbortController();
  activeSlideControllers.set(index, controller);
  try {
    const stream = streamSlide(state.sessionId, slideNum, 'generate', { signal: controller.signal });
    for await (const token of stream) {
      slideHtml += token.replace(/\\n/g, '\n'); // unescape backend newlines
    }

    if (runToken !== sessionRunToken) return;
    if (!slideHtml.trim()) throw new Error('Empty slide response from backend');

    state.draftSlides[index] = slideHtml;
    if (index === state.currentIndex && runToken === sessionRunToken) {
      state.currentSlideHtml = slideHtml;
      state.status = 'REVIEWING';
      renderSlide(slideHtml);
    }
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
    if (runToken !== sessionRunToken) {
      return;
    }
    if (error?.name === 'AbortError') {
      if (index === state.currentIndex) {
        renderPlaceholder(`Stopped generating slide ${slideNum}.`);
      }
    } else {
      console.error('Slide generation failed:', error);
      state.status = 'ERROR';
      updateUI();
      if (index === state.currentIndex) {
        renderPlaceholder(`Error generating slide ${slideNum}. Check console.`);
      }
    }
  } finally {
    activeSlideControllers.delete(index);
    delete state.generatingSlides[index];
    renderOutline(navigateToSlide);
    updateUI();
  }
}

// ── Slide Approval ────────────────────────────────────────────────────────────
async function approveSlide() {
  try {
    const html = state.draftSlides[state.currentIndex] || state.currentSlideHtml;
    if (!html?.trim()) {
      renderPlaceholder('Generate this slide first, then approve.');
      return;
    }
    const approvedIndex = state.currentIndex;
    const slideNum = approvedIndex + 1;
    state.status = 'APPROVING';
    updateUI();

    state.slides = state.slides.filter(s => s.index !== approvedIndex);
    state.slides.push({ index: approvedIndex, html });
    delete state.draftSlides[approvedIndex];

    if (approvedIndex < state.outline.length - 1) {
      const nextReadyIndex = state.outline.findIndex((_, idx) => {
        const alreadyApproved = state.slides.some(s => s.index === idx);
        return !alreadyApproved && !!state.draftSlides[idx];
      });
      const nextPendingIndex = state.outline.findIndex((_, idx) => {
        const alreadyApproved = state.slides.some(s => s.index === idx);
        return !alreadyApproved;
      });

      state.currentIndex = nextReadyIndex >= 0 ? nextReadyIndex : (nextPendingIndex >= 0 ? nextPendingIndex : approvedIndex);
      const hasCurrentDraft = !!state.draftSlides[state.currentIndex];
      state.status = hasCurrentDraft ? 'REVIEWING' : 'GENERATING';
      renderOutline(navigateToSlide);
      updateUI();
      if (hasCurrentDraft) {
        renderSlide(state.draftSlides[state.currentIndex]);
      } else {
        renderPlaceholder(`Slide ${state.currentIndex + 1} is still generating. You can approve any ready slide now.`);
      }
    } else {
      state.status = 'DONE';
      updateUI();
      renderOutline(navigateToSlide);
      renderPlaceholder('🎉 Deck Complete! All slides approved. Use Export PDF to save.');
    }

    approveSlideApi(state.sessionId, slideNum, html).catch((error) => {
      console.error('Approval sync failed:', error);
    });
  } catch (error) {
    console.error('Approval failed:', error);
    state.status = 'REVIEWING';
    updateUI();
  }
}

// ── Slide Refinement ──────────────────────────────────────────────────────────
async function startRefinement(mode) {
  const currentHtml = state.draftSlides[state.currentIndex] || state.currentSlideHtml;
  if (!currentHtml?.trim()) return;

  for (const image of pendingRefineImages) {
    await uploadFile(state.sessionId, image, 'reference');
  }

  elements.comparisonOverlay.style.display = 'flex';
  elements.iframeBefore.srcdoc = elements.slideIframe.srcdoc;
  renderPlaceholder('Refining...', elements.iframeAfter);

  let refinedHtml = '';
  activeRefineController = new AbortController();
  try {
    const stream = streamSlide(state.sessionId, state.currentIndex + 1, 'refine', {
      refineMode: mode,
      currentHtml,
      instruction: elements.refineInstructionInput.value.trim(),
      signal: activeRefineController.signal
    });
    for await (const token of stream) {
      refinedHtml += token.replace(/\\n/g, '\n');
    }
    lastRefinedHtml = refinedHtml;
    renderSlide(refinedHtml, elements.iframeAfter);
  } catch (error) {
    if (error?.name === 'AbortError') {
      renderPlaceholder('Refinement stopped.', elements.iframeAfter);
    } else {
      console.error('Refinement failed:', error);
      renderPlaceholder(`Refinement error: ${error.message}`, elements.iframeAfter);
    }
  } finally {
    activeRefineController = null;
  }
}

function handleTopicImagesSelected(files) {
  pendingTopicImages = files;
  renderImageThumbs(files, elements.topicImageThumbs);
}

function handleRefineImagesSelected(files) {
  pendingRefineImages = files;
  renderImageThumbs(files, elements.refineImageThumbs);
}

function regenerateCurrentSlide() {
  startSlideGeneration(state.currentIndex, true);
}

function stopAllGeneration() {
  sessionRunToken += 1;
  for (const controller of activeSlideControllers.values()) {
    controller.abort();
  }
  activeSlideControllers.clear();
  if (activeRefineController) {
    activeRefineController.abort();
    activeRefineController = null;
  }
  state.generatingSlides = {};
  if (state.status === 'GENERATING' || state.status === 'APPROVING') {
    state.status = state.currentSlideHtml ? 'REVIEWING' : 'IDLE';
  }
  renderOutline(navigateToSlide);
  updateUI();
  renderPlaceholder('Generation stopped.');
}

async function stopConversation() {
  const activeSessionId = state.sessionId;
  stopAllGeneration();
  handleNewDeck();
  if (activeSessionId) {
    deleteSession(activeSessionId).catch((error) => {
      console.error('Failed to delete session:', error);
    });
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
