/**
 * VAPOR DECK — main.js (UPGRADED)
 * ─────────────────────────────────
 * Wires the new systems into the existing app without breaking anything.
 *
 * NEW in this version:
 *   - Uses renderer/index.js (isolated iframe renderer) for slide rendering
 *   - Integrates comparison.js for split-view refinement
 *   - Integrates export.js for PDF export
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
  addOutlineSlide,
  retryAnalysis,
  sendDesignChat,
} from './api/client.js';

import { state, updateState } from './state.js';
import { elements, updateUI, renderOutline, renderPlaceholder, renderSlide, renderOutlineContentSummary, renderImageThumbs, renderSlideInfo, renderChatMessage, clearUI } from './ui.js';
import { initResizers } from './resizers.js';
import { setupEventListeners } from './events.js';

// ── New modules ────────────────────────────────────────────────────────────────
import { mountSlide, mountPlaceholder, buildBaseDocument, ensureFontsInDocument } from './renderer/index.js';
import { exportDeckAsPDF, getExportableSlideCount } from './export.js';
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

// ── Context Upload State ──────────────────────────────────────────────────────
// Files staged here are uploaded after session creation, before synthesize.
/** @type {{ file: File, name: string, type: 'image'|'doc' }[]} */
let contextUploadQueue = [];

// ── Info Panel View State ─────────────────────────────────────────────────────
// Tracks whether the right sidebar shows per-slide detail or the full overview.
let infoView = 'detail'; // 'detail' | 'overview'

function refreshInfoPanel() {
  const toggle = document.getElementById('info-view-toggle');
  if (toggle && state.outline && state.outline.length) toggle.style.display = 'flex';
  if (infoView === 'overview') {
    renderOutlineContentSummary(elements.infoList);
  } else {
    renderSlideInfo(state.currentIndex);
  }
}
// Expose so ui.js can call it from updateUI without a circular import
window.refreshInfoPanel = refreshInfoPanel;

function showLoadingBar() {
  const bar = document.getElementById('slide-loading-bar');
  if (!bar) return;
  bar.classList.remove('done', 'fade-out');
  bar.classList.add('running');
}

function hideLoadingBar() {
  const bar = document.getElementById('slide-loading-bar');
  if (!bar) return;
  bar.classList.remove('running');
  bar.classList.add('done');
  setTimeout(() => {
    bar.classList.add('fade-out');
    setTimeout(() => {
      bar.classList.remove('done', 'fade-out');
    }, 400);
  }, 500);
}

/**
 * Helper to render the outline with all necessary callbacks and state.
 */
function refreshOutline() {
  renderOutline(navigateToSlide, reorderSlides, state.isReorderMode);
}
const SESSION_VIEW_PREFIX = 'vapordeck:view:';

function beginSlideJob(index) {
  const id = ++slideJobCounter;
  const slideId = getSlideId(index);
  if (slideId) latestJobBySlide[slideId] = id;
  return id;
}

function isLatestSlideJob(index, id) {
  const slideId = getSlideId(index);
  return slideId ? latestJobBySlide[slideId] === id : false;
}

function getSessionViewKey(sessionId) {
  return `${SESSION_VIEW_PREFIX}${sessionId}`;
}

function getSlideId(index) {
  return state.outline[index]?.id;
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
    promptApplyingIds: Object.keys(state.promptApplyingSlides || {}),
    generatingIds: Object.keys(state.generatingSlides || {}),
    currentIndex: state.currentIndex || 0,
    currentSlideHtml: state.currentSlideHtml || '',
    messages: state.messages || [],
    slidePhases: state.slidePhases || {},
    slideAudits: state.slideAudits || {},  // persist audit results across navigation/reload
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
  const ids = Object.keys(state.generatingSlides || {});
  if (!ids.length) return;
  // ONLY resume slides that are NOT already approved
  ids.forEach((id) => {
    const isApproved = state.slides.some(s => s.id === id);
    const outlineItem = state.outline.find(s => s.id === id);
    if (!isApproved && outlineItem) {
      startSlideGeneration(outlineItem.index - 1, true);
    } else {
      delete state.generatingSlides[id];
    }
  });
}

