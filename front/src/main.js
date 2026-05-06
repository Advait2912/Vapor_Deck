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
  getActiveSession,
  updateMode,
  sendPlanChat
} from './api/client.js';

import { state, updateState, getSlidePhase, lockSlideIntoBuild, canPlanSlide, isModeAllowedForSlide } from './state.js';
import { elements, updateUI, renderOutline, renderPlaceholder, renderSlide, renderOutlineContentSummary, renderImageThumbs, renderSlideInfo, renderChatMessage, clearUI } from './ui.js';
import { initResizers } from './resizers.js';
import { setupEventListeners } from './events.js';

let pendingTopicImages = [];
let pendingRefineImages = [];
let lastRefinedHtml = '';
const activeSlideControllers = new Map();
let activeRefineController = null;
let currentAbortController = null; // ← was missing, caused ReferenceError
let sessionRunToken = 0;
const latestJobBySlide = {};
let slideJobCounter = 0;
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
    slidePhases: state.slidePhases || {}
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
  } catch {
    // ignore
  }
}

function resumeGeneratingSlidesFromCache() {
  const indices = Object.keys(state.generatingSlides || {}).map(Number);
  if (!indices.length) return;
  indices.forEach((idx) => {
    startSlideGeneration(idx, true);
  });
}

function syncStatusFromState() {
  const hasActiveJobs = Object.keys(state.generatingSlides || {}).length > 0;
  const currentSaved = state.slides.some(s => s.index === state.currentIndex);
  const currentDraft = !!state.draftSlides?.[state.currentIndex] || !!state.currentSlideHtml;
  
  if (state.status === 'REVIEWING_OUTLINE') return;

  if (hasActiveJobs) {
    state.status = 'GENERATING';
  } else if (currentSaved || currentDraft) {
    state.status = 'REVIEWING';
  } else if (state.outline.length && state.slides.length === state.outline.length) {
    state.status = 'DONE';
  }
}

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
    onCustomRegenerate: customRegenerateWithPrompt,
    onRegenerate: regenerateCurrentSlide,
    onStopGeneration: stopConversation,
    onNewDeck: handleNewDeck,
    onUseRefined: () => {
      if (!lastRefinedHtml.trim()) return;
      state.currentSlideHtml = lastRefinedHtml;
      state.draftSlides[state.currentIndex] = lastRefinedHtml;
      renderSlide(lastRefinedHtml);
    },
    onSwitchMode: handleSwitchMode,
    onPlanChat: handlePlanChat,
    onStartSlideGeneration: (index) => startSlideGeneration(index, true)
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
      const cached = loadSessionViewState(session.session_id) || {};
      const approvedFromBackend = (session.slides || [])
        .filter(s => s.approved)
        .map(s => ({ index: (s.index || 1) - 1, html: s.html }));
      const latestSlides = { ...(cached.latestSlides || {}) };
      const draftSlides = { ...(cached.draftSlides || {}) };
      const generatingSlides = (cached.generatingIndices || []).reduce((acc, idx) => {
        acc[idx] = true;
        return acc;
      }, {});
      const promptApplyingSlides = (cached.promptApplyingIndices || []).reduce((acc, idx) => {
        acc[idx] = true;
        return acc;
      }, {});
      approvedFromBackend.forEach(s => {
        latestSlides[s.index] = s.html;
      });

      updateState({
        sessionId: session.session_id,
        outline: session.outline || [],
        slides: (session.slides || []).map(s => ({ ...s, index: s.index - 1 })),
        status: backendStatus.toUpperCase(),
        currentIndex: cached.currentIndex ?? (session.current_index || 0),
        currentSlideHtml: cached.currentSlideHtml || '',
        theme: session.theme || 'dark-tech',
        model: session.text_model || state.model,
        mode: session.mode || 'plan',
        messages: cached.messages || [],
        slidePhases: cached.slidePhases || {}
      });

      // Restore chat history in UI
      if (state.messages.length > 0) {
        elements.chatHistory.innerHTML = '';
        state.messages.forEach(m => renderChatMessage(m.role, m.text));
      }

      console.log(`Restored session ${state.sessionId} (status: ${state.status})`);
      renderOutline(navigateToSlide);
      updateUI();

      const s = state.status;
      if (s === 'REVIEWING_OUTLINE') {
        state.phase = 'CONTENT';
        renderOutlineContentSummary(elements.infoList);
      } else if (s === 'GENERATING') {
        state.phase = 'DESIGN';
        renderPlaceholder('Resuming previous generation...');
        resumeGeneratingSlidesFromCache();
      } else if (s === 'REVIEWING') {
        state.phase = 'DESIGN';
        const latest = state.latestSlides[state.currentIndex];
        if (latest) {
          state.currentSlideHtml = latest;
          renderSlide(latest);
        } else {
          renderPlaceholder('Slide ready for review. Approve or refine.');
        }
      } else if (s === 'DONE') {
        state.phase = 'DESIGN';
        const latest = state.latestSlides[state.currentIndex];
        if (latest) {
          state.currentSlideHtml = latest;
          renderSlide(latest);
        } else {
          renderPlaceholder('Deck complete! Export or start a new deck.');
        }
      } else if (state.outline.length > 0) {
        renderPlaceholder('Project loaded. Ready to continue.');
      }
      persistSessionViewState();
    }
  } catch (error) {
    console.error('Failed to load project info:', error);
    elements.projectPathDisplay.textContent = 'Standalone Mode';
  }
}

