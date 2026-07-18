// server.js
// Backend that keeps your Kiro API key secret and proxies requests to kiro-cli.
// The key lives only in .env / Render's env vars -- it is NEVER sent to the browser.
//
// Local run:  npm install && cp .env.example .env  (fill in your real key) && npm start
// Requires kiro-cli installed and on PATH (see README.md in this folder).

require('dotenv').config();
const express = require('express');
const { execFile } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // serves public/index.html

const PORT = process.env.PORT || 3000;
const KIRO_API_KEY = process.env.KIRO_API_KEY;

if (!KIRO_API_KEY) {
  console.warn('WARNING: KIRO_API_KEY is not set. Add it to a .env file (see .env.example).');
}

// kiro-cli emits ANSI color codes even in --no-interactive mode (e.g. a
// colored "> " prompt marker prefixing the response) -- confirmed by testing.
// Strip them so the browser gets clean plain text.
function stripAnsi(s) {
  return (s || '').replace(/\x1b\[[0-9;]*m/g, '');
}

app.post('/api/test-kiro', (req, res) => {
  const prompt = (req.body && req.body.prompt) || 'Say hello and confirm you are working.';

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
    'kiro-cli',
    ['chat', '--no-interactive', '--trust-tools=', prompt],
    { env: { ...process.env, KIRO_API_KEY }, timeout: 30000 },
    (error, stdout, stderr) => {
      if (error) {
        console.error(stripAnsi(stderr) || error.message);
        return res.status(500).json({ ok: false, error: stripAnsi(stderr) || error.message });
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