function syncStatusFromState() {
  const hasActiveJobs = Object.keys(state.generatingSlides || {}).length > 0;
  if (state.status === 'REVIEWING_OUTLINE') return;
  
  const currentId = getSlideId(state.currentIndex);
  if (hasActiveJobs) {
    state.status = 'GENERATING';
  } else if ((currentId && state.draftSlides?.[currentId]) || state.currentSlideHtml) {
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

    } else if (e.detail.reason === 'slide-added') {
      const { newSlide } = e.detail;
      addOutlineSlide(state.sessionId, {
        title: newSlide.title,
        intent: newSlide.intent,
        key_points: newSlide.key_points,
        layout_hint: newSlide.layout_hint,
      }).then(res => {
        // Sync backend's canonical (re-numbered) outline back to state
        if (res.outline) {
          updateState({ outline: res.outline });
          refreshOutline();
          // Navigate to the newly added slide (last item after re-numbering)
          const newIdx = res.outline.length - 1;
          navigateToSlide(newIdx);
        }
      }).catch(err => console.warn('Add slide sync failed:', err));
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

  window.addEventListener('global:generate-all', () => {
    if (!state.sessionId || !state.outline.length) return;
    if (state.status === 'REVIEWING_OUTLINE') return;
    
    // Add all unbuilt slides to the queue
    state.outline.forEach((item, idx) => {
      const id = item.id;
      const isBuilt = !!state.latestSlides[id] || state.slides.some(s => s.id === id);
      if (!isBuilt && !state.generatingSlides[id]) {
        addToGenerationQueue(idx, false);
      }
    });
  });

  // ── Info Panel Toggle ─────────────────────────────────────────────────────
  document.getElementById('info-view-detail')?.addEventListener('click', () => {
    infoView = 'detail';
    document.getElementById('info-view-detail')?.classList.add('active');
    document.getElementById('info-view-overview')?.classList.remove('active');
    refreshInfoPanel();
  });
  document.getElementById('info-view-overview')?.addEventListener('click', () => {
    infoView = 'overview';
    document.getElementById('info-view-overview')?.classList.add('active');
    document.getElementById('info-view-detail')?.classList.remove('active');
    refreshInfoPanel();
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
    onRefineImagesSelected: handleRefineImagesSelected,
    onDesignChat: handleDesignChat,
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
      const id = getSlideId(state.currentIndex);
      if (id) state.draftSlides[id] = html;
      // Use new isolated renderer
      const iframe = elements.slideIframe;
      mountSlide(iframe, html, state.theme, state.designConfig?.font_hints);
      persistSessionViewState();
    },
    onSwitchMode: handleSwitchMode,
    onPlanChat: handlePlanChat,
    onStartSlideGeneration: (index) => startSlideGeneration(index, true)
  });

  // Wire up comparison overlay buttons using the new comparison module
  _wireComparisonButtons();

  // Wire up the context upload panel
  setupContextUpload();

  await loadProjectInfo();
  updateUI();
  mountGlobalControlsInSidebar();

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
      const id = getSlideId(state.currentIndex);
      if (id) state.draftSlides[id] = html;
      mountSlide(elements.slideIframe, html, state.theme, state.designConfig?.font_hints);
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
      (session.slides || []).forEach(s => { 
        if (s.id) {
          latestSlides[s.id] = s.html; 
          // If it's in the backend, it's no longer a local-only draft
          delete draftSlides[s.id];
        }
      });

      const generatingSlides = (cached.generatingIds || []).reduce((acc, id) => {
        acc[id] = true; return acc;
      }, {});

      const promptApplyingSlides = (cached.promptApplyingIds || []).reduce((acc, id) => {
        acc[id] = true; return acc;
      }, {});

      updateState({
        sessionId: session.session_id,
        outline: session.outline || [],
        slides: session.slides || [],
        draftSlides,
        latestSlides,
        generatingSlides,
        promptApplyingSlides,
        status: (session.session_status || backendStatus).toUpperCase(),
        currentIndex: cached.currentIndex ?? (session.current_index || 0),
        currentSlideHtml: cached.currentSlideHtml || '',
        theme: session.theme || 'dark-tech',
        designConfig: session.design_config || {},
        model: session.text_model || state.model,
        visionModel: session.vision_model || state.visionModel,
        mode: session.mode || 'plan',
        messages: cached.messages || [],
        slidePhases: cached.slidePhases || {},
        slideAudits: cached.slideAudits || {},  // restore audit results from cache
        auditingSlides: {},                      // always start fresh, never restore in-flight audits
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
        refreshInfoPanel();
      } else if (s === 'GENERATING') {
        state.phase = 'DESIGN';
        const approved = state.slides.find(s => s.index === state.currentIndex);
        if (approved) {
          mountSlide(elements.slideIframe, approved.html, state.theme, state.designConfig?.font_hints);
        } else {
          mountPlaceholder(elements.slideIframe, 'Resuming previous generation...');
        }
        resumeGeneratingSlidesFromCache();
      } else if (s === 'REVIEWING' || s === 'DONE') {
        state.phase = 'DESIGN';
        const id = getSlideId(state.currentIndex);
        const latest = id ? state.latestSlides[id] : null;
        if (latest) {
          state.currentSlideHtml = latest;
          mountSlide(elements.slideIframe, latest, state.theme, state.designConfig?.font_hints);
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
  pendingRefineImages = [];

  // Reset context upload panel for the new session
  contextUploadQueue = [];
  const _pills = document.getElementById('context-file-pills');
  if (_pills) _pills.innerHTML = '';
  document.getElementById('context-upload-panel')?.classList.remove('hidden');
  updateState({
    sessionId: null, outline: [], slides: [], messages: [],
    draftSlides: {}, latestSlides: {}, promptApplyingSlides: {},
    generatingSlides: {}, slidePhases: {}, currentIndex: 0,
    slideAudits: {}, auditingSlides: {},  // clear all audit state
    currentSlideHtml: '', status: 'IDLE', phase: 'CONTENT',
    mode: 'plan', projectPath: state.projectPath
  });

  clearUI();
  document.getElementById('global-controls-container')?.remove();

  if (oldSessionId) {
    try { await deleteSession(oldSessionId); } catch {}
  }
}

// ── Context Upload Panel ───────────────────────────────────────────────────────
/**
 * Sets up click-to-pick and drag-and-drop on #context-drop-zone.
 * Files are queued in contextUploadQueue and shown as pills immediately.
 * Actual upload happens inside startGeneration once we have a session ID.
 */
function setupContextUpload() {
  const dropZone = document.getElementById('context-drop-zone');
  const fileInput = document.getElementById('context-file-input');
  const pillsContainer = document.getElementById('context-file-pills');
  if (!dropZone || !fileInput || !pillsContainer) return;

  const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
  const DOC_EXTS   = new Set(['pdf', 'docx', 'doc']);

  function getFileType(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (DOC_EXTS.has(ext))   return 'doc';
    return null;
  }

  function addPill(entry) {
    const pill = document.createElement('div');
    pill.className = `context-file-pill pill-${entry.type}`;
    pill.dataset.name = entry.name;
    const icon = entry.type === 'image' ? '🖼' : '📄';
    pill.innerHTML = `
      <span class="pill-icon">${icon}</span>
      <span class="pill-name" title="${entry.name}">${entry.name}</span>
      <button class="pill-remove" title="Remove">×</button>
    `;
    pill.querySelector('.pill-remove').addEventListener('click', () => {
      contextUploadQueue = contextUploadQueue.filter(e => e !== entry);
      pill.remove();
    });
    pillsContainer.appendChild(pill);
  }

  function enqueueFiles(files) {
    for (const file of files) {
      const type = getFileType(file);
      if (!type) continue;
      // Dedup by name
      if (contextUploadQueue.some(e => e.name === file.name)) continue;
      const entry = { file, name: file.name, type };
      contextUploadQueue.push(entry);
      addPill(entry);
    }
  }

  // Click to open file picker
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    enqueueFiles(Array.from(e.target.files || []));
    fileInput.value = ''; // reset so same file can be re-added after removal
  });

  // Drag and drop
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    enqueueFiles(Array.from(e.dataTransfer.files || []));
  });
}

