/* ══════════════════════════════════════════════
   TELEGRAM DAILY PLAN — link + precomputed digest
   The actual sending is done by a daily GitHub Actions job (server-side).
   The browser's only jobs are:
     1. let the user opt in + store their Telegram chatId
     2. precompute a per-date plain-text digest so the job can just read it
══════════════════════════════════════════════ */

/* Build up to 7 days (today + next 6) of plan text from the combined schedule
   map (study topics + due revisions). Stored as { 'YYYY-MM-DD': 'line\nline' }. */
function buildTelegramDigest() {
  const digest = {};
  try {
    const map = (typeof getPlanScheduleMap === 'function') ? getPlanScheduleMap() : {};
    const start = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = (typeof fmtDate === 'function') ? fmtDate(d) : d.toISOString().slice(0, 10);
      const items = (map[ds] || []).filter(it => {
        if (it.type === 'spacer') return false;
        /* Drop topics the user deleted so a regenerating plan doesn't re-add
           them to the digest (mirrors the planner views' tombstone check). */
        const ch = it.ch || {};
        if (typeof isTaskDeleted === 'function' &&
            isTaskDeleted({
              chId: ch.id || '',
              text: ch.name || '',
              planPartIndex: Number(it.partIndex) || 0,
              planTotalParts: Math.max(1, Number(it.totalParts) || 1),
              planId: it.planId || 'default'
            })) return false;
        return true;
      });
      if (!items.length) continue;
      const lines = items.map(it => {
        const ch = it.ch || {};
        if (it.type === 'revise') return `🔁 Revise: ${ch.name || ''}${it.dueLabel ? ' (' + it.dueLabel + ')' : ''}`;
        return `📖 ${ch.name || ''}${it.part ? ' ' + it.part : ''}${ch.subName ? '  — ' + ch.subName : ''}`;
      });
      digest[ds] = lines.join('\n');
    }
  } catch(e) {}
  return digest;
}

/* Refresh the stored digest (called whenever the plan or progress changes). */
function refreshTelegramDigest() {
  if (!appState.telegram) appState.telegram = { chatId:'', username:'', enabled:false, digest:null };
  appState.telegram.digest = buildTelegramDigest();
}

/* Save the Telegram settings from the Study Profile modal. */
function saveTelegramSettings() {
  if (!appState.telegram) appState.telegram = { chatId:'', username:'', enabled:false, digest:null };
  const chatEl   = document.getElementById('tg-chatid');
  const onEl     = document.getElementById('tg-enabled');
  const statusEl = document.getElementById('tg-status-msg');
  if (chatEl) appState.telegram.chatId = (chatEl.value || '').trim();
  if (onEl)   appState.telegram.enabled = !!onEl.checked;

  /* Warn if enabled but no chat ID */
  if (appState.telegram.enabled && !appState.telegram.chatId) {
    if (statusEl) { statusEl.style.color = '#e74c3c'; statusEl.textContent = '⚠️ Pehle Chat ID daalo — "Step 1: Bot kholo" dabao ya @userinfobot se ID lo.'; }
    if (typeof showToast === 'function') showToast('⚠️ Chat ID missing! Pehle bot se ya @userinfobot se ID lo.', 'info');
    return;
  }

  refreshTelegramDigest();
  saveProgress();

  const ok = appState.telegram.enabled && appState.telegram.chatId;
  if (statusEl) {
    statusEl.style.color = ok ? '#27ae60' : 'var(--muted)';
    statusEl.textContent = ok
      ? '✅ Saved! Kal subah 6 AM IST pe message aayega.'
      : appState.telegram.enabled ? '' : '🔕 Telegram notifications OFF.';
  }
  if (typeof showToast === 'function') {
    showToast(appState.telegram.enabled
      ? (appState.telegram.chatId ? '📩 Daily Telegram plan ON ✅' : '⚠️ Chat ID daalo pehle')
      : '🔕 Telegram daily plan OFF', ok ? 'success' : 'info');
  }
}

/* Open the bot so the user can press Start; payload carries their uid. */
const TELEGRAM_BOT_USERNAME = 'SSCplannerbot'; /* Connect button opens https://t.me/SSCplannerbot */
function connectTelegram() {
  const uid = (currentUser && currentUser.uid) ? currentUser.uid : '';
  const url = 'https://t.me/' + TELEGRAM_BOT_USERNAME + (uid ? '?start=' + encodeURIComponent(uid) : '');
  window.open(url, '_blank');
  /* After opening, show guidance so user knows what to do next */
  setTimeout(function() {
    const msg = document.getElementById('tg-status-msg');
    if (msg) {
      msg.style.color = '#229ED9';
      msg.textContent = '✅ Bot khul gaya! "Start" dabao → bot apna Chat ID reply karega → woh ID oopar paste karo.';
    }
    if (typeof showToast === 'function') {
      showToast('Bot open hua! Start dabao → Chat ID copy karo → yahan paste karo 👆', 'info');
    }
  }, 800);
}

