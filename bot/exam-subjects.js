/**
 * Server-side subject catalog for the Telegram bot.
 * ─────────────────────────────────────────────────────────────────────────────
 * Mirrors the subject-level entries defined in js/data/exams.js +
 * js/data/syllabus-data.js. The bot uses this to (a) tell the AI which subjects
 * exist for a user's exam so it can classify a task, and (b) map the AI's
 * free-text subject guess back to a real subject id that the planner UI renders.
 *
 * ⚠️  If you add/rename subjects in exams.js, update this file too. Only the
 *     subject level is needed here (not chapters), so it changes rarely.
 *
 * `keywords` are lowercase hints used for fuzzy matching when the AI returns a
 * label that isn't an exact subject name (e.g. "polity" → upsc_gsii).
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SUBJECT_CATALOG = {
  cgl: [
    { id: 'reasoning', name: 'Reasoning & General Intelligence', keywords: ['reasoning', 'gi', 'general intelligence', 'logical'] },
    { id: 'ga',        name: 'General Awareness',                 keywords: ['ga', 'gk', 'general awareness', 'general knowledge', 'gs', 'current affairs', 'history', 'polity', 'geography', 'economy', 'science', 'static'] },
    { id: 'quant',     name: 'Quantitative Aptitude',            keywords: ['quant', 'quantitative', 'maths', 'math', 'mathematics', 'aptitude', 'di', 'data interpretation'] },
    { id: 'english',   name: 'English Language',                 keywords: ['english', 'grammar', 'vocab', 'vocabulary', 'comprehension', 'rc'] },
  ],
  ntpc: [
    { id: 'ntpc_ga',        name: 'General Awareness',                  keywords: ['ga', 'gk', 'general awareness', 'general knowledge', 'gs', 'current affairs', 'history', 'polity', 'geography', 'economy', 'science', 'railway'] },
    { id: 'ntpc_math',      name: 'Mathematics',                        keywords: ['math', 'maths', 'mathematics', 'quant', 'aptitude', 'di'] },
    { id: 'ntpc_reasoning', name: 'Reasoning & General Intelligence',   keywords: ['reasoning', 'gi', 'general intelligence', 'logical'] },
  ],
  gd: [
    { id: 'gd_reasoning', name: 'General Intelligence & Reasoning', keywords: ['reasoning', 'gi', 'general intelligence', 'logical'] },
    { id: 'gd_gk',        name: 'General Knowledge & Awareness',    keywords: ['gk', 'ga', 'general knowledge', 'general awareness', 'gs', 'current affairs', 'history', 'polity', 'geography', 'economy', 'science'] },
    { id: 'gd_math',      name: 'Elementary Mathematics',           keywords: ['math', 'maths', 'mathematics', 'quant', 'aptitude'] },
    { id: 'gd_english',   name: 'English Language',                 keywords: ['english', 'grammar', 'vocab', 'comprehension'] },
    { id: 'gd_hindi',     name: 'हिंदी भाषा',                        keywords: ['hindi', 'हिंदी', 'vyakaran', 'व्याकरण'] },
  ],
  ibps: [
    { id: 'ibps_reasoning', name: 'Reasoning & Computer Aptitude',   keywords: ['reasoning', 'computer', 'gi', 'logical', 'puzzle'] },
    { id: 'ibps_quant',     name: 'Quantitative Aptitude / DI',      keywords: ['quant', 'quantitative', 'maths', 'math', 'di', 'data interpretation', 'aptitude'] },
    { id: 'ibps_english',   name: 'English Language',                keywords: ['english', 'grammar', 'vocab', 'comprehension', 'rc'] },
    { id: 'ibps_banking',   name: 'Banking & Financial Awareness',   keywords: ['banking', 'finance', 'financial', 'awareness', 'ga', 'gk', 'current affairs', 'economy'] },
  ],
  upsc: [
    { id: 'upsc_gsi',   name: 'GS I – History, Culture & Geography',        keywords: ['gs1', 'gs i', 'history', 'culture', 'geography', 'art'] },
    { id: 'upsc_gsii',  name: 'GS II – Polity, Governance & IR',            keywords: ['gs2', 'gs ii', 'polity', 'governance', 'ir', 'international relations', 'constitution'] },
    { id: 'upsc_gsiii', name: 'GS III – Economy, S&T, Environment & Security', keywords: ['gs3', 'gs iii', 'economy', 'economics', 'science', 'technology', 's&t', 'environment', 'security'] },
    { id: 'upsc_gsiv',  name: 'GS IV – Ethics, Integrity & Aptitude',       keywords: ['gs4', 'gs iv', 'ethics', 'integrity', 'aptitude'] },
    { id: 'upsc_csat',  name: 'CSAT – Paper II (Qualifying)',               keywords: ['csat', 'paper 2', 'aptitude', 'maths', 'reasoning', 'comprehension'] },
  ],
  uppcs: [
    { id: 'uppcs_history', name: 'History & National Movement',          keywords: ['history', 'freedom', 'national movement'] },
    { id: 'uppcs_geo',     name: 'Geography',                            keywords: ['geography', 'geo'] },
    { id: 'uppcs_polity',  name: 'Polity & Governance',                  keywords: ['polity', 'governance', 'constitution'] },
    { id: 'uppcs_economy', name: 'Economy & Social Development',         keywords: ['economy', 'economics', 'social'] },
    { id: 'uppcs_env',     name: 'Environment, Ecology & Disaster Mgmt', keywords: ['environment', 'ecology', 'disaster'] },
    { id: 'uppcs_science', name: 'General Science & Technology',         keywords: ['science', 'technology', 's&t', 'tech'] },
    { id: 'uppcs_ca',      name: 'Current Affairs',                      keywords: ['current affairs', 'ca', 'news'] },
    { id: 'uppcs_ethics',  name: 'Ethics, Integrity & Aptitude (GS IV)', keywords: ['ethics', 'integrity', 'aptitude', 'gs4'] },
    { id: 'uppcs_csat',    name: 'CSAT – Paper II (Qualifying)',         keywords: ['csat', 'paper 2', 'reasoning', 'maths'] },
    { id: 'uppcs_up',      name: 'Uttar Pradesh Special (GS V & VI)',    keywords: ['up', 'uttar pradesh', 'state', 'gs5', 'gs6'] },
    { id: 'uppcs_hindi',   name: 'General Hindi & Essay (Mains)',        keywords: ['hindi', 'essay', 'हिंदी', 'mains'] },
  ],
  bpsc: [
    { id: 'bpsc_history', name: 'History & National Movement',     keywords: ['history', 'freedom', 'national movement'] },
    { id: 'bpsc_geo',     name: 'Geography',                       keywords: ['geography', 'geo'] },
    { id: 'bpsc_polity',  name: 'Polity & Governance',             keywords: ['polity', 'governance', 'constitution'] },
    { id: 'bpsc_economy', name: 'Economy',                         keywords: ['economy', 'economics'] },
    { id: 'bpsc_science', name: 'General Science & Technology',    keywords: ['science', 'technology', 's&t', 'tech'] },
    { id: 'bpsc_env',     name: 'Environment & Ecology',           keywords: ['environment', 'ecology'] },
    { id: 'bpsc_ca',      name: 'Current Affairs',                 keywords: ['current affairs', 'ca', 'news'] },
    { id: 'bpsc_gma',     name: 'Mental Ability & Data Analysis',  keywords: ['mental ability', 'maths', 'math', 'data analysis', 'reasoning', 'aptitude'] },
    { id: 'bpsc_mains',   name: 'Essay, Hindi & Optional (Mains)', keywords: ['essay', 'hindi', 'optional', 'mains'] },
  ],
};

/** Return the subject list for an exam (defaults to cgl). */
function subjectsForExam(examId) {
  return SUBJECT_CATALOG[examId] || SUBJECT_CATALOG.cgl;
}

