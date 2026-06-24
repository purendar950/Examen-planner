/**
 * Groq AI parser for the Telegram bot.
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns a free-form Telegram message into a structured list of intents the bot
 * can act on. Groq exposes an OpenAI-compatible Chat Completions endpoint, so we
 * call it over plain HTTPS (no SDK dependency) and ask for a JSON object back.
 *
 * Output shape (validated before returning):
 *   {
 *     intents: [
 *       { action: 'add_task',  date: 'YYYY-MM-DD', text: '...', priority: 'high'|'normal', subject: '<label>' },
 *       { action: 'add_video', date: 'YYYY-MM-DD', text: '...', url: 'https://...', subject: '<label>' }
 *     ],
 *     reply: 'short friendly confirmation'
 *   }
 *
 * The caller resolves `subject` to a real subject id and writes the tasks.
 * If anything goes wrong (no key, network/JSON error), we throw so the caller
 * can fall back to the regex parser.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https = require('https');

const GROQ_HOST = 'api.groq.com';
const GROQ_PATH = '/openai/v1/chat/completions';

const SUPPORTED_MODELS = [
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
];
const DEFAULT_MODEL = 'llama-3.1-8b-instant';

function buildSystemPrompt(ctx) {
  const { todayIST, weekdayIST, examName, subjectList } = ctx;
  return [
    'You are the scheduling brain for a study-planner app used by Indian govt-exam aspirants.',
    'A student sends you a casual message (often Hinglish — Hindi written in English). Convert it into a JSON object describing what to schedule.',
    '',
    `Today is ${todayIST} (${weekdayIST}), India Standard Time. The student is preparing for: ${examName}.`,
    '',
    'Available subjects for this exam (use the id on the left for the "subject" field):',
    subjectList,
    '',
    'Return ONLY a JSON object with this exact shape:',
    '{',
    '  "intents": [',
    '    { "action": "add_task"|"add_video", "date": "YYYY-MM-DD", "text": "concise task title", "priority": "high"|"normal", "subject": "<subject id or empty>", "url": "<youtube url if action is add_video, else omit>" }',
    '  ],',
    '  "reply": "one short friendly line (Hinglish ok) confirming what you scheduled"',
    '}',
    '',
    'Rules:',
    '- Resolve relative dates against today: today/aaj, tomorrow/kal, parso/day-after, weekday names (next future occurrence), "25 Jun", ISO dates. Default to today if no date is given.',
    '- If the message contains a YouTube link (youtube.com or youtu.be), use action "add_video", keep the full URL in "url", and write a short "text" like "Watch: <topic>".',
    '- A message can produce MULTIPLE intents (e.g. "mon-fri 1hr current affairs" → one per day; several tasks on separate lines → several intents).',
    '- Always pick the most relevant subject id from the list above; if truly unclear, use "".',
    '- Mark priority "high" only when the student signals urgency/importance (urgent, important, must, !, #high).',
    '- Keep "text" short and action-oriented. Do not invent tasks the student did not mention.',
    '- Output valid JSON only. No markdown, no commentary outside the JSON.',
  ].join('\n');
}

function postJson(apiKey, payload) {
  const body = JSON.stringify(payload);
  const options = {
    host: GROQ_HOST,
    path: GROQ_PATH,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': 'Bearer ' + apiKey,
    },
    timeout: 25000,
  };
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const msg = (json.error && json.error.message) || ('HTTP ' + res.statusCode);
            return reject(new Error('Groq: ' + msg));
          }
          resolve(json);
        } catch (e) {
          reject(new Error('Groq returned non-JSON (HTTP ' + res.statusCode + ')'));
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Groq request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const VALID_ACTIONS = new Set(['add_task', 'add_video']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Validate + normalise the model's JSON into a clean intents array. */
function sanitizeResult(raw, fallbackDate) {
  const out = { intents: [], reply: '' };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.reply === 'string') out.reply = raw.reply.slice(0, 400);

  const list = Array.isArray(raw.intents) ? raw.intents
             : Array.isArray(raw.tasks)   ? raw.tasks
             : [];
  list.forEach((it) => {
    if (!it || typeof it !== 'object') return;
    let action = String(it.action || 'add_task').toLowerCase();
    if (!VALID_ACTIONS.has(action)) action = it.url ? 'add_video' : 'add_task';

    const text = String(it.text || it.title || '').trim().slice(0, 300);
    if (!text && action === 'add_task') return;

    let date = String(it.date || '').trim();
    if (!DATE_RE.test(date)) date = fallbackDate;

    const priority = (String(it.priority || '').toLowerCase() === 'high') ? 'high' : 'normal';
    const subject  = String(it.subject || '').trim().slice(0, 60);
    const url      = String(it.url || '').trim().slice(0, 500);

    if (action === 'add_video' && !url) return; // a video intent needs a link
    out.intents.push({ action, date, text: text || 'Watch video', priority, subject, url });
  });
  return out;
}

/**
 * Parse a message with Groq.
 * @param {string} message      raw user text
 * @param {object} cfg          { apiKey, model }
 * @param {object} ctx          { todayIST, weekdayIST, examName, subjectList, fallbackDate }
 * @returns {Promise<{intents:Array, reply:string}>}
 */
async function aiParse(message, cfg, ctx) {
  if (!cfg || !cfg.apiKey) throw new Error('No Groq API key configured');
  const model = SUPPORTED_MODELS.includes(cfg.model) ? cfg.model : DEFAULT_MODEL;

  const payload = {
    model,
    messages: [
      { role: 'system', content: buildSystemPrompt(ctx) },
      { role: 'user',   content: String(message || '').slice(0, 2000) },
    ],
    temperature: 0.2,
    max_completion_tokens: 1024,
    top_p: 1,
    stream: false,
    response_format: { type: 'json_object' },
  };

  const resp = await postJson(cfg.apiKey, payload);
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message
    ? resp.choices[0].message.content : '';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    // Some models wrap JSON in prose/markdown despite json_object — extract it.
    const m = content && content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI did not return JSON');
    parsed = JSON.parse(m[0]);
  }
  return sanitizeResult(parsed, ctx.fallbackDate);
}

module.exports = { aiParse, SUPPORTED_MODELS, DEFAULT_MODEL };
