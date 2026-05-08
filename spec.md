# AI-Powered Interactive Slide Generator — Full Project Report

> **Scope:** Architecture, tech stack, feature breakdown, harness design, and debugging strategy  
> **Timeline:** 5-day hackathon build  
> **Output:** Web-native interactive slide decks, not PPTX

---

## Table of Contents

1. [What We Are Building](#1-what-we-are-building)
2. [Core Architectural Decisions](#2-core-architectural-decisions)
3. [Full Tech Stack](#3-full-tech-stack)
4. [Feature Breakdown](#4-feature-breakdown)
5. [Pipeline: End-to-End Flow](#5-pipeline-end-to-end-flow)
6. [Backend Harness](#6-backend-harness)
7. [Frontend Harness](#7-frontend-harness)
8. [Multi-Model AI Layer](#8-multi-model-ai-layer)
9. [Snapshot & Vision Feedback System](#9-snapshot--vision-feedback-system)
10. [Split-View Comparison & History](#10-split-view-comparison--history)
11. [Deck Context JSON (Memory System)](#11-deck-context-json-memory-system)
12. [Theme System](#12-theme-system)
13. [Animation Layer](#13-animation-layer)
14. [PDF Export](#14-pdf-export)
15. [Debugging Strategy](#15-debugging-strategy)
16. [5-Day Build Plan](#16-5-day-build-plan)
17. [Demo Strategy](#17-demo-strategy)

---

## 1. What We Are Building

An AI-powered web application that takes any input (topic, document, transcript, or code) and generates a fully interactive, web-native slide deck — one slide at a time, with user control at every step.

**What it is NOT:**
- Not a PPTX generator
- Not a drag-and-drop editor like Canva
- Not a static export tool

**What it IS:**
- A pipeline where an LLM writes real HTML+CSS+JS slides directly
- An iterative loop where users approve, refine, expand, or regenerate each slide before moving on
- A system where a vision-capable model can *see* its own rendered output and self-correct
- A comparison tool where refinements are shown side-by-side against the current version

---

## 2. Core Architectural Decisions

### Decision 1: LLM writes HTML directly, not via templates

The LLM is not filling in a JSON template that maps to HTML. It receives context and writes the full `<section>` HTML itself, including scoped `<style>` and `<script>` tags. This means:

- Interactivity (tabs, toggles, hover reveals) is baked in, not bolted on
- Layout is not constrained to predefined slots
- The LLM's creativity is the ceiling, not a template definition

### Decision 2: JSON is deck memory, not an intermediate render layer

A `deck_context.json` file accumulates what every slide has defined, stated, and covered. Every slide generation call receives this JSON. It prevents the LLM from:

- Redefining terms already introduced
- Contradicting facts from earlier slides
- Losing the narrative thread across calls

The JSON is never rendered. It is never mapped to HTML. It is only ever read by the LLM as context.

### Decision 3: Iterative per-slide generation with user control

Two LLM calls define the shape of a deck:

1. **Outline call** — returns the full list of slide titles, intents, and key points
2. **Per-slide calls** — one call per slide, reads deck context, writes HTML

Between these, the user edits the outline, approves each slide, and triggers refinements. The deck is never generated all at once.

### Decision 4: Multi-model support via provider abstraction

A thin router layer maps model strings like `"google/gemma-4"` or `"ollama/llama3.1:8b"` to provider classes, each implementing a common interface. This means switching from a local Ollama model to Gemma 4 or Claude is a single config change — no pipeline changes.

---

## 3. Full Tech Stack

### Backend

| Tool | Version | Purpose |
|------|---------|---------|
| **Python** | 3.11+ | Backend language |
| **FastAPI** | 0.110+ | API server, SSE streaming, async routes |
| **Uvicorn** | latest | ASGI server for FastAPI |
| **Playwright** | latest | Headless Chromium for server-side slide snapshots |
| **google-generativeai** | latest | Google Gemma 4 / Gemini API provider |
| **anthropic** | latest | Claude API provider |
| **openai** | latest | OpenAI-compatible provider |
| **httpx** | latest | Async HTTP for Ollama local calls |
| **pydantic** | v2 | Request/response validation, session models |
| **python-dotenv** | latest | API key management from `.env` |

### Frontend

| Tool | Version | Purpose |
|------|---------|---------|
| **Vite** | 5.x | Dev server, module bundler, HMR |
| **Vanilla JS (ES modules)** | — | State machine, event handling, no framework |
| **html2canvas** | 1.4.x | Client-side slide snapshots for comparison view |
| **Prism.js** | 1.29 | Code syntax highlighting in slides |
| **EventSource API** | native | SSE stream from backend, no library needed |

### Styling

| Tool | Purpose |
|------|---------|
| **Plain CSS** | Theme files using CSS custom properties (`--bg`, `--accent`, etc.) |
| **No Tailwind** | Slides use scoped CSS written by the LLM — utility classes would conflict |

### AI Models (configurable)

| Model | Provider | Text | Vision |
|-------|---------|------|--------|
| `gemma-4` | Google | ✅ | ✅ (native multimodal) |
| `gemini-2.0-flash` | Google | ✅ | ✅ |
| `llama3.1:8b` | Ollama (local) | ✅ | ❌ |
| `llava:13b` | Ollama (local) | ✅ | ✅ |
| `claude-sonnet-4-6` | Anthropic | ✅ | ✅ |
| `gpt-4o` | OpenAI | ✅ | ✅ |

### Export

| Tool | Purpose |
|------|---------|
| `window.print()` + print CSS | Zero-dependency PDF export for demo |
| `html2pdf.js` (optional) | Polished PDF with more control, add if time permits |

---

## 4. Feature Breakdown

### 4.1 Input Ingestion

**What it does:** Accepts four types of input from the user — a topic string, a pasted document, a video transcript, or a code file.

**How it works:**
- Frontend sends raw input + detected type to `POST /session`
- Backend classifies the input type (if not explicitly stated) using a short LLM call
- Input type influences the outline generation strategy: a code file generates slides differently from a business topic

**Tech involved:** FastAPI route, pydantic model for input validation, optional LLM classifier call

---

### 4.2 Outline Generation

**What it does:** Produces the full slide plan (titles, intents, key points, layout hints) before any slide HTML is generated.

**How it works:**
- One LLM call with the full raw input + classification
- LLM returns a JSON array of slide objects
- User sees this outline immediately in the sidebar
- User can edit titles, reorder, add, or remove slides before committing
- Confirmed outline stored in session and never regenerated

**Tech involved:** FastAPI `POST /session`, LLM provider `stream_text()`, pydantic `OutlineItem` model, frontend outline panel

---

### 4.3 Per-Slide HTML Generation (Core Feature)

**What it does:** For each slide in the outline, generates a complete `<section class="slide">` HTML block including scoped CSS and interactive JS.

**How it works:**
- Backend receives `POST /session/{id}/slide/{n}`
- Builds a prompt containing: deck context JSON, current slide intent and key points, style rules, CSS variable reference
- Sends prompt to configured LLM
- Streams raw HTML tokens back to frontend via SSE
- Frontend injects partial HTML into preview iframe as it arrives
- Once stream ends, frontend captures snapshot via html2canvas

**Tech involved:** FastAPI SSE route, LLM `stream_text()`, `EventSource` on frontend, iframe injection, html2canvas post-stream

---

### 4.4 Deck Context (Memory System)

**What it does:** Keeps a running JSON record of everything every slide has said, defined, and covered. Prevents hallucination and drift across multi-slide decks.

**How it works:**
- After each slide is approved, the LLM generates a short summary of what the slide covered
- This summary is appended to `deck_context.json` under `slides_summary`, `key_terms_defined`, and `concepts_covered`
- Every subsequent slide generation prompt receives this full JSON
- The LLM's system prompt instructs it to never redefine what is already in context

**Tech involved:** In-memory dict in FastAPI session, serialized to JSON per request, injected into every LLM prompt

---

### 4.5 Iterative Refinement

**What it does:** Allows the user to transform the current slide without losing it — simplify, expand, add an example, or make it more interactive.

**How it works:**
- User clicks a refinement button (Simplify / Expand / Add Example / Make Interactive)
- Frontend enters comparison mode before triggering the API call
- Backend regenerates the slide with a refinement-specific prompt suffix
- The current slide's snapshot is sent to the LLM as visual context ("here is what you produced — improve it")
- New HTML streams into the right panel of the comparison view

**Tech involved:** `POST /session/{id}/slide/{n}/refine`, refinement prompt variants, current slide snapshot attached as image to LLM call (if vision-capable model), SSE stream to comparison right panel

---

### 4.6 Visual Feedback via Snapshots

**What it does:** Captures a pixel-accurate screenshot of each rendered slide and sends it to the vision-capable LLM as feedback before the next generation.

**Two capture paths:**

**Client-side (html2canvas):** Used for the comparison view. Fast, runs in browser. Lower fidelity but sufficient for user-facing thumbnails.

**Server-side (Playwright):** Used for vision model feedback. Headless Chromium renders the slide HTML at full 1280×720, captures a PNG, and stores it in the session. This is then sent to the vision model as `inline_data` image input.

**How it works:**
1. Slide HTML is approved by user
2. Frontend POSTs the HTML to `POST /session/{id}/slide/{n}/snapshot`
3. Playwright headless browser renders the HTML in isolation, injects the current theme CSS
4. Screenshot captured at 1280×720, stored as base64 PNG in session
5. Next slide's prompt optionally includes: "previous slide image + visual audit result"

**Vision audit:** A separate LLM call (vision model) inspects the screenshot and returns a structured JSON: `{ visual_issues, layout_verdict, fix_instructions }`. If `layout_verdict` is `"regenerate"`, the slide is flagged before the user approves it.

**Tech involved:** Playwright async API (`async_playwright`), base64 PNG, FastAPI snapshot route, vision LLM call with `inline_data`, audit result stored in session

---

### 4.7 Split-View Comparison

**What it does:** When the user triggers any refinement, the current slide freezes on the left and the new version streams in on the right. User chooses which to keep.

**How it works:**
- `enterComparisonMode()` called immediately on refinement click — before any API call
- Left panel: current slide's HTML injected immediately (feels instant)
- Right panel: SSE stream populates live as LLM generates the refined HTML
- Once stream settles, html2canvas captures both panels
- User sees: `[← Keep this]` and `[Use this →]` and `[Refine again]`
- "Refine again" pushes the current "after" into history and starts a new refinement stream

**History strip:** Every refinement attempt that was not chosen is stored as a thumbnail at the bottom of the comparison overlay. User can click any thumbnail to restore that version as the new "before".

**Tech involved:** `comparisonState` object, html2canvas on both panels, SSE right-panel injection, history array with base64 snapshots

---

### 4.8 Multi-Model Support

**What it does:** Allows the user (or config) to choose any supported AI model for text generation and vision auditing. A single model like Gemma 4 can serve both roles.

**How it works:**
- Model string format: `"provider/model-name"` e.g. `"google/gemma-4"`, `"ollama/llava:13b"`
- `get_model(model_string)` returns the appropriate provider class instance
- All providers implement the same `BaseProvider` interface: `stream_text()` and `vision_audit()`
- If `text_model == vision_model`, the same model instance handles both — no separate process

**Gemma 4 specifics:** It is natively multimodal, so one API key and one model string handles the full pipeline. No separate vision model configuration needed.

**Tech involved:** `ai/router.py`, `ai/base.py`, `ai/providers/google.py`, `ai/providers/ollama.py`, `ai/providers/anthropic.py`

---

### 4.9 Theme System

**What it does:** Lets users switch the visual style of the entire deck instantly.

**How it works:**
- Slides use CSS custom properties: `--bg`, `--surface`, `--text`, `--accent`, `--font-head`, `--font-body`
- Theme files define these variables on `.slide`
- Switching theme = swapping the active `<link>` tag in the preview document
- The active theme name is sent with every slide generation prompt so the LLM writes CSS variables, not hardcoded colors

**Included themes:** `dark-tech` (dark background, purple accent, mono font), `clean-light` (white, blue accent, sans-serif), `brutalist` (high contrast, bold borders)

**Tech involved:** CSS custom properties, 3 CSS files, one-line JS theme switch, theme name in LLM prompt

---

### 4.10 Animations

**What it does:** Adds entrance animations to slide content that trigger as the slide becomes visible.

**How it works:**
- LLM adds `class="reveal"` and `style="--delay: 0.1s"` to elements it wants animated
- CSS defines the animation on `.reveal`, transitions triggered by `.visible` class
- IntersectionObserver adds `.visible` when a slide enters viewport
- Body blocks stagger via `--delay` increments

**Tech involved:** CSS `transition`, `transform`, `opacity`, IntersectionObserver, `--delay` CSS variable

---

### 4.11 PDF Export

**What it does:** Exports the approved deck as a PDF.

**How it works (demo version):**
- All approved slide HTML blocks are injected into a hidden `#print-container` div
- `window.print()` triggered
- Print CSS hides everything except `#print-container` and applies `page-break-after: always` per slide

**Polished version (if time allows):**
- Send all slide HTML to backend
- Playwright renders each slide to PNG
- Combine into PDF with `pypdf` or `reportlab`

**Tech involved:** `window.print()`, `@media print` CSS, optional Playwright server-side PDF

---

## 5. Pipeline: End-to-End Flow

```
User submits input
        │
        ▼
POST /session
  ├── classify input type
  ├── generate outline (LLM call 1)
  └── return outline[]
        │
        ▼
User edits outline in sidebar
        │
        ▼
User confirms → POST /session/{id}/confirm
        │
        ▼
┌────────────────────────── Per-Slide Loop ────────────────────────────┐
│                                                                       │
│   Read deck_context.json                                             │
│          │                                                           │
│          ▼                                                           │
│   POST /session/{id}/slide/{n}  (LLM call N)                        │
│   ├── inject deck context + intent + style rules into prompt        │
│   ├── stream HTML response via SSE                                  │
│   └── frontend injects partial HTML into preview live              │
│          │                                                           │
│          ▼                                                           │
│   Stream ends → html2canvas captures client snapshot               │
│          │                                                           │
│          ▼                                                           │
│   POST /session/{id}/slide/{n}/snapshot                             │
│   ├── Playwright renders full-res server snapshot                  │
│   └── Vision audit (optional): inspect screenshot, return issues   │
│          │                                                           │
│          ▼                                                           │
│   User Review State                                                 │
│   ├── Approve → update deck_context, advance to n+1               │
│   ├── Regenerate → re-run LLM call N (new attempt, same intent)   │
│   └── Refine (Simplify/Expand/Example/Interactive)                 │
│           │                                                          │
│           ▼                                                          │
│      Enter comparison mode (left: current, right: streaming)       │
│      ├── Stream refined HTML into right panel via SSE              │
│      ├── Capture both panels via html2canvas                       │
│      └── User: Keep / Use / Refine Again                           │
│              │                                                       │
│              ▼ (approved version)                                    │
│      Update deck_context.json                                       │
│      Advance to n+1                                                 │
│                                                                       │
└───────────────────────────────────────────────────────────────────────┘
        │
        ▼
All slides approved
        │
        ▼
Export (window.print() or Playwright PDF)
```

---

## 6. Backend Harness

### Directory Structure

```
backend/
├── main.py                    # FastAPI app, route registration
├── .env                       # API keys (never committed)
├── requirements.txt
│
├── routes/
│   ├── session.py             # POST /session (create, classify, outline)
│   ├── slide.py               # POST /session/{id}/slide/{n} (generate, refine)
│   └── snapshot.py            # POST /session/{id}/slide/{n}/snapshot
│
├── ai/
│   ├── router.py              # get_model("google/gemma-4") dispatcher
│   ├── base.py                # BaseProvider ABC
│   └── providers/
│       ├── google.py          # Gemma 4, Gemini Flash
│       ├── ollama.py          # Local Llama, LLaVA
│       ├── anthropic.py       # Claude
│       └── openai.py          # GPT-4o
│
├── prompts/
│   ├── classify.py            # Input type classification prompt
│   ├── outline.py             # Outline generation prompt
│   ├── slide.py               # Per-slide generation prompt
│   ├── refine.py              # Refinement variant prompts
│   ├── vision_audit.py        # Vision model snapshot audit prompt
│   └── context_update.py      # Post-approval summary prompt
│
├── models/
│   ├── session.py             # DeckSession pydantic model
│   ├── slide.py               # SlideData, SlideIntent models
│   └── audit.py               # VisionAuditResult model
│
├── services/
│   ├── context.py             # deck_context.json read/write helpers
│   ├── snapshot.py            # Playwright capture service
│   └── sse.py                 # SSE response builder
│
└── store/
    └── sessions.py            # In-memory session dict (sessions: dict[str, DeckSession])
```

### Core Routes

```python
# routes/session.py
POST /session
  Body:  { input_type, raw_input, theme, text_model, vision_model }
  Does:  classify → outline LLM call → store session
  Returns: { session_id, outline: OutlineItem[] }

POST /session/{id}/confirm
  Body:  { outline: OutlineItem[] }  # user-edited version
  Does:  stores confirmed outline, sets session.status = "generating"
  Returns: { status: "ready", total_slides: int }

# routes/slide.py
POST /session/{id}/slide/{n}
  Body:  {}
  Does:  reads deck_context → builds prompt → streams HTML via SSE
  Returns: SSE stream of HTML tokens

POST /session/{id}/slide/{n}/refine
  Body:  { mode: "simplify"|"expand"|"example"|"interactive" }
  Does:  reads current slide HTML + snapshot → builds refine prompt → streams
  Returns: SSE stream of refined HTML tokens

POST /session/{id}/slide/{n}/approve
  Body:  { html: string }  # final approved HTML
  Does:  LLM generates slide summary → updates deck_context → advances index
  Returns: { status: "approved", next_index: int }

# routes/snapshot.py
POST /session/{id}/slide/{n}/snapshot
  Body:  { html: string }
  Does:  Playwright renders HTML → captures PNG → runs vision audit
  Returns: { snapshot_b64: string, audit: VisionAuditResult }
```

### Session Model

```python
# models/session.py
class DeckSession(BaseModel):
    session_id: str
    status: str           # idle | outlining | generating | reviewing | done
    input_type: str       # topic | document | transcript | code
    raw_input: str
    text_model: str       # "google/gemma-4"
    vision_model: str     # "google/gemma-4"
    theme: str            # "dark-tech"
    outline: list[OutlineItem]
    slides: list[SlideData]   # approved slides
    current_index: int
    deck_context: dict        # the live memory JSON
```

### SSE Streaming Pattern

```python
# services/sse.py
from fastapi.responses import StreamingResponse

async def stream_llm_response(generator):
    async def event_stream():
        async for token in generator:
            yield f"data: {token}\n\n"
        yield "data: [DONE]\n\n"
    return StreamingResponse(event_stream(), media_type="text/event-stream")
```

---

## 7. Frontend Harness

### Directory Structure

```
frontend/
├── index.html
├── vite.config.js
│
├── main.js                    # app entry, state machine, dispatch()
│
├── api/
│   └── client.js              # fetch wrappers + SSE stream reader
│
├── renderer/
│   ├── index.js               # mountSlide(html) — injects into preview
│   └── blocks.js              # renderBlock() for static fallback
│
├── ui/
│   ├── outline.js             # left panel: outline list, edit, confirm
│   ├── preview.js             # center: slide preview iframe
│   ├── controls.js            # approve/regen/simplify/expand/example buttons
│   ├── comparison.js          # split-view overlay, history strip
│   └── topbar.js              # theme picker, model picker, export button
│
├── snapshot/
│   └── capture.js             # html2canvas wrapper, waitForSlideReady()
│
├── themes/
│   ├── dark-tech.css
│   ├── clean-light.css
│   └── brutalist.css
│
└── export.js                  # window.print() PDF export
```

### State Machine

```javascript
// main.js
const state = {
  session: null,
  outline: [],
  slides: [],           // approved SlideData[]
  currentIndex: 0,
  currentSlide: null,   // HTML string pending approval
  status: 'idle'        // idle | outlining | generating | reviewing | done
};

// 5 statuses, one transition function
function dispatch(action) {
  switch (action.type) {
    case 'SESSION_CREATED':   /* store session_id, outline, render outline panel */ break;
    case 'OUTLINE_CONFIRMED': /* set status=generating, call generateSlide(0) */ break;
    case 'SLIDE_STREAM_START':/* show streaming indicator in preview */ break;
    case 'SLIDE_TOKEN':       /* append token to preview iframe */ break;
    case 'SLIDE_READY':       /* status=reviewing, enable action buttons */ break;
    case 'APPROVE':           /* push to slides[], advance index, next generate */ break;
    case 'REFINE':            /* enter comparison mode, trigger refine stream */ break;
    case 'COMPARISON_RESOLVED': /* update currentSlide, exit comparison mode */ break;
    case 'DONE':              /* show export button, summary screen */ break;
  }
  render();
}
```

### SSE Client Pattern

```javascript
// api/client.js
export async function* streamSlide(sessionId, n) {
  const es = new EventSource(`/api/session/${sessionId}/slide/${n}`);
  // wrap EventSource in async generator for clean consumption
  for await (const token of eventSourceToGenerator(es)) {
    if (token === '[DONE]') break;
    yield token;
  }
}

// usage in main.js
for await (const token of streamSlide(state.session.id, state.currentIndex)) {
  dispatch({ type: 'SLIDE_TOKEN', token });
}
dispatch({ type: 'SLIDE_READY' });
```

### UI Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [Project Name]   [Theme ▾]  [Model ▾]            [Export PDF]  │  ← topbar.js
├─────────────────┬────────────────────────────────────────────────┤
│                 │                                                │
│  OUTLINE        │     SLIDE PREVIEW                             │
│  ──────────     │     ─────────────────────────────────         │
│  1. Title  ✓   │     ┌─────────────────────────────────────┐   │
│  2. Intro  ✓   │     │                                     │   │
│  3. Mech ◄──   │     │     [live slide HTML in iframe]     │   │
│  4. ...        │     │                                     │   │
│  5. ...        │     └─────────────────────────────────────┘   │
│  6. Summary    │                                                │
│                │   [Simplify] [Expand] [Example] [Interactive] │
│  [Edit]        │   [↻ Regen]                    [Approve →]    │
│                │                                                │
│                │   ▓▓▓▓▓▓▓▓▒▒▒▒░░░░  Generating 3/8...        │
└─────────────────┴────────────────────────────────────────────────┘
```

---

## 8. Multi-Model AI Layer

### Provider Interface

```python
# ai/base.py
from abc import ABC, abstractmethod
from typing import AsyncIterator

class BaseProvider(ABC):
    @abstractmethod
    async def stream_text(
        self,
        messages: list[dict],
        system: str
    ) -> AsyncIterator[str]:
        """Stream text tokens."""
        pass

    @abstractmethod
    async def vision_audit(
        self,
        prompt: str,
        image_b64: str
    ) -> str:
        """Send image + prompt, return full response string."""
        pass
```

### Router

```python
# ai/router.py
from .providers.google import GoogleProvider
from .providers.ollama import OllamaProvider
from .providers.anthropic import AnthropicProvider
from .providers.openai import OpenAIProvider

PROVIDERS = {
    "google":    GoogleProvider,
    "ollama":    OllamaProvider,
    "anthropic": AnthropicProvider,
    "openai":    OpenAIProvider,
}

_cache: dict[str, BaseProvider] = {}

def get_model(model_string: str) -> BaseProvider:
    if model_string not in _cache:
        provider_name, model_name = model_string.split("/", 1)
        _cache[model_string] = PROVIDERS[provider_name](model_name)
    return _cache[model_string]
```

### Google Provider (Gemma 4)

```python
# ai/providers/google.py
import google.generativeai as genai
from ..base import BaseProvider
import os

class GoogleProvider(BaseProvider):
    def __init__(self, model: str):
        genai.configure(api_key=os.getenv("GOOGLE_API_KEY"))
        self.model_name = model
        self.client = genai.GenerativeModel(model)

    async def stream_text(self, messages, system):
        response = await self.client.generate_content_async(
            contents=messages,
            system_instruction=system,
            stream=True,
            generation_config=genai.GenerationConfig(temperature=0.5)
        )
        async for chunk in response:
            if chunk.text:
                yield chunk.text

    async def vision_audit(self, prompt, image_b64):
        import base64
        image_part = {
            "inline_data": {
                "mime_type": "image/png",
                "data": image_b64
            }
        }
        response = await self.client.generate_content_async(
            contents=[prompt, image_part]
        )
        return response.text
```

### Environment Variables

```bash
# .env
GOOGLE_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
# Ollama needs no key — talks to localhost:11434
```

---

## 9. Snapshot & Vision Feedback System

### Two Capture Paths Explained

**Path 1 — Client html2canvas (comparison view thumbnails):**
- Runs in the browser
- Captures the DOM as rendered by the browser engine
- Fast (~200ms), lower fidelity
- Used for: side-by-side comparison thumbnails, history strip

**Path 2 — Server Playwright (vision model feedback):**
- Headless Chromium via Playwright
- Renders the slide HTML in isolation with full CSS
- Pixel-accurate at 1280×720
- Used for: sending to vision model for layout audit

### Playwright Capture Service

```python
# services/snapshot.py
from playwright.async_api import async_playwright

SLIDE_WRAPPER = """
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="stylesheet" href="/themes/{theme}.css">
  <link rel="stylesheet" href="/prism.css">
  <style>
    body {{ margin: 0; padding: 0; width: 1280px; height: 720px; overflow: hidden; }}
    .slide {{ width: 1280px; height: 720px; }}
  </style>
</head>
<body>{slide_html}</body>
</html>
"""

async def capture_slide(html: str, theme: str) -> str:
    wrapped = SLIDE_WRAPPER.format(slide_html=html, theme=theme)

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1280, "height": 720})
        await page.set_content(wrapped, wait_until="networkidle")
        await page.wait_for_timeout(400)   # let animations settle

        screenshot = await page.screenshot(type="png")
        await browser.close()

    import base64
    return base64.b64encode(screenshot).decode()
```

### Vision Audit Prompt

```python
# prompts/vision_audit.py
VISION_AUDIT_PROMPT = """
You generated the HTML below. The attached image shows how it rendered in a 1280x720 browser.

Inspect the image and identify any of:
- Content overflowing slide bounds
- Empty or underused right panel in a split layout
- Text too dense or too sparse
- Heading wrapping badly
- Code blocks clipped or unreadable
- Poor left/right visual balance

HTML: {html}

Return ONLY this JSON:
{{
  "visual_issues": [],
  "layout_verdict": "good" | "fixable" | "regenerate",
  "fix_instructions": "string or null"
}}
"""
```

---

## 10. Split-View Comparison & History

### State

```javascript
// ui/comparison.js
const comparisonState = {
  active: false,
  slideId: null,
  mode: null,            // "simplify" | "expand" | "example" | "interactive"

  before: {
    html: null,
    snapshot: null,      // base64 from html2canvas
    label: "Current"
  },

  after: {
    html: "",
    snapshot: null,
    streaming: true,
    label: null          // set to mode string
  },

  history: []            // previous attempts: [{html, snapshot, label}]
};
```

### Entering Comparison Mode

```javascript
export async function enterComparisonMode(slideId, mode) {
  const current = store.getState().currentSlide;

  comparisonState.active = true;
  comparisonState.slideId = slideId;
  comparisonState.mode = mode;
  comparisonState.before = {
    html: current.html,
    snapshot: current.snapshot,
    label: "Current"
  };
  comparisonState.after = { html: "", snapshot: null, streaming: true, label: mode };
  comparisonState.history = [];

  renderOverlay();

  // stream refined slide into right panel
  for await (const token of api.streamRefine(slideId, mode)) {
    comparisonState.after.html += token;
    updateRightPanel(comparisonState.after.html);
  }

  comparisonState.after.streaming = false;
  comparisonState.after.snapshot = await capture(rightPanelEl());
  renderOverlay();
}
```

### Refine Again

```javascript
export async function refineAgain() {
  // push current "after" to history as a saved attempt
  comparisonState.history.push({ ...comparisonState.after });

  // current "after" becomes the new "before"
  comparisonState.before = { ...comparisonState.after };
  comparisonState.after = { html: "", snapshot: null, streaming: true, label: comparisonState.mode };

  renderOverlay();
  // re-stream
  for await (const token of api.streamRefine(comparisonState.slideId, comparisonState.mode)) {
    comparisonState.after.html += token;
    updateRightPanel(comparisonState.after.html);
  }
  // ...
}
```

---

## 11. Deck Context JSON (Memory System)

### Schema

```json
{
  "deck": {
    "title": "Introduction to WebGPU",
    "theme": "dark-tech",
    "total_slides": 8,
    "audience": "intermediate developers",
    "tone": "technical, concise"
  },

  "context": {
    "key_terms_defined": [
      "command encoder",
      "bind group",
      "render pipeline"
    ],
    "concepts_covered": [
      "GPU memory model covered in slide 2",
      "Pipeline stages explained in slide 3"
    ],
    "facts_stated": [
      "WebGPU is not WebGL",
      "Compute shaders run outside the render pipeline"
    ],
    "running_narrative": "Covered architecture and memory. Next: data flow."
  },

  "slides_summary": [
    {
      "index": 1,
      "title": "What is WebGPU?",
      "covered": ["history", "browser support", "vs WebGL"],
      "layout_style": "title-hero"
    }
  ]
}
```

### Update After Approval

```python
# prompts/context_update.py
CONTEXT_UPDATE_PROMPT = """
A slide was just approved. Summarize what it added to the presentation.

Slide HTML: {html}
Current context: {current_context_json}

Return ONLY updated context JSON — same schema, with new entries appended.
Do not remove existing entries. Only add. Return raw JSON.
"""
```

---

## 12. Theme System

### CSS Structure

```css
/* themes/dark-tech.css */
.slide {
  --bg:          #0d0d0d;
  --surface:     #141414;
  --text:        #f0f0f0;
  --text-muted:  #888888;
  --accent:      #7c3aed;
  --accent-glow: #7c3aed33;
  --code-bg:     #1a1a2e;
  --border:      #2a2a2a;
  --font-head:   'JetBrains Mono', monospace;
  --font-body:   'Inter', sans-serif;
}
```

### Theme Switch (1 line)

```javascript
// ui/topbar.js
function setTheme(name) {
  document.getElementById('theme-link').href = `/themes/${name}.css`;
  store.dispatch({ type: 'THEME_CHANGED', theme: name });
  // theme name also sent with next slide generation call
}
```

---

## 13. Animation Layer

```css
/* global.css */
.reveal {
  opacity: 0;
  transform: translateY(20px);
  transition: opacity 0.45s ease, transform 0.45s ease;
  transition-delay: var(--delay, 0s);
}

.reveal.visible {
  opacity: 1;
  transform: none;
}
```

```javascript
// renderer/index.js — set up once globally
const observer = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (e.isIntersecting) e.target.classList.add('visible');
  });
}, { threshold: 0.1 });

function observeReveals(container) {
  container.querySelectorAll('.reveal').forEach(el => observer.observe(el));
}
```

The LLM is instructed in its style rules to add `class="reveal"` and `style="--delay: Xs"` to stagger elements. It handles the creative ordering; the CSS and observer handle the execution.

---

## 14. PDF Export

### Demo Version (zero dependencies)

```javascript
// export.js
export function exportPDF(slides, theme) {
  const container = document.createElement('div');
  container.id = 'print-container';
  container.innerHTML = slides.map(s => s.html).join('');
  document.body.appendChild(container);
  window.print();
  document.body.removeChild(container);
}
```

```css
/* global.css */
@media print {
  body > *:not(#print-container) { display: none !important; }
  #print-container .slide {
    page-break-after: always;
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    box-shadow: none;
  }
}
```

### Polished Version (Playwright server-side)

```python
# routes/export.py
@app.get("/session/{id}/export/pdf")
async def export_pdf(id: str):
    session = get_session(id)
    html_pages = [s.html for s in session.slides]

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        full_html = build_deck_html(html_pages, session.theme)
        await page.set_content(full_html)
        pdf_bytes = await page.pdf(format="A4", landscape=True, print_background=True)
        await browser.close()

    return Response(content=pdf_bytes, media_type="application/pdf")
```

---

## 15. Debugging Strategy

### Backend Debugging

**Structured logging per route:**
```python
import logging
logger = logging.getLogger("slide_gen")

# At the start of each route handler:
logger.info(f"[slide/{n}] prompt_tokens={len(prompt)} model={session.text_model}")

# After LLM stream completes:
logger.info(f"[slide/{n}] html_length={len(html)} duration={elapsed:.2f}s")

# On vision audit:
logger.info(f"[audit/{n}] verdict={audit.layout_verdict} issues={audit.visual_issues}")
```

**Dump prompt to file on failure:**
```python
if os.getenv("DEBUG_PROMPTS"):
    with open(f"debug/prompt_slide_{n}.txt", "w") as f:
        f.write(full_prompt)
```

**Harness for testing single slide generation without frontend:**
```python
# scripts/test_slide.py
import asyncio
from ai.router import get_model
from prompts.slide import build_slide_prompt

async def main():
    model = get_model("google/gemma-4")
    prompt = build_slide_prompt(
        n=2, total=6,
        title="The GPU Memory Model",
        intent="explain-mechanism",
        key_points=["buffers", "textures", "bind groups"],
        deck_context={},
        theme="dark-tech"
    )
    html = ""
    async for token in model.stream_text([{"role":"user","content":prompt}], system=""):
        html += token
        print(token, end="", flush=True)

    with open("debug/slide_2_output.html", "w") as f:
        f.write(html)

asyncio.run(main())
```
Run this independently to test any slide generation call in isolation. Open the output HTML file in a browser to verify rendering.

**Test all providers:**
```bash
python scripts/test_provider.py --model "google/gemma-4"
python scripts/test_provider.py --model "ollama/llama3.1:8b"
python scripts/test_provider.py --model "anthropic/claude-sonnet-4-6"
```

---

### Frontend Debugging

**State inspector (dev only):**
```javascript
// main.js — dev helper
window.__state = () => console.table(state);
window.__dispatch = dispatch;   // allows dispatch from browser console
```

**SSE stream monitor:**
```javascript
// api/client.js
if (import.meta.env.DEV) {
  console.group(`SSE /slide/${n}`);
  // log token count every 50 tokens
}
```

**Comparison view in isolation:**
```javascript
// Load a hardcoded before/after pair to test the comparison UI without LLM
window.__testComparison = () => {
  enterComparisonMode('test', 'expand', {
    before: { html: SAMPLE_SLIDE_HTML, snapshot: null },
  });
};
```

**html2canvas failure fallback:**
```javascript
export async function captureSlide(el) {
  try {
    const canvas = await html2canvas(el, { scale: 0.5 });
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.warn('html2canvas failed, using placeholder', e);
    return null;   // null snapshot = skip visual feedback, pipeline continues
  }
}
```

---

### LLM Output Debugging

The LLM should return valid HTML. Common failure modes and mitigations:

| Failure | Cause | Mitigation |
|---------|-------|-----------|
| Markdown fences in output | LLM adds ` ```html ` | Strip ` ```html ` and ` ``` ` server-side before returning |
| JSON inside HTML | LLM confused context | Add explicit rule: "Return ONLY the `<section>` element" |
| Missing closing tags | Stream truncation | Wrap inject in `try {}` catch, show partial slide with warning |
| Script errors in slide | LLM JS bugs | Sandbox in iframe with `sandbox="allow-scripts"` |
| CSS variable not used | LLM uses hex colors | Add rule: "Never use hardcoded colors — only CSS variables" |
| Slide too long (overflow) | LLM too verbose | Add rule: "Content must fit in 1280x720. Max 4 body blocks." |

**Strip markdown fences:**
```python
# services/stream_cleanup.py
def clean_html_stream(raw: str) -> str:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1]   # remove first line
    if raw.endswith("```"):
        raw = raw.rsplit("```", 1)[0]  # remove last fence
    return raw.strip()
```

**Validate HTML contains a slide section:**
```python
def validate_slide_html(html: str) -> bool:
    return '<section' in html and 'class="slide"' in html
```

---

### Playwright Snapshot Debugging

```python
# In capture_slide(), dev mode saves to disk for inspection
if os.getenv("DEBUG_SNAPSHOTS"):
    with open(f"debug/snapshot_slide_{slide_n}.png", "wb") as f:
        f.write(screenshot_bytes)
```

Open `debug/snapshot_slide_N.png` to see exactly what the vision model receives.

---

## 16. 5-Day Build Plan

| Day | Goal | What Gets Built |
|-----|------|----------------|
| **Day 1** | Foundation | FastAPI skeleton, all routes stubbed, AI router + Google/Ollama providers, outline generation working end-to-end |
| **Day 2** | Core loop | Per-slide HTML generation streaming, SSE to frontend, 2-3 layouts rendering correctly in preview iframe, deck context JSON updating on approval |
| **Day 3** | Frontend state | Vanilla JS state machine wired, outline sidebar, approve/regen loop functional, comparison mode UI (left panel only) |
| **Day 4** | Visual features | Comparison split view with streaming right panel, html2canvas snapshots, history strip, themes, animations |
| **Day 5** | Polish + demo | Playwright snapshot + vision audit, PDF export, 3 demo scenarios rehearsed, error handling, cut anything that isn't working |

### What to Cut If Time Runs Short (priority order)

1. Playwright / vision audit — use client html2canvas only, skip AI visual feedback
2. History strip in comparison view — just keep current vs refined
3. Brutalist theme — ship 2 themes
4. Server-side PDF — use `window.print()`
5. Comparison mode — just regenerate in place

### What Must Ship No Matter What

- SSE streaming (makes local models feel fast)
- Outline sidebar (gives the demo a sense of structure)
- Approve / Regenerate loop (core value proposition)
- At least one refinement action working (Add Example is the most impressive to demo)
- One polished theme

---

## 17. Demo Strategy

### Three Canned Scenarios

Prepare these inputs in advance so demo never waits for you to type:

1. **Technical:** "Explain the WebGPU rendering pipeline to intermediate web developers" → model: `google/gemma-4` → theme: `dark-tech`
2. **Business:** "Pitch a B2B SaaS tool for async team standup" → model: `google/gemma-4` → theme: `clean-light`
3. **Code file:** Paste a 50-line Python function → model: `google/gemma-4` → theme: `dark-tech`

### Demo Script (6 minutes)

```
0:00 - Paste topic, show outline generated instantly
0:45 - Walk through outline panel, delete one slide, reorder another
1:15 - Confirm outline, watch slide 1 stream in live (show the HTML tokens appearing)
2:00 - Approve slide 1, watch slide 2 begin streaming immediately
2:45 - Hit "Add Example" on slide 2 — split view appears
3:15 - Show before/after comparison, hit "Refine again"
4:00 - Accept the refined version, continue to slide 3
4:30 - Switch theme from dark-tech to clean-light (instant)
5:00 - Hit Export PDF, show browser print dialog
5:30 - Q&A
```

### The Moment That Always Gets a Reaction

The split-view comparison appearing instantly (before panel freezes, after panel begins streaming) while the LLM visibly builds the new HTML in real time. Stage this as the centerpiece of the demo.

---

*Report generated for hackathon planning. Stack validated against 5-day build constraint.*