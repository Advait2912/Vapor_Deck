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
  refineButtons: [
    document.getElementById('refine-simplify'),
    document.getElementById('refine-expand'),
    document.getElementById('refine-example'),
    document.getElementById('refine-interactive')
  ],
  newDeckBtn: document.getElementById('new-deck-btn')
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

  // ── Generate Button: context-aware label + state ──────────────────────────
  const btn = elements.generateBtn;
  const newDeckBtn = elements.newDeckBtn;

  if (status === 'IDLE') {
    btn.textContent = 'Generate Deck';
    btn.disabled = false;
    if (newDeckBtn) newDeckBtn.style.display = 'none';
  } else if (status === 'REVIEWING_OUTLINE') {
    btn.textContent = 'Start Generation →';
    btn.disabled = false; // clickable to trigger confirm
    elements.confirmOutlineBtn.style.display = 'block';
    if (newDeckBtn) newDeckBtn.style.display = 'block';
  } else if (status === 'SYNTHESIZING' || status === 'OUTLINING' || status === 'INITIALIZING') {
    btn.textContent = 'Working...';
    btn.disabled = true;
    if (newDeckBtn) newDeckBtn.style.display = 'none';
  } else if (status === 'GENERATING') {
    btn.textContent = 'Generating Slides...';
    btn.disabled = true;
    if (newDeckBtn) newDeckBtn.style.display = 'block';
  } else if (status === 'REVIEWING') {
    btn.textContent = 'Approve or Refine Slide';
    btn.disabled = true;
    if (newDeckBtn) newDeckBtn.style.display = 'block';
  } else if (status === 'DONE') {
    btn.textContent = 'Deck Complete ✓';
    btn.disabled = true;
    if (newDeckBtn) newDeckBtn.style.display = 'block';
  } else if (status === 'ERROR') {
    btn.textContent = 'Retry';
    btn.disabled = false;
    if (newDeckBtn) newDeckBtn.style.display = 'block';
  }

  if (elements.stopBtn) {
    const inActiveSession = !!state.sessionId && ['GENERATING', 'REVIEWING', 'APPROVING', 'DONE'].includes(status);
    elements.stopBtn.disabled = !inActiveSession;
  }
  if (elements.customRegenBtn) {
    const hasDraft = !!state.draftSlides?.[state.currentIndex] || !!state.currentSlideHtml;
    elements.customRegenBtn.disabled = !hasDraft;
  }

  // Show slide controls when in generation/reviewing phase
  const inSlidePhase = ['GENERATING', 'REVIEWING', 'APPROVING', 'DONE'].includes(status);
  if (inSlidePhase) {
    elements.promptContainer.style.display = 'none';
    elements.slideControls.style.display = 'flex';
    elements.refinePanel.style.display = 'block';
  } else {
    elements.promptContainer.style.display = 'flex';
    elements.slideControls.style.display = 'none';
    elements.refinePanel.style.display = 'none';
  }
}

/**
 * Render the slide outline in the sidebar.
 * Always attaches click handlers — approved slides navigate to their saved HTML,
 * unapproved future slides are navigable only if a callback is provided.
 */
export function renderOutline(onItemClick = null) {
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

    return `
      <div class="outline-item ${isActive ? 'active' : ''} ${isApproved ? 'approved' : ''}"
           data-index="${index}"
           style="padding: 12px; border-bottom: 1px solid var(--border); font-size: 0.85rem;
                  cursor: ${cursor}; display: flex; align-items: center; gap: 10px;
                  background: ${bgColor}; transition: background 0.15s;">
        <span style="color: ${numColor}; font-family: var(--font-mono); min-width: 22px; font-size: 0.75rem;">${badge}</span>
        <div style="flex: 1; color: ${textColor}; font-weight: ${weight};">${item.title}</div>
        ${isApproved ? '<span style="font-size:0.65rem;color:#10b981;opacity:0.7;">approved</span>' : isGenerating ? '<span style="font-size:0.65rem;color:#fbbf24;opacity:0.85;">generating</span>' : isDraft ? '<span style="font-size:0.65rem;color:#60a5fa;opacity:0.85;">ready</span>' : '<span style="font-size:0.65rem;color:#6b7280;opacity:0.85;">pending</span>'}
      </div>
    `;
  }).join('');

  // Always wire up clicks — the handler decides what to do per state
  elements.outlineList.querySelectorAll('.outline-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index);
      if (onItemClick) {
        onItemClick(idx);
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

export function renderOutlineContentSummary() {
  const rows = state.outline.map((item, idx) => `
    <div style="padding: 10px 0; border-bottom: 1px solid #222;">
      <div style="font-weight: 600; color: #fff;">${idx + 1}. ${item.title}</div>
      <div style="color:#9ca3af; margin-top:4px; font-size: 0.85rem;">Intent: ${item.intent} | Layout: ${item.layout_hint}</div>
      <ul style="margin: 6px 0 0 18px; color: #d1d5db; font-size: 0.85rem;">
        ${(item.key_points || []).map(p => `<li>${p}</li>`).join('')}
      </ul>
    </div>
  `).join('');

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
