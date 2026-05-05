/**
 * API Client for Vapor Deck
 * Handles session creation, slide generation via SSE, and snapshots.
 */

const BASE_URL = 'http://localhost:8000/api'; // Harness uses /api prefix

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

export async function uploadText(sessionId, text, role = 'topic') {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/upload/text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, role })
  });
  return response.json();
}

export async function synthesize(sessionId) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/synthesize`, {
    method: 'POST'
  });
  return response.json();
}

export async function generateOutline(sessionId) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/outline`, {
    method: 'POST'
  });
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

/**
 * Stream slide generation or refinement as an async generator.
 * @param {string} sessionId
 * @param {number} slideIndex  1-indexed slide number
 * @param {'generate'|'refine'} mode
 * @param {object} [extra]  e.g. { refineMode: 'expand', currentHtml: '...' }
 */
export async function* streamSlide(sessionId, slideIndex, mode = 'generate', extra = {}) {
  const isRefine = mode === 'refine';
  const endpoint = isRefine
    ? `${BASE_URL}/session/${sessionId}/slide/${slideIndex}/refine`
    : `${BASE_URL}/session/${sessionId}/slide/${slideIndex}`;

  const body = isRefine
    ? JSON.stringify({ mode: extra.refineMode ?? 'expand', current_html: extra.currentHtml ?? '' })
    : undefined;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Accept': 'text/event-stream',
      ...(isRefine ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body } : {})
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

export async function takeSnapshot(sessionId, slideIndex, html) {
  const response = await fetch(`${BASE_URL}/session/${sessionId}/slide/${slideIndex}/snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ html })
  });
  return response.json();
}