/**
 * Upload all queued context files to an existing session.
 * Updates pill styles in-place (uploading → success/error).
 * Non-fatal: one file failing does not block the rest.
 */
async function flushContextUploads(sessionId) {
  if (!contextUploadQueue.length) return;
  const pillsContainer = document.getElementById('context-file-pills');

  for (const entry of contextUploadQueue) {
    const pill = pillsContainer?.querySelector(`[data-name="${CSS.escape(entry.name)}"]`);
    if (pill) pill.classList.add('pill-uploading');

    try {
      const role = entry.type === 'doc' ? 'reference' : 'reference';
      await uploadFile(sessionId, entry.file, role);
      if (pill) {
        pill.classList.remove('pill-uploading');
        // brief success flash
        pill.style.borderColor = 'rgba(16,185,129,0.6)';
      }
    } catch (err) {
      console.warn(`Context upload failed for '${entry.name}':`, err);
      if (pill) {
        pill.classList.remove('pill-uploading');
        pill.classList.add('pill-error');
        pill.title = `Upload failed: ${err.message}`;
      }
    }
  }
}

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
    updateUI();

    // ── Upload queued context files (images + docs) BEFORE topic text ─────────
    // Order matters: context must reach the backend before synthesize() so the
    // multimodal outline prompt has doc_summary and image metadata available.
    if (contextUploadQueue.length) {
      elements.generateBtn.textContent = `Uploading ${contextUploadQueue.length} file(s)...`;
      await flushContextUploads(state.sessionId);
      // Collapse the panel — files are now committed to the session
      document.getElementById('context-upload-panel')?.classList.add('hidden');
    }

    elements.generateBtn.textContent = 'Uploading topic...';
    await uploadText(state.sessionId, prompt, 'topic');

    elements.generateBtn.textContent = 'Synthesizing...';
    await synthesize(state.sessionId);

    state.status = 'OUTLINING';
    elements.generateBtn.textContent = 'Outlining...';
    updateUI();
    const preferredSlides = parseInt(document.getElementById('preferred-slides-input')?.value, 10) || 8;
    const outlineData = await generateOutline(state.sessionId, preferredSlides);
    state.outline = outlineData.outline;

    state.status = 'REVIEWING_OUTLINE';
    state.phase = 'CONTENT';
    renderOutline(navigateToSlide);
    refreshInfoPanel();
    mountGlobalControlsInSidebar();
    updateUI();
  } catch (error) {
    console.error('Generation failed:', error);
    state.status = 'ERROR';
    updateUI();
    elements.generateBtn.disabled = false;
    elements.promptInput.disabled = false;
    
    const errMsg = error.message || 'Unknown error';
    const friendlyMsg = `⚠️ **Deck initialization failed.**\n\nIt looks like the AI backend couldn't process your request. This is often because the Ollama server is offline or busy.\n\n**Error Details:** ${errMsg}\n\n*Please ensure Ollama is running and try clicking 'Retry Generation' below.*`;
    
    state.messages.push({ role: 'ai', text: friendlyMsg });
    renderChatMessage('ai', friendlyMsg);
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
      id: item.id,
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
  const id = getSlideId(state.currentIndex);
  if (id && state.generatingSlides[id]) {
    alert('Slide is still generating. Please wait.');
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
    const sortedOutline = (res.outline || []).slice().sort((a, b) => a.index - b.index);
    updateState({ outline: sortedOutline });
    state.status = 'REVIEWING_OUTLINE';
    // Input already cleared above
    const aiResponse = res.message || "Outline updated.";
    state.messages.push({ role: 'ai', text: aiResponse });
    renderChatMessage('ai', aiResponse);
    renderOutline(navigateToSlide);
    refreshInfoPanel();
    updateUI();
    persistSessionViewState();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error('Plan chat failed:', error);
    state.status = 'ERROR';
    updateUI();
    
    const errMsg = error.message || 'Unknown error';
    const friendlyMsg = `⚠️ **Planning update failed.**\n\nI couldn't update the outline. This might be due to a temporary connection issue with the AI server.\n\n**Error Details:** ${errMsg}\n\n*You can try sending your message again.*`;

    state.messages.push({ role: 'ai', text: friendlyMsg });
    renderChatMessage('ai', friendlyMsg);
  }
}