/* Verify that the entered chat ID looks valid and test-ping it */
async function verifyTelegramChatId() {
  const chatEl = document.getElementById('tg-chatid');
  const statusEl = document.getElementById('tg-status-msg');
  const chatId = (chatEl && chatEl.value || '').trim();
  if (!chatId || !/^-?\d+$/.test(chatId)) {
    if (statusEl) { statusEl.style.color = '#e74c3c'; statusEl.textContent = '⚠️ Valid numeric Chat ID daalo (e.g. 987654321)'; }
    return;
  }
  if (statusEl) { statusEl.style.color = 'var(--muted)'; statusEl.textContent = '⏳ Testing...'; }
  try {
    const token = null; /* Bot token is only in GitHub Secrets — we can't test-send from browser */
    /* Without token in browser we just validate format and show success */
    if (statusEl) { statusEl.style.color = '#27ae60'; statusEl.textContent = '✅ Chat ID format sahi hai! Save karo aur GitHub Actions se test karo.'; }
  } catch(e) {
    if (statusEl) { statusEl.style.color = '#e74c3c'; statusEl.textContent = '❌ Error: ' + e.message; }
  }
}

/* Opened from the user dropdown — close the menu and show the Study Profile
   modal, which contains the full Telegram daily-plan section. */
function openTelegramSettings() {
  try {
    const menu = document.getElementById('user-menu-dropdown');
    if (menu) menu.classList.remove('open');
  } catch(e) {}
  if (typeof openStudyProfileModal === 'function') {
    openStudyProfileModal(3); /* jump straight to the Schedule & Telegram step */
    /* Scroll the Telegram section into view inside the modal. */
    setTimeout(function() {
      try {
        const el = document.getElementById('tg-chatid');
        if (el) el.scrollIntoView({ behavior:'smooth', block:'center' });
      } catch(e) {}
    }, 200);
  } else if (typeof showToast === 'function') {
    showToast('Open Planner → ⚙️ Profile to connect Telegram.', 'info');
  }
}



/* ══════════════════════════════════════════════
   TELEGRAM → PLANNER INBOX (AI auto-schedule)
   The Telegram bot writes tasks/videos a user texts it into a SEPARATE
   `telegramInbox` array on their user doc (NOT inside appState, so the
   browser's full-appState save can never clobber them). Here we drain that
   inbox into appState.tasks, resolve subject names → subject ids, then clear
   the inbox. Driven by the existing onSnapshot listener in auth.js, so new
   tasks appear live (no manual reload).
══════════════════════════════════════════════ */

/* Map any telegram task's free-text subject name onto a real subject id (for
   the colored subject chip). Runs over all tasks; only fills empty .subject. */
function resolveTelegramTaskSubjects() {
  try {
    const subs = (typeof getActiveSubjects === 'function') ? getActiveSubjects() : [];
    if (!subs.length || !appState.tasks) return;
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    Object.keys(appState.tasks).forEach(ds => {
      (appState.tasks[ds] || []).forEach(t => {
        if (t.subject || !t.subjectName) return;
        const key = norm(t.subjectName);
        if (!key) return;
        let hit = subs.find(s => norm(s.name) === key);
        if (!hit) hit = subs.find(s => norm(s.name).includes(key) || key.includes(norm(s.name)));
        if (!hit) {
          /* match on the first word of the subject name (e.g. "General Science") */
          hit = subs.find(s => { const first = norm(s.name.split(/[ &]/)[0]); return first && (first === key || key.includes(first) || first.includes(key)); });
        }
        if (hit) t.subject = hit.id;
      });
    });
  } catch (e) {}
}

/* Base URL of the proxy that streams Telegram-hosted images (/tg-photo). */
function tgProxyBase() {
  return (localStorage.getItem('turboBackendUrl') || 'https://youtube-turbo-proxy-gej4.onrender.com').replace(/\/+$/, '');
}

/* Telegram media is protected by Firebase identity, so <img src> cannot fetch
   it directly. Fetch the file with an Authorization header, then attach a
   short-lived object URL to the image element instead. */
