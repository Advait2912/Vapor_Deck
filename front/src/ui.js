/**
 * UI Management and Rendering
 */
import { state } from './state.js';

// DOM Elements
export const elements = {
  statusText: document.getElementById('status-text'),
  slideProgress: document.getElementById('slide-progress'),
  outlineList: document.getElementById('outline-list'),
  slideIframe: document.getElementById('slide-iframe'),
  themeSelect: document.getElementById('theme-select'),
  modelSelect: document.getElementById('model-select'),
  customRegenBtn: document.getElementById('custom-regen-btn'),
  stopBtn: document.getElementById('stop-btn'),
  regenBtn: document.getElementById('regen-btn'),
  generateBtn: document.getElementById('generate-btn'),
  promptInput: document.getElementById('prompt-input'),
  promptContainer: document.getElementById('prompt-container'),
  slideControls: document.getElementById('slide-controls'),
  confirmOutlineBtn: document.getElementById('confirm-outline-btn'),
  comparisonOverlay: document.getElementById('comparison-overlay'),
  iframeBefore: document.getElementById('iframe-before'),
  iframeAfter: document.getElementById('iframe-after'),
  closeComparison: document.getElementById('close-comparison'),
  keepCurrentBtn: document.getElementById('keep-before-btn'),
  useRefinedBtn: document.getElementById('use-after-btn'),
  exportBtn: document.getElementById('export-btn'),
  visionIndicator: document.getElementById('vision-indicator'),
  visionBadge: document.querySelector('#vision-indicator .vision-badge'),
  projectPathDisplay: document.getElementById('project-path-display'),
  refinePanel: document.getElementById('refine-panel'),
  refineInstructionInput: document.getElementById('refine-instruction-input'),
  refineImageInput: document.getElementById('refine-image-input'),
  refineImageThumbs: document.getElementById('refine-image-thumbs'),
  refineButtons: [],
  newDeckBtn: document.getElementById('new-deck-btn'),
  infoSidebar: document.getElementById('info-sidebar'),
  infoList: document.getElementById('info-list'),
  planInteraction: document.getElementById('plan-interaction'),
  chatHistory: document.getElementById('chat-history'),
  buildInteraction: document.getElementById('build-interaction'),
  // Mode pill buttons
  modePillPlan: document.getElementById('interaction-mode-plan'),
  modePillBuild: document.getElementById('interaction-mode-build'),
  modePillDesign: document.getElementById('interaction-mode-design'),
  // Design Mode Chat
  designInteraction: document.getElementById('design-interaction'),
  designChatHistory: document.getElementById('design-chat-history'),
  designPromptInput: document.getElementById('design-prompt-input'),
  designGenerateBtn: document.getElementById('design-generate-btn'),
};

/**
 * Update the global UI status and progress
 */