// ── Design Chat ─────────────────────────────────────────────────────────────────
async function handleDesignChat(message) {
  if (!state.sessionId) return;
  try {
    renderChatMessage('user', message, elements.designChatHistory);
    
    elements.designPromptInput.value = '';
    elements.designPromptInput.style.height = 'auto';
    elements.designPromptInput.disabled = true;
    elements.designGenerateBtn.disabled = true;

    if (currentAbortController) currentAbortController.abort();
    currentAbortController = new AbortController();
    const res = await sendDesignChat(state.sessionId, message, currentAbortController.signal);
    currentAbortController = null;

    const aiResponse = res.message || "Design configuration updated.";
    renderChatMessage('ai', aiResponse, elements.designChatHistory);

  } catch (error) {
    if (error?.name === 'AbortError') return;
    console.error('Design chat failed:', error);
  } finally {
    elements.designPromptInput.disabled = false;
    elements.designGenerateBtn.disabled = false;
    elements.designPromptInput.focus();
  }
}

// ── Outline Navigation ───────────────────────────────────────────────────────────
function navigateToSlide(index) {
  state.currentIndex = index;
  const id = getSlideId(index);

  if (state.status === 'REVIEWING_OUTLINE') {
    renderSlideInfo(index);
    renderOutline(navigateToSlide);
    updateUI();
    return;
  }

  if (id && state.promptApplyingSlides[id]) {
    state.status = 'GENERATING';
    mountPlaceholder(elements.slideIframe, `Applying prompt to Slide ${index + 1}...`);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const latest = id ? state.latestSlides[id] : null;
  if (latest) {
    state.currentSlideHtml = latest;
    state.status = 'REVIEWING';
    mountSlide(elements.slideIframe, latest, state.theme, state.designConfig?.font_hints);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const draft = id ? state.draftSlides[id] : null;
  if (draft) {
    state.currentSlideHtml = draft;
    state.status = 'REVIEWING';
    mountSlide(elements.slideIframe, draft, state.theme, state.designConfig?.font_hints);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  const saved = id ? state.slides.find(s => s.id === id) : null;
  if (saved) {
    state.currentSlideHtml = saved.html;
    state.status = 'REVIEWING';
    mountSlide(elements.slideIframe, saved.html, state.theme, state.designConfig?.font_hints);
    renderOutline(navigateToSlide);
    updateUI();
    persistSessionViewState();
    return;
  }

  if (id && state.generatingSlides[id]) {
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
  
  const id = getSlideId(index);
  // If we are calling this directly (not via queue), and it's already generating, abort
  if (id && state.generatingSlides[id] === true && !force) return;
  if (force && activeSlideControllers.has(index)) {
    activeSlideControllers.get(index).abort();
  }



  if (state.mode === 'plan' && state.currentIndex === index) {
    state.mode = 'build';
    updateMode(state.sessionId, 'build').catch(() => {});
  }
  
  state.status = 'GENERATING';
  if (id) {
    state.generatingSlides[id] = true;
    delete state.promptApplyingSlides[id];
  }
  const runToken = sessionRunToken;
  const jobId = beginSlideJob(index);
  updateUI();
  refreshOutline();
  persistSessionViewState();

  const slideNum = index + 1;
  const slideTitle = state.outline[index]?.title ?? `Slide ${slideNum}`;

  if (index === state.currentIndex) {
    mountPlaceholder(elements.slideIframe, `Generating Slide ${slideNum}: ${slideTitle}...`);
    showLoadingBar();
  }

  let slideHtml = '';
  const controller = new AbortController();
  activeSlideControllers.set(index, controller);

  try {
    const stream = streamSlide(state.sessionId, id, 'generate', { force }, controller.signal);
    for await (const token of stream) {
      const t = token;
      slideHtml += t;
    }

    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (!slideHtml.trim()) throw new Error('Empty slide response from backend');

    if (index === state.currentIndex) {
      hideLoadingBar();
    }

    if (id) {
      state.draftSlides[id] = slideHtml;
      state.latestSlides[id] = slideHtml;
    }

    if (index === state.currentIndex && runToken === sessionRunToken) {
      state.currentSlideHtml = slideHtml;
      state.status = 'REVIEWING';
      // Render final clean version
      mountSlide(elements.slideIframe, slideHtml, state.theme, state.designConfig?.font_hints);
    }

    updateUI();
    refreshOutline();
    persistSessionViewState();

    // ── Vision audit (Goal 3) — runs after slide is shown, non-blocking ────
    _runVisionAuditInBackground(index, slideNum, slideHtml);

    if (id) delete state.generatingSlides[id];
    return slideHtml;

  } catch (error) {
    if (id) {
      state.generatingSlides[id] = 'ERROR';
      state.slideErrors[id] = error.message;
    }
    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) throw error;
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
      if (id) delete state.generatingSlides[id];
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

  const id = getSlideId(index);
  if (!id) return;

  // Versioning: discard results from a superseded audit run (race condition fix)
  const jobToken = ++auditJobCounter;
  latestAuditJobBySlide[id] = jobToken;
  const isLatestAuditJob = () => latestAuditJobBySlide[id] === jobToken;

  // Track that this slide is actively being audited
  state.auditingSlides[id] = jobToken;

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
    let snapshotB64 = null;
    try {
      snapshotB64 = await captureHtmlOffscreen(html, state.theme);
    } catch (captureErr) {
      console.warn('Offscreen capture failed, proceeding without screenshot:', captureErr);
    }

    const result = await takeSnapshot(state.sessionId, id, html, snapshotB64, id);

    // Discard if a newer audit for this slide has already started
    if (!isLatestAuditJob()) return;

    const audit = result?.audit;
    const verdict = audit?.verdict || 'good';
    const issues = audit?.visual_issues || [];
    const refinePrompt = result?.refine_prompt || null;

    // Store the audit result in the dedicated map
    state.slideAudits[id] = audit || { verdict: 'audit_failed', visual_issues: ['Audit engine error'] };

    // Persist the current HTML as final (no auto-fix replacement)
    state.slides = state.slides.filter(s => s.id !== id);
    state.slides.push({
      id: id,
      index: index,
      html: html,
      audit: state.slideAudits[id],
      approved: true,
      status: 'ready'
    });
    state.latestSlides[id] = html;
    delete state.draftSlides[id];
    
    persistSessionViewState();

    // Update the indicator for the currently visible slide
    if (isCurrent()) {
      _applyAuditToIndicator(verdict, false, false, issues, refinePrompt);
    }

  } catch (err) {
    if (!isLatestAuditJob()) return;
    console.warn('Vision audit failed (non-fatal):', err);
    state.slideAudits[id] = { verdict: 'audit_failed', visual_issues: [err.message] };
    if (isCurrent()) {
      _applyAuditToIndicator('audit_failed', false, false, [err.message]);
    }
  } finally {
    if (isLatestAuditJob()) {
      delete state.auditingSlides[id];
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
  // 1. Scan HTML for any font-family declarations to ensure they are loaded
  const fontMatches = html.match(/font-family:\s*['"]?([^'";,)]+)['"]?/g) || [];
  const scannedFonts = fontMatches.map(m => {
    return m.replace(/font-family:\s*['"]?/, '').replace(/['"]?$/, '').trim();
  }).filter(f => f && !['serif', 'sans-serif', 'monospace', 'inherit', 'initial'].includes(f.toLowerCase()));

  const designFonts = state.designConfig?.font_hints || [];
  const allFonts = [...new Set([...designFonts, ...scannedFonts])];

  // Prime the parent document's cache with these fonts so html2canvas can find them
  ensureFontsInDocument(document, allFonts);

  // Use the same robust document builder as the live preview
  const fullHtml = buildBaseDocument(html, theme, allFonts);

  const offscreen = document.createElement('iframe');
  offscreen.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1280px;height:720px;border:none;pointer-events:none;visibility:hidden;';
  offscreen.setAttribute('aria-hidden', 'true');
  document.body.appendChild(offscreen);

  try {
    offscreen.contentDocument.open();
    offscreen.contentDocument.write(fullHtml);
    offscreen.contentDocument.close();

    // 1. Wait for __VAPOR_READY__ signal (Prism + Initial Layout)
    let attempts = 0;
    while ((!offscreen.contentWindow || !offscreen.contentWindow.__VAPOR_READY__) && attempts < 50) {
      await new Promise(r => setTimeout(r, 100));
      attempts++;
    }

    // 2. Ensure all stylesheets are loaded
    const links = Array.from(offscreen.contentDocument.querySelectorAll('link[rel="stylesheet"]'));
    await Promise.all(links.map(link => {
      if (link.sheet) return Promise.resolve();
      return new Promise(r => {
        link.onload = link.onerror = r;
      });
    }));

    // 3. Ensure all fonts are ready
    if (offscreen.contentWindow.document.fonts) {
      try {
        await offscreen.contentWindow.document.fonts.ready;
      } catch (e) {
        console.warn('Font loading wait failed:', e);
      }
    }

    // 4. Ensure all images are loaded
    const images = Array.from(offscreen.contentDocument.images);
    await Promise.all(images.map(img => {
      if (img.complete) return Promise.resolve();
      return new Promise(r => {
        img.onload = img.onerror = r;
      });
    }));

    // 5. Force audit mode for the capture
    offscreen.contentDocument.body.classList.add('audit-mode');

    // 6. Text Guard: Ensure the document actually has text before capturing
    // This prevents capturing a 'blank' slide if the DOM hasn't fully hydrated.
    let textWaitAttempts = 0;
    while (offscreen.contentDocument.body.innerText.trim().length < 10 && textWaitAttempts < 10) {
      await new Promise(r => setTimeout(r, 200));
      textWaitAttempts++;
    }

    // 7. Force Layout Reflow & Paint
    offscreen.contentDocument.body.getBoundingClientRect(); // Trigger reflow
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); // Wait for double-paint

    // 8. Stability buffer for layout engine and animations to fully settle
    await new Promise(r => setTimeout(r, 3000));

    const canvas = await html2canvas(offscreen.contentDocument.body, {
      scale: 1,
      width: 1280,
      height: 720,
      windowWidth: 1280,
      windowHeight: 720,
      scrollX: 0,
      scrollY: 0,
      logging: false,
      useCORS: true,
      backgroundColor: '#000000',
      onclone: (clonedDoc) => {
        const body = clonedDoc.body;
        body.style.cssText = 'width:1280px;height:720px;overflow:hidden;margin:0;padding:0;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;';
        
        // Use the cloned document's window for style computation
        const win = clonedDoc.defaultView || window;

        clonedDoc.querySelectorAll('*').forEach(el => {
          const style = win.getComputedStyle(el);
          
          // 1. Visibility Recovery: Force elements that are COMPLETELY hidden to be visible.
          // This catches AI-driven animations that start at opacity: 0 but haven't finished.
          // We leave low-opacity elements (like 0.15 for background stars) alone to avoid over-exposure.
          if (style.opacity === '0') {
            el.style.setProperty('opacity', '1', 'important');
            el.style.setProperty('visibility', 'visible', 'important');
            el.style.setProperty('transform', 'none', 'important');
          }

          // 2. Fix Gradient Text (background-clip: text)
          if (style.webkitBackgroundClip === 'text' || style.backgroundClip === 'text') {
            // Try to extract the first color from the gradient to use as a flat fallback
            const colorMatch = style.background.match(/#(?:[0-9a-fA-F]{3}){1,2}|rgba?\([^\)]+\)/);
            const fallbackColor = colorMatch ? colorMatch[0] : 'var(--accent)';

            el.style.setProperty('background', 'none', 'important');
            el.style.setProperty('-webkit-background-clip', 'initial', 'important');
            el.style.setProperty('background-clip', 'initial', 'important');
            
            if (style.color === 'transparent' || style.color === 'rgba(0, 0, 0, 0)') {
              el.style.setProperty('color', fallbackColor, 'important');
            }
          }

          // 3. Fix Over-exposure (Shadows)
          if (el.style) {
            el.style.textShadow = 'none';
            el.style.boxShadow = 'none';
            el.style.webkitTextStroke = '0px';
          }
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

// ── Slide Approval removed in favor of live flow ──────────────────────────────────

// ── Slide Refinement ──────────────────────────────────────────────────────────
async function startRefinement(mode, instruction = '') {
  const id = getSlideId(state.currentIndex);
  const currentHtml = id ? (state.draftSlides[id] || state.currentSlideHtml) : state.currentSlideHtml;
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
      id,
      'refine',
      {
        refineMode: mode,
        currentHtml,
        instruction: instructionText,
      },
      activeRefineController.signal
    );
    for await (const token of stream) {
      const t = token;
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

function handleRefineImagesSelected(files) {
  pendingRefineImages = files;
  renderImageThumbs(files, elements.refineImageThumbs);
}


function regenerateCurrentSlide() {
  startSlideGeneration(state.currentIndex, true);
}

async function customRegenerateWithPrompt() {
  const instruction = elements.refineInstructionInput?.value?.trim();
  const id = getSlideId(state.currentIndex);
  const currentHtml = id ? (state.draftSlides[id] || state.currentSlideHtml) : state.currentSlideHtml;
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

  state.slides = state.slides.filter(s => id ? s.id !== id : s.index !== index);
  state.status = 'GENERATING';
  if (id) {
    state.generatingSlides[id] = true;
    state.promptApplyingSlides[id] = true;
  }
  refreshOutline();
  updateUI();
  persistSessionViewState();
  mountPlaceholder(elements.slideIframe, `Applying prompt to Slide ${slideNum}...`);
  if (index === state.currentIndex) showLoadingBar();

  let regenerated = '';
  activeRefineController = new AbortController();
  try {
    const stream = streamSlide(state.sessionId, id, 'refine', {
      refineMode: 'expand',
      currentHtml,
      instruction,
    }, activeRefineController.signal);

    for await (const token of stream) {
      const t = token;
      regenerated += t;
    }

    if (runToken !== sessionRunToken || !isLatestSlideJob(index, jobId)) return;
    if (!regenerated.trim()) throw new Error('Empty regenerated slide');

    if (id) {
      state.draftSlides[id] = regenerated;
      state.latestSlides[id] = regenerated;
      delete state.promptApplyingSlides[id];
    }
    if (state.currentIndex === index) {
      hideLoadingBar();
      state.currentSlideHtml = regenerated;
      state.status = 'REVIEWING';
      mountSlide(elements.slideIframe, regenerated, state.theme, state.designConfig?.font_hints);
    }
    
    // Auto-finalize and persist the refinement
    _runVisionAuditInBackground(index, slideNum, regenerated);
  } catch (error) {
    if (!isLatestSlideJob(index, jobId)) return;
    if (error?.name !== 'AbortError') {
      console.error('Custom regeneration failed:', error);
      state.status = 'ERROR';
      if (id) delete state.promptApplyingSlides[id];
      if (state.currentIndex === index) {
        mountPlaceholder(elements.slideIframe, `Custom regenerate failed: ${error.message}`);
      }
    } else {
      if (id) delete state.promptApplyingSlides[id];
    }
  } finally {
    if (!isLatestSlideJob(index, jobId)) return;
    activeRefineController = null;
    if (id) delete state.generatingSlides[id];
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
async function handleExport() {
  if (!state.sessionId) return;
  const count = getExportableSlideCount();
  if (count === 0) {
    alert('No slides to export yet. Generate at least one slide first.');
    return;
  }
  try {
    elements.exportBtn.textContent = 'Preparing...';
    elements.exportBtn.disabled = true;
    // Use new export module (window.print() based)
    exportDeckAsPDF();
  } catch (error) {
    console.error('Export failed:', error);
  } finally {
    setTimeout(() => {
      elements.exportBtn.textContent = 'Export PDF';
      elements.exportBtn.disabled = false;
    }, 1000);
  }
}

// ── Manual Re-audit ──────────────────────────────────────────────────────────
export function manualAudit() {
  _runVisionAuditInBackground(state.currentIndex, state.currentIndex + 1, state.currentSlideHtml);
}

// ── Slideshow ──────────────────────────────────────────────────────────────────
function initSlideshow() {
  const overlay   = document.getElementById('slideshow-overlay');
  const iframe    = document.getElementById('slideshow-iframe');
  const counter   = document.getElementById('slideshow-counter');
  const dots      = document.getElementById('slideshow-dots');
  const closeBtn  = document.getElementById('slideshow-close');
  const prevBtn   = document.getElementById('slideshow-prev');
  const nextBtn   = document.getElementById('slideshow-next');
  if (!overlay || !iframe) return;

  let currentIdx = 0;
  let keyHandler = null;

  const PLACEHOLDER_HTML = (title) => `
    <html><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
      <div style="text-align:center;color:#444;">
        <div style="font-size:2rem;margin-bottom:12px;">⏳</div>
        <div style="font-size:1rem;color:#555;">${title || 'Not generated yet'}</div>
      </div>
    </body></html>`;

  function renderDots() {
    dots.innerHTML = '';
    state.outline.forEach((_, i) => {
      const dot = document.createElement('div');
      const id = getSlideId(i);
      const isBuilt = id ? !!state.latestSlides[id] : false;
      dot.style.cssText = `width:7px;height:7px;border-radius:50%;cursor:pointer;transition:all 0.15s;background:${
        i === currentIdx ? '#fff' : isBuilt ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.1)'
      };transform:${i === currentIdx ? 'scale(1.3)' : 'scale(1)'};`;
      dot.addEventListener('click', () => goTo(i));
      dots.appendChild(dot);
    });
  }

  function updateScale() {
    if (overlay.style.display === 'none') return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const scale = Math.min(vw / 1280, vh / 720) * 0.95; // 0.95 for a slight margin
    const frame = document.getElementById('slideshow-frame');
    if (frame) {
      frame.style.transform = `scale(${scale})`;
    }
  }

  function goTo(idx) {
    const total = state.outline.length;
    if (!total) return;
    currentIdx = (idx + total) % total;
    const id = getSlideId(currentIdx);
    const rawHtml = id ? state.latestSlides[id] : null;
    const fonts = state.designConfig?.font_hints || [];
    if (rawHtml) {
      iframe.srcdoc = buildBaseDocument(rawHtml, state.theme || 'dark-tech', fonts);
    } else {
      iframe.srcdoc = PLACEHOLDER_HTML(state.outline[currentIdx]?.title);
    }
    counter.textContent = `${currentIdx + 1} / ${total}`;
    renderDots();
    updateScale();
  }

  function open() {
    if (!state.outline.length) return;
    currentIdx = state.currentIndex || 0;
    overlay.style.display = 'flex';
    goTo(currentIdx);
    window.addEventListener('resize', updateScale);

    keyHandler = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') goTo(currentIdx + 1);
      if (e.key === 'ArrowLeft'  || e.key === 'ArrowUp')   goTo(currentIdx - 1);
    };
    window.addEventListener('keydown', keyHandler);
  }

  function close() {
    overlay.style.display = 'none';
    iframe.srcdoc = '';
    window.removeEventListener('resize', updateScale);
    if (keyHandler) window.removeEventListener('keydown', keyHandler);
    keyHandler = null;
  }

  closeBtn?.addEventListener('click', close);
  prevBtn?.addEventListener('click', () => goTo(currentIdx - 1));
  nextBtn?.addEventListener('click', () => goTo(currentIdx + 1));

  // Open via Deck Actions button
  window.addEventListener('global:present', open);

  // Open via F key (when slideshow is not already open)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') {
      // Don't intercept if user is typing in an input
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (overlay.style.display === 'none') open();
    }
  });
}

// ── Generation Queue ──────────────────────────────────────────────────────────
let generationQueue = [];
let activeGenerations = 0;
const MAX_CONCURRENT_GENERATIONS = 2;

async function processGenerationQueue() {
  if (activeGenerations >= MAX_CONCURRENT_GENERATIONS || generationQueue.length === 0) return;

  const { index, force } = generationQueue.shift();
  activeGenerations++;
  
  try {
    await startSlideGeneration(index, force);
  } catch (err) {
    console.error(`Generation failed for slide ${index + 1}:`, err);
  } finally {
    activeGenerations--;
    processGenerationQueue(); // Try to start the next one
  }
}

function addToGenerationQueue(index, force = false) {
  const id = getSlideId(index);
  if (!id) return;
  
  // Don't queue if already generating or built (unless forced)
  const isBuilt = !!state.latestSlides[id] || state.slides.some(s => s.id === id);
  if (isBuilt && !force) return;
  if (state.generatingSlides[id]) return;

  state.generatingSlides[id] = 'QUEUED';
  generationQueue.push({ index, force });
  
  updateUI();
  refreshOutline();
  
  processGenerationQueue();
}

init();
initSlideshow();
// Window event for updating slide title directly from sidebar
window.addEventListener('update-slide-title', async (e) => {
  const { index, title } = e.detail;
  if (!state.outline[index]) return;
  
  const id = getSlideId(index);
  const oldTitle = state.outline[index].title;
  state.outline[index].title = title;
  
  try {
    if (id) {
      await updateSlideTitle(state.sessionId, id, title);
      showAuditToast(`Slide ${index + 1} renamed to: ${title}`, 'info');
    }
  } catch (err) {
    console.error('Failed to update title:', err);
    state.outline[index].title = oldTitle; // rollback
    refreshOutline();
  }
});
