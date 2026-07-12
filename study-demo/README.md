# Groq Study Demo (transcript → notes / quiz / summary)

Standalone proof-of-concept for **Phase 2**: turn a YouTube transcript into study
material with Groq — **before** wiring it into the app. Pairs with the
`/api/transcript` work already in the proxy.

## Modes
| Mode | Output |
|---|---|
| `summary` | 4–7 bullet TL;DR (Markdown) |
| `insights` | Key exam-relevant takeaways (Markdown) |
| `notes` | Comprehensive structured notes: headings, facts, dates, definitions (Markdown) |
| `quiz` | MCQs as JSON: `question`, 4 `options`, `answer_index`, `explanation` |
| `flashcards` | Q/A cards as JSON |

## Handles your content
- **Hindi / Hinglish auto-captions** (no punctuation): the model is told to clean +
  punctuate before generating.
- **Output language** is configurable — English / Hindi / Hinglish.
- **Long lectures**: transcript is condensed (map step) first, to stay under
  Groq free-tier tokens-per-minute limits.

## Run it

```bash
pip install -r requirements.txt
export GROQ_API_KEY=gsk_your_free_key      # https://console.groq.com/keys
export GROQ_MODEL=llama-3.3-70b-versatile  # optional (default)

# Web UI
python web_demo.py                          # open http://localhost:5002

# CLI: <video-or-url> <mode> <out-lang>
python groq_study.py "https://youtu.be/..." notes Hinglish
```

> Run transcript fetching from a **home/mobile-data connection** (residential IP);
> a datacenter IP hits YouTube's bot-gate. To test just the AI part, paste
> transcript text into the web UI's textarea (no fetch needed).

## Web UI
- Paste a **YouTube URL** (fetches transcript) **or** paste **transcript text** directly.
- Pick **mode**, **output language**, and **Groq model**, then Generate.

## Files
| File | Purpose |
|---|---|
| `transcript.py` | Caption fetch (android client, json3, auto-detect, live_chat excluded) |
| `groq_study.py` | Groq chat + chunk/condense + the 5 modes |
| `web_demo.py` | Flask UI |

## Next (after you approve)
Wire this into the app: a `/api/study` route on the proxy reusing the transcript
cache + `config/ai` Groq key, and quiz results into `revision.js` spaced repetition.