export function updateUI() {
  const status = state.status.toUpperCase();
  elements.statusText.textContent = status;
  elements.slideProgress.textContent = (state.outline && state.outline.length)
    ? `Slide ${state.currentIndex + 1} / ${state.outline.length}`
    : 'Slide 0 / 0';
  
  const dot = document.querySelector('.status-dot');
  if (!dot) return;

  const busyStatuses = ['GENERATING', 'OUTLINING', 'SYNTHESIZING', 'INITIALIZING', 'CONFIRMING'];
  if (busyStatuses.includes(status)) {
    dot.style.background = '#fbbf24';
    dot.style.boxShadow = '0 0 8px #fbbf24';
  } else if (status === 'IDLE') {
    dot.style.background = '#3b82f6';
    dot.style.boxShadow = '0 0 8px #3b82f6';
  } else {
    dot.style.background = '#10b981';
    dot.style.boxShadow = '0 0 8px #10b981';
  }

  // ── Mode-based visibility ──────────────────────────────────────────────────
  const isPlan = state.mode === 'plan';
  const isDesign = state.mode === 'design';
  const isBuild = state.mode === 'build';

  if (elements.planInteraction) elements.planInteraction.style.display = isPlan ? 'flex' : 'none';
  if (elements.designInteraction) elements.designInteraction.style.display = isDesign ? 'flex' : 'none';
  if (elements.buildInteraction) elements.buildInteraction.style.display = isBuild ? 'flex' : 'none';

  // Update mode pill active state
  if (elements.modePillPlan && elements.modePillBuild && elements.modePillDesign) {
    elements.modePillPlan.classList.toggle('active', isPlan);
    elements.modePillDesign.classList.toggle('active', isDesign);
    elements.modePillBuild.classList.toggle('active', isBuild);
  }

  // Status-based visibility
  const inSlidePhase = ['GENERATING', 'REVIEWING', 'APPROVING', 'DONE'].includes(status);

  // Always show the Detail/Overview toggle whenever an outline exists
  const toggle = document.getElementById('info-view-toggle');
  if (toggle) toggle.style.display = state.outline.length ? 'flex' : 'none';

  if (inSlidePhase) {
    elements.refinePanel.style.display = 'block';
    if (state.outline.length > 0) {
      // Delegate to refreshInfoPanel so the Detail/Overview toggle is respected
      if (typeof window.refreshInfoPanel === 'function') {
        window.refreshInfoPanel();
      } else {
        renderSlideInfo(state.currentIndex);
      }
    }
  } else {
    elements.refinePanel.style.display = 'none';
    if (status === 'IDLE') {
      elements.infoList.innerHTML = '<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">Select a slide or generate an outline to see details.</div>';
    }
  }

  // Generate Button label in Plan Mode
  if (isPlan) {
    elements.promptInput.disabled = false;
    if (status === 'IDLE') {
      elements.generateBtn.textContent = 'Generate Outline';
      elements.generateBtn.disabled = false;
    } else if (status === 'REVIEWING_OUTLINE' || status === 'GENERATING' || status === 'DONE' || status === 'REVIEWING') {
      elements.generateBtn.textContent = 'Send Message';
      elements.generateBtn.disabled = false;
    } else if (['SYNTHESIZING', 'OUTLINING', 'PLANNING'].includes(status)) {
      elements.generateBtn.textContent = 'Working...';
      elements.generateBtn.disabled = true;
      elements.promptInput.disabled = true;
    }
  }

  // Handle Confirm Outline visibility
  if (status === 'REVIEWING_OUTLINE') {
    elements.confirmOutlineBtn.style.display = 'block';
  } else {
    elements.confirmOutlineBtn.style.display = 'none';
  }

  // Refresh Vision Indicator for current slide
  refreshVisionIndicator();
}

function getSlideId(index) {
  return state.outline[index]?.id;
}

