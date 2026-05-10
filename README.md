# Vapor Deck

**AI-powered, web-native presentation generator.** Describe a topic, upload reference material, and get a full slide deck rendered as production-quality HTML — streamed live, with vision-model layout auditing built in.

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Running the App](#running-the-app)
- [Core Workflow](#core-workflow)
- [Features](#features)
- [Design System](#design-system)
- [API Reference](#api-reference)
- [Configuration](#configuration)
- [Development](#development)

---

## Overview

Vapor Deck generates presentation slides as interactive HTML fragments rather than static images or PowerPoint files. Each slide is a self-contained `<section class="slide">` element with scoped CSS and optional JavaScript — rendered in an isolated iframe, streamed token-by-token from an LLM backend.

The pipeline has three phases:

1. **Plan** — Upload context (text, PDFs, images), synthesize a deck outline, refine it via chat.
2. **Design** — Chat with a Design AI to establish a color palette, typography, and visual language.
3. **Build** — Generate slides one at a time (or all at once), refine with natural language, and audit layout automatically with a vision model.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (Vite)                    │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │
│  │ Outline  │  │  Slide   │  │  Interaction Shell   │  │
│  │ Sidebar  │  │ Preview  │  │  Plan / Design /     │  │
│  │          │  │ (iframe) │  │  Build modes         │  │
│  └──────────┘  └──────────┘  └──────────────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTP + SSE
┌──────────────────────▼──────────────────────────────────┐
│                  Backend (FastAPI)                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  │
│  │ Session  │  │  Slide   │  │ Snapshot │  │ Design │  │
│  │  Route   │  │  Route   │  │  Route   │  │ Route  │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───┬────┘  │
│       └─────────────┴─────────────┴─────────────┘       │
│                   AI Router                             │
│         ┌──────────────────────────┐                    │
│         │  Ollama  │  Google Gemini│                    │
│         └──────────────────────────┘                    │
└────────────────────────────────────┬────────────────────┘
                                     │
                              Project Directory
                         ┌───────────────────────┐
                         │  vapor_deck.json       │
                         │  design.json           │
                         │  slides/               │
                         │  assets/               │
                         │  snapshots/            │
                         └───────────────────────┘
```

### Three-Layer CSS Architecture

Slide styling is intentionally layered:

| Layer | File                        | Scope                                                       |
| ----- | --------------------------- | ----------------------------------------------------------- |
| 1     | `front/src/style.css`       | App UI only — never touches slides                          |
| 2     | `front/public/themes/*.css` | Theme variables injected into each slide iframe             |
| 3     | `<style>` inside LLM HTML   | Per-slide scoped overrides using CSS variables from Layer 2 |

---

## Project Structure

```
vapor-deck/
├── vapor_deck.py              # CLI launcher — starts backend + frontend
│
├── front/                     # Vite frontend
│   ├── src/
│   │   ├── main.js            # App entry point, all orchestration logic
│   │   ├── state.js           # Centralized application state
│   │   ├── ui.js              # DOM rendering (outline, chat, slide info)
│   │   ├── events.js          # Event listener setup
│   │   ├── resizers.js        # Drag-to-resize sidebar/panel logic
│   │   ├── export.js          # PDF export via window.print()
│   │   ├── api/
│   │   │   └── client.js      # All backend API calls
│   │   ├── renderer/
│   │   │   ├── iframe.js      # Isolated iframe renderer + base document builder
│   │   │   └── index.js       # Public renderer API
│   │   └── ui/
│   │       ├── comparison.js  # Split-view before/after refinement overlay
│   │       └── global_control.js  # Deck-wide controls (add/remove/reorder slides)
│   ├── public/
│   │   └── themes/
│   │       ├── dark-tech.css
│   │       ├── clean-light.css
│   │       └── brutalist.css
│   └── index.html
│
├── harness/                   # FastAPI backend
│   ├── main.py                # App factory, middleware, route registration
│   ├── models/
│   │   ├── session.py         # DeckSession, OutlineItem, SlideData
│   │   ├── input_unit.py      # InputUnit (text/doc/image with chunks)
│   │   └── audit.py           # VisionAuditResult
│   ├── routes/
│   │   ├── session.py         # Session lifecycle + outline management
│   │   ├── slide.py           # Slide generation, refinement, plan chat
│   │   ├── snapshot.py        # Vision audit pipeline
│   │   ├── upload.py          # File + text upload
│   │   ├── design.py          # Design AI chat
│   │   └── assets.py          # Local asset listing
│   ├── ai/
│   │   ├── base.py            # BaseProvider ABC
│   │   ├── router.py          # Provider registry + instance cache
│   │   └── providers/
│   │       ├── ollama.py      # Ollama (local models)
│   │       └── google.py      # Google Gemini / Gemma
│   ├── prompts/
│   │   ├── outline.py         # Text-only and multimodal outline prompts
│   │   ├── slide.py           # Per-slide generation prompt + intent guidance
│   │   ├── vision_audit.py    # Layout audit prompt
│   │   └── context_update.py  # Running deck narrative update prompt
│   ├── services/
│   │   ├── context_synthesis.py   # Fuse input units into deck_context
│   │   ├── snapshot.py            # Vision audit orchestration
│   │   ├── theme_compiler.py      # Embed theme CSS for standalone files
│   │   ├── stream_utils.py        # collect_stream, strip_fences helpers
│   │   ├── html_validator.py      # Structural HTML validation
│   │   └── extractors/
│   │       ├── text_extractor.py  # Plain text → InputUnit
│   │       ├── document_extractor.py  # PDF/DOCX → InputUnit + semantic summary
│   │       └── image_extractor.py     # Image → InputUnit (palette + description)
│   └── store/
│       └── sessions.py        # File-backed session persistence
│
└── design_skill.md            # Design AI prompt guidelines (read at runtime)
```

---

## Prerequisites

- **Python 3.11+**
- **Node.js 20.19+ or 22.12+** (required by Vite 8 / Rolldown)
- **[Ollama](https://ollama.com)** running locally on port `11434` (default)
- Optionally: a **Google API key** for Gemini/Gemma models

### Recommended Ollama models

| Role            | Model                                             |
| --------------- | ------------------------------------------------- |
| Text generation | `qwen3-coder` or any capable instruction model    |
| Vision audit    | `qwen2.5vl` or `llava` (must support image input) |

---

## Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd vapor-deck

# 2. Install Python dependencies
cd harness
pip install -r requirements.txt
cd ..

# 3. Install frontend dependencies
cd front
npm install
cd ..

# 4. Create a .env file in harness/
cat > harness/.env <<EOF
VAPOR_TEXT_MODEL=ollama/your-text-model
VAPOR_VISION_MODEL=ollama/your-vision-model
OLLAMA_HOST=http://localhost:11434

# Optional — for Google Gemini provider
# GOOGLE_API_KEY=your_key_here
EOF
```

---

## Running the App

```bash
# Start both backend and frontend with a single command
python vapor_deck.py /path/to/your/project

# Example
python vapor_deck.py ~/decks/my-presentation
```

This will:

- Create the project directory structure (`slides/`, `assets/`, `snapshots/`)
- Start the FastAPI backend on `http://localhost:8000`
- Start the Vite dev server on `http://localhost:5173`

Open `http://localhost:5173` in your browser.

To stop, press `Ctrl+C`.

### Manual startup (for development)

```bash
# Terminal 1 — backend
cd harness
VAPOR_PROJECT_DIR=/path/to/project uvicorn main:app --reload --port 8000

# Terminal 2 — frontend
cd front
npm run dev
```

---

## Core Workflow

### 1. Plan Mode

Enter a topic in the prompt bar and click **Generate Outline**. Vapor Deck will:

1. Upload your topic text to the backend
2. Synthesize a `deck_context` object (audience, tone, key themes, narrative arc)
3. Generate a structured JSON outline (title, intent, key points, layout hint per slide)
4. Present the outline for review in the sidebar

You can also upload **context files** before generating:

- **Images** (PNG, JPG, WEBP, SVG) — analyzed by the vision model; assigned to relevant slides automatically
- **Documents** (PDF, DOCX) — parsed and summarized; key facts grounded into slide content

Once the outline looks right, click **Confirm** to lock it and move to generation.

Alternatively, keep chatting in Plan mode to refine individual slides, add new ones, or reorder the narrative.

### 2. Design Mode

Switch to **Design** mode to talk with the Design AI. Describe a visual mood, reference a brand, or ask for something specific:

> "Make it feel like a high-end tech magazine. Dark background, electric purple accents, editorial typography."

The Design AI outputs a `design_config` with palette, fonts, atmospheric feel, and component DNA — persisted to `design.json` and injected into every subsequent slide prompt.

### 3. Build Mode

Switch to **Build** mode and click the **✧** button next to any slide in the sidebar, or hit **✧ Generate All** to queue them all.

Slides stream in real time. After generation:

- A vision model automatically audits the layout (overflow, clipping, contrast, spacing)
- The **👁 indicator** in the top-right of the preview shows the audit result
- If issues are found, a **✦ Fix Issues** button appears — click it to apply a targeted refinement

To manually refine any slide, type an instruction in the Build input and press **Refine ✦**. A split-view comparison lets you keep the current version or adopt the refinement.

### Exporting

Click **Export PDF** to print all generated slides via the browser's print dialog (landscape A4).

---

## Features

### Streaming Generation

Slide HTML is streamed token-by-token over SSE. The iframe updates live as content arrives.

### Vision Audit Pipeline

After each slide is generated, a screenshot is captured via `html2canvas` and sent to the vision model alongside the slide HTML. The model checks for:

- Content overflow or clipping
- Lopsided/unbalanced layouts
- Unreadable code blocks
- Contrast issues
- Awkward text wrapping
- Bad spacing and empty regions

Verdicts: `good` / `fixable` / `regenerate`. Fixable and regenerate verdicts include a `refine_prompt` the user can apply with one click.

### Multimodal Outline Generation

When images or documents are uploaded, the outline prompt is enriched with:

- Semantic summaries of each document (topics, key facts)
- Content descriptions of each image
- LLM-driven assignment of images to the slides they best match

### Comparison Mode

Every refinement opens a split-view overlay. The original is frozen on the left; the refined version streams on the right. A history strip shows all previous attempts for the session.

### Global Deck Controls

- **Add Slide** — insert a new slide with a title and description; the AI integrates it into the outline
- **Reorder** — drag and drop slides in the sidebar to rearrange
- **Generate All** — queue all unbuilt slides for concurrent generation (up to 2 at a time)
- **Present** — fullscreen slideshow mode (also triggered with `F`)

### Session Persistence

Sessions are saved to `vapor_deck.json` in the project directory. The frontend caches draft HTML, audit results, and chat history in `localStorage` keyed by session ID. Refreshing the page restores the full workspace state.

### Standalone Slide Files

Every approved slide is saved as:

- `slides/slide_NN.html` — bare HTML fragment
- `slides/slide_NN_standalone.html` — full document with theme CSS embedded inline (opens directly in any browser)
- `slides/slide_NN.json` — slide metadata + audit result

---

## Design System

Three built-in themes, selectable from the header dropdown:

| Theme         | Feel                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| `dark-tech`   | Black background, purple/violet accents, monospace headlines, code-forward |
| `clean-light` | White background, blue accents, Inter typography, minimal                  |
| `brutalist`   | Off-white, red accents, Impact headlines, heavy borders, raw               |

Each theme exposes CSS variables that the LLM is instructed to use for all colors:

```css
--bg          /* slide background */
--surface     /* card / panel background */
--text        /* primary text */
--text-muted  /* secondary text */
--accent      /* highlight color */
--accent-glow /* rgba glow version of accent */
--border      /* divider / border color */
--code-bg     /* code block background */
--font-head   /* headline font stack */
--font-body   /* body font stack */
--font-mono   /* monospace font stack */
```

Custom palettes from the Design AI override these variables at the section level.

---

## API Reference

### Session Management

| Method   | Endpoint                       | Description                                       |
| -------- | ------------------------------ | ------------------------------------------------- |
| `POST`   | `/api/session`                 | Create a new session                              |
| `GET`    | `/api/session/active`          | Get the active session from the project directory |
| `DELETE` | `/api/session/{id}`            | Delete a session and clean up files               |
| `POST`   | `/api/session/{id}/synthesize` | Synthesize uploaded inputs into `deck_context`    |
| `POST`   | `/api/session/{id}/outline`    | Generate a slide outline                          |
| `POST`   | `/api/session/{id}/confirm`    | Confirm the outline and begin generation          |
| `PUT`    | `/api/session/{id}/mode`       | Switch between `plan`, `design`, `build`          |

### Outline Controls

| Method   | Endpoint                            | Description                                                |
| -------- | ----------------------------------- | ---------------------------------------------------------- |
| `POST`   | `/api/session/{id}/chat`            | Plan mode chat — refine or add to outline                  |
| `POST`   | `/api/session/{id}/outline/add`     | Add a new slide to the outline                             |
| `POST`   | `/api/session/{id}/outline/reorder` | Reorder slides (pass new index permutation)                |
| `DELETE` | `/api/session/{id}/outline/{n}`     | Remove slide N (cannot remove approved slides)             |
| `PUT`    | `/api/session/{id}/deck-settings`   | Update global deck settings (tone, audience, instructions) |

### Slide Generation

| Method | Endpoint                                     | Description                           |
| ------ | -------------------------------------------- | ------------------------------------- |
| `POST` | `/api/session/{id}/slide/{slide_id}`         | Generate a slide — returns SSE stream |
| `POST` | `/api/session/{id}/slide/{slide_id}/approve` | Approve and persist slide HTML        |
| `POST` | `/api/session/{id}/slide/{slide_id}/refine`  | Refine a slide — returns SSE stream   |
| `PUT`  | `/api/session/{id}/slide/{slide_id}/title`   | Rename a slide                        |

### Vision & Assets

| Method | Endpoint                                      | Description                                   |
| ------ | --------------------------------------------- | --------------------------------------------- |
| `POST` | `/api/session/{id}/slide/{slide_id}/snapshot` | Submit screenshot for vision audit            |
| `POST` | `/api/session/{id}/upload`                    | Upload a file (PDF, DOCX, image)              |
| `POST` | `/api/session/{id}/upload/text`               | Upload raw text content                       |
| `GET`  | `/api/assets`                                 | List files in the project `assets/` directory |
| `POST` | `/api/session/{id}/chat/design`               | Design mode chat                              |

### SSE Stream Format

Slide generation and refinement use Server-Sent Events. Each token is Base64-encoded:

```
data: <base64_encoded_token>\n\n
data: [DONE]\n\n          # stream complete
data: [ERROR] <msg>\n\n   # error
```

---

## Configuration

All configuration is via environment variables (loaded from `harness/.env`):

| Variable             | Default                         | Description                                            |
| -------------------- | ------------------------------- | ------------------------------------------------------ |
| `VAPOR_TEXT_MODEL`   | `ollama/qwen3-coder-next:cloud` | Model string for text generation                       |
| `VAPOR_VISION_MODEL` | `ollama/qwen3-vl:235b-cloud`    | Model string for vision audit                          |
| `OLLAMA_HOST`        | `http://localhost:11434`        | Ollama server URL                                      |
| `GOOGLE_API_KEY`     | —                               | Required for Google Gemini provider                    |
| `VAPOR_PROJECT_DIR`  | `.`                             | Path to the active project directory                   |
| `DEBUG_PROMPTS`      | `0`                             | Set to `1` to write prompts to `debug/` for inspection |

### Model string format

```
provider/model-name

ollama/llama3.1:8b
ollama/qwen2.5vl:7b
google/gemini-2.0-flash
google/gemma-3-27b-it
```

---

## Development

### Running tests

```bash
# Test a provider directly
cd harness
python scripts/test_provider.py --model ollama/llama3.1:8b

# Test input extractors
python scripts/test_extractor.py --pdf path/to/doc.pdf --image path/to/img.png

# Full end-to-end API test
python scripts/test_e2e.py --topic "Explain transformer attention mechanisms"
```

### Debug mode

Set `DEBUG_PROMPTS=1` in your `.env` to write all LLM prompts to `debug/` in the project directory. Useful for tuning outline or slide prompt behavior.

### Adding a new AI provider

1. Create `harness/ai/providers/yourprovider.py` implementing `BaseProvider`
2. Implement `stream_text()` and `vision_audit()`
3. Register it in `harness/ai/router.py` under `PROVIDERS`

```python
from .providers.yourprovider import YourProvider

PROVIDERS = {
    "google": GoogleProvider,
    "ollama": OllamaProvider,
    "yourprovider": YourProvider,  # add here
}
```

### Adding a new theme

Create `front/public/themes/yourtheme.css` defining the standard CSS variables (see existing themes for the template), then add an `<option>` to the theme select in `front/index.html`.

---

## License

MIT
