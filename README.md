# AI Slide Generator — Backend (Step 1)

Web-native AI slide deck generator. The LLM writes real HTML+CSS+JS slides directly.

## Project Structure

```
slide-generator/
└── backend/
    ├── main.py                        ← FastAPI app entry point
    ├── requirements.txt
    ├── .env                           ← Put your API keys here
    │
    ├── ai/
    │   ├── base.py                    ← BaseProvider interface
    │   ├── router.py                  ← get_model("google/gemini-2.0-flash")
    │   └── providers/
    │       ├── google.py              ← Gemini 2.0 Flash / Gemma 4
    │       └── ollama.py              ← Local models via Ollama
    │
    ├── models/
    │   ├── input_unit.py              ← InputUnit, TextChunk, InputRole
    │   └── session.py                 ← DeckSession, OutlineItem, SlideData
    │
    ├── services/
    │   ├── stream_utils.py            ← collect_stream(), strip_fences()
    │   ├── sse.py                     ← SSE StreamingResponse builder
    │   ├── context_synthesis.py       ← Input units → deck_context
    │   └── extractors/
    │       ├── chunker.py             ← Token-aware text chunker
    │       ├── text_extractor.py      ← Plain text + auto role detection
    │       ├── document_extractor.py  ← PDF (pymupdf) + DOCX (python-docx)
    │       └── image_extractor.py     ← Vision LLM + color palette
    │
    ├── prompts/
    │   ├── outline.py                 ← Outline generation prompt
    │   ├── slide.py                   ← Per-slide HTML generation prompt
    │   └── context_update.py          ← Deck memory update prompt
    │
    ├── routes/
    │   ├── session.py                 ← /session /synthesize /outline /confirm
    │   ├── upload.py                  ← /upload (files) /upload/text
    │   └── slide.py                   ← /slide/{n} /approve /refine
    │
    ├── store/
    │   └── sessions.py                ← In-memory session store
    │
    └── scripts/
        ├── test_provider.py           ← Verify a provider works
        ├── test_extractor.py          ← Verify extractors with real files
        └── test_e2e.py                ← Full API flow test
```

---

## Setup

### 1. Install dependencies

```bash
cd backend
pip install -r requirements.txt
```

### 2. Configure API keys

Edit `backend/.env`:

```env
GOOGLE_API_KEY=your_google_api_key_here
```

Get a Google API key at: https://aistudio.google.com/app/apikey

For Ollama (local models), no key needed — just run `ollama serve` and pull a model:
```bash
ollama pull llama3.1:8b
ollama pull llava:13b   # for vision features
```

### 3. Start the server

```bash
cd backend
uvicorn main:app --reload --port 8000
```

---

## Verify It Works (run in order)

```bash
# 1. Health check
curl http://localhost:8000/health

# 2. Test provider directly (no HTTP layer)
python scripts/test_provider.py --model "google/gemini-2.0-flash"
python scripts/test_provider.py --model "ollama/llama3.1:8b"   # if Ollama running

# 3. Full end-to-end test (creates session, uploads, synthesizes, generates slide 1)
python scripts/test_e2e.py

# 4. Open the generated slide in a browser
open debug/slide_1_e2e.html    # macOS
# or just drag the file into Chrome/Firefox
```

---

## API Call Sequence

```
POST /api/session                          → creates session, returns session_id
POST /api/session/{id}/upload/text         → upload topic / reference / instruction text
POST /api/session/{id}/upload              → upload PDF, DOCX, or image (multipart)
POST /api/session/{id}/synthesize          → process all inputs → deck_context
POST /api/session/{id}/outline             → generate slide outline from deck_context
POST /api/session/{id}/confirm             → lock outline, begin generation
POST /api/session/{id}/slide/1             → SSE stream of slide HTML
POST /api/session/{id}/slide/1/approve     → update deck memory, advance
POST /api/session/{id}/slide/2             → next slide...
```

### Quick curl test

```bash
# Create session
SESSION=$(curl -s -X POST http://localhost:8000/api/session \
  -H "Content-Type: application/json" \
  -d '{"text_model":"google/gemini-2.0-flash","theme":"dark-tech"}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['session_id'])")

echo "Session: $SESSION"

# Upload topic
curl -s -X POST http://localhost:8000/api/session/$SESSION/upload/text \
  -H "Content-Type: application/json" \
  -d '{"text":"Explain how transformer attention works to ML engineers","role":"topic"}'

# Synthesize
curl -s -X POST http://localhost:8000/api/session/$SESSION/synthesize | python3 -m json.tool

# Generate outline
curl -s -X POST http://localhost:8000/api/session/$SESSION/outline | python3 -m json.tool
```

---

## Supported Input Types

| Type | How to upload | Role options |
|------|--------------|--------------|
| Plain text (topic) | `POST /upload/text` with `"role":"topic"` | topic |
| Plain text (notes) | `POST /upload/text` with `"role":"reference"` | reference |
| Plain text (rules) | `POST /upload/text` with `"role":"instruction"` | instruction |
| PDF | `POST /upload` multipart | reference, instruction |
| DOCX | `POST /upload` multipart | reference, instruction |
| PNG/JPG/WEBP | `POST /upload` multipart | auto → design_style |

PPTX input coming in a later step.

---

## Debug Flags

Set in `.env` or as environment variables:

```bash
DEBUG_PROMPTS=1    # dumps all LLM prompts + responses to debug/
```

```bash
DEBUG_PROMPTS=1 uvicorn main:app --reload --port 8000
```

---

## Models

**Google (needs GOOGLE_API_KEY)**
- `google/gemini-2.0-flash` — recommended, fast, multimodal
- `google/gemini-1.5-pro` — higher quality, slower
- `google/gemma-4` — if available on your key

**Ollama (local, no key)**
- `ollama/llama3.1:8b` — text only
- `ollama/mistral` — text only
- `ollama/llava:13b` — vision capable (for image inputs)
