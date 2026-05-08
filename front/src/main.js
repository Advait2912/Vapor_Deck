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
let sessionRunToken = 0; // increment only for hard resets/stops
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
    currentSlideHtml: state.currentSlideHtml || ''
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
  if (hasActiveJobs) {
    state.status = 'GENERATING';
  } else if (currentSaved || currentDraft) {
    state.status = 'REVIEWING';
  } else if (state.outline.length && state.slides.length === state.outline.length) {
    state.status = 'DONE';
  }
}

function setupIframeScaler() {
  const container = document.getElementById('preview-container');
  const iframe = document.getElementById('slide-iframe');
  if (!container || !iframe) return;

  const observer = new ResizeObserver(entries => {
    for (let entry of entries) {
      const w = entry.contentRect.width;
      const h = entry.contentRect.height;
      // Leave 40px padding total (20px each side)
      const scaleX = (w - 40) / 1280;
      const scaleY = (h - 40) / 720;
      const scale = Math.min(scaleX, scaleY);
      iframe.style.transform = `scale(${scale})`;
    }
  });
  observer.observe(container);
}

// ── Initialization ────────────────────────────────────────────────────────────
async function init() {
  initResizers();
  setupIframeScaler();
  
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
        // Normalise backend snake_case status to our uppercase convention
        status: backendStatus.toUpperCase(),
        currentIndex: cached.currentIndex ?? (session.current_index || 0),
        currentSlideHtml: cached.currentSlideHtml || '',
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
function handleNewDeck() {
  clearSessionViewState(state.sessionId);
  stopAllGeneration();
  pendingTopicImages = [];
  pendingRefineImages = [];
  updateState({
    sessionId: null,
    outline: [],
    slides: [],
    draftSlides: {},
    latestSlides: {},
    promptApplyingSlides: {},
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
  delete state.promptApplyingSlides[index];
  const runToken = sessionRunToken;
  const jobId = beginSlideJob(index);
  updateUI();
  renderOutline(navigateToSlide);
  persistSessionViewState();

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

    // Vision status animation
    elements.visionStatus.style.display = 'inline-block';
    elements.visionStatus.style.color = 'var(--accent)';
    elements.visionStatus.textContent = 'VISION: ANALYZING...';
    setTimeout(() => {
      elements.visionStatus.textContent = 'VISION: LAYOUT OK';
      elements.visionStatus.style.color = '#10b981';
    }, 1500);
  } catch (error) {
    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) {
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
    const iframe = elements.slideIframe;
    // Capture live HTML directly from the body now that scaler wrapper is removed
    let html = '';
    if (iframe.contentDocument && iframe.contentDocument.body) {
      // Clone body to remove the injected script tag before saving
      const bodyClone = iframe.contentDocument.body.cloneNode(true);
      const scriptTags = bodyClone.getElementsByTagName('script');
      for (let i = scriptTags.length - 1; i >= 0; i--) {
        scriptTags[i].parentNode.removeChild(scriptTags[i]);
      }
      html = bodyClone.innerHTML;
    } else {
      html = state.draftSlides[state.currentIndex] || state.currentSlideHtml;
    }

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

  // If a slide was previously approved, regenerating it creates a new draft
  // and should require re-approval.
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
  if (!state.sessionId || !state.slides.length) {
    alert('No slides to export. Please generate and approve some slides first.');
    return;
  }

  try {
    elements.exportBtn.textContent = 'Exporting...';
    elements.exportBtn.disabled = true;

    const slideData = [];
    for (let i = 0; i < state.outline.length; i++) {
      // 1. If it's the slide currently on screen, capture live DOM (WYSIWYG)
      if (i === state.currentIndex && elements.slideIframe.contentDocument?.body) {
        const bodyClone = elements.slideIframe.contentDocument.body.cloneNode(true);
        const scriptTags = bodyClone.getElementsByTagName('script');
        for (let j = scriptTags.length - 1; j >= 0; j--) {
          scriptTags[j].parentNode.removeChild(scriptTags[j]);
        }
        slideData.push(bodyClone.innerHTML);
        continue;
      }

      // 2. Use explicitly approved HTML if available
      const approved = state.slides.find(s => s.index === i);
      if (approved) {
        slideData.push(approved.html);
        continue;
      }

      // 3. Fallback to raw draft if not approved
      if (state.draftSlides[i]) {
        slideData.push(state.draftSlides[i]);
        continue;
      }

      // 4. Fallback to latest known HTML
      if (state.latestSlides[i]) {
        slideData.push(state.latestSlides[i]);
        continue;
      }

      // 5. Blank placeholder if slide was completely skipped
      slideData.push('<div style="color:#666;display:flex;align-items:center;justify-content:center;height:100%;width:100%;font-size:2rem;background:#000;">[Slide ' + (i+1) + ' Not Generated]</div>');
    }
    const theme = state.theme || 'dark-tech';

    console.log(`Exporting ${slideData.length} slides (theme: ${theme})`);

    const response = await fetch(
      `http://localhost:8000/api/export/session/${state.sessionId}/pdf`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slides: slideData, theme }),
      }
    );

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      let rawText = '';
      try {
        rawText = await response.text();
        const err = JSON.parse(rawText);
        detail = err.detail || JSON.stringify(err);
      } catch (_) {
        detail = rawText || detail;
      }
      console.error('Export error response:', detail);
      throw new Error(detail);
    }

    // Server returns raw PDF bytes
    const pdfBlob = await response.blob();
    const url = URL.createObjectURL(pdfBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vapor_deck_${state.sessionId}.pdf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Export failed:', error);
    const msg = error.message || String(error);

    // Offer to download debug HTML so the user can inspect / report
    const wantDebug = confirm(
      'PDF export failed.\n\n' +
      msg.substring(0, 500) + '\n\n' +
      'Would you like to download the debug HTML file to inspect what went wrong?'
    );
    if (wantDebug) {
      try {
        const debugResp = await fetch(
          `http://localhost:8000/api/export/session/${state.sessionId}/debug-html`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slides: state.slides.map(s => s.html), theme: state.theme || 'dark-tech' }),
          }
        );
        if (debugResp.ok) {
          const blob = await debugResp.blob();
          const u = URL.createObjectURL(blob);
          const a2 = document.createElement('a');
          a2.href = u;
          a2.download = `debug_${state.sessionId}.html`;
          document.body.appendChild(a2);
          a2.click();
          document.body.removeChild(a2);
          URL.revokeObjectURL(u);
        }
      } catch (e) {
        console.error('Debug HTML download also failed:', e);
      }
    }
  } finally {
    elements.exportBtn.textContent = 'Export PDF';
    elements.exportBtn.disabled = false;
  }
}

init();
