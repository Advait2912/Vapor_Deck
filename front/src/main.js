/**
 * VAPOR DECK — main.js (UPGRADED)
 * ─────────────────────────────────
 * Wires the new systems into the existing app without breaking anything.
 *
 * NEW in this version:
 *   - Uses renderer/index.js (isolated iframe renderer) for slide rendering
 *   - Integrates comparison.js for split-view refinement
 *   - Initializes app state and persists to local storage
 *   - Integrates global_control.js in sidebar
 *   - Calls /snapshot route after slide generation (vision audit)
 *   - Per-slide lifecycle states (PLANNING → BUILDING → REVIEWING → APPROVED)
 *
 * PRESERVED from original:
 *   - All SSE streaming logic
 *   - All session management
 *   - All outline/confirmation flow
 *   - All mode switching (plan/build)
 *   - All localStorage persistence
 *   - All abort controller patterns
 */

import './style.css';
import html2canvas from 'html2canvas';
import {
  createSession,
  uploadFile,
  uploadText,
  synthesize,
  generateOutline,
  confirmOutline,
  streamSlide,
  updateSlideTitle,
  deleteSession,
  getProjectInfo,
  getActiveSession,
  updateMode,
  sendPlanChat,
  takeSnapshot,
  exportSlides,
} from './api/client.js';

import { state, updateState } from './state.js';
import { elements, updateUI, renderOutline, renderPlaceholder, renderSlide, renderOutlineContentSummary, renderImageThumbs, renderSlideInfo, renderChatMessage, clearUI } from './ui.js';
import { initResizers } from './resizers.js';
import { setupEventListeners } from './events.js';

// ── New modules ────────────────────────────────────────────────────────────────
import { mountSlide, mountPlaceholder, streamToken, finalizeSlide, clearStreamBuffer, stripFences } from './renderer/index.js';
import { renderGlobalControls, globalState, addSlideToOutline, reorderSlides } from './ui/global_control.js';
import {
  comparisonState,
  enterComparison,
  appendComparisonToken,
  finalizeComparison,
  refineAgain,
  useRefinedVersion,
  resetComparison,
} from './ui/comparison.js';

let pendingTopicImages = [];
let pendingRefineImages = [];
let lastRefinedHtml = '';
const activeSlideControllers = new Map();
let activeRefineController = null;
let currentAbortController = null;
let sessionRunToken = 0;
const latestJobBySlide = {};
let slideJobCounter = 0;
// Per-index audit job versioning — prevents stale results from a slow
// previous audit overwriting a newer one (race condition fix).
const latestAuditJobBySlide = {};
let auditJobCounter = 0;

/**
 * Helper to render the outline with all necessary callbacks and state.
 */
function refreshOutline() {
  renderOutline(navigateToSlide, reorderSlides, state.isReorderMode);
}
const SESSION_VIEW_PREFIX = 'vapordeck:view:';

function beginSlideJob(index) {
  const id = ++slideJobCounter;
  latestJobBySlide[index] = id;
  return id;
}

function isLatestSlideJob(index, id) {
  return latestJobBySlide[index] === id;
}

function getSessionViewKey(sessionId) {
  return `${SESSION_VIEW_PREFIX}${sessionId}`;
}

