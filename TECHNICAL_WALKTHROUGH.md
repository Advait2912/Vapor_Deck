# VAPOR DECK — Technical Walkthrough

A deep dive into every architectural decision, data flow, and engineering tradeoff in the Vapor Deck codebase.

---

## Table of Contents

1. [System overview](#1-system-overview)
2. [The three-layer CSS architecture](#2-the-three-layer-css-architecture)
3. [Backend: session lifecycle](#3-backend-session-lifecycle)
4. [Input ingestion pipeline](#4-input-ingestion-pipeline)
5. [Context synthesis](#5-context-synthesis)
6. [Outline generation](#6-outline-generation)
7. [Slide generation and SSE streaming](#7-slide-generation-and-sse-streaming)
8. [The isolated iframe renderer](#8-the-isolated-iframe-renderer)
9. [Design AI system](#9-design-ai-system)
10. [Vision audit pipeline](#10-vision-audit-pipeline)
11. [Refinement and comparison mode](#11-refinement-and-comparison-mode)
12. [State management and persistence](#12-state-management-and-persistence)
13. [Frontend event model](#13-frontend-event-model)
14. [AI provider abstraction](#14-ai-provider-abstraction)
15. [Key engineering decisions and tradeoffs](#15-key-engineering-decisions-and-tradeoffs)

---

## 1. System overview

Vapor Deck is split into two processes that talk over HTTP:

- **`front/`** — a Vite + vanilla JS SPA, responsible for all rendering and user interaction
- **`harness/`** — a FastAPI server, responsible for LLM calls, file storage, and session state

The frontend never calls an LLM directly. The backend never renders HTML. This boundary is strict.

```
User
 │
 ▼
Browser (Vite SPA)
  ├── Sends fetch/SSE requests to FastAPI on :8000
  ├── Renders slide HTML into isolated <iframe> elements
  └── Captures offscreen screenshots via html2canvas
       │
       ▼
FastAPI (harness/)
  ├── Routes → Services → AI Router → Provider (Ollama / Google)
  └── Persists session state to {VAPOR_PROJECT_DIR}/vapor_deck.json
```

One important design choice: **there is no database**. The entire session — outline, slides, context, design config — lives in a single JSON file on disk. This makes the project portable and easy to debug at the cost of not supporting concurrent sessions on the same server (which is fine for a local tool).

---

## 2. The three-layer CSS architecture

Every rendered slide is built from three independent CSS layers, and understanding this is key to understanding the whole rendering pipeline.

```
Layer 1: front/src/style.css
  ↓ app chrome only — never enters an iframe
  Header, sidebar, footer, mode pills, status bar

Layer 2: front/public/themes/{theme}.css
  ↓ injected into every slide iframe via a <link> tag
  Defines CSS custom properties: --bg, --accent, --text, --border, etc.

Layer 3: <style> inside the LLM-generated <section class="slide">
  ↓ scoped to this one slide
  Overrides variables, adds animations, defines layout
```

The LLM is instructed to write only within Layer 3, using the CSS variables defined in Layer 2. It is explicitly told never to write rules for `body {}` (which would bleed out of the iframe context) and to always use `--accent` rather than a hardcoded hex.

This means themes are swappable without regenerating slides. Changing `--accent` in `dark-tech.css` from `#8b5cf6` to `#f59e0b` updates every slide that references it.

The three themes (`dark-tech`, `clean-light`, `brutalist`) differ not just in colour but in structural defaults — `brutalist.css` uses 4px solid borders everywhere and forces uppercase headings as a base, while `clean-light.css` uses hairline borders and gentle shadows.

---

## 3. Backend: session lifecycle

A `DeckSession` (defined in `models/session.py`) is a Pydantic model that tracks everything. Its status field is a state machine:

```
idle
  → synthesizing   (POST /synthesize in progress)
  → synthesized
  → outlining      (POST /outline in progress)
  → reviewing_outline  (waiting for user to confirm)
  → generating     (slides are being built)
  → done
```

The session is stored in memory in a dict (`store/sessions.py::sessions`) and written to disk on every mutation via `save_session()`. A threading lock (`_save_lock`) prevents concurrent writes corrupting the JSON file.

Reading is lazy — `get_session()` checks the in-memory dict first, then falls back to loading `vapor_deck.json` from disk. This means a server restart doesn't lose state, and the frontend can reload and reconnect seamlessly.

The design config (`design_config`) is split out into its own file (`design.json`) alongside the main session file so it can be edited by hand without touching the larger session blob.

---

## 4. Input ingestion pipeline

When a user uploads content (text, PDF, DOCX, or image), it becomes an `InputUnit`. Each unit tracks:

- Its **role** (`topic`, `reference`, or `instruction`)
- Chunked text (400-token chunks with 50-token overlap)
- For images: a visual summary, colour palette, font hints
- For instructions: a parsed list of individual rules

The role is auto-detected for plain text via a fast LLM classification call if the user doesn't specify it:

```python
# services/extractors/text_extractor.py
role_prompt = f"""Classify this text into exactly one role:
- topic: a subject to present
- reference: factual content to draw from
- instruction: rules the deck must follow
...
Return ONE word only: topic, reference, or instruction"""
```

Deduplication is done by SHA-256 hash of the raw content, stored in `session.input_hash_index`. Uploading the same file twice returns a `"status": "duplicate"` response without re-processing.

**Chunking** (in `services/extractors/chunker.py`) uses a simple character-count approximation: 1 token ≈ 4 characters. This is deliberately rough — the chunks are used for keyword-based retrieval later, not exact token budgeting against a context window.

**Image extraction** does two things: sends the image to the vision model with a structured prompt asking for layout hints, font names, and a suggested theme, then extracts a dominant colour palette using Pillow's quantise method (reduces the image to N representative colours). These signals feed into the design config if the user uploads a brand sheet.

---

## 5. Context synthesis

Before the outline is generated, all `InputUnit` objects are collapsed into a single `deck_context` dict by `services/context_synthesis.py`.

The synthesis prompt assembles:
- All topic-role chunks (first 3 chunks per unit)
- All reference-role chunks (up to 6000 tokens, ordered by upload time)
- All instruction-role parsed rules (verbatim, not processed by the LLM — to prevent the model from softening hard constraints)

The LLM returns a structured JSON object:

```json
{
  "topic": "...",
  "audience": "...",
  "tone": "...",
  "key_themes": [...],
  "key_facts": [...],
  "narrative_arc": "...",
  "hard_constraints": [...]
}
```

This becomes the backbone for every downstream prompt. The outline prompt, the slide generation prompt, and the context update prompt all draw from `deck_context`. The design signals (palette, fonts) from image uploads are stored in a separate `design_config` and are not merged into `deck_context` — they flow through a different channel into the slide prompt.

---

## 6. Outline generation

`POST /outline` calls `build_outline_prompt()` from `prompts/outline.py`, which injects the synthesised context into a template asking for a JSON array of `OutlineItem` objects.

Each `OutlineItem` has:
- `index` — 1-based position
- `title` — slide heading
- `intent` — one of 10 named intents (`title-hero`, `explain-concept`, `code-walkthrough`, `narrative-break`, etc.)
- `key_points` — 2–5 bullets the slide must cover
- `layout_hint` — free-text layout description (`"asymmetrical-overlap"`, `"split-diagonal"`, etc.)

The intent system is important: it drives the per-slide prompt's `INTENT_GUIDANCE` dict, which gives the LLM specific creative direction depending on the type of slide. A `narrative-break` slide gets "use a bold quote or massive single word", while `code-walkthrough` gets "deep-focus code blocks with interactive callouts".

After the LLM returns JSON, the backend uses a lenient parser:

```python
cleaned = strip_fences(raw_outline)
if not cleaned.startswith("["):
    start = cleaned.find("[")
    end = cleaned.rfind("]")
    cleaned = cleaned[start:end+1]
sanitized = "".join(c for c in cleaned if c.isprintable() or c in "\n\r\t")
outline_data = json.loads(sanitized, strict=False)
```

The `strip_fences` + index extraction + control-character sanitisation pattern appears in several places because LLMs have a habit of wrapping JSON in markdown code fences, adding preamble text, and occasionally emitting non-printable characters.

---

## 7. Slide generation and SSE streaming

`POST /session/{id}/slide/{slide_id}` is the core endpoint. It streams HTML tokens using Server-Sent Events.

The critical implementation detail: **all tokens are Base64-encoded before transmission**.

```python
b64_token = base64.b64encode(token.encode("utf-8")).decode("utf-8")
yield f"data: {b64_token}\n\n"
```

And decoded on the client:

```javascript
const token = decodeURIComponent(escape(atob(b64Token)));
```

This solved a class of corruption bugs where HTML containing newlines, angle brackets, or special characters was misinterpreted by the SSE parser. The frontend was accumulating `data: ` lines that themselves contained `data:` prefixes from the slide content. Base64 sidesteps all of this.

The slide generation prompt (`prompts/slide.py`) is the most complex in the system. It includes:

1. **The scene** — slide number, title, intent, key points, layout hint
2. **Deck context summary** — what slides have been covered, terms defined, narrative so far
3. **Reference knowledge** — relevant chunks from uploaded documents (scored by keyword overlap against the slide's intent string)
4. **Available assets** — filenames in `{project}/assets/` that can be referenced as `<img src="/assets/filename">`
5. **Brand section** — the design config's palette, fonts, and atmospheric feel, formatted as explicit CSS variable override instructions
6. **Intent execution** — the `INTENT_GUIDANCE` string for this slide's intent type
7. **Output rules** — return only the `<section>` element, use CSS variables, include `class="reveal"` for animations

The brand section is built by `_build_brand_section()` which generates actual CSS that the LLM is instructed to paste verbatim at the top of its `<style>` block:

```
section.slide {
  --bg: #0a0a0f;
  --accent: #c084fc;
  --text: #f0e6ff;
  ...
}
```

This pattern — giving the LLM the CSS to copy rather than asking it to infer it — is more reliable than relying on the model to consistently translate a palette description into correct CSS custom property values.

**Relevant chunk retrieval** uses keyword overlap scoring:

```python
intent_words = set(slide_intent.lower().split())
overlap = len(intent_words & set(chunk.text.lower().split()))
```

This is intentionally primitive. The intention is for a future embedding-based retrieval upgrade, but keyword overlap works well enough for most decks where the topic vocabulary is consistent across the outline.

---

## 8. The isolated iframe renderer

`front/src/renderer/iframe.js` is the most carefully engineered file in the frontend.

The core problem it solves: how do you render a stream of HTML tokens without the page flickering or Prism.js running multiple times?

The solution is a two-phase approach:

**Phase 1 (first render):** Set `iframe.srcdoc` to `buildBaseDocument(html, theme, fonts)`. This injects the full theme CSS link, Prism.js core and language components (all bundled inline using Vite's `?raw` import), and a `window.__PATCH_SLIDE__` function.

**Phase 2 (subsequent updates):** Call `iframe.__PATCH_SLIDE__(newHtml)` to replace only the content of `#slide-container` without reloading the iframe. This means Prism loads once per iframe lifetime, not once per token.

The base document structure:

```html
<!DOCTYPE html>
<html>
<head>
  <!-- Google Fonts link (Inter, JetBrains Mono + any design config fonts) -->
  <link href="themes/{theme}.css" rel="stylesheet">
  <style>/* Prism CSS */</style>
  <style>/* reveal animation + audit-mode overrides */</style>
</head>
<body>
  <div id="slide-container">{slideHtml}</div>
  <script>
    /* Prism core + 4 language components, all inlined */
    window.__PATCH_SLIDE__ = function(newHtml) { ... }
    window.addEventListener('load', function() {
      triggerReveal();
      highlightCode();
      window.__VAPOR_READY__ = true;
    });
  </script>
</body>
```

`window.__VAPOR_READY__` is a flag the vision audit system polls before capturing a screenshot, ensuring the slide is fully painted and highlighted before the image is taken.

The `audit-mode` CSS class is injected by the offscreen capture process — it disables all animations and forces all `.reveal` elements to their final visible state, so the screenshot captures the completed layout rather than a mid-animation frame.

**Font injection** is handled by `ensureFontsInDocument()`, which scans the slide HTML for `font-family` declarations, combines them with the design config's `font_hints`, and injects a Google Fonts link if the fonts aren't already loaded. This runs in both the live preview iframe and the offscreen capture iframe.

---

## 9. Design AI system

`routes/design.py` implements a separate AI persona — the Design AI — that manages the `design_config` object.

The Design AI is given:
- The current `design_config` JSON
- The full content of `design_skill.md` — a 500-word methodology document describing how to approach colour theory, typography, atmospheric feel, and component DNA
- The user's message

It is instructed to return a JSON object with exactly two keys: `"message"` (conversational reply) and `"design_config"` (the complete updated config).

The `design_config` schema includes fields the slide generation prompt actively uses:
- `color_palette` — 5–6 hex codes
- `font_hints` — font family names
- `atmospheric_feel` — a prose description (fed into the brand section prompt)
- `color_theory_intent` — how to use the palette (which colour is for callouts, which is for backgrounds)
- `component_styles` — visual DNA for cards, buttons, borders
- `visual_elements` — recurring decorative motifs

The Design AI runs in a separate chat history (`#design-chat-history`) from the content Plan AI, making the separation of concerns visible in the UI as well as the code.

---

## 10. Vision audit pipeline

The vision audit is the most complex subsystem. It involves the frontend, the backend, and two different AI calls.

**Step 1: Offscreen render**

After slide generation completes, `main.js` calls `captureHtmlOffscreen()`. This creates a hidden 1280×720 iframe, writes the full slide document to it (using `buildBaseDocument()`), and waits for `window.__VAPOR_READY__` to be `true`.

Then it calls `html2canvas()` on the iframe body. Before the capture, it runs an `onclone` callback that:
- Forces all elements with `opacity: 0` to `opacity: 1` (catches stalled entry animations)
- Fixes gradient text (`background-clip: text`) which html2canvas can't render — replaces it with a flat colour
- Removes box shadows and text shadows (they over-expose the capture)

The result is a base64 PNG string.

**Step 2: Vision model audit**

The screenshot + slide HTML is posted to `POST /session/{id}/slide/{id}/snapshot`. The backend calls `services/snapshot.py::capture_and_audit()`.

The vision audit prompt (`prompts/vision_audit.py`) asks the model to check nine specific conditions: overflow, clipping, too much content, unreadable code, bad spacing, font size, visual balance, contrast, and wrapping. It returns structured JSON:

```json
{
  "verdict": "fixable",
  "visual_issues": ["right column text wrapping at narrow widths"],
  "refine_prompt": "Fix: Set min-width: 300px on .right-col and reduce font-size from 1.1rem to 0.95rem.",
  "has_overflow": false,
  "has_wrapping_issues": true,
  ...
}
```

**Step 3: Result routing**

The audit result is stored in `state.slideAudits[id]` on the frontend and `existing_slide.audit` on the backend. The verdict drives the 👁 indicator:

- `good` → green, "LAYOUT OK"
- `fixable` → blue, "MINOR ISSUES" + a "✦ Apply Fix" button
- `regenerate` → amber, "ISSUES FOUND" + fix button
- `audit_failed` → red, "AUDIT FAILED"

The "Apply Fix" button pre-fills the Build mode refine input with the `refine_prompt` string and focuses it. The user still has to click "Refine ✦" — the system never auto-applies fixes silently.

**Race condition protection**

Because audits run asynchronously and the user can navigate between slides while they're running, there's a versioning system:

```javascript
const jobToken = ++auditJobCounter;
latestAuditJobBySlide[id] = jobToken;
const isLatestAuditJob = () => latestAuditJobBySlide[id] === jobToken;
```

If a new audit starts for the same slide before the previous one finishes, the stale result is discarded via the `isLatestAuditJob()` guard. The same pattern (`latestJobBySlide` + `slideJobCounter`) applies to generation jobs.

---

## 11. Refinement and comparison mode

Refinement (Build mode) works by sending the current slide HTML back to `POST /session/{id}/slide/{id}/refine` with:
- `mode` — one of `simplify`, `expand`, `example`, `interactive`
- `current_html` — the full HTML being refined
- `instruction` — the user's natural language change request

The backend appends the instruction to `slide_data.refinements` (a persisted list), then constructs a slide generation prompt with two extra sections: the current HTML and all previous refinement instructions. The prompt ends with:

```
CRITICAL: Your task is to modify the provided CURRENT SLIDE HTML. You MUST preserve the existing structural design [...] unless the current instruction explicitly asks you to change them.
```

This prevents the LLM from "helpfully" discarding layout decisions from previous refinement rounds.

**Comparison mode** (`src/ui/comparison.js`) splits the screen into before/after iframes when refinement starts. The state machine:

```javascript
comparisonState = {
  active: bool,
  before: { html, label },   // frozen immediately when refinement starts
  after: { html, streaming }, // accumulates tokens
  history: [...]              // past "after" versions
}
```

`appendComparisonToken()` uses a 150ms debounce on iframe updates — patching the right-panel iframe every token would cause constant repaints during a 3–5 second stream.

When the user clicks "Use Refined →", the after HTML becomes the live slide. When they click "Keep Current", nothing changes. Both paths call `resetComparison()` to clear the overlay state.

The history strip at the bottom of the comparison overlay lets users revisit rejected refinements — each discarded "after" is pushed into `comparisonState.history` if the user clicks "Refine Again".

---

## 12. State management and persistence

The frontend uses a single flat state object (`src/state.js`). There is no Flux, no Zustand, no reactive system. State is mutated directly and `updateUI()` is called explicitly. This is intentional for a tool of this complexity — the overhead of reactivity would be more harmful than helpful given the number of async operations running simultaneously.

The state that matters most:

```javascript
state = {
  sessionId,        // links to backend
  outline,          // OutlineItem[]
  slides,           // approved slides with HTML
  draftSlides,      // { id → html } — generated but not yet approved
  latestSlides,     // { id → html } — most recent version (draft or approved)
  generatingSlides, // { id → true | 'QUEUED' | 'ERROR' }
  slideAudits,      // { id → VisionAuditResult }
  auditingSlides,   // { id → jobToken } — in-flight audits
  currentIndex,
  currentSlideHtml,
  status, mode, theme, designConfig, ...
}
```

The distinction between `draftSlides` and `latestSlides` is subtle but important. `latestSlides` always has the most recent HTML for any slide ID, regardless of whether it came from generation, refinement, or a refine-again cycle. `draftSlides` is cleared when a slide is approved/snapshotted. Navigation uses `latestSlides` first, then falls back through `draftSlides` → `slides` (backend-approved).

**LocalStorage persistence** serialises a subset of state to `vapordeck:view:{sessionId}` on every meaningful change. On reload, this is merged with the backend session data (backend wins for approved slide HTML). This gives a consistent experience across refreshes without requiring the backend to store ephemeral frontend-only state like chat history or current scroll position.

---

## 13. Frontend event model

The frontend uses three event mechanisms:

**1. Direct function calls** — for tight interactions (clicking a slide in the outline calls `navigateToSlide(index)` directly)

**2. Custom DOM events** — for loose coupling between modules. `global_control.js` doesn't import `main.js`; instead it dispatches `CustomEvent('global:outline-changed', { detail: { outline, reason } })` and `main.js` handles it:

```javascript
window.addEventListener('global:outline-changed', (e) => {
  updateState({ outline: e.detail.outline });
  refreshOutline();
  persistSessionViewState();
  // Sync to backend based on e.detail.reason...
});
```

Events used: `global:outline-changed`, `global:add-slide-ai`, `global:reorder-mode`, `global:setting-changed`, `global:generate-all`, `global:present`, `generate-slide`, `update-slide-title`.

**3. `window.refreshInfoPanel`** — a single deliberately global function exposed by `main.js` so `ui.js::updateUI()` can trigger a refresh of the right sidebar without creating a circular import.

The generation queue uses a simple array + active counter:

```javascript
let generationQueue = [];
let activeGenerations = 0;
const MAX_CONCURRENT_GENERATIONS = 2;

async function processGenerationQueue() {
  if (activeGenerations >= MAX_CONCURRENT_GENERATIONS) return;
  const { index, force } = generationQueue.shift();
  activeGenerations++;
  await startSlideGeneration(index, force);
  activeGenerations--;
  processGenerationQueue(); // tail recursion to process next item
}
```

The two-at-a-time limit balances generation speed against Ollama's context window pressure.

---

## 14. AI provider abstraction

`harness/ai/base.py` defines `BaseProvider` with two methods:

```python
async def stream_text(messages, system) -> AsyncIterator[str]: ...
async def vision_audit(prompt, image_b64) -> str: ...
```

`harness/ai/router.py` maintains a module-level cache of provider instances keyed by model string (`"provider/model-name"`). Providers are instantiated lazily on first use. This means all slides in a session share one Ollama client with one connection pool.

The Ollama provider (`providers/ollama.py`) has one notable hack:

```python
# BUG: gemma4:31b-cloud is text-only and crashes Ollama with 500 if images are sent.
effective_model = self.model
if "gemma4" in self.model:
    effective_model = "ministral-3:14b-cloud"
```

Gemma 4 doesn't support vision but the user might select it as their text model. Rather than erroring, the vision audit silently switches to a vision-capable model. The session stores a separate `vision_model` field for exactly this reason.

The Google provider (`providers/google.py`) uses the `google-genai` SDK with its `aio` async interface for both streaming and vision. The message format conversion (OpenAI-style `{"role": "user", "content": "..."}` → Google's `Content` + `Part` objects) is handled inside the provider, so all callers use a uniform interface.

---

## 15. Key engineering decisions and tradeoffs

**SSE over WebSockets**

SSE is unidirectional (server → client) and works over plain HTTP/1.1 without an upgrade handshake. Since slide generation is purely server-push, SSE was simpler than WebSockets and doesn't require managing connection state. The tradeoff is that stopping a generation requires an `AbortController` on the client side rather than a close frame.

**Base64 SSE encoding**

The most impactful single change in the streaming pipeline. Before it, special characters in slide HTML (newlines in `<style>` blocks, `data:` URIs in inline SVGs, angle brackets in attributes) would corrupt the SSE stream. Base64 encoding every token adds ~33% overhead in bytes but eliminates an entire class of reliability bugs.

**Single JSON file storage**

No database means no migration concerns, no connection pooling, and trivial portability — the project directory is a self-contained artifact. The tradeoff is that large slide payloads (each slide's HTML is typically 3–8KB) bloat the session JSON. At 20 slides this is manageable (~160KB). A future improvement would be storing each slide's HTML in its own file and keeping only a reference in the session JSON.

**No token-by-token iframe injection**

Early versions injected each SSE token directly into the iframe's DOM. This caused Prism.js to re-highlight on every token (expensive), produced visible mid-parse flicker as the HTML was invalid mid-stream, and caused reveal animations to trigger multiple times. The current approach accumulates the full HTML and patches the iframe at a controlled interval (the comparison overlay) or after the stream completes (the main preview).

**Keyword retrieval over embeddings**

The relevant chunk retrieval uses word overlap, not semantic similarity. This is a conscious tradeoff: semantic retrieval would require running an embedding model (more dependencies, more latency, more memory) for marginal benefit in the common case where the user's topic vocabulary is consistent. The system is designed so this function can be swapped out without touching any other code.

**Design AI as a separate persona**

Keeping the Design AI separate from the content Plan AI (different system prompt, different chat history, different endpoint) prevents contamination — you don't want "make the outline more concise" requests accidentally affecting the colour palette, or vice versa. The tradeoff is that changes in one domain don't automatically propagate awareness to the other; if the user asks the Plan AI to make the deck more minimalist, the Design AI won't know unless explicitly told.

**Vision audit as user-triggered, not auto-applied**

Early designs auto-applied vision audit fixes. This caused problems: the user would see their slide change silently while they were reading it, regression bugs appeared when the auto-fix made things worse, and the audit loop could run indefinitely. The current design shows the issue and a ready-to-use instruction, but the user has to click "✦ Apply Fix" and then "Refine ✦" to apply it. This adds one click but makes the system's behaviour predictable.

**`window.__VAPOR_READY__` polling**

Rather than using a `postMessage` channel between the parent page and the iframe, the offscreen capture uses a simple flag polling loop (`while (!iframe.contentWindow.__VAPOR_READY__) await sleep(100)`). This is slightly crude but avoids the complexity of message routing when multiple iframes exist simultaneously (main preview, offscreen capture, comparison before/after panels).

---

*Built with FastAPI, Vite, Ollama, and an unhealthy amount of SSE debugging.*
