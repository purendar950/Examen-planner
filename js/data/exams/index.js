/* ══════════════════════════════════════════════
   MULTI-EXAM DATA — INDEX
   Split from the original monolithic js/data/exams.js into per-exam data
   files (this directory), one per supported exam:
     cgl.js, ntpc.js, gd.js, ibps.js, upsc.js, uppcs.js, bpsc.js
   Each of those files only sets window.ALL_EXAMS_PARTS.<id> = {...}; this
   index file (loaded LAST, after all seven) assembles the final ALL_EXAMS
   object and defines currentExam — exactly reproducing what the single
   js/data/exams.js file used to do, just organized by exam instead of as
   one 1300+ line object literal.
══════════════════════════════════════════════ */
let currentExam = 'cgl';

const ALL_EXAMS = window.ALL_EXAMS_PARTS || {};

// Set CGL subjects reference after definition
ALL_EXAMS.cgl.subjects = null; // Will use SUBJECTS directly

// Free the temporary assembly bucket now that ALL_EXAMS owns the data.
delete window.ALL_EXAMS_PARTS;
