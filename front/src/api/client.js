/**
 * API Client for Vapor Deck
 * Handles session creation, slide generation via SSE, snapshots, and global controls.
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

export async function generateOutline(sessionId, preferredSlides = 8) {
  const url = `${BASE_URL}/session/${sessionId}/outline?preferred_slides=${preferredSlides}`;
  const response = await fetch(url, { method: 'POST' });
  return response.json();
}

export async function confirmOutline(sessionId, outline) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outline })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Failed to confirm outline: ${errText}`);
  }
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
  let endpoint = isRefine
    ? `${BASE_URL}/session/${sessionId}/slide/${slideIndex}/refine`
    : `${BASE_URL}/session/${sessionId}/slide/${slideIndex}`;

  if (!isRefine && extra.force) {
    endpoint += '?force=true';
  }

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

    // Process all full events in the buffer
    let eventEnd;
    while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
      const event = buffer.slice(0, eventEnd);
      buffer = buffer.slice(eventEnd + 2);

      // In SSE, an event can have multiple 'data: ' lines
      const lines = event.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const b64Token = line.slice(6);
          if (b64Token === '[DONE]') return;
          if (b64Token.startsWith('[ERROR]')) throw new Error(b64Token.slice(8));
          
          try {
            // Decode Base64 token to UTF-8 string
            const token = decodeURIComponent(escape(atob(b64Token)));
            yield token;
          } catch (e) {
            console.error('Failed to decode Base64 token:', b64Token, e);
            // Fallback for non-base64 tokens (like [DONE] if it wasn't caught)
            yield b64Token;
          }
        }
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
 * Send an html2canvas screenshot + slide HTML to the backend for vision audit.
 * Returns { snapshot_b64, audit, refine_prompt, auto_fixed }.
 * Fire-and-update: call after slide generation, don't block the UI on it.
 */
export async function takeSnapshot(sessionId, slideIndex, html, snapshotB64 = null) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(`${BASE_URL}/session/${sessionId}/slide/${slideIndex}/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, snapshot_b64: snapshotB64, run_audit: true }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return { snapshot_b64: null, audit: { verdict: 'good' }, refine_prompt: null, auto_fixed: false };
    }
    return response.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err?.name === 'AbortError') {
      return {
        snapshot_b64: null,
        audit: { verdict: 'audit_failed', timed_out: true, visual_issues: ['Request timed out after 120 seconds'] },
        refine_prompt: null,
        auto_fixed: false,
      };
    }
    return { snapshot_b64: null, audit: { verdict: 'good' }, refine_prompt: null, auto_fixed: false };
  }
}

// ── Global control API calls ───────────────────────────────────────────────────

export async function updateSlideTitle(sessionId, index, title) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/outline/${index}/title`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  return response.json();
}

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
export async function retryAnalysis(sessionId, unitId) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/input/${unitId}/retry_analysis`, {
    method: 'POST'
  });
  return response.json();
}