function loadSessionViewState(sessionId) {
  if (!sessionId) return null;
  try {
    const raw = localStorage.getItem(getSessionViewKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistSessionViewState() {
  if (!state.sessionId) return;
  const payload = {
    draftSlides: state.draftSlides || {},
    latestSlides: state.latestSlides || {},
    promptApplyingIndices: Object.keys(state.promptApplyingSlides || {}).map(Number),
    generatingIndices: Object.keys(state.generatingSlides || {}).map(Number),
    currentIndex: state.currentIndex || 0,
    currentSlideHtml: state.currentSlideHtml || '',
    messages: state.messages || [],
    slidePhases: state.slidePhases || {},
    slideAudits: state.slideAudits || {},  // persist audit results across navigation/reload
    exportSnapshots: state.exportSnapshots || {},  // frozen slide HTML for PDF export
  };
  try {
    localStorage.setItem(getSessionViewKey(state.sessionId), JSON.stringify(payload));
  } catch {
    // ignore quota/storage errors
  }
}

function clearSessionViewState(sessionId) {
  if (!sessionId) return;
  try {
    localStorage.removeItem(getSessionViewKey(sessionId));
  } catch {}
}

function resumeGeneratingSlidesFromCache() {
  const indices = Object.keys(state.generatingSlides || {}).map(Number);
  if (!indices.length) return;
  // ONLY resume slides that are NOT already approved
  indices.forEach((idx) => {
    const isApproved = state.slides.some(s => s.index === idx);
    if (!isApproved) {
      startSlideGeneration(idx, true);
    } else {
      delete state.generatingSlides[idx];
    }
  });
}

function syncStatusFromState() {
  const hasActiveJobs = Object.keys(state.generatingSlides || {}).length > 0;
  if (state.status === 'REVIEWING_OUTLINE') return;
  if (hasActiveJobs) {
    state.status = 'GENERATING';
  } else if (state.draftSlides?.[state.currentIndex] || state.currentSlideHtml) {
    state.status = 'REVIEWING';
  } else if (state.outline.length && state.slides.length === state.outline.length) {
    state.status = 'DONE';
  }
}

// ── Global control event listeners ────────────────────────────────────────────
function setupGlobalControlListeners() {
  window.addEventListener('global:outline-changed', (e) => {
    updateState({ outline: e.detail.outline });
    refreshOutline();
    persistSessionViewState();

    if (!state.sessionId) return;

    // ── Sync to backend ──────────────────────────────────────────────────────
    if (e.detail.reason === 'slide-removed') {
      removeOutlineSlide(state.sessionId, e.detail.removedIndex)
        .catch(err => console.warn('Remove slide sync failed:', err));

    } else if (e.detail.reason === 'reordered') {
      reorderOutline(state.sessionId, e.detail.permutation)
        .catch(err => console.warn('Reorder sync failed:', err));
    }
  });

  window.addEventListener('global:add-slide-ai', async (e) => {
    if (!state.sessionId) return;
    const { title, description } = e.detail;
    
    // Provide immediate feedback
    renderChatMessage('user', `[ACTION] Add slide: "${title}"`);
    renderChatMessage('ai', 'Integrating new slide into the outline... ✧');
    
    const msg = `[AGENTIC ACTION: ADD SLIDE] Title: "${title}". Description: "${description}". 
Please integrate this into the outline at the most logical position. Return the updated outline JSON.`;
    
    try {
      state.status = 'PLANNING';
      updateUI();
      
      const res = await sendPlanChat(state.sessionId, msg, state.currentIndex);
      updateState({ outline: res.outline });
      refreshOutline();
      
      const newSlideIdx = res.outline.findIndex(s => s.title === title);
      if (newSlideIdx !== -1) {
        navigateToSlide(newSlideIdx);
      }
      
      // Update the chat with the final word from AI
      renderChatMessage('ai', res.message);
      state.status = (res.session_status || 'GENERATING').toUpperCase();
      syncStatusFromState();
      updateUI();
    } catch (err) {
      console.error('AI Add failed:', err);
      renderChatMessage('ai', `❌ Failed to add slide: ${err.message}`);
      state.status = 'ERROR';
      updateUI();
    }
  });

  window.addEventListener('global:reorder-mode', (e) => {
    refreshOutline();
  });

  window.addEventListener('global:setting-changed', (e) => {
    if (!state.sessionId) return;
    const { globalState: gs } = e.detail;
    updateDeckSettings(state.sessionId, {
      deck_instructions: gs.deckInstructions || null,
    }).catch(err => console.warn('Deck settings sync failed:', err));
  });

  window.addEventListener('global:error', (e) => {
    renderChatMessage('ai', `⚠ ${e.detail.message}`);
    elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
  });
}

// ── Sidebar: render global controls above the outline ────────────────────────
function mountGlobalControlsInSidebar() {
  const outlineList = elements.outlineList;
  if (!outlineList) return;

  // Insert a container before the outline list
  let gcContainer = document.getElementById('global-controls-container');
  if (!gcContainer) {
    gcContainer = document.createElement('div');
    gcContainer.id = 'global-controls-container';
    outlineList.parentNode.insertBefore(gcContainer, outlineList);
  }

  // Only show global controls once outline exists and we're past IDLE
  if (state.outline.length > 0 && state.status !== 'IDLE') {
    renderGlobalControls(gcContainer);
  } else {
    gcContainer.innerHTML = '';
  }
}


// ── Initialization ─────────────────────────────────────────────────────────────
async function init() {
  initResizers();
  setupGlobalControlListeners();

  setupEventListeners({
    onStartGeneration: startGeneration,
    onTopicImagesSelected: handleTopicImagesSelected,
    onRefineImagesSelected: handleRefineImagesSelected,
    onExport: handleExport,
    onConfirmOutline: handleConfirmOutline,
    onRefine: startRefinement,
    onCustomRegenerate: customRegenerateWithPrompt,
    onRegenerate: regenerateCurrentSlide,
    onStopGeneration: stopConversation,
    onNewDeck: handleNewDeck,
    onUseRefined: () => {
      const html = useRefinedVersion();
      if (!html?.trim()) return;
      state.currentSlideHtml = html;
      state.draftSlides[state.currentIndex] = html;
      // Use new isolated renderer
      const iframe = elements.slideIframe;
      mountSlide(iframe, html, state.theme);
      persistSessionViewState();
    },
    onSwitchMode: handleSwitchMode,
    onPlanChat: handlePlanChat,
    onStartSlideGeneration: (index) => startSlideGeneration(index, true)
  });

  // Wire up comparison overlay buttons using the new comparison module
  _wireComparisonButtons();

  await loadProjectInfo();
  updateUI();
  mountGlobalControlsInSidebar();

  setupIframeScaler(); // Initialize iframe scaling

  if (!state.outline.length) {
    mountPlaceholder(elements.slideIframe, 'Slide Preview Area');
  }

  // BUG 8: Manual re-audit trigger
  if (elements.visionIndicator) {
    elements.visionIndicator.addEventListener('click', () => {
      _runVisionAuditInBackground(state.currentIndex, state.currentIndex + 1, state.currentSlideHtml);
    });
  }
}

function _wireComparisonButtons() {
  // Keep-before button
  elements.closeComparison?.addEventListener('click', () => {
    resetComparison();
    elements.comparisonOverlay.style.display = 'none';
  });

  elements.keepCurrentBtn?.addEventListener('click', () => {
    resetComparison();
    elements.comparisonOverlay.style.display = 'none';
  });

  elements.useRefinedBtn?.addEventListener('click', () => {
    const html = useRefinedVersion();
    if (html?.trim()) {
      state.currentSlideHtml = html;
      state.draftSlides[state.currentIndex] = html;
      mountSlide(elements.slideIframe, html, state.theme);
      persistSessionViewState();
    }
    resetComparison();
    elements.comparisonOverlay.style.display = 'none';
  });

  // "Refine Again" button — if it exists in the DOM
  const refineAgainBtn = document.getElementById('refine-again-btn');
  if (refineAgainBtn) {
    refineAgainBtn.addEventListener('click', async () => {
      const newBeforeHtml = refineAgain();
      if (newBeforeHtml) {
        // Stream a new refinement into the right panel
        await _streamRefinementIntoComparisonRight();
      }
    });
  }
}

async function _streamRefinementIntoComparisonRight() {
  const currentHtml = comparisonState.before?.html || state.currentSlideHtml;
  if (!currentHtml) return;

  const iframeAfter = document.getElementById('iframe-after');
  clearStreamBuffer('comparison-after');
  mountPlaceholder(iframeAfter, 'Refining...');

  let refinedHtml = '';
  activeRefineController = new AbortController();
  try {
    const stream = streamSlide(
      state.sessionId,
      state.currentIndex + 1,
      'refine',
      {
        refineMode: 'expand',
        currentHtml,
        instruction: elements.refineInstructionInput?.value?.trim() || '',
      },
      activeRefineController.signal
    );
    for await (const token of stream) {
      const t = token.replace(/\\n/g, '\n');
      refinedHtml += t;
      appendComparisonToken(t);
    }
    finalizeComparison();
  } catch (err) {
    if (err?.name !== 'AbortError') {
      console.error('Comparison re-refinement failed:', err);
    }
  } finally {
    activeRefineController = null;
  }
}

// ── Project & Session Restore ──────────────────────────────────────────────────
async function loadProjectInfo() {
  try {
    const info = await getProjectInfo();
    state.projectPath = info.path;
    elements.projectPathDisplay.textContent = info.path;

    const session = await getActiveSession();
    if (session && session.session_id) {
      const backendStatus = (session.status || 'idle').toLowerCase();
      const cached = loadSessionViewState(session.session_id) || {};
      const latestSlides = { ...(cached.latestSlides || {}) };
      const draftSlides = { ...(cached.draftSlides || {}) };
      
      // Merge backend data (backend wins for all generated slides)
      const allBackendSlides = (session.slides || []).map(s => ({ index: (s.index || 1) - 1, html: s.html }));
      allBackendSlides.forEach(s => { 
        latestSlides[s.index] = s.html; 
        // If it's in the backend, it's no longer a local-only draft
        delete draftSlides[s.index];
      });

      const generatingSlides = (cached.generatingIndices || []).reduce((acc, idx) => {
        acc[idx] = true; return acc;
      }, {});

      updateState({
        sessionId: session.session_id,
        outline: session.outline || [],
        slides: (session.slides || []).map(s => ({ ...s, index: s.index - 1 })),
        draftSlides,
        latestSlides,
        generatingSlides,
        status: backendStatus.toUpperCase(),
        currentIndex: cached.currentIndex ?? (session.current_index || 0),
        currentSlideHtml: cached.currentSlideHtml || '',
        theme: session.theme || 'dark-tech',
        model: session.text_model || state.model,
        visionModel: session.vision_model || state.visionModel,
        mode: session.mode || 'plan',
        messages: cached.messages || [],
        slidePhases: cached.slidePhases || {},
        slideAudits: cached.slideAudits || {},  // restore audit results from cache
        auditingSlides: {},                      // always start fresh, never restore in-flight audits
        exportSnapshots: cached.exportSnapshots || {},  // restore frozen export HTML
      });

      if (state.messages.length > 0) {
        elements.chatHistory.innerHTML = '';
        state.messages.forEach(m => renderChatMessage(m.role, m.text));
      }

      renderOutline(navigateToSlide);
      updateUI();
      mountGlobalControlsInSidebar();

      const s = state.status;
      if (s === 'REVIEWING_OUTLINE') {
        state.phase = 'CONTENT';
        renderOutlineContentSummary(elements.infoList);
      } else if (s === 'GENERATING') {
        state.phase = 'DESIGN';
        const approved = state.slides.find(s => s.index === state.currentIndex);
        if (approved) {
          mountSlide(elements.slideIframe, approved.html, state.theme);
        } else {
          mountPlaceholder(elements.slideIframe, 'Resuming previous generation...');
        }
        resumeGeneratingSlidesFromCache();
      } else if (s === 'REVIEWING' || s === 'DONE') {
        state.phase = 'DESIGN';
        const latest = state.latestSlides[state.currentIndex];
        if (latest) {
          state.currentSlideHtml = latest;
          mountSlide(elements.slideIframe, latest, state.theme);
        } else {
          mountPlaceholder(elements.slideIframe, s === 'DONE' ? 'Deck complete! Export or start a new deck.' : 'Ready to review.');
        }
      } else if (state.outline.length > 0) {
        mountPlaceholder(elements.slideIframe, 'Project loaded. Ready to continue.');
      }
      persistSessionViewState();
    }
  } catch (error) {
    console.error('Failed to load project info:', error);
    elements.projectPathDisplay.textContent = 'Standalone Mode';
  }
}

// ── New Deck ────────────────────────────────────────────────────────────────────
async function handleNewDeck() {
  const oldSessionId = state.sessionId;
  clearSessionViewState(oldSessionId);
  stopAllGeneration();
  pendingTopicImages = [];
  pendingRefineImages = [];
  updateState({
    sessionId: null, outline: [], slides: [], messages: [],
    draftSlides: {}, latestSlides: {}, promptApplyingSlides: {},
    generatingSlides: {}, slidePhases: {}, currentIndex: 0,
    slideAudits: {}, auditingSlides: {},  // clear all audit state
    exportSnapshots: {},  // clear export snapshots
    currentSlideHtml: '', status: 'IDLE', phase: 'CONTENT',
    mode: 'plan', projectPath: state.projectPath
  });

  clearUI();
  document.getElementById('global-controls-container')?.remove();

  if (oldSessionId) {
    try { await deleteSession(oldSessionId); } catch {}
  }
}

// ── Outline Generation ──────────────────────────────────────────────────────────
async function startGeneration(prompt) {
  try {
    state.status = 'INITIALIZING';
    updateUI();
    elements.promptInput.disabled = true;
    elements.generateBtn.disabled = true;

    const session = await createSession({ 
      text_model: state.model, 
      vision_model: state.visionModel, 
      theme: state.theme 
    });
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
    renderOutlineContentSummary(elements.infoList);
    mountGlobalControlsInSidebar();
    updateUI();
  } catch (error) {
    console.error('Generation failed:', error);
    state.status = 'ERROR';
    updateUI();
    elements.generateBtn.disabled = false;
    elements.promptInput.disabled = false;
  }
}

// ── Outline Confirmation ────────────────────────────────────────────────────────
async function handleConfirmOutline() {
  try {
    state.status = 'CONFIRMING';
    updateUI();
    elements.confirmOutlineBtn.disabled = true;
    elements.confirmOutlineBtn.textContent = 'Wait...';

    // Sanitize the outline payload to match the backend OutlineItem schema strictly
    const sanitizedOutline = state.outline.map(item => ({
      index: item.index,
      title: item.title,
      intent: item.intent,
      key_points: item.key_points,
      layout_hint: item.layout_hint
    }));

    await confirmOutline(state.sessionId, sanitizedOutline);

    state.status = 'GENERATING';
    state.phase = 'DESIGN';
    state.currentIndex = 0;

    const confirmMsg = "Outline confirmed! You can continue planning individual slides or switch to Build mode to generate them.";
    state.messages.push({ role: 'ai', text: confirmMsg });
    renderChatMessage('ai', confirmMsg);

    elements.confirmOutlineBtn.style.display = 'none';
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
    mountGlobalControlsInSidebar();
    updateUI();
    navigateToSlide(0);
  } catch (error) {
    console.error('Confirmation failed:', error);
    state.status = 'REVIEWING_OUTLINE';
    updateUI();
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
  }
}

// ── Mode Switch ──────────────────────────────────────────────────────────────────
async function handleSwitchMode(newMode) {
  if (!state.sessionId) return;
  try {
    const res = await updateMode(state.sessionId, newMode);
    updateState({ mode: res.mode });
    updateUI();
    persistSessionViewState();
  } catch (error) {
    console.error('Mode switch failed:', error);
  }
}

// ── Plan Chat ───────────────────────────────────────────────────────────────────
async function handlePlanChat(message) {
  if (!state.sessionId) return;
  if (state.generatingSlides[state.currentIndex]) {
    renderChatMessage('ai', `Can't chat while slide ${state.currentIndex + 1} is generating.`);
    return;
  }
  try {
    state.messages.push({ role: 'user', text: message });
    renderChatMessage('user', message);
    // Clear input immediately so it feels responsive
    elements.promptInput.value = '';
    elements.promptInput.style.height = 'auto';
    state.status = 'OUTLINING';
    updateUI();
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const res = await sendPlanChat(state.sessionId, message, state.currentIndex + 1, currentAbortController.signal);
    currentAbortController = null;
    updateState({ outline: res.outline });
    state.status = 'REVIEWING_OUTLINE';
    // Input already cleared above
    const aiResponse = res.message || "Outline updated.";
    state.messages.push({ role: 'ai', text: aiResponse });
    renderChatMessage('ai', aiResponse);
    renderOutline(navigateToSlide);
    renderOutlineContentSummary(elements.infoList);
    updateUI();
    persistSessionViewState();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error('Plan chat failed:', error);
    state.status = 'REVIEWING_OUTLINE';
    updateUI();
  }
}

// ── Outline Navigation ───────────────────────────────────────────────────────────
function navigateToSlide(index) {
  // Invalidate any pending streaming timer for the previous slide.
  // This bumps the buffer's generation counter so deferred 200ms timers
  // self-discard rather than patching the iframe after we've moved away.
  clearStreamBuffer('main');

  state.currentIndex = index;

  if (state.status === 'REVIEWING_OUTLINE') {
    renderSlideInfo(index);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  if (state.promptApplyingSlides[index]) {
    state.status = 'GENERATING';
    mountPlaceholder(elements.slideIframe, `Applying prompt to Slide ${index + 1}...`);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const latest = state.latestSlides[index];
  if (latest) {
    state.currentSlideHtml = latest;
    state.status = 'REVIEWING';
    mountSlide(elements.slideIframe, latest, state.theme);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const draft = state.draftSlides[index];
  if (draft) {
    state.currentSlideHtml = draft;
    state.status = 'REVIEWING';
    mountSlide(elements.slideIframe, draft, state.theme);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const saved = state.slides.find(s => s.index === index);
  if (saved) {
    state.currentSlideHtml = saved.html;
    state.status = 'REVIEWING';
    mountSlide(elements.slideIframe, saved.html, state.theme);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  if (state.generatingSlides[index]) {
    mountPlaceholder(elements.slideIframe, `Slide ${index + 1} is generating...`);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  mountPlaceholder(elements.slideIframe, `Slide ${index + 1} not built yet. Click ✧ to generate.`);
  renderOutline(navigateToSlide);
  updateUI();
}

// ── Slide Generation ─────────────────────────────────────────────────────────────
async function startSlideGeneration(index = state.currentIndex, force = false) {
  if (state.status === 'OUTLINING') {
    console.warn('Cannot generate while plan chat in progress');
    return;
  }
  if (state.generatingSlides[index] && !force) return;
  if (force && activeSlideControllers.has(index)) {
    activeSlideControllers.get(index).abort();
  }



  if (state.mode === 'plan' && state.currentIndex === index) {
    state.mode = 'build';
    updateMode(state.sessionId, 'build').catch(() => {});
  }

  state.status = 'GENERATING';
  state.generatingSlides[index] = true;
  delete state.promptApplyingSlides[index];
  const runToken = sessionRunToken;
  const jobId = beginSlideJob(index);
  updateUI();
  refreshOutline();
  persistSessionViewState();

  const slideNum = index + 1;
  const slideTitle = state.outline[index]?.title ?? `Slide ${slideNum}`;

  if (index === state.currentIndex) {
    mountPlaceholder(elements.slideIframe, `Generating Slide ${slideNum}: ${slideTitle}...`);
    clearStreamBuffer('main');
  }

  let slideHtml = '';
  const controller = new AbortController();
  activeSlideControllers.set(index, controller);

  try {
    const stream = streamSlide(state.sessionId, slideNum, 'generate', { force }, controller.signal);
    for await (const token of stream) {
      const t = token.replace(/\\n/g, '\n');
      slideHtml += t;
      // Use new buffered renderer for the active slide
      if (index === state.currentIndex && runToken === sessionRunToken) {
        streamToken(elements.slideIframe, t, state.theme, 'main');
      }
    }

    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (!slideHtml.trim()) throw new Error('Empty slide response from backend');

    // Finalize the stream
    if (index === state.currentIndex) {
      finalizeSlide(elements.slideIframe, state.theme, 'main');
    }

    state.draftSlides[index] = slideHtml;
    state.latestSlides[index] = slideHtml;

    if (index === state.currentIndex && runToken === sessionRunToken) {
      state.currentSlideHtml = slideHtml;
      state.status = 'REVIEWING';
      // Render final clean version
      mountSlide(elements.slideIframe, slideHtml, state.theme);
    }

    updateUI();
    refreshOutline();
    persistSessionViewState();

    // ── Vision audit (Goal 3) — runs after slide is shown, non-blocking ────
    _runVisionAuditInBackground(index, slideNum, slideHtml);

  } catch (error) {
    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (error?.name === 'AbortError') {
      if (index === state.currentIndex) {
        mountPlaceholder(elements.slideIframe, `Stopped generating slide ${slideNum}.`);
      }
    } else {
      console.error('Slide generation failed:', error);
      state.status = 'ERROR';
      updateUI();
      if (index === state.currentIndex) {
        mountPlaceholder(elements.slideIframe, `Error generating slide ${slideNum}.`);
      }
    }
  } finally {
    if (isLatestSlideJob(index, jobId)) {
      activeSlideControllers.delete(index);
      delete state.generatingSlides[index];
    }
    if (runToken === sessionRunToken && isLatestSlideJob(index, jobId)) {
      syncStatusFromState();
    }
    refreshOutline();
    updateUI();
    persistSessionViewState();
  }
}

// ── Vision Audit (background, non-blocking) ───────────────────────────────
async function _runVisionAuditInBackground(index, slideNum, html) {
  if (!state.sessionId) return;

  // Versioning: discard results from a superseded audit run (race condition fix)
  const jobToken = ++auditJobCounter;
  latestAuditJobBySlide[index] = jobToken;
  const isLatestAuditJob = () => latestAuditJobBySlide[index] === jobToken;

  // Track that this slide is actively being audited
  state.auditingSlides[index] = jobToken;

  const isCurrent = () => state.currentIndex === index;

  // Minimal yield before starting offscreen render (keeps event loop responsive)
  await new Promise(r => setTimeout(r, 200));

  // Show "ANALYZING..." only when the audit actually begins, not during generation
  if (isCurrent()) {
    elements.visionIndicator.style.display = 'flex';
    elements.visionIndicator.className = 'vision-indicator analyzing';
    elements.visionBadge.textContent = 'ANALYZING...';
    elements.visionIndicator.title = 'Vision model is auditing layout...';
  }

  try {
    // Render into an isolated offscreen iframe — fully decoupled from the live preview.
    // This prevents the race where navigation or concurrent generation swaps the
    // visible iframe content between the wait and the capture.
    let snapshotB64 = null;
    try {
      snapshotB64 = await captureHtmlOffscreen(html, state.theme);
    } catch (captureErr) {
      console.warn('Offscreen capture failed, proceeding without screenshot:', captureErr);
    }

    const result = await takeSnapshot(state.sessionId, slideNum, html, snapshotB64);

    // Discard if a newer audit for this slide has already started
    if (!isLatestAuditJob()) return;

    const audit = result?.audit;
    const verdict = audit?.verdict || 'good';
    const issues = audit?.visual_issues || [];
    const refinePrompt = result?.refine_prompt || null;

    // Store the audit result in the dedicated map
    state.slideAudits[index] = audit || { verdict: 'audit_failed', visual_issues: ['Audit engine error'] };

    // Persist the current HTML as final (no auto-fix replacement)
    state.slides = state.slides.filter(s => s.index !== index);
    state.slides.push({
      index: index,
      html: html,
      audit: state.slideAudits[index],
      approved: true,
      status: 'ready'
    });
    state.latestSlides[index] = html;

    // ── AUTOMATIC EXPORT SNAPSHOT ──────────────────────────────────────────
    // Since the "Approve" button is removed, we capture the snapshot for the
    // PDF exporter as soon as the slide is stable and audited.
    state.exportSnapshots[index] = stripFences(html);
    console.log(`[Export] Auto-snapshot updated for slide ${index + 1}`);
    delete state.draftSlides[index];
    
    persistSessionViewState();

    // Update the indicator for the currently visible slide
    if (isCurrent()) {
      _applyAuditToIndicator(verdict, false, false, issues, refinePrompt);
    }

  } catch (err) {
    if (!isLatestAuditJob()) return;
    console.warn('Vision audit failed (non-fatal):', err);
    state.slideAudits[index] = { verdict: 'audit_failed', visual_issues: [err.message] };
    if (isCurrent()) {
      _applyAuditToIndicator('audit_failed', false, false, [err.message]);
    }
  } finally {
    if (isLatestAuditJob()) {
      delete state.auditingSlides[index];
      refreshOutline();
      updateUI();
    }
  }
}

/**
 * Renders `html` into a hidden offscreen iframe and captures a 1280×720 PNG.
 * Completely isolated from the main preview — safe to run during navigation
 * or concurrent slide generation.
 */
async function captureHtmlOffscreen(html, theme = 'dark-tech') {
  const themeLink  = `<link rel="stylesheet" href="/themes/${theme}.css">`;
  const prismLink  = `<link rel="stylesheet" href="/lib/prism/prism-tomorrow.css">`;
  const prismScript = `<script src="/lib/prism/prism.js"><\/script>`;

  const fullHtml = `<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    ${themeLink}${prismLink}
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      html, body { margin: 0; padding: 0; width: 1280px; height: 720px; overflow: hidden; background: #000; }
      .reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
    </style>
  </head><body>${html}${prismScript}</body></html>`;

  const offscreen = document.createElement('iframe');
  offscreen.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1280px;height:720px;border:none;pointer-events:none;visibility:hidden;';
  offscreen.setAttribute('aria-hidden', 'true');
  document.body.appendChild(offscreen);

  try {
    offscreen.contentDocument.open();
    offscreen.contentDocument.write(fullHtml);
    offscreen.contentDocument.close();

    // Wait for layout + synchronous scripts (Prism highlight etc.) to finish
    await new Promise(r => setTimeout(r, 800));

    const canvas = await html2canvas(offscreen.contentDocument.body, {
      scale: 1,
      width: 1280,
      height: 720,
      windowWidth: 1280,
      windowHeight: 720,
      logging: false,
      useCORS: true,
      backgroundColor: '#000000',
      onclone: (clonedDoc) => {
        clonedDoc.body.style.cssText = 'width:1280px;height:720px;overflow:hidden;margin:0;padding:0;';
        clonedDoc.querySelectorAll('.reveal').forEach(el => {
          el.style.opacity = '1';
          el.style.transform = 'none';
        });
      },
    });
    return canvas.toDataURL('image/png').split(',')[1];
  } finally {
    document.body.removeChild(offscreen);
  }
}

/**
 * Captures the live slide iframe as a base64 PNG.
 * Used for on-demand manual re-audits (clicking the vision eye).
 */
async function captureIframeSnapshot(iframe) {
  if (!iframe || !iframe.contentDocument || !iframe.contentWindow) return null;

  try {
    // Wait for the slide to signal it's ready (layout stabilized, code highlighted)
    let attempts = 0;
    while (!iframe.contentWindow.__VAPOR_READY__ && attempts < 10) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    // Simplify: capture exactly what is in the preview window at high resolution
    const canvas = await html2canvas(iframe.contentDocument.body, {
      scale: 1, // Use native scale inside our forced 1280x720 env
      width: 1280,
      height: 720,
      windowWidth: 1280, // Force vw units to evaluate against 1280px
      windowHeight: 720, // Force vh units to evaluate against 720px
      logging: false,
      useCORS: true,
      backgroundColor: '#000000',
      onclone: (clonedDoc) => {
        // 1. Mark as audit mode for CSS overrides
        clonedDoc.body.classList.add('audit-mode');
        
        // 2. Force deterministic 1280x720 viewport for the capture
        const body = clonedDoc.body;
        body.style.width = '1280px';
        body.style.height = '720px';
        body.style.overflow = 'hidden';
        // 3. (Removed legacy scaler reset)

        // 4. Manually force reveal classes to their 'visible' state in the clone
        clonedDoc.querySelectorAll('.reveal').forEach(el => {
          el.classList.add('visible');
          el.style.opacity = '1';
          el.style.transform = 'none';
        });
      }
    });

    return canvas.toDataURL('image/png').split(',')[1];
  } catch (err) {
    console.warn('Snapshot capture failed:', err);
    return null;
  }
}

/**
 * Apply an audit verdict to the vision indicator element.
 */
function _applyAuditToIndicator(verdict, autoFixed, timedOut, issues = [], refinePrompt = null) {
  elements.visionIndicator.style.display = 'flex';

  // Remove any existing fix button
  const existing = elements.visionIndicator.querySelector('.audit-fix-btn');
  if (existing) existing.remove();

  if (timedOut) {
    elements.visionIndicator.className = 'vision-indicator error';
    elements.visionBadge.textContent = 'TIMED OUT';
    elements.visionIndicator.title = 'Vision audit timed out. Click to re-audit.';
    return;
  }

  const issueTitle = issues.length ? `Issues:\n• ${issues.join('\n• ')}` : '';

  switch (verdict) {
    case 'good':
      elements.visionIndicator.className = 'vision-indicator good';
      elements.visionBadge.textContent = 'LAYOUT OK';
      elements.visionIndicator.title = 'Visual layout looks clean and professional.';
      break;
    case 'fixable':
      elements.visionIndicator.className = 'vision-indicator fixable';
      elements.visionBadge.textContent = 'MINOR ISSUES';
      elements.visionIndicator.title = issueTitle || 'Minor layout issues detected.';
      if (refinePrompt) _showAuditFixButton(refinePrompt, verdict);
      break;
    case 'regenerate':
      elements.visionIndicator.className = 'vision-indicator regenerate';
      elements.visionBadge.textContent = 'ISSUES FOUND';
      elements.visionIndicator.title = issueTitle || 'Significant layout issues detected.';
      if (refinePrompt) _showAuditFixButton(refinePrompt, verdict);
      break;
    case 'audit_failed':
    default:
      elements.visionIndicator.className = 'vision-indicator error';
      elements.visionBadge.textContent = 'AUDIT FAILED';
      elements.visionIndicator.title = issues[0] || 'Audit engine error. Click to retry.';
      break;
  }
}

/**
 * Shows a compact "✦ Fix Issues" pill button inside the vision indicator.
 * On click, pre-fills the refine input and triggers the refinement.
 */
function _showAuditFixButton(refinePrompt, verdict) {
  // Only show the button if we're in build mode (refine input exists and is visible)
  if (!elements.refineInstructionInput) return;

  const btn = document.createElement('button');
  btn.className = 'audit-fix-btn';
  btn.textContent = verdict === 'regenerate' ? '✦ Fix Issues' : '✦ Apply Fix';
  btn.title = refinePrompt;
  btn.onclick = (e) => {
    e.stopPropagation();
    // Switch to build mode if needed
    if (state.mode !== 'build') {
      handleSwitchMode('build');
    }
    // Pre-fill the refine instruction with the AI-generated prompt
    elements.refineInstructionInput.value = refinePrompt;
    elements.refineInstructionInput.focus();
    // Auto-scroll refine input into view
    elements.refineInstructionInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    // Remove the button after use
    btn.remove();
  };
  elements.visionIndicator.appendChild(btn);
}

/**
 * Show a transient toast notification for vision audit events.
 * Auto-dismisses after 6 seconds; can also be closed manually.
 */
function showAuditToast(message, type = 'info') {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `audit-toast audit-toast-${type}`;
  toast.innerHTML = `<span class="toast-msg">${message}</span><button class="toast-close" title="Dismiss">×</button>`;
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    setTimeout(() => toast.remove(), 400);
  }, 6000);
}

async function approveSlide() {
  try {
    // ── Capture WYSIWYG snapshot from live iframe for export ─────────────────
    const exportHtml = _captureCurrentSlideFromIframe();
    const html = exportHtml || state.draftSlides[state.currentIndex] || state.currentSlideHtml;

    if (!html?.trim()) {
      mountPlaceholder(elements.slideIframe, 'Generate this slide first, then approve.');
      return;
    }
    const approvedIndex = state.currentIndex;
    const slideNum = approvedIndex + 1;
    state.status = 'APPROVING';
    updateUI();

    // Read the audit from slideAudits — NOT from draftSlides which is a raw HTML string
    const audit = state.slideAudits[approvedIndex] || null;

    // ── Freeze this slide's HTML+CSS into the export snapshots array ────────
    // This is the single source of truth for PDF export.
    state.exportSnapshots[approvedIndex] = stripFences(exportHtml || html);
    console.log(`[Export] Snapshot frozen for slide ${slideNum}`);

    state.slides = state.slides.filter(s => s.index !== approvedIndex);
    state.slides.push({ 
      index: approvedIndex, 
      html,
      audit: audit // Preserve the vision audit result for the backend
    });
    state.latestSlides[approvedIndex] = html;
    delete state.draftSlides[approvedIndex];
    delete state.generatingSlides[approvedIndex];

    if (approvedIndex < state.outline.length - 1) {
      const nextPending = state.outline.findIndex((_, idx) => {
        return !state.slides.some(s => s.index === idx);
      });
      state.currentIndex = nextPending >= 0 ? nextPending : approvedIndex;
      const hasDraft = !!state.draftSlides[state.currentIndex];
      state.status = hasDraft ? 'REVIEWING' : 'GENERATING';
      renderOutline(navigateToSlide);
      updateUI();
      if (hasDraft) {
        mountSlide(elements.slideIframe, state.draftSlides[state.currentIndex], state.theme);
      } else {
        mountPlaceholder(elements.slideIframe, `Slide ${state.currentIndex + 1} not built yet.`);
      }
    } else {
      state.status = 'DONE';
      updateUI();
      renderOutline(navigateToSlide);
      mountPlaceholder(elements.slideIframe, '🎉 Deck Complete! All slides approved. Export PDF.');
    }
    persistSessionViewState();
    approveSlideApi(state.sessionId, slideNum, html).catch(err => console.error('Approval sync failed:', err));
  } catch (error) {
    console.error('Approval failed:', error);
    state.status = 'REVIEWING';
    updateUI();
  }
}


// ── Slide Refinement ──────────────────────────────────────────────────────────
async function startRefinement(mode, instruction = '') {
  const currentHtml = state.draftSlides[state.currentIndex] || state.currentSlideHtml;
  if (!currentHtml?.trim()) return;

  const instructionText = instruction || elements.refineInstructionInput?.value?.trim() || '';

  // Enter comparison mode — freezes current on left, streams new on right
  enterComparison(currentHtml, mode.charAt(0).toUpperCase() + mode.slice(1));
  elements.comparisonOverlay.style.display = 'flex';

  const iframeAfter = document.getElementById('iframe-after');

  let refinedHtml = '';
  activeRefineController = new AbortController();
  try {
    const stream = streamSlide(
      state.sessionId,
      state.currentIndex + 1,
      'refine',
      {
        refineMode: mode,
        currentHtml,
        instruction: instructionText,
      },
      activeRefineController.signal
    );
    for await (const token of stream) {
      const t = token.replace(/\\n/g, '\n');
      refinedHtml += t;
      appendComparisonToken(t);
    }
    finalizeComparison();
    lastRefinedHtml = refinedHtml;
  } catch (error) {
    if (error?.name === 'AbortError') {
      mountPlaceholder(iframeAfter, 'Refinement stopped.');
    } else {
      console.error('Refinement failed:', error);
      mountPlaceholder(iframeAfter, `Refinement error: ${error.message}`);
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

async function customRegenerateWithPrompt() {
  const instruction = elements.refineInstructionInput?.value?.trim();
  const currentHtml = state.draftSlides[state.currentIndex] || state.currentSlideHtml;
  if (!currentHtml?.trim() || !instruction) return;

  if (activeSlideControllers.has(state.currentIndex)) {
    activeSlideControllers.get(state.currentIndex).abort();
  }
  if (activeRefineController) activeRefineController.abort();

  const index = state.currentIndex;
  const slideNum = index + 1;
  const runToken = sessionRunToken;
  const jobId = beginSlideJob(index);

  // Clear refine input immediately for instant feedback
  elements.refineInstructionInput.value = '';
  elements.refineInstructionInput.style.height = 'auto';

  state.slides = state.slides.filter(s => s.index !== index);
  state.status = 'GENERATING';
  state.generatingSlides[index] = true;
  state.promptApplyingSlides[index] = true;
  refreshOutline();
  updateUI();
  persistSessionViewState();
  mountPlaceholder(elements.slideIframe, `Applying prompt to Slide ${slideNum}...`);
  clearStreamBuffer('main');

  let regenerated = '';
  activeRefineController = new AbortController();
  try {
    const stream = streamSlide(state.sessionId, slideNum, 'refine', {
      refineMode: 'expand',
      currentHtml,
      instruction,
    }, activeRefineController.signal);

    for await (const token of stream) {
      const t = token.replace(/\\n/g, '\n');
      regenerated += t;
      // Only stream to the live iframe if the user is still on this slide
      if (index === state.currentIndex && runToken === sessionRunToken && isLatestSlideJob(index, jobId)) {
        streamToken(elements.slideIframe, t, state.theme, 'main');
      }
    }

    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (!regenerated.trim()) throw new Error('Empty regenerated slide');

    state.draftSlides[index] = regenerated;
    state.latestSlides[index] = regenerated;
    delete state.promptApplyingSlides[index];
    if (state.currentIndex === index) {
      finalizeSlide(elements.slideIframe, state.theme, 'main');
      state.currentSlideHtml = regenerated;
      state.status = 'REVIEWING';
      mountSlide(elements.slideIframe, regenerated, state.theme);
    }
    
    // Auto-finalize and persist the refinement
    _runVisionAuditInBackground(index, slideNum, regenerated);
  } catch (error) {
    if (!isLatestSlideJob(index, jobId)) return;
    if (error?.name !== 'AbortError') {
      console.error('Custom regeneration failed:', error);
      state.status = 'ERROR';
      delete state.promptApplyingSlides[index];
      if (state.currentIndex === index) {
        mountPlaceholder(elements.slideIframe, `Custom regenerate failed: ${error.message}`);
      }
    } else {
      delete state.promptApplyingSlides[index];
    }
  } finally {
    if (!isLatestSlideJob(index, jobId)) return;
    activeRefineController = null;
    delete state.generatingSlides[index];
    syncStatusFromState();
    refreshOutline();
    updateUI();
    persistSessionViewState();
  }
}

function stopAllGeneration() {
  sessionRunToken += 1;
  Object.keys(latestJobBySlide).forEach(k => delete latestJobBySlide[k]);
  if (currentAbortController) { currentAbortController.abort(); currentAbortController = null; }
  for (const controller of activeSlideControllers.values()) controller.abort();
  activeSlideControllers.clear();
  if (activeRefineController) { activeRefineController.abort(); activeRefineController = null; }
  state.generatingSlides = {};
  state.promptApplyingSlides = {};
  if (state.status === 'GENERATING' || state.status === 'APPROVING') {
    state.status = state.currentSlideHtml ? 'REVIEWING' : 'IDLE';
  }
  refreshOutline();
  updateUI();
  mountPlaceholder(elements.slideIframe, 'Generation stopped.');
}

async function stopConversation() {
  const activeSessionId = state.sessionId;
  stopAllGeneration();
  handleNewDeck();
  if (activeSessionId) {
    deleteSession(activeSessionId).catch(err => console.error('Failed to delete session:', err));
  }
}

// ── Export ─────────────────────────────────────────────────────────────────────

/**
 * Extract the slide HTML from the live iframe DOM.
 * Grabs inline <style> blocks from the iframe's <head> (per-slide scoped styles)
 * and the actual slide content from <body>, stripping #slide-scaler and scripts.
 */
function _captureCurrentSlideFromIframe() {
  const iframe = elements.slideIframe;
  if (!iframe?.contentDocument?.body) return null;

  const doc = iframe.contentDocument;
  let parts = [];

  // 1. Grab all inline <style> from the iframe <head> (skip linked stylesheets)
  const headStyles = doc.querySelectorAll('head style');
  headStyles.forEach(styleEl => {
    // Skip the base iframe styles (box-sizing, body margin, scaler, reveal, audit)
    // We only want the LLM-generated per-slide styles
    const text = styleEl.textContent || '';
    if (text.includes('#slide-scaler') || text.includes('body.audit-mode')) return;
    parts.push(`<style>${text}</style>`);
  });

  // 2. Grab slide content from body
  //    The iframe wraps everything in <div id="slide-scaler">, dig inside it
  const scaler = doc.getElementById('slide-scaler');
  const source = scaler || doc.body;
  const clone = source.cloneNode(true);

  // Remove all <script> tags
  const scripts = clone.getElementsByTagName('script');
  for (let i = scripts.length - 1; i >= 0; i--) {
    scripts[i].parentNode.removeChild(scripts[i]);
  }

  parts.push(clone.innerHTML);
  return parts.join('\n');
}

async function handleExport() {
  if (!state.sessionId || !state.outline.length) {
    alert('No slides to export. Please generate some slides first.');
    return;
  }

  // Check how many slides have been approved (have export snapshots)
  const snapshotCount = Object.keys(state.exportSnapshots).length;
  if (snapshotCount === 0) {
    alert('No slides are ready for export. Wait for generation to finish.');
    return;
  }

  try {
    elements.exportBtn.textContent = 'Exporting...';
    elements.exportBtn.disabled = true;

    // Build the slide array sorted by index — only approved snapshots
    const slideData = [];
    const sortedIndices = Object.keys(state.exportSnapshots)
      .map(Number)
      .sort((a, b) => a - b);

    for (const idx of sortedIndices) {
      slideData.push(state.exportSnapshots[idx]);
    }

    const theme = state.theme || 'dark-tech';
    console.log(`Exporting ${slideData.length} approved slides to PDF (theme: ${theme})`);

    const response = await exportSlides(state.sessionId, { slides: slideData, theme });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Export failed' }));
      throw new Error(error.detail || 'Export failed');
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vapor_deck_${state.sessionId}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Export failed:', error);
    alert(`Export failed: ${error.message}`);
  } finally {
    elements.exportBtn.textContent = 'Export PDF';
    elements.exportBtn.disabled = false;
  }
}

// ── Fixed resolution scaling for iframe ──────────────────────────────────────
function setupIframeScaler() {
  const container = document.getElementById('preview-container');
  const iframe = document.getElementById('slide-iframe');
  if (!container || !iframe) return;

  const observer = new ResizeObserver(entries => {
    for (let entry of entries) {
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      // Leave some padding
      const scaleX = (w - 40) / 1280;
      const scaleY = (h - 40) / 720;
      const scale = Math.min(scaleX, scaleY);
      iframe.style.transform = `scale(${scale})`;
    }
  });
  observer.observe(container);
}

// ── Manual Re-audit ──────────────────────────────────────────────────────────
export function manualAudit() {
  _runVisionAuditInBackground(state.currentIndex, state.currentIndex + 1, state.currentSlideHtml);
}

init();
// Window event for updating slide title directly from sidebar
window.addEventListener('update-slide-title', async (e) => {
  const { index, title } = e.detail;
  if (!state.outline[index]) return;
  
  const oldTitle = state.outline[index].title;
  state.outline[index].title = title;
  
  try {
    await updateSlideTitle(state.sessionId, index, title);
    showAuditToast(`Slide ${index + 1} renamed to: ${title}`, 'info');
  } catch (err) {
    console.error('Failed to update title:', err);
    state.outline[index].title = oldTitle; // rollback
    refreshOutline();
  }
});
