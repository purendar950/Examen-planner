import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
function ok(label, cond) { if (cond) { console.log('  ✓', label); checks++; } else { console.error('  ✗', label); process.exitCode = 1; } }

console.log('\nFocus Circle contracts');

// Data layer loads and exposes expected API
const dataSrc = readFileSync(join(root, 'js/data/study-circles.js'), 'utf8');
ok('data layer is an IIFE that sets window.FocusCircleData', dataSrc.includes('window.FocusCircleData'));
for (const fn of ['createCircle','joinByCode','joinPublic','leaveCircle','setVisibility','renameCircle','togglePin','removeMember','getMyCircles','listPublicCircles','getCircleDetail','setPresence','recordFocusMinutes','getLiveSummary','requestToJoin','approveJoinRequest','rejectJoinRequest','watchJoinRequest','subscribeMessages','sendMessage','creationEligibility']) {
  ok(`exports ${fn}`, dataSrc.includes(fn));
}
ok('join code is 6 chars from safe alphabet', /const chars = '[A-HJ-NP-Z2-9]{28}'/.test(dataSrc.replace(/\s+/g,'')) || dataSrc.includes("'ABCDEFGHJKMNPQRSTUVWXYZ23456789'"));
ok('streak gate uses 21 days', dataSrc.includes('REQUIRED_STREAK = 21'));

// Controller wires page activation
const ctrlSrc = readFileSync(join(root, 'js/features/focus-circle.js'), 'utf8');
ok('controller registers onPageActivated', ctrlSrc.includes("onPageActivated('study-circle'"));
for (const fn of ['fcSwitchTab','fcOpenCreateModal','fcDoCreate','fcJoinByCode','fcDoJoinPublic','fcOpenDetail','fcDoApproveRequest','fcDoRejectRequest','fcEnterRoom','fcCloseRoom','fcSendRoomMessage','fcRefreshLive']) {
  ok(`controller exports ${fn}`, ctrlSrc.includes(`window.${fn}`));
}

// Page partial has required containers
const pageSrc = readFileSync(join(root, 'pages/study-circle.html'), 'utf8');
ok('page container id=page-study-circle', pageSrc.includes('id="page-study-circle"'));
ok('nav entry id=nav-study-circle exists in app.html', readFileSync(join(root,'app.html'),'utf8').includes('nav-study-circle'));
ok('page include present in app.html', readFileSync(join(root,'app.html'),'utf8').includes('pages/study-circle.html'));
for (const id of ['fc-live-text','fc-my-list','fc-discover-list','fc-panel-join','fc-create-overlay','fc-detail-overlay','fc-new-approval','fc-room-overlay','fc-room-messages','fc-room-input']) {
  ok(`UI element #${id} exists`, pageSrc.includes(`id="${id}"`));
}

// State defaults
const stateSrc = readFileSync(join(root, 'js/core/state.js'), 'utf8');
ok('state defaults fcCircleIds', stateSrc.includes('fcCircleIds'));
ok('state defaults fcPinnedIds', stateSrc.includes('fcPinnedIds'));
ok('state tracks pending join requests', stateSrc.includes('fcRequestIds'));
ok('accepted requests auto-open the room', ctrlSrc.includes("request.status === 'approved'") && ctrlSrc.includes('fcEnterRoom(cid)'));
ok('messages use a member-only live query', dataSrc.includes("collection('messages')") && dataSrc.includes("orderBy('createdAt', 'asc')"));
ok('rules document includes request and message security', readFileSync(join(root, 'docs/focus-circle-firestore-rules-additions.md'), 'utf8').includes('match /joinRequests/{requestUserId}') && readFileSync(join(root, 'docs/focus-circle-firestore-rules-additions.md'), 'utf8').includes('match /messages/{messageId}'));

// Presence wired into planner timer
const timerSrc = readFileSync(join(root, 'js/tabs/planner-timer.js'), 'utf8');
ok('timer start calls setPresence(true)', timerSrc.includes('setPresence(true)'));
ok('timer stop calls setPresence(false)', timerSrc.includes('setPresence(false)'));
ok('timer records focus minutes on stop', timerSrc.includes('recordFocusMinutes'));

// Script tags loaded
const appHtml = readFileSync(join(root, 'app.html'), 'utf8');
ok('study-circles.js script tag', appHtml.includes('src="js/data/study-circles.js"'));
ok('focus-circle.js script tag', appHtml.includes('src="js/features/focus-circle.js"'));

console.log(`\n${checks} checks passed\n`);