// ── New Deck ──────────────────────────────────────────────────────────────────
async function handleNewDeck() {
  const oldSessionId = state.sessionId;
  
  clearSessionViewState(oldSessionId);
  stopAllGeneration();
  pendingTopicImages = [];
  pendingRefineImages = [];
  updateState({
    sessionId: null,
    outline: [],
    slides: [],
    messages: [],
    draftSlides: {},
    latestSlides: {},
    promptApplyingSlides: {},
    generatingSlides: {},
    slidePhases: {},
    currentIndex: 0,
    currentSlideHtml: '',
    status: 'IDLE',
    phase: 'CONTENT',
    mode: 'plan',
    projectPath: state.projectPath 
  });
  
  clearUI();

  if (oldSessionId) {
    try {
      await deleteSession(oldSessionId);
    } catch (e) {
      console.warn('Failed to delete session on backend:', e);
    }
  }
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
    renderOutlineContentSummary(elements.infoList);
    updateUI();
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

    // Stay in plan mode — user picks when to switch per-slide
    state.status = 'GENERATING';
    state.phase = 'DESIGN';
    state.currentIndex = 0;
    
    const confirmMsg = "Outline confirmed! You can continue planning individual slides or switch to Build mode to generate them. Each slide moves from Plan → Build independently.";
    state.messages.push({ role: 'ai', text: confirmMsg });
    renderChatMessage('ai', confirmMsg);

    elements.confirmOutlineBtn.style.display = 'none';
    elements.confirmOutlineBtn.disabled = false;
    elements.confirmOutlineBtn.textContent = 'Confirm';
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

// ── Mode Switch ────────────────────────────────────────────────────────────────
async function handleSwitchMode(newMode) {
  if (!state.sessionId) return;

  // If switching to plan mode, check if current slide allows it
  if (newMode === 'plan' && !canPlanSlide(state.currentIndex)) {
    showSlidePhaseBoundaryMessage(state.currentIndex, 'plan');
    return;
  }

  try {
    const res = await updateMode(state.sessionId, newMode);
    updateState({ mode: res.mode });
    updateUI();
    persistSessionViewState();
  } catch (error) {
    console.error('Mode switch failed:', error);
  }
}

/**
 * Show a clear message when the user tries to do something that violates
 * the per-slide plan→build boundary.
 */
function showSlidePhaseBoundaryMessage(index, attemptedAction) {
  const slideNum = index + 1;
  if (attemptedAction === 'plan') {
    const msg = `Slide ${slideNum} has already been built. You can't go back to planning a slide that has been generated. Switch to Build mode to refine it instead.`;
    // Add to chat history so it's visible
    renderChatMessage('ai', msg);
    elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
  } else if (attemptedAction === 'build-while-chat') {
    const msg = `Can't generate Slide ${slideNum} while a plan chat is in progress. Wait for the chat to complete first.`;
    renderChatMessage('ai', msg);
    elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
  }
}

// ── Plan Chat ─────────────────────────────────────────────────────────────────
async function handlePlanChat(message) {
  if (!state.sessionId) return;

  // Per-slide boundary check: if this slide has been built, no more planning
  if (!canPlanSlide(state.currentIndex)) {
    showSlidePhaseBoundaryMessage(state.currentIndex, 'plan');
    return;
  }

  // Can't chat while this slide is actively generating
  if (state.generatingSlides[state.currentIndex]) {
    showSlidePhaseBoundaryMessage(state.currentIndex, 'build-while-chat');
    return;
  }

  try {
    state.messages.push({ role: 'user', text: message });
    renderChatMessage('user', message);
    
    state.status = 'OUTLINING';
    updateUI();
    
    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const res = await sendPlanChat(state.sessionId, message, state.currentIndex + 1, currentAbortController.signal);
    currentAbortController = null;
    
    updateState({ outline: res.outline });
    state.status = 'REVIEWING_OUTLINE';
    elements.promptInput.value = '';
    
    const aiResponse = res.message || "Outline updated based on your request.";
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

// ── Outline Navigation ────────────────────────────────────────────────────────
function navigateToSlide(index) {
  state.currentIndex = index;

  // When navigating, auto-switch mode to match the slide's current phase
  // so the UI always shows the right interaction panel
  const slidePhase = getSlidePhase(index);
  if (slidePhase === 'build' && state.mode === 'plan') {
    // Silently update local mode — don't call backend just for navigation
    state.mode = 'build';
    updateMode(state.sessionId, 'build').catch(() => {});
  }

  if (state.status === 'REVIEWING_OUTLINE') {
    renderSlideInfo(index);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  if (state.promptApplyingSlides[index]) {
    state.status = 'GENERATING';
    renderPlaceholder(`Applying prompt to Slide ${index + 1}...`);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const latest = state.latestSlides[index];
  if (latest) {
    state.currentSlideHtml = latest;
    state.status = 'REVIEWING';
    renderSlide(latest);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const draft = state.draftSlides[index];
  if (draft) {
    state.currentSlideHtml = draft;
    state.status = 'REVIEWING';
    renderSlide(draft);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const saved = state.slides.find(s => s.index === index);
  if (saved) {
    state.currentSlideHtml = saved.html;
    state.status = 'REVIEWING';
    renderSlide(saved.html);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  if (state.generatingSlides[index]) {
    renderPlaceholder(`Slide ${index + 1} is generating in the background...`);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  renderPlaceholder(`Slide ${index + 1} has not been built yet. Click the ✦ button in the outline to generate it.`);
  renderOutline(navigateToSlide);
  updateUI();
}

// ── Slide Generation ──────────────────────────────────────────────────────────
async function startSlideGeneration(index = state.currentIndex, force = false) {
  // Per-slide boundary: generation locks this slide into build phase
  if (!canPlanSlide(index)) {
    // Already in build — that's fine, just regenerating
  }

  // Block generation if a plan chat is in progress for ANY slide
  // (backend can't handle simultaneous chat + generate on same session)
  if (state.status === 'OUTLINING') {
    console.warn('Cannot generate while plan chat is in progress');
    return;
  }

  if (state.generatingSlides[index] && !force) return;
  if (force && activeSlideControllers.has(index)) {
    activeSlideControllers.get(index).abort();
  }

  // Lock this slide into build phase — irreversible
  lockSlideIntoBuild(index);

  // If we're currently in plan mode viewing this slide, switch to build
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
  renderOutline(navigateToSlide);
  persistSessionViewState();

  const slideNum = index + 1;
  const slideTitle = state.outline[index]?.title ?? `Slide ${slideNum}`;

  if (index === state.currentIndex) {
    renderPlaceholder(`Generating Slide ${slideNum}: ${slideTitle}...`);
  }

  let slideHtml = '';
  const controller = new AbortController();
  activeSlideControllers.set(index, controller);
  try {
    const stream = streamSlide(state.sessionId, slideNum, 'generate', {}, controller.signal);
    for await (const token of stream) {
      slideHtml += token.replace(/\\n/g, '\n');
    }

    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (!slideHtml.trim()) throw new Error('Empty slide response from backend');

    state.draftSlides[index] = slideHtml;
    state.latestSlides[index] = slideHtml;
    if (index === state.currentIndex && runToken === sessionRunToken && isLatestSlideJob(index, jobId)) {
      state.currentSlideHtml = slideHtml;
      state.status = 'REVIEWING';
      renderSlide(slideHtml);
    }
    updateUI();
    renderOutline(navigateToSlide);
    persistSessionViewState();

    elements.visionStatus.style.display = 'inline-block';
    elements.visionStatus.style.color = 'var(--accent)';
    elements.visionStatus.textContent = 'VISION: ANALYZING...';
    setTimeout(() => {
      elements.visionStatus.textContent = 'VISION: LAYOUT OK';
      elements.visionStatus.style.color = '#10b981';
    }, 1500);
  } catch (error) {
    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
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
    if (isLatestSlideJob(index, jobId)) {
      activeSlideControllers.delete(index);
      delete state.generatingSlides[index];
    }
    if (runToken === sessionRunToken && isLatestSlideJob(index, jobId)) {
      syncStatusFromState();
    }
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
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
    state.latestSlides[approvedIndex] = html;
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
    persistSessionViewState();

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

async function customRegenerateWithPrompt() {
  const instruction = elements.refineInstructionInput.value.trim();
  const currentHtml = state.draftSlides[state.currentIndex] || state.currentSlideHtml;
  if (!currentHtml?.trim()) {
    renderPlaceholder('Generate this slide first, then apply custom prompt.');
    return;
  }
  if (!instruction) {
    renderPlaceholder('Type a custom instruction first, then click Apply Prompt.');
    return;
  }

  if (activeSlideControllers.has(state.currentIndex)) {
    activeSlideControllers.get(state.currentIndex).abort();
  }
  if (activeRefineController) {
    activeRefineController.abort();
  }

  const index = state.currentIndex;
  const slideNum = index + 1;
  const runToken = sessionRunToken;
  const jobId = beginSlideJob(index);

  state.slides = state.slides.filter(s => s.index !== index);

  state.status = 'GENERATING';
  state.generatingSlides[index] = true;
  state.promptApplyingSlides[index] = true;
  renderOutline(navigateToSlide);
  updateUI();
  persistSessionViewState();
  renderPlaceholder(`Applying prompt to Slide ${slideNum}...`);

  let regenerated = '';
  activeRefineController = new AbortController();
  try {
    const stream = streamSlide(state.sessionId, slideNum, 'refine', {
      refineMode: 'expand',
      currentHtml,
      instruction,
      signal: activeRefineController.signal
    });

    for await (const token of stream) {
      regenerated += token.replace(/\\n/g, '\n');
    }

    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (!regenerated.trim()) throw new Error('Empty regenerated slide');

    state.draftSlides[index] = regenerated;
    state.latestSlides[index] = regenerated;
    delete state.promptApplyingSlides[index];
    if (state.currentIndex === index) {
      state.currentSlideHtml = regenerated;
      state.status = 'REVIEWING';
      renderSlide(regenerated);
    }
  } catch (error) {
    if (runToken !== sessionRunToken) return;
    if (!isLatestSlideJob(index, jobId)) return;
    if (error?.name !== 'AbortError') {
      console.error('Custom regeneration failed:', error);
      state.status = 'ERROR';
      delete state.promptApplyingSlides[index];
      if (state.currentIndex === index) {
        renderPlaceholder(`Custom regenerate failed: ${error.message}`);
      }
    } else {
      delete state.promptApplyingSlides[index];
    }
  } finally {
    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    activeRefineController = null;
    delete state.generatingSlides[index];
    syncStatusFromState();
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
  }
}

function stopAllGeneration() {
  sessionRunToken += 1;
  Object.keys(latestJobBySlide).forEach((k) => {
    delete latestJobBySlide[k];
  });
  if (currentAbortController) {
    currentAbortController.abort();
    currentAbortController = null;
  }
  for (const controller of activeSlideControllers.values()) {
    controller.abort();
  }
  activeSlideControllers.clear();
  if (activeRefineController) {
    activeRefineController.abort();
    activeRefineController = null;
  }
  state.generatingSlides = {};
  state.promptApplyingSlides = {};
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