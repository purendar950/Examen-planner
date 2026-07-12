#!/usr/bin/env python3
"""
Groq study-material generation from a transcript.

Modes: summary | insights | notes | quiz | flashcards
- Handles Hindi/Hinglish auto-caption text (no punctuation) by instructing the
  model to clean + punctuate before generating.
- Output language is configurable (English / Hindi / Hinglish / ...).
- Long transcripts are condensed via a simple map step first, so we stay under
  Groq free-tier tokens-per-minute limits.

Set GROQ_API_KEY (free key: https://console.groq.com/keys).
Optionally set GROQ_MODEL (default: llama-3.3-70b-versatile).
"""

import json
import os

import requests

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
DEFAULT_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
MODES = ["summary", "insights", "notes", "quiz", "flashcards"]

# module-level hook so tests can stub the network call
_CHAT_IMPL = None


def _chat(messages, model=None, temperature=0.3, max_tokens=2048, json_mode=False):
    if _CHAT_IMPL is not None:                      # test/mock override
        return _CHAT_IMPL(messages, model, temperature, max_tokens, json_mode)
    key = os.environ.get("GROQ_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GROQ_API_KEY not set — get a free key at "
                           "https://console.groq.com/keys")
    body = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if json_mode:
        body["response_format"] = {"type": "json_object"}
    r = requests.post(GROQ_URL,
                      headers={"Authorization": "Bearer " + key,
                               "Content-Type": "application/json"},
                      json=body, timeout=90)
    if r.status_code != 200:
        raise RuntimeError("Groq %s: %s" % (r.status_code, r.text[:300]))
    return r.json()["choices"][0]["message"]["content"]


def _chunk_words(text, size_chars=9000):
    words = (text or "").split()
    chunks, cur, n = [], [], 0
    for w in words:
        cur.append(w)
        n += len(w) + 1
        if n >= size_chars:
            chunks.append(" ".join(cur))
            cur, n = [], 0
    if cur:
        chunks.append(" ".join(cur))
    return chunks or [""]


def _condense(text, out_lang, model=None):
    """Map long transcripts to key-point bullets so downstream prompts fit the
    free-tier token budget. Short transcripts pass through unchanged."""
    chunks = _chunk_words(text, 9000)
    if len(chunks) <= 1:
        return text.strip()
    parts = []
    sysmsg = ("You extract faithful key points from a chunk of an auto-generated "
              "lecture transcript (may be Hindi/Hinglish, no punctuation, ASR "
              "errors). Do not invent facts. Write the points in " + out_lang + ".")
    for i, ch in enumerate(chunks):
        parts.append(_chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": "Part %d of %d:\n\n%s\n\nList the key "
              "points as concise bullets." % (i + 1, len(chunks), ch)}],
            model=model, max_tokens=900))
    return "\n".join(parts)


def _safe_json(raw):
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        a, b = raw.find("{"), raw.rfind("}")
        if a != -1 and b != -1 and b > a:
            try:
                return json.loads(raw[a:b + 1])
            except Exception:  # noqa: BLE001
                pass
    return {}


def _sys(out_lang):
    return ("The source is an auto-generated lecture transcript that may be in "
            "Hindi/Hinglish with no punctuation and ASR errors. First mentally "
            "clean and punctuate it, then respond. Respond ONLY in " + out_lang +
            ". Stay strictly faithful to the transcript — never invent facts.")


def generate(mode, transcript, out_lang="English", model=None, title=None,
             num_questions=8):
    mode = (mode or "").lower()
    if mode not in MODES:
        raise ValueError("mode must be one of %s" % MODES)
    transcript = (transcript or "").strip()
    if not transcript:
        raise ValueError("empty transcript")

    body = _condense(transcript, out_lang, model)
    head = ("Video title: %s\n\n" % title) if title else ""
    sysmsg = _sys(out_lang)

    if mode == "summary":
        content = _chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + "Write a concise summary as 4-7 "
              "bullet points capturing the main ideas:\n\n" + body}],
            model=model, max_tokens=700)
        return {"mode": mode, "format": "markdown", "content": content}

    if mode == "insights":
        content = _chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + "List the most important insights "
              "/ takeaways as bullet points. Be specific and exam-relevant:\n\n"
              + body}],
            model=model, max_tokens=900)
        return {"mode": mode, "format": "markdown", "content": content}

    if mode == "notes":
        content = _chat(
            [{"role": "system", "content": sysmsg},
             {"role": "user", "content": head + "Create comprehensive, well-"
              "structured study notes in Markdown. Use headings, sub-points, and "
              "clearly mark important facts, dates, definitions, and formulas. "
              "Organize by topic:\n\n" + body}],
            model=model, max_tokens=2400)
        return {"mode": mode, "format": "markdown", "content": content}

    if mode == "quiz":
        raw = _chat(
            [{"role": "system", "content": sysmsg + " Output ONLY valid JSON."},
             {"role": "user", "content": head + ("Generate %d multiple-choice "
              "questions from the content. Return JSON of the exact shape: "
              '{\"questions\":[{\"question\":\"...\",\"options\":[\"a\",\"b\",\"c\",\"d\"],'
              '\"answer_index\":0,\"explanation\":\"...\"}]}. Exactly 4 options each, '
              "answer_index is 0-3. Mix factual and conceptual questions.\n\n"
              % num_questions) + body}],
            model=model, max_tokens=3000, json_mode=True)
        data = _safe_json(raw)
        questions = data.get("questions") if isinstance(data, dict) else data
        return {"mode": mode, "format": "json", "questions": questions or []}

    if mode == "flashcards":
        raw = _chat(
            [{"role": "system", "content": sysmsg + " Output ONLY valid JSON."},
             {"role": "user", "content": head + "Create 8-12 flashcards. Return "
              'JSON: {\"cards\":[{\"front\":\"question/term\",\"back\":\"answer\"}]}.'
              "\n\n" + body}],
            model=model, max_tokens=2000, json_mode=True)
        data = _safe_json(raw)
        cards = data.get("cards") if isinstance(data, dict) else data
        return {"mode": mode, "format": "json", "cards": cards or []}

    raise ValueError("unhandled mode")


if __name__ == "__main__":
    import sys
    from transcript import fetch_transcript
    v = sys.argv[1] if len(sys.argv) > 1 else "dQw4w9WgXcQ"
    md = sys.argv[2] if len(sys.argv) > 2 else "summary"
    lg = sys.argv[3] if len(sys.argv) > 3 else "English"
    t = fetch_transcript(v, "auto")
    print("Transcript: %s segments, %s chars (%s)\n" %
          (t["segment_count"], t["char_count"], t["chosen_lang"]))
    print(json.dumps(generate(md, t["text"], lg, title=t["title"]),
                     indent=2, ensure_ascii=False))