function tgHydrateImage(img, fileId) {
  if (!img || !fileId || img.dataset.tgLoading) return;
  img.dataset.tgLoading = '1';
  var attempts = 0;

  function load() {
    attempts += 1;
    var retryPending = false;
    getFirebaseIdToken().then(function (token) {
      return fetch(tgProxyBase() + '/tg-photo?file_id=' + encodeURIComponent(fileId), {
        headers: { Authorization: 'Bearer ' + token }
      });
    }).then(function (response) {
      if (!response.ok) {
        var error = new Error('photo unavailable');
        error.status = response.status;
        throw error;
      }
      return response.blob();
    }).then(function (blob) {
      if (!img.isConnected) return;
      var objectUrl = URL.createObjectURL(blob);
      var oldUrl = img.dataset.tgObjectUrl;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      img.dataset.tgObjectUrl = objectUrl;
      img.src = objectUrl;
    }).catch(function (error) {
      // Firestore may not yet contain a just-sent file ID when the UI paints.
      // Retry that short replication race only; authorization and other failures
      // should remain visible immediately instead of masking a real problem.
      if (error && error.status === 404 && attempts < 3 && img.isConnected) {
        retryPending = true;
        setTimeout(load, attempts * 350);
        return;
      }
      if (img.isConnected) img.alt = 'Telegram photo unavailable';
    }).then(function () {
      if (!retryPending) delete img.dataset.tgLoading;
    });
  }

  load();
}

function tgHydrateImages(root) {
  if (!root) return;
  root.querySelectorAll('img[data-tg-file-id]').forEach(function (img) {
    tgHydrateImage(img, img.dataset.tgFileId);
  });
}

/* The "Telegram Uploads" store: a flat tree the user organises in the Uploads
   tab. folders keyed by id ({id,name,parentId}); images carry a folderId
   (null = root). Only the Telegram file_id is stored — never image bytes. */
function tgUploadsState() {
  if (!appState.tgUploads || typeof appState.tgUploads !== 'object') appState.tgUploads = { folders: {}, images: [] };
  if (!appState.tgUploads.folders) appState.tgUploads.folders = {};
  if (!Array.isArray(appState.tgUploads.images)) appState.tgUploads.images = [];
  return appState.tgUploads;
}

/* Add an image the user sent the bot into the Uploads store (at root). */
function addTgUploadImage(item) {
  try {
    if (!item || !item.tgFileId) return false;
    const u = tgUploadsState();
    if (u.images.some(im => im.tgFileId === item.tgFileId)) return false;   // de-dupe
    u.images.push({
      id: 'im_' + (item.id || Date.now()) + Math.random().toString(36).slice(2, 5),
      tgFileId: item.tgFileId,
      caption: item.caption || '',
      createdAt: item.createdAt || new Date().toISOString(),
      folderId: null                                   // arrives at root
    });
    return true;
  } catch (e) { return false; }
}

/* One-time migration: images from an earlier build that landed in the
   Screenshots store (source:'telegram-upload') are moved into the Uploads
   store and removed from ytScreenshots. Returns how many were moved. */
function migrateTelegramUploads() {
  try {
    const ss = appState.ytScreenshots;
    if (!ss || !ss.folders) return 0;
    const u = tgUploadsState();
    let moved = 0;
    Object.keys(ss.folders).forEach(plId => {
      const pl = ss.folders[plId];
      Object.keys(pl.videos || {}).forEach(vId => {
        const vf = pl.videos[vId];
        (vf.items || []).slice().forEach(it => {
          if (it.source !== 'telegram-upload') return;
          if (it.tgFileId && !u.images.some(im => im.tgFileId === it.tgFileId)) {
            u.images.push({
              id: it.id || ('im_' + Date.now() + Math.random().toString(36).slice(2, 5)),
              tgFileId: it.tgFileId,
              caption: it.label || it.videoTitle || '',
              createdAt: it.createdAt || new Date().toISOString(),
              folderId: null
            });
            moved++;
          }
          vf.items = vf.items.filter(x => x !== it);
        });
        if (!(vf.items || []).length) delete pl.videos[vId];
      });
      if (!Object.keys(pl.videos || {}).length) delete ss.folders[plId];
    });
    return moved;
  } catch (e) { return 0; }
}

/* Drain the telegramInbox array from a Firestore user-doc snapshot into the
   planner. Safe to call on every snapshot — it no-ops when the inbox is empty
   and clears the inbox after merging so items are processed exactly once. */
