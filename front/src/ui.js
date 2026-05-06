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
  approveBtn: document.getElementById('approve-btn'),
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
  visionStatus: document.getElementById('vision-status'),
  projectPathDisplay: document.getElementById('project-path-display'),
  topicImageInput: document.getElementById('topic-image-input'),
  topicImageThumbs: document.getElementById('topic-image-thumbs'),
  refinePanel: document.getElementById('refine-panel'),
  refineInstructionInput: document.getElementById('refine-instruction-input'),
  refineImageInput: document.getElementById('refine-image-input'),
  refineImageThumbs: document.getElementById('refine-image-thumbs'),
  refineButtons: [], // Removed in favor of refined workflow
  newDeckBtn: document.getElementById('new-deck-btn'),
  infoSidebar: document.getElementById('info-sidebar'),
  infoList: document.getElementById('info-list'),
  planInteraction: document.getElementById('plan-interaction'),
  chatHistory: document.getElementById('chat-history'),
  buildInteraction: document.getElementById('build-interaction'),
  planModeBtn: document.getElementById('plan-mode-btn'),
  buildModeBtn: document.getElementById('build-mode-btn')
};

/**
 * Update the global UI status and progress
 */
export function updateUI() {
  const status = state.status.toUpperCase();
  elements.statusText.textContent = status;
  elements.slideProgress.textContent = state.outline.length
    ? `Slide ${state.currentIndex + 1} / ${state.outline.length}`
    : 'Slide 0 / 0';
  
  const dot = document.querySelector('.status-dot');
  if (!dot) return;

  const busyStatuses = ['GENERATING', 'OUTLINING', 'SYNTHESIZING', 'INITIALIZING', 'CONFIRMING', 'APPROVING'];
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

  // ── Mode-aware Layout ──────────────────────────────────────────────────────
  const isPlan = state.mode === 'plan';
  elements.planInteraction.style.display = isPlan ? 'flex' : 'none';
  elements.buildInteraction.style.display = isPlan ? 'none' : 'flex';

  if (elements.planModeBtn) elements.planModeBtn.classList.toggle('active', isPlan);
  if (elements.buildModeBtn) elements.buildModeBtn.classList.toggle('active', !isPlan);

  // Status-based visibility
  const inSlidePhase = ['GENERATING', 'REVIEWING', 'APPROVING', 'DONE'].includes(status);
  
  if (inSlidePhase) {
    elements.refinePanel.style.display = 'block';
    if (state.outline.length > 0) {
      renderSlideInfo(state.currentIndex);
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
      elements.generateBtn.textContent = 'Generate Deck';
      elements.generateBtn.disabled = false;
    } else if (status === 'REVIEWING_OUTLINE' || status === 'GENERATING' || status === 'DONE' || status === 'REVIEWING') {
      elements.generateBtn.textContent = 'Send Message';
      elements.generateBtn.disabled = false;
    } else if (['SYNTHESIZING', 'OUTLINING'].includes(status)) {
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
}

/**
 * Render a chat message in the plan interaction history
 */
export function renderChatMessage(role, text) {
  if (!elements.chatHistory) return;
  
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role === 'user' ? 'user-msg' : 'ai-msg'} fade-in`;
  
  const roleSpan = document.createElement('div');
  roleSpan.className = 'msg-role';
  roleSpan.textContent = role === 'user' ? 'You' : 'VaporDeck';
  
  const textDiv = document.createElement('div');
  textDiv.textContent = text;
  
  msgDiv.appendChild(roleSpan);
  msgDiv.appendChild(textDiv);
  elements.chatHistory.appendChild(msgDiv);
  
  // Scroll to bottom
  elements.chatHistory.scrollTop = elements.chatHistory.scrollHeight;
}

/**
 * Render the slide outline in the sidebar.
 * Always attaches click handlers — approved slides navigate to their saved HTML,
 * unapproved future slides are navigable only if a callback is provided.
 */
export function renderOutline(onItemClick = null) {
  if (!state.outline.length) {
    elements.outlineList.innerHTML = `<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">No outline generated yet. Submit a topic to begin.</div>`;
    return;
  }
  elements.outlineList.innerHTML = state.outline.map((item, index) => {
    const isActive = index === state.currentIndex;
    const isApproved = state.slides.some(s => s.index === index);
    const isDraft = !!state.draftSlides[index];
    const isGenerating = !!state.generatingSlides[index];
    const isPast = index < state.currentIndex && !isApproved;

    let badge;
    if (isApproved)      badge = '✓';
    else if (index + 1 < 10) badge = `0${index + 1}`;
    else                 badge = `${index + 1}`;

    const bgColor   = isActive ? 'rgba(59,130,246,0.12)' : 'transparent';
    const textColor = isActive ? 'var(--text-main)' : 'var(--text-muted)';
    const numColor  = isActive ? 'var(--accent)' : isApproved ? '#10b981' : 'var(--text-muted)';
    const weight    = isActive ? '600' : '400';
    const cursor    = (isApproved || onItemClick) ? 'pointer' : 'default';

    const genBtnHtml = isApproved 
      ? `<button class="gen-slide-btn secondary" data-index="${index}" title="Regenerate Slide">↻</button>`
      : isGenerating 
        ? `<div class="loading-spinner-tiny"></div>`
        : `<button class="gen-slide-btn primary" data-index="${index}" title="Build Slide">✧</button>`;

    return `
      <div class="outline-item ${isActive ? 'active' : ''} ${isApproved ? 'approved' : ''}"
           data-index="${index}"
           style="padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.03); 
                  font-size: 0.85rem; cursor: ${cursor}; display: flex; align-items: center; gap: 12px;
                  background: ${bgColor}; transition: all 0.2s ease;">
        <span style="color: ${numColor}; font-family: var(--font-mono); min-width: 20px; font-size: 0.7rem; opacity: 0.8;">${badge}</span>
        <div style="flex: 1; color: ${textColor}; font-weight: ${weight}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; letter-spacing: 0.01em;">${item.title}</div>
        <div class="outline-item-actions" style="display: flex; align-items: center; opacity: ${isActive ? '1' : '0.6'}; transition: opacity 0.2s;">
          ${genBtnHtml}
        </div>
      </div>
    `;
  }).join('');

  // Wire up clicks
  elements.outlineList.querySelectorAll('.outline-item').forEach(el => {
    el.addEventListener('click', (e) => {
      // Don't navigate if clicking the generate button
      if (e.target.closest('.gen-slide-btn')) return;
      
      const idx = parseInt(el.dataset.index);
      if (onItemClick) {
        onItemClick(idx);
      }
    });
  });

  // Wire up per-slide generation buttons
  elements.outlineList.querySelectorAll('.gen-slide-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.index);
      // Trigger a global event or callback
      window.dispatchEvent(new CustomEvent('generate-slide', { detail: { index: idx } }));
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
 * Injects a scale-to-fit script so fixed-size slides (e.g. 1280×720)
 * always fill the viewport without scrollbars.
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
    #slide-scaler {
      transform-origin: top left;
      /* scale applied by JS below */
    }
  </style>
</head>
<body>
  <div id="slide-scaler">${html}</div>
  <script>
    function fitSlide() {
      const scaler = document.getElementById('slide-scaler');
      if (!scaler) return;
      const slide = scaler.firstElementChild;
      if (!slide) return;
      // Use the slide's natural rendered size (or declared CSS size)
      const naturalW = slide.scrollWidth  || slide.offsetWidth  || 1280;
      const naturalH = slide.scrollHeight || slide.offsetHeight || 720;
      const scaleX = window.innerWidth  / naturalW;
      const scaleY = window.innerHeight / naturalH;
      const scale  = Math.min(scaleX, scaleY);
      scaler.style.transform = 'scale(' + scale + ')';
      // Centre the scaled content
      const scaledW = naturalW * scale;
      const scaledH = naturalH * scale;
      scaler.style.marginLeft = ((window.innerWidth  - scaledW) / 2) + 'px';
      scaler.style.marginTop  = ((window.innerHeight - scaledH) / 2) + 'px';
    }
    // Run after layout and on resize
    window.addEventListener('load', fitSlide);
    window.addEventListener('resize', fitSlide);
    // Also run immediately in case load already fired
    if (document.readyState === 'complete') fitSlide();
    // Trigger reveal animations
    setTimeout(() => {
      document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
      fitSlide();
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

  elements.infoList.innerHTML = `
    <div class="fade-in">
      <div style="font-size: 0.7rem; color: var(--accent); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px;">Slide ${index + 1} Metadata</div>
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
      </div>
    </div>
  `;
}

export function renderOutlineContentSummary(target = null) {
  const rows = state.outline.map((item, idx) => `
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
  // 1. Text Inputs
  elements.promptInput.value = '';
  elements.refineInstructionInput.value = '';
  elements.promptInput.disabled = false;
  
  // 2. File Inputs & Thumbs
  if (elements.topicImageInput) elements.topicImageInput.value = '';
  if (elements.refineImageInput) elements.refineImageInput.value = '';
  elements.topicImageThumbs.innerHTML = '';
  elements.refineImageThumbs.innerHTML = '';
  
  // 3. Chat & Info
  if (elements.chatHistory) elements.chatHistory.innerHTML = '';
  elements.infoList.innerHTML = '<div style="padding: 20px; color: var(--text-muted); font-size: 0.85rem;">Select a slide or generate an outline to see details.</div>';
  
  // 4. Progress & Status
  elements.statusText.textContent = 'IDLE';
  elements.slideProgress.textContent = 'Slide 0 / 0';
  elements.visionStatus.style.display = 'none';
  
  // 5. Sidebar Outline
  renderOutline(); // This will show the "No outline" placeholder via state.outline check
  
  // 6. Preview Iframe
  renderPlaceholder('Slide Preview Area');
  
  // 7. Reset Buttons
  elements.generateBtn.disabled = false;
  elements.generateBtn.textContent = 'Generate Deck';
  elements.confirmOutlineBtn.style.display = 'none';
  
  // 8. Selects (Optional: reset to first option)
  elements.themeSelect.selectedIndex = 0;
  elements.modelSelect.selectedIndex = 0;
  
  // 9. Comparison Overlay
  elements.comparisonOverlay.style.display = 'none';
  
  updateUI();
}
