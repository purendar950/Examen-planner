/* ══════════════════════════════════════════════
   MULTI-EXAM DATA — INDEX
   Loads all 32 exam data files and assembles ALL_EXAMS.
   index.js MUST load last after all exam files.
══════════════════════════════════════════════ */
let currentExam = 'cgl';

const ALL_EXAMS = window.ALL_EXAMS_PARTS || {};

// Set CGL subjects reference after definition
ALL_EXAMS.cgl.subjects = null; // Will use SUBJECTS directly

// Free the temporary assembly bucket now that ALL_EXAMS owns the data.
delete window.ALL_EXAMS_PARTS;
