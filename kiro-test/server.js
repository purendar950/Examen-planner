// server.js
// Backend that keeps your Kiro API key secret and proxies requests to kiro-cli.
// The key lives only in .env / Render's env vars -- it is NEVER sent to the browser.
//
// Local run:  npm install && cp .env.example .env  (fill in your real key) && npm start
// Requires kiro-cli installed (see README.md in this folder).

require('dotenv').config();
const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public'))); // serves public/index.html

const PORT = process.env.PORT || 3000;
const KIRO_API_KEY = process.env.KIRO_API_KEY;

// Keep-alive: Render free tier spins down after 15min inactivity, causing
// 30-50s cold starts that exceed the proxy's upstream timeout → 502. This
// self-ping every 10min keeps the service warm. The /health endpoint is also
// used by Render's built-in health check.
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Self-ping to prevent free-tier sleep (fires 2min after boot, then every 10min)
const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
let _keepAliveTimer = null;
function startKeepAlive() {
  if (_keepAliveTimer) return;
  _keepAliveTimer = setInterval(() => {
    fetch(`${SELF_URL}/health`).catch(() => {});
  }, 10 * 60 * 1000); // every 10 minutes
}
setTimeout(startKeepAlive, 2 * 60 * 1000); // start 2min after boot

if (!KIRO_API_KEY) {
  console.warn('WARNING: KIRO_API_KEY is not set. Add it to a .env file (see .env.example).');
}

// Where the kiro-cli installer places the binary (~/.local/bin). On Render the
// PATH exported in the start command does not reliably propagate to child
// processes spawned by execFile, which resolves the program name via PATH only
// -- that is what caused "spawn kiro-cli ENOENT". So we resolve the binary by
// absolute path when it exists, and fall back to a bare PATH lookup otherwise.
//
// CRITICAL: Render's build and runtime run on SEPARATE filesystems. Anything the
// build installs OUTSIDE the project directory (e.g. the installer's default
// $HOME/.local/bin) is discarded before runtime -- confirmed via /api/diag,
// which showed binaryExists:false with HOME=/opt/render at runtime. The only
// files that survive to runtime are those inside the deployed project directory.
// So the build installs kiro-cli into VENDOR_BIN (a folder next to this file,
// via HOME override), and we resolve it here relative to __dirname.
const VENDOR_BIN = path.join(__dirname, 'vendor', 'kiro', '.local', 'bin');
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