function refreshVisionIndicator() {
  const index = state.currentIndex;
  const id = getSlideId(index);
  const isAuditing = id ? !!state.auditingSlides?.[id] : false;
  const audit = id ? state.slideAudits?.[id] : null;

  // Default state: slide exists but has no audit result yet
  elements.visionIndicator.style.display = 'flex';
  elements.visionIndicator.className = 'vision-indicator';
  elements.visionBadge.textContent = 'NOT AUDITED';
  elements.visionIndicator.title = 'Slide has not been visually audited yet. Click to audit.';

  // Show "ANALYZING..." only when a real audit request is in flight
  if (isAuditing) {
    elements.visionIndicator.className = 'vision-indicator analyzing';
    elements.visionBadge.textContent = 'ANALYZING...';
    elements.visionIndicator.title = 'Vision model is auditing layout...';
    return;
  }

  // No audit result stored yet — leave at "NOT AUDITED"
  if (!audit) return;

  const verdict = audit.verdict || 'unknown';
  const issues = audit.visual_issues || [];
  const issueTitle = issues.length ? `Issues:\n• ${issues.join('\n• ')}` : '';

  switch (verdict) {
    case 'good':
      elements.visionIndicator.className = 'vision-indicator good';
      elements.visionBadge.textContent = 'LAYOUT OK';
      elements.visionIndicator.title = 'Visual layout: stable and readable.';
      break;
    case 'fixable':
      elements.visionIndicator.className = 'vision-indicator fixable';
      elements.visionBadge.textContent = 'MINOR ISSUES';
      elements.visionIndicator.title = issueTitle || 'Minor layout issues detected.';
      break;
    case 'regenerate':
      elements.visionIndicator.className = 'vision-indicator regenerate';
      elements.visionBadge.textContent = 'ISSUES FOUND';
      elements.visionIndicator.title = issueTitle || 'Significant layout issues detected.';
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
 * Render a chat message in the plan interaction history
 */
export function renderChatMessage(role, text, target = elements.chatHistory) {
  if (!target) return;
  
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role === 'user' ? 'user-msg' : 'ai-msg'} fade-in`;
  
  const roleSpan = document.createElement('div');
  roleSpan.className = 'msg-role';
  roleSpan.textContent = role === 'user' ? 'You' : 'VaporDeck';
  
  const textDiv = document.createElement('div');
  textDiv.textContent = text;
  
  msgDiv.appendChild(roleSpan);
  msgDiv.appendChild(textDiv);
  target.appendChild(msgDiv);
  
  target.scrollTop = target.scrollHeight;
}

/**
 * Render the slide outline in the sidebar.
 * @param {Function|null} onItemClick  - called with index when a slide row is clicked
 * @param {Function|null} onReorder    - called with (fromIndex, toIndex) on drag-drop
 * @param {boolean}       isReorderMode - when true, adds drag handles + drag events
 */
export function renderOutline(onItemClick = null, onReorder = null, isReorderMode = false) {
  if (!state.outline || !state.outline.length) {
    elements.outlineList.innerHTML = `<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">No outline generated yet. Submit a topic to begin.</div>`;
    return;
  }
  elements.outlineList.innerHTML = state.outline.map((item, index) => {
    const isActive    = index === state.currentIndex;
    const isApproved  = state.slides.some(s => s.id === item.id);
    const isDraft     = !!state.draftSlides[item.id];
    const genStatus   = state.generatingSlides[item.id]; // true | 'QUEUED' | 'ERROR'
    const error       = state.slideErrors[item.id];
    
    let badge;
    if (index + 1 < 10) badge = `0${index + 1}`;
    else                 badge = `${index + 1}`;

    const bgColor   = isActive ? 'rgba(59,130,246,0.12)' : 'transparent';
    const textColor = isActive ? 'var(--text-main)' : 'var(--text-muted)';
    const numColor  = isActive ? 'var(--accent)' : isApproved ? '#10b981' : 'var(--text-muted)';
    const weight    = isActive ? '600' : '400';
    const cursor    = isReorderMode ? 'grab' : (isApproved || onItemClick) ? 'pointer' : 'default';

    const phasePill = ''; // Removed to keep UI cleaner

    let genBtnHtml = '';
    if (!isReorderMode) {
      if (isApproved) {
        genBtnHtml = `<button class="gen-slide-btn secondary" data-index="${index}" title="Regenerate Slide">↻</button>`;
      } else if (genStatus === true) {
        genBtnHtml = `<div class="loading-spinner-tiny"></div>`;
      } else if (genStatus === 'QUEUED') {
        genBtnHtml = `<span class="queued-badge" title="Waiting in queue...">🕒</span>`;
      } else if (genStatus === 'ERROR') {
        genBtnHtml = `<button class="gen-slide-btn error" data-index="${index}" title="Error: ${error || 'Unknown'}. Click to retry.">⚠</button>`;
      } else {
        genBtnHtml = `<button class="gen-slide-btn primary" data-index="${index}" title="Build Slide">✧</button>`;
      }
    }

    // Drag handle — only visible in reorder mode
    const dragHandle = isReorderMode
      ? `<span class="drag-handle" title="Drag to reorder">⠿</span>`
      : '';

    const hasContent = isApproved || isDraft;

    return `
      <div class="outline-item ${isActive ? 'active' : ''} ${isApproved ? 'approved' : ''} ${hasContent ? 'slide-built' : 'slide-plan'} ${isReorderMode ? 'reorder-mode' : ''}"
           data-index="${index}"
           ${isReorderMode ? 'draggable="true"' : ''}
           style="padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,0.03);
                  font-size: 0.85rem; cursor: ${cursor}; display: flex; align-items: center; gap: 10px;
                  background: ${bgColor}; transition: all 0.2s ease;
                  border-left: 2px solid ${hasContent ? 'rgba(59,130,246,0.4)' : 'rgba(139,92,246,0.3)'};">
        ${dragHandle}
        <span style="color: ${numColor}; font-family: var(--font-mono); min-width: 20px; font-size: 0.7rem; opacity: 0.8;">${badge}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="outline-item-title" 
               style="color: ${textColor}; font-weight: ${weight}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0.01em;">
            ${item.title}
          </div>
          <div style="margin-top: 2px;">${phasePill}</div>
        </div>
        <div class="outline-item-actions" style="display: flex; align-items: center; opacity: ${isActive ? '1' : '0.6'}; transition: opacity 0.2s; flex-shrink: 0;">
          ${genBtnHtml}
        </div>
      </div>
    `;
  }).join('');

  // Wire up click navigation
  elements.outlineList.querySelectorAll('.outline-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (isReorderMode) return; // clicks disabled in reorder mode
      if (e.target.closest('.gen-slide-btn')) return;
      const idx = parseInt(el.dataset.index);
      if (onItemClick) onItemClick(idx);
    });
  });

  // Wire up per-slide generation buttons
  elements.outlineList.querySelectorAll('.gen-slide-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      window.dispatchEvent(new CustomEvent('generate-slide', { detail: { index: idx } }));
    });
  });


  // ── Drag-and-Drop (reorder mode only) ────────────────────────────────────────
  if (!isReorderMode || !onReorder) return;

  let dragFromIndex = null;
  let dragOverIndex = null;

  const items = elements.outlineList.querySelectorAll('.outline-item[draggable]');
  items.forEach(el => {
    el.addEventListener('dragstart', (e) => {
      dragFromIndex = parseInt(el.dataset.index);
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Required for Firefox
      e.dataTransfer.setData('text/plain', dragFromIndex);
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      // Clean up all drop indicators
      elements.outlineList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(t => {
        t.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      dragFromIndex = null;
      dragOverIndex = null;
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const toIndex = parseInt(el.dataset.index);
      if (toIndex === dragFromIndex) return;

      // Determine if drop is in top or bottom half
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isTopHalf = e.clientY < midY;

      // Clear others
      elements.outlineList.querySelectorAll('.drag-over-top, .drag-over-bottom').forEach(t => {
        if (t !== el) {
          t.classList.remove('drag-over-top', 'drag-over-bottom');
        }
      });

      el.classList.remove('drag-over-top', 'drag-over-bottom');
      el.classList.add(isTopHalf ? 'drag-over-top' : 'drag-over-bottom');
      dragOverIndex = isTopHalf ? toIndex : toIndex + 1;
    });

    el.addEventListener('dragleave', (e) => {
      // Only clear if leaving to outside the outline list
      if (!el.contains(e.relatedTarget)) {
        el.classList.remove('drag-over-top', 'drag-over-bottom');
      }
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over-top', 'drag-over-bottom');

      const from = dragFromIndex;
      if (from === null || dragOverIndex === null) return;

      let to = dragOverIndex;
      // Adjust target index when moving down (because splice removes the element first)
      if (to > from) to -= 1;
      to = Math.max(0, Math.min(to, state.outline.length - 1));

      if (from !== to) {
        onReorder(from, to);
      }
    });
  });
}


/**
 * Render a placeholder in an iframe
 */
export function renderPlaceholder(text, targetIframe = elements.slideIframe) {
  const initialHtml = `
    <html>
      <head>
        <style>
          body { 
            background: #000; 
            color: #444; 
            display: flex; 
            align-items: center; 
            justify-content: center; 
            height: 100vh; 
            margin: 0;
            font-family: system-ui, -apple-system, sans-serif;
            text-transform: uppercase;
            letter-spacing: 0.2em;
            font-size: 0.8rem;
          }
          .placeholder { border: 1px dashed #222; padding: 40px; border-radius: 4px; }
        </style>
      </head>
      <body>
        <div class="placeholder">${text}</div>
      </body>
    </html>
  `;
  targetIframe.srcdoc = initialHtml;
}

/**
 * Render slide HTML into an iframe.
 */
export function renderSlide(html, targetIframe = elements.slideIframe) {
  targetIframe.srcdoc = `
<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="/themes/${state.theme}.css">
  <style>
    html, body {
      margin: 0; padding: 0;
      width: 100%; height: 100%;
      overflow: hidden;
      background: #000;
    }

  </style>
</head>
<body>
  <div id="slide-container" style="width: 100%; height: 100%;">
    ${html}
  </div>
  <script>
    setTimeout(() => {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
      window.parent.scaleIframe(); // Trigger parent scaler once layout stabilizes
    }, 80);
  </script>
</body>
</html>
  `;
}

export function renderSlideInfo(index) {
  const item = state.outline[index];
  if (!item) {
    elements.infoList.innerHTML = '<div style="padding: 20px; color: var(--text-muted);">No slide selected.</div>';
    return;
  }

  const id = item.id;
  const isApproved  = state.slides.some(s => s.id === id);
  const isDraft     = !!state.draftSlides[id];

  elements.infoList.innerHTML = `
    <div class="fade-in">
      <div style="font-size: 0.7rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px;">Slide ${index + 1}</div>
      <h3 style="margin: 0 0 16px 0; font-size: 1.1rem; color: #fff;">${item.title}</h3>
      
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <div style="padding: 12px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px;">
          <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Intent</div>
          <div style="font-size: 0.85rem; color: #60a5fa; font-weight: 500;">${item.intent}</div>
        </div>

        <div style="padding: 12px; background: var(--bg-input); border: 1px solid var(--border); border-radius: 4px;">
          <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Layout Hint</div>
          <div style="font-size: 0.85rem; color: #9ca3af;">${item.layout_hint}</div>
        </div>

        <div>
          <div style="font-size: 0.65rem; color: var(--text-muted); text-transform: uppercase; margin-bottom: 8px;">Key Points</div>
          <ul style="margin: 0; padding-left: 18px; color: #d1d5db; font-size: 0.85rem; line-height: 1.6;">
            ${(item.key_points || []).map(p => `<li style="margin-bottom: 6px;">${p}</li>`).join('')}
          </ul>
        </div>

        ${(isApproved || isDraft) ? `
        <div style="padding: 10px 12px; background: rgba(59,130,246,0.08); border: 1px solid rgba(59,130,246,0.2); border-radius: 4px; font-size: 0.75rem; color: #93c5fd;">
          ⚙ This slide has been built. Switch to Build mode to refine it.
        </div>` : `
        <div style="padding: 10px 12px; background: rgba(139,92,246,0.08); border: 1px solid rgba(139,92,246,0.2); border-radius: 4px; font-size: 0.75rem; color: #c4b5fd;">
          ✏ This slide is in the outline. Chat to refine the outline, or click ✧ to build it.
        </div>`}
      </div>
    </div>
  `;
}

export function renderOutlineContentSummary(target = null) {
  const rows = (state.outline || []).map((item, idx) => `
    <div style="padding: 12px; border-bottom: 1px solid #222; background: ${idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'}">
      <div style="font-weight: 600; color: #fff; font-size: 0.9rem;">${idx + 1}. ${item.title}</div>
      <div style="color:#60a5fa; margin-top:4px; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em;">${item.intent}</div>
      <ul style="margin: 8px 0 0 16px; padding: 0; color: #9ca3af; font-size: 0.8rem; list-style: circle;">
        ${(item.key_points || []).map(p => `<li style="margin-bottom: 4px;">${p}</li>`).join('')}
      </ul>
    </div>
  `).join('');

  const html = `
    <div class="fade-in">
      <div style="font-size: 0.7rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 12px;">Full Deck Outline</div>
      <div style="border: 1px solid var(--border); border-radius: 6px; background: #000; overflow: hidden;">
        ${rows}
      </div>
    </div>
  `;

  if (target) {
    target.innerHTML = html;
  } else {
    elements.slideIframe.srcdoc = `
      <html>
        <body style="margin:0; background:#090909; color:#e5e7eb; font-family: Inter, Arial, sans-serif;">
          <div style="max-width: 980px; margin: 0 auto; padding: 28px;">
            <h2 style="margin:0 0 6px; color:#60a5fa; text-transform:uppercase; letter-spacing:0.08em; font-size:0.8rem;">Phase 1: Content Plan Review</h2>
            <h1 style="margin:0 0 14px; font-size:1.3rem;">Approve this full content outline before slide design/generation</h1>
            <div style="padding: 14px; border:1px solid #1f2937; border-radius:8px; background:#111827;">${rows}</div>
          </div>
        </body>
      </html>
    `;
  }
}

export function renderImageThumbs(files, target) {
  if (!target) return;
  target.innerHTML = '';
  files.slice(0, 8).forEach(file => {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.title = file.name;
    img.src = URL.createObjectURL(file);
    target.appendChild(img);
  });
}

/**
 * Reset all UI elements to their fresh, initial state.
 */
export function clearUI() {
  elements.promptInput.value = '';
  if (elements.refineInstructionInput) elements.refineInstructionInput.value = '';
  if (elements.designPromptInput) elements.designPromptInput.value = '';
  elements.promptInput.disabled = false;
  if (elements.designPromptInput) elements.designPromptInput.disabled = false;
  
  if (elements.refineImageInput) elements.refineImageInput.value = '';
  elements.refineImageThumbs.innerHTML = '';
  
  if (elements.chatHistory) elements.chatHistory.innerHTML = '';
  if (elements.designChatHistory) elements.designChatHistory.innerHTML = '';
  elements.infoList.innerHTML = '<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">Select a slide or generate an outline to see details.</div>';
  
  elements.statusText.textContent = 'IDLE';
  elements.slideProgress.textContent = 'Slide 0 / 0';
  if (elements.visionIndicator) elements.visionIndicator.style.display = 'none';
  
  renderOutline();
  renderPlaceholder('Slide Preview Area');
  
  elements.generateBtn.disabled = false;
  elements.generateBtn.textContent = 'Generate Deck';
  elements.confirmOutlineBtn.style.display = 'none';
  
  elements.themeSelect.selectedIndex = 0;
  elements.modelSelect.selectedIndex = 0;
  
  elements.comparisonOverlay.style.display = 'none';
  
  updateUI();
}

/**
 * Externally scale the 1280x720 iframe to fit the preview container
 */
export function scaleIframe() {
  const container = document.getElementById('preview-container');
  const iframe = document.getElementById('slide-iframe');
  if (!container || !iframe) return;

  const padding = 40; // 20px padding on each side
  const availableW = container.clientWidth - padding;
  const availableH = container.clientHeight - padding;

  const scale = Math.min(availableW / 1280, availableH / 720);
  iframe.style.transform = `scale(${scale})`;
}

// Make globally accessible for the iframe script to call
window.scaleIframe = scaleIframe;

window.addEventListener('resize', scaleIframe);
// Initial scale
requestAnimationFrame(scaleIframe);