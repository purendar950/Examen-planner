// server.js
// Backend that keeps your Kiro API key secret and proxies requests to kiro-cli.
// The key lives only in .env / Render's env vars -- it is NEVER sent to the browser.
//
// Local run:  npm install && cp .env.example .env  (fill in your real key) && npm start
//
// Locating kiro-cli: on some hosts (e.g. Render) the build step and the
// runtime step run in DIFFERENT environments, so a binary installed to
// $HOME/.local/bin during build may not be on PATH -- or may not even exist --
// at runtime. We therefore resolve the binary's absolute path across several
// known locations instead of relying on the PATH, and expose /api/diag so the
// runtime environment can be inspected without shell access.

require('dotenv').config();
const express = require('express');
const { execFile, execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves public/index.html

const PORT = process.env.PORT || 3000;
const KIRO_API_KEY = process.env.KIRO_API_KEY;

if (!KIRO_API_KEY) {
  console.warn('WARNING: KIRO_API_KEY is not set. Add it to a .env file (see .env.example).');
}

// ---------------------------------------------------------------------------
// Locate the kiro-cli binary.
// ---------------------------------------------------------------------------
function kiroCliCandidates() {
  const list = [];
  if (process.env.KIRO_CLI_PATH) list.push(process.env.KIRO_CLI_PATH);
  // Installed into the project dir by the postinstall script (persists to runtime).
  list.push(path.join(__dirname, '.kiro-cli-home', '.local', 'bin', 'kiro-cli'));
  // Default installer location, under whatever HOME resolves to at runtime.
  list.push(path.join(os.homedir(), '.local', 'bin', 'kiro-cli'));
  // Common absolute homes on various hosts.
  list.push('/opt/render/.local/bin/kiro-cli');
  list.push('/root/.local/bin/kiro-cli');
  list.push('/home/render/.local/bin/kiro-cli');
  list.push('/usr/local/bin/kiro-cli');
  list.push('/usr/bin/kiro-cli');
  return list;
}

function resolveKiroCli() {
  for (const c of kiroCliCandidates()) {
    try {
      if (c && fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (_) { /* ignore */ }
  }
  // Last resort: ask the shell to find it on PATH.
  try {
    const found = execFileSync('bash', ['-lc', 'command -v kiro-cli'], { encoding: 'utf8' }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch (_) { /* not on PATH */ }
  return null;
}

let KIRO_CLI = resolveKiroCli();
console.log('Resolved kiro-cli path:', KIRO_CLI || '(NOT FOUND)');

function stripAnsi(s) {
  return (s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Diagnostics: inspect the runtime environment remotely (no secrets exposed).
// ---------------------------------------------------------------------------
app.get('/api/diag', (req, res) => {
  const candidates = kiroCliCandidates().map((c) => ({
    path: c,
    exists: (() => { try { return fs.existsSync(c); } catch (_) { return false; } })()
  }));
  let localBinListing = null;
  try {
    localBinListing = fs.readdirSync(path.join(os.homedir(), '.local', 'bin'));
  } catch (e) {
    localBinListing = 'ERR: ' + e.message;
  }
  res.json({
    resolvedKiroCli: KIRO_CLI,
    homedir: os.homedir(),
    HOME_env: process.env.HOME,
    PATH: process.env.PATH,
    hasKiroApiKey: Boolean(KIRO_API_KEY),
    candidates,
    homeLocalBin: localBinListing,
    cwd: process.cwd(),
    dirname: __dirname
  });
});

app.post('/api/test-kiro', (req, res) => {
  const prompt = (req.body && req.body.prompt) || 'Say hello and confirm you are working.';

  // Re-resolve in case the binary appeared after startup.
  if (!KIRO_CLI || !fs.existsSync(KIRO_CLI)) KIRO_CLI = resolveKiroCli();

  if (!KIRO_CLI) {
    return res.status(503).json({
      ok: false,
      error: 'kiro-cli binary not found on this server. Check /api/diag for details.'
    });
  }

  // --trust-tools= (empty) means no tools are trusted -- safest for a public
  // test endpoint. kiro-cli exits 0 even on an invalid key (error only on
  // stderr, empty stdout), so we check for that case explicitly below.
  execFile(
    KIRO_CLI,
    ['chat', '--no-interactive', '--trust-tools=', prompt],
    { env: { ...process.env, KIRO_API_KEY }, timeout: 60000 },
    (error, stdout, stderr) => {
      const stderrText = stripAnsi(stderr);
      const output = stripAnsi(stdout).trim();

      if (error && !output) {
        console.error(stderrText || error.message);
        return res.status(500).json({ ok: false, error: stderrText || error.message });
      }

      if (!output && /Authentication failed/i.test(stderrText)) {
        return res.status(401).json({
          ok: false,
          error: 'Authentication failed. Your KIRO_API_KEY is invalid or expired.'
        });
      }

      if (!output) {
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