function resolveKiroCli() {
  const candidates = [
    path.join(VENDOR_BIN, 'kiro-cli'), // installed into the project dir at build (persists)
    path.join(LOCAL_BIN, 'kiro-cli'),  // fallback: default installer location
    '/opt/render/.local/bin/kiro-cli', // fallback: Render's runtime home
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return 'kiro-cli'; // last resort: rely on PATH
}

// Ensure the vendored bin dir (and ~/.local/bin) is on PATH for the spawned
// process regardless of how the start command was launched.
function childEnv() {
  const extraPath = [VENDOR_BIN, LOCAL_BIN, '/opt/render/.local/bin'].join(path.delimiter);
  return {
    ...process.env,
    KIRO_API_KEY,
    PATH: `${extraPath}${path.delimiter}${process.env.PATH || ''}`,
  };
}

// Run kiro-cli in /tmp so it doesn't read the project directory as context.
// When run in the kiro-test/ dir, it reads server.js/README as project context
// and thinks it's a coding assistant, refusing study-note requests or adding
// unhelpful "I'm a dev agent" preambles. /tmp is empty → no project context.
const KIRO_CWD = '/tmp';

// kiro-cli emits ANSI color codes even in --no-interactive mode (e.g. a
// colored "> " prompt marker prefixing the response) -- confirmed by testing.
// Strip them so the browser gets clean plain text.
function stripAnsi(s) {
  return (s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

// Diagnostic endpoint: reports where kiro-cli was found and the runtime env.
// Safe to expose -- it does NOT reveal the API key value (only whether it is set).
app.get('/api/diag', (req, res) => {
  const bin = resolveKiroCli();
  const info = {
    home: os.homedir(),
    vendorBin: VENDOR_BIN,
    localBin: LOCAL_BIN,
    resolvedBinary: bin,
    binaryExists: bin !== 'kiro-cli',
    apiKeySet: Boolean(KIRO_API_KEY),
    path: process.env.PATH,
  };

  execFile(bin, ['--version'], { env: childEnv(), timeout: 10000 }, (error, stdout, stderr) => {
    info.version = stripAnsi(stdout).trim() || null;
    info.versionError = error ? (stripAnsi(stderr) || error.message) : null;
    res.json(info);
  });
});

app.post('/api/test-kiro', (req, res) => {
  const prompt = (req.body && req.body.prompt) || 'Say hello and confirm you are working.';
  const model = (req.body && req.body.model) || '';
  const bin = resolveKiroCli();

  // If a model is specified, set it via `kiro-cli settings chat.defaultModel`
  // before invoking chat. This is the only way to select models in headless
  // (non-interactive) mode — the /model slash command is unavailable. If no
  // model is specified (empty string = "Auto"), we skip the settings call and
  // let kiro-cli use whatever model it deems optimal for the task.
  function runChat() {
    // --trust-tools= (empty) means no tools are trusted at all -- safest default
    // for a public-facing test endpoint. Tool-using prompts will just be
    // declined/skipped rather than hanging waiting for confirmation input.
    //
    // IMPORTANT (verified by live testing with a real key): kiro-cli exits with
    // code 0 EVEN WHEN KIRO_API_KEY IS INVALID/EXPIRED. It prints
    // "Authentication failed..." to stderr and returns EMPTY stdout, but does
    // NOT signal failure via the exit code -- so `error` below will be null
    // and stdout will be "". We explicitly check for that case below, or an
    // invalid key would silently look like a successful empty response.
    execFile(
      bin,
      ['chat', '--no-interactive', '--trust-tools=', prompt],
      { env: childEnv(), timeout: 180000, cwd: KIRO_CWD },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stripAnsi(stderr) || error.message;
          console.error(detail);
          // Give a clearer hint when the binary itself could not be launched.
          if (error.code === 'ENOENT') {
            return res.status(500).json({
              ok: false,
              error: `kiro-cli binary not found (looked at ${bin}). Check the build installed it and /api/diag output.`,
            });
          }
          return res.status(500).json({ ok: false, error: detail });
        }

        const output = stripAnsi(stdout).trim();
        const stderrText = stripAnsi(stderr);

        if (!output && /Authentication failed/i.test(stderrText)) {
          console.error(stderrText.trim());
          return res.status(401).json({
            ok: false,
            error: 'Authentication failed. Your KIRO_API_KEY is invalid or expired.'
          });
        }

        if (!output) {
          console.error('Empty response from kiro-cli. stderr:', stderrText.trim());
          return res.status(502).json({
            ok: false,
            error: stderrText.trim() || 'kiro-cli returned an empty response with no error detail.'
          });
        }

        res.json({ ok: true, response: output, model: model || 'auto' });
      }
    );
  }

  if (model) {
    // Set the model before running chat
    execFile(
      bin,
      ['settings', 'chat.defaultModel', model],
      { env: childEnv(), timeout: 10000, cwd: KIRO_CWD },
      (err, stdout, stderr) => {
        if (err) {
          console.error('Failed to set model:', stripAnsi(stderr) || err.message);
          // Still try to run chat even if model setting fails — it'll use whatever was last set
        }
        runChat();
      }
    );
  } else {
    runChat();
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   OpenAI-compatible /v1/chat/completions endpoint.
   The youtube-turbo-proxy (and any OpenAI-compatible client) sends requests
   in the standard format: POST /v1/chat/completions with { model, messages }.
   We translate this into a kiro-cli call and return an OpenAI-shaped response.
   Also mounted at /chat/completions (no /v1 prefix) for compatibility.
   ═══════════════════════════════════════════════════════════════════════════ */
function handleChatCompletions(req, res) {
  const body = req.body || {};
  const model = body.model || '';
  const messages = body.messages || [];
  const wantStream = body.stream === true;

  // Extract the user's prompt from the messages array (take the last user message)
  let prompt = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      prompt = messages[i].content || '';
      break;
    }
  }
  // If there's a system message, prepend it as context
  const systemMsg = messages.find(m => m.role === 'system');
  if (systemMsg && systemMsg.content) {
    prompt = systemMsg.content + '\n\n' + prompt;
  }

  if (!prompt) {
    return res.status(400).json({
      error: { message: 'No user message found in messages array', type: 'invalid_request_error' }
    });
  }

  const bin = resolveKiroCli();
  const completionId = 'kiro-' + Date.now();

  // If streaming is requested, set up SSE headers and send keep-alive comments
  // every 5s to prevent Cloudflare/Render's intermediary proxies from timing out
  // (Cloudflare kills connections with no data after ~100s). kiro-cli doesn't
  // support real token streaming, so we send the full response as one chunk at
  // the end — but the keep-alive pings keep the connection open during generation.
  let keepAliveInterval = null;
  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    // Send an initial role-only chunk immediately — this is standard OpenAI
    // streaming behavior and signals to intermediaries (Render LB, Cloudflare)
    // that the response has started (not just SSE comments). Some proxies treat
    // data: lines differently from : comment lines for timeout purposes.
    const initChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model || 'auto',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    };
    res.write('data: ' + JSON.stringify(initChunk) + '\n\n');
    // Send a comment every 5 seconds to keep the connection alive
    keepAliveInterval = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 5000);
  }

  function sendResult(output) {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (wantStream) {
      // Send the content as a single SSE data chunk in OpenAI streaming format
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'auto',
        choices: [{
          index: 0,
          delta: { role: 'assistant', content: output },
          finish_reason: null
        }]
      };
      res.write('data: ' + JSON.stringify(chunk) + '\n\n');
      // Send the final chunk with finish_reason
      const done = {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model || 'auto',
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      };
      res.write('data: ' + JSON.stringify(done) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model || 'auto',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: output },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      });
    }
  }

  function sendError(status, message) {
    if (keepAliveInterval) clearInterval(keepAliveInterval);
    if (wantStream) {
      // For streaming errors, send an error event then close
      res.write('data: ' + JSON.stringify({ error: { message, type: 'server_error' } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(status).json({ error: { message, type: 'server_error' } });
    }
  }

  function runChat() {
    execFile(
      bin,
      ['chat', '--no-interactive', '--trust-tools=', prompt],
      { env: childEnv(), timeout: 180000, cwd: KIRO_CWD },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stripAnsi(stderr) || error.message;
          console.error('[chat/completions]', detail);
          return sendError(500, error.code === 'ENOENT'
            ? `kiro-cli binary not found (looked at ${bin})`
            : detail);
        }

        const output = stripAnsi(stdout).trim();
        const stderrText = stripAnsi(stderr);

        if (!output && /Authentication failed/i.test(stderrText)) {
          return sendError(401, 'Authentication failed. KIRO_API_KEY is invalid or expired.');
        }

        if (!output) {
          return sendError(502, stderrText.trim() || 'Empty response from kiro-cli');
        }

        sendResult(output);
      }
    );
  }

  if (model && model !== 'auto') {
    execFile(
      bin,
      ['settings', 'chat.defaultModel', model],
      { env: childEnv(), timeout: 10000, cwd: KIRO_CWD },
      (err) => {
        if (err) console.error('[chat/completions] Failed to set model:', model);
        runChat();
      }
    );
  } else {
    runChat();
  }
}

// Mount at both paths — the proxy may use either depending on how baseUrl is configured
app.post('/v1/chat/completions', handleChatCompletions);
app.post('/chat/completions', handleChatCompletions);

app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
