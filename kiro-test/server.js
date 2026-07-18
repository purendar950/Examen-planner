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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves public/index.html

const PORT = process.env.PORT || 3000;
const KIRO_API_KEY = process.env.KIRO_API_KEY;

if (!KIRO_API_KEY) {
  console.warn('WARNING: KIRO_API_KEY is not set. Add it to a .env file (see .env.example).');
}

// Where the kiro-cli installer places the binary (~/.local/bin). On Render the
// PATH exported in the start command does not reliably propagate to child
// processes spawned by execFile, which resolves the program name via PATH only
// -- that is what caused "spawn kiro-cli ENOENT". So we resolve the binary by
// absolute path when it exists, and fall back to a bare PATH lookup otherwise.
const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

function resolveKiroCli() {
  const candidates = [
    path.join(LOCAL_BIN, 'kiro-cli'),
    '/opt/render/.local/bin/kiro-cli', // Render's runtime home, in case HOME differs
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) { /* ignore */ }
  }
  return 'kiro-cli'; // last resort: rely on PATH
}

// Ensure ~/.local/bin is on PATH for the spawned process regardless of how the
// start command was launched.
function childEnv() {
  const extraPath = [LOCAL_BIN, '/opt/render/.local/bin'].join(path.delimiter);
  return {
    ...process.env,
    KIRO_API_KEY,
    PATH: `${extraPath}${path.delimiter}${process.env.PATH || ''}`,
  };
}

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
    localBin: LOCAL_BIN,
    resolvedBinary: bin,
    binaryExists: bin !== 'kiro-cli' ? true : fs.existsSync(path.join(LOCAL_BIN, 'kiro-cli')),
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
  const bin = resolveKiroCli();

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
    { env: childEnv(), timeout: 30000 },
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

      res.json({ ok: true, response: output });
    }
  );
});

app.listen(PORT, () => console.log(`Server running: http://localhost:${PORT}`));
