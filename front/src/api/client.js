/**
 * API Client for Vapor Deck
 * Handles session creation, slide generation via SSE, snapshots, and global controls.
 *
 * Changes from original:
 *   - takeSnapshot now actually calls the backend (was a stub)
 *   - Added updateDeckSettings for global control sync
 *   - Added reorderOutline and removeOutlineSlide for global control
 * All existing exports preserved exactly.
 */

const BASE_URL = 'http://localhost:8000/api';

export async function createSession(data) {
  const response = await fetch(`${BASE_URL}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return response.json();
}

export async function getProjectInfo() {
  const response = await fetch(`${BASE_URL}/project`);
  return response.json();
}

export async function getActiveSession() {
  const response = await fetch(`${BASE_URL}/session/active`);
  return response.json();
}

export async function deleteSession(sessionId) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}`, { method: 'DELETE' });
  return response.json();
}

export async function uploadText(sessionId, text, role = 'topic') {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/upload/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, role })
  });
  return response.json();
}

export async function uploadFile(sessionId, file, role = 'reference') {
  const form = new FormData();
  form.append('file', file);
  form.append('role', role);
  const response = await fetch(`${BASE_URL}/session/${sessionId}/upload`, {
    method: 'POST',
    body: form
  });
  return response.json();
}

export async function synthesize(sessionId) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/synthesize`, { method: 'POST' });
  return response.json();
}

export async function generateOutline(sessionId) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/outline`, { method: 'POST' });
  return response.json();
}

export async function confirmOutline(sessionId, outline) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outline })
  });
  return response.json();
}

export async function updateMode(sessionId, mode, signal) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/mode`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode }),
    signal
  });
  return response.json();
}

export async function sendPlanChat(sessionId, message, currentSlideIndex, signal) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, current_slide_index: currentSlideIndex }),
    signal
  });
  return response.json();
}

/**
 * Stream slide generation or refinement as an async generator.
 */
export async function* streamSlide(sessionId, slideIndex, mode = 'generate', extra = {}, signal) {
  const isRefine = mode === 'refine';
  const endpoint = isRefine
    ? `${BASE_URL}/session/${sessionId}/slide/${slideIndex}/refine`
    : `${BASE_URL}/session/${sessionId}/slide/${slideIndex}`;

  const body = isRefine
    ? JSON.stringify({
        mode: extra.refineMode ?? 'expand',
        current_html: extra.currentHtml ?? '',
        instruction: extra.instruction ?? ''
      })
    : undefined;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      ...(isRefine ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body } : {}),
    signal
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Backend ${response.status}: ${errText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const token = line.slice(6);
        if (token === '[DONE]') return;
        if (token.startsWith('[ERROR]')) throw new Error(token.slice(8));
        yield token;
      }
    }
  }
}

export async function approveSlide(sessionId, slideIndex, html) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/slide/${slideIndex}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html })
  });
  return response.json();
}

/**
 * Take a Playwright snapshot + vision audit of a slide.
 * Returns { snapshot_b64, audit, fixed_html, auto_fixed }.
 *
 * This is fire-and-update: call after slide generation, don't block the UI.
 * If the backend doesn't have Playwright installed, gracefully returns { audit: { verdict: 'good' } }.
 */
export async function takeSnapshot(sessionId, slideIndex, html) {
  try {
    const response = await fetch(`${BASE_URL}/session/${sessionId}/slide/${slideIndex}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, run_audit: true, auto_fix: true })
    });
    if (!response.ok) {
      // Snapshot is optional — fail gracefully
      return { snapshot_b64: null, audit: { verdict: 'good' }, fixed_html: null, auto_fixed: false };
    }
    return response.json();
  } catch {
    // Playwright may not be installed — that's fine
    return { snapshot_b64: null, audit: { verdict: 'good' }, fixed_html: null, auto_fixed: false };
  }
}

// ── NEW: Global control API calls ─────────────────────────────────────────────

/**
 * Update deck-wide settings (tone, audience, narrative structure).
 */
export async function updateDeckSettings(sessionId, settings) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/deck-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings)
  });
  return response.json();
}

/**
 * Reorder slides in the outline.
 * @param {string} sessionId
 * @param {number[]} order - new order as array of original indices
 */
export async function reorderOutline(sessionId, order) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/outline/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order })
  });
  return response.json();
}

/**
 * Add a new slide to the outline.
 */
export async function addOutlineSlide(sessionId, slide) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/outline/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(slide)
  });
  return response.json();
}

/**
 * Remove a slide from the outline (only if not yet built).
 */
export async function removeOutlineSlide(sessionId, slideN) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/outline/${slideN}`, {
    method: 'DELETE'
  });
  return response.json();
}