/** Compact "id — name" lines for the AI prompt. */
function subjectPromptList(examId) {
  return subjectsForExam(examId)
    .map(s => `- ${s.id}: ${s.name}`)
    .join('\n');
}

/**
 * Resolve an AI-provided subject label (id OR name OR loose keyword) to a real
 * subject id for the given exam. Returns '' when nothing matches confidently.
 */
function resolveSubjectId(examId, label) {
  if (!label) return '';
  const subs = subjectsForExam(examId);
  const q = String(label).trim().toLowerCase();
  if (!q) return '';

  // 1) Exact id match (AI ideally returns the id directly).
  const byId = subs.find(s => s.id.toLowerCase() === q);
  if (byId) return byId.id;

  // 2) Exact / substring name match.
  const byName = subs.find(s => s.name.toLowerCase() === q)
            || subs.find(s => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()));
  if (byName) return byName.id;

  // 3) Keyword match (longest keyword first so "general knowledge" beats "gk").
  //    Use word-boundary matching for plain alphanumeric keywords so "quantum"
  //    doesn't match "quant"; fall back to substring for keywords with symbols.
  let best = '';
  let bestLen = 0;
  subs.forEach(s => {
    (s.keywords || []).forEach(kw => {
      let hit;
      if (/^[a-z0-9 ]+$/.test(kw)) {
        hit = new RegExp('\\b' + kw.replace(/ /g, '\\s+') + '\\b').test(q);
      } else {
        hit = q.includes(kw);
      }
      if (hit && kw.length > bestLen) { best = s.id; bestLen = kw.length; }
    });
  });
  return best;
}

module.exports = { SUBJECT_CATALOG, subjectsForExam, subjectPromptList, resolveSubjectId };