function drainTelegramInbox(snapData) {
  try {
    const inbox = snapData && snapData.telegramInbox;
    if (!Array.isArray(inbox) || !inbox.length) return;
    if (!appState.tasks) appState.tasks = {};

    /* Remember which inbox items we've already turned into tasks. Without this,
       a Telegram task the user later DELETED would be re-created on the very
       next snapshot (and every day after) whenever the server-side inbox clear
       below didn't stick — offline, a permission hiccup, or a racing write all
       leave the item lingering. Keying on the inbox item's stable id makes the
       drain idempotent: each texted task is materialised exactly once, ever, so
       deleting it makes it stay deleted. */
    if (!Array.isArray(appState.telegramProcessedIds)) appState.telegramProcessedIds = [];
    const processed = new Set(appState.telegramProcessedIds);

    const fmt = (typeof fmtDate === 'function') ? fmtDate : (d => d.toISOString().slice(0, 10));
    const todayStr = fmt(new Date());
    let added = 0;
    let imgAdded = 0;
    const newlyProcessed = [];

    inbox.forEach(item => {
      if (!item) return;

      /* Already materialised once — never re-add (even if the user deleted it). */
      if (item.id != null && processed.has(item.id)) return;
      if (item.id != null) { processed.add(item.id); newlyProcessed.push(item.id); }

      /* Images the user sent the bot → Uploads store (organised in Uploads tab). */
      if (item.kind === 'image') { if (addTgUploadImage(item)) imgAdded++; return; }

      const date = /^\d{4}-\d{2}-\d{2}$/.test(item.date) ? item.date : todayStr;
      if (!appState.tasks[date]) appState.tasks[date] = [];
      const list = appState.tasks[date];

      /* De-dupe: same video already on the day, or same text already added from Telegram. */
      if (item.videoId && list.some(t => t.videoId === item.videoId)) return;
      const txt = (item.text || item.title || '').trim();
      if (!item.videoId && txt && list.some(t => t.fromTelegram && (t.text || '').trim().toLowerCase() === txt.toLowerCase())) return;

      /* Stay-deleted guard for inbox items with no stable id (which the
         telegramProcessedIds ledger can't track): if the user already deleted
         this exact video/text, don't recreate it on a later snapshot. */
      if (typeof isTaskDeleted === 'function' &&
          isTaskDeleted(item.videoId ? { videoId: item.videoId } : { text: txt })) return;

      const task = {
        id: 'tg_' + (item.id || (Date.now().toString())) + Math.random().toString(36).slice(2, 6),
        text: txt || 'Task',
        done: false,
        status: 'todo',
        priority: ['high', 'normal', 'low'].includes(item.priority) ? item.priority : 'normal',
        subject: '',
        subjectName: item.subjectName || '',
        type: item.kind === 'video' ? 'video' : 'study',
        fromTelegram: true
      };
      if (item.kind === 'video' && item.videoId) {
        task.type = 'video';
        task.videoId = item.videoId;
        task.url = item.url || ('https://www.youtube.com/watch?v=' + item.videoId);
      }
      list.push(task);
      added++;
    });

    /* Persist the processed-id ledger (capped so it can't grow unbounded) so the
       "add exactly once" guarantee survives reloads and future snapshots. */
    if (newlyProcessed.length) {
      const MAX_PROCESSED = 500;
      appState.telegramProcessedIds = appState.telegramProcessedIds
        .concat(newlyProcessed)
        .slice(-MAX_PROCESSED);
    }

    /* Clear the server inbox so items aren't re-added on the next snapshot. */
    try {
      if (db && currentUser) db.collection('users').doc(currentUser.uid).update({ telegramInbox: [] }).catch(() => {});
    } catch (e) {}

    /* Persist even when nothing was newly added but the ledger grew, so the
       "process once" guarantee is durable. Only surface UI when tasks actually
       appeared. */
    if (added || newlyProcessed.length) {
      if (typeof saveProgress === 'function') saveProgress();
    }
    if (added) {
      resolveTelegramTaskSubjects();
      try { if (typeof buildPlannerCalendar === 'function') buildPlannerCalendar(); } catch (e) {}
      if (typeof showToast === 'function') {
        showToast('📩 ' + added + ' naya task' + (added > 1 ? 's' : '') + ' Telegram se add hua! Planner check karo.', 'success');
      }
    }

    if (imgAdded) {
      if (typeof saveProgress === 'function') saveProgress();
      try { if (typeof ssUpdateBadge === 'function') ssUpdateBadge(); } catch (e) {}
      /* Live-refresh the Analysis tab if it's open. */
      try {
        const pg = document.getElementById('page-analysis');
        if (typeof anRender === 'function' && pg && pg.classList.contains('active')) anRender();
      } catch (e) {}
      if (typeof showToast === 'function') {
        showToast('🖼️ ' + imgAdded + ' image Telegram se aayi — Analysis → 📥 Uploads dekho.', 'success');
      }
    }
  } catch (e) {}
}
