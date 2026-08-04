/*
 * Sends per-user Calculation Practice reminders at each preset's configured
 * IST time. Runs from the existing Telegram workflow every ~15 minutes.
 *
 * Delivery is intentionally at-least-once. A Firestore lease prevents
 * concurrent sends and permits recovery after a crashed worker. If Telegram
 * accepts a message but the final Firestore acknowledgement fails, a later
 * stale-lease recovery may send one duplicate rather than lose the reminder.
 */
const crypto = require('crypto');
const admin = require('firebase-admin');
const { isProUser } = require('../shared/proGating');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set.');

let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
} catch (error) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.');
}
if (!serviceAccount.project_id || !serviceAccount.private_key) {
  throw new Error('FIREBASE_SERVICE_ACCOUNT is incomplete.');
}

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const IST_OFFSET_MS = 330 * 60000;
const DUE_WINDOW_MS = 3 * 60 * 60000;
const RETRY_DELAY_MS = 15 * 60000;
const LEASE_MS = 30 * 60 * 1000;
const DELIVERY_LIMIT = 200;

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}
function escHtml(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function validTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value || '')) return false;
  const [hour, minute] = value.split(':').map(Number);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59;
}
function privateChatId(value) {
  const chatId = String(value == null ? '' : value).trim();
  return /^\d+$/.test(chatId) && Number(chatId) > 0 ? chatId : '';
}
function dateKeyFromWallMs(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
function deliveryId(uid, presetId, practiceDate) {
  return crypto.createHash('sha256').update(`${uid}:${presetId}:${practiceDate}`).digest('hex').slice(0, 32);
}
function presetSnapshot(preset) {
  const reminder = preset && preset.reminder && typeof preset.reminder === 'object' ? preset.reminder : {};
  return {
    id: String((preset && preset.id) || '').slice(0, 80),
    name: String((preset && preset.name) || 'Daily Practice').slice(0, 40),
    icon: String((preset && preset.icon) || '🎯').slice(0, 4),
    questionCount: clamp(preset && preset.questionCount, 3, 50, 10),
    difficulty: ['easy', 'standard', 'exam', 'custom'].includes(preset && preset.difficulty) ? preset.difficulty : 'standard',
    reminder: {
      snoozeMinutes: [5, 10, 15, 30, 60].includes(Number(reminder.snoozeMinutes)) ? Number(reminder.snoozeMinutes) : 10,
      maxSnoozes: [0, 1, 2, 3, 5].includes(Number(reminder.maxSnoozes)) ? Number(reminder.maxSnoozes) : 2
    }
  };
}
function candidateSchedule(preset, nowMs) {
  if (!preset || !preset.dailyEnabled || !preset.reminder || !preset.reminder.telegramEnabled) return null;
  if (!validTime(preset.dailyTime)) return null;
  const days = Array.isArray(preset.days) ? preset.days.map(Number).filter(day => day >= 0 && day <= 6) : [];
  if (!days.length) return null;
  const [hour, minute] = preset.dailyTime.split(':').map(Number);
  const leadMinutes = [0, 5, 10, 15, 30, 60].includes(Number(preset.reminder.reminderMinutes))
    ? Number(preset.reminder.reminderMinutes)
    : 0;
  const nowWallMs = nowMs + IST_OFFSET_MS;
  const todayWall = new Date(nowWallMs);
  const midnightWallMs = Date.UTC(todayWall.getUTCFullYear(), todayWall.getUTCMonth(), todayWall.getUTCDate());
  const candidates = [];

  for (let offset = -1; offset <= 1; offset++) {
    const practiceWallMs = midnightWallMs + offset * 86400000 + (hour * 60 + minute) * 60000;
    if (!days.includes(new Date(practiceWallMs).getUTCDay())) continue;
    const reminderWallMs = practiceWallMs - leadMinutes * 60000;
    const elapsed = nowWallMs - reminderWallMs;
    candidates.push({
      practiceDate: dateKeyFromWallMs(practiceWallMs),
      dueAt: admin.firestore.Timestamp.fromMillis(reminderWallMs - IST_OFFSET_MS),
      baseDue: elapsed >= 0 && elapsed <= DUE_WINDOW_MS,
      distance: Math.abs(elapsed)
    });
  }
  candidates.sort((left, right) => left.distance - right.distance);
  return candidates[0] || null;
}

async function sendMessage(chatId, preset, deliveryDocId) {
  const reminder = preset.reminder || {};
  const snoozeMinutes = [5, 10, 15, 30, 60].includes(Number(reminder.snoozeMinutes)) ? Number(reminder.snoozeMinutes) : 10;
  const maxSnoozes = [0, 1, 2, 3, 5].includes(Number(reminder.maxSnoozes)) ? Number(reminder.maxSnoozes) : 2;
  const practiceUrl = `https://examzen.in/app.html?open=calc&preset=${encodeURIComponent(preset.id)}`;
  const rows = [[{ text: '▶ Start Practice', url: practiceUrl }]];
  if (maxSnoozes > 0) rows.push([{ text: `⏰ Snooze ${snoozeMinutes}m`, callback_data: `calc_snooze:${deliveryDocId}` }]);
  const text =
    `🧮 <b>Calculation Practice</b>\n` +
    `${escHtml(preset.icon || '🎯')} <b>${escHtml(preset.name || 'Daily Practice')}</b>\n` +
    `${clamp(preset.questionCount, 3, 50, 10)} questions · ${escHtml(preset.difficulty || 'standard')}\n\n` +
    'Your scheduled practice is ready.';
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: rows }
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!body.ok) {
    const error = new Error(body.description || `Telegram API error ${body.error_code || response.status}`);
    error.skip = body.error_code === 403 || (body.error_code === 400 && /chat not found/i.test(body.description || ''));
    throw error;
  }
  return { messageId: body.result && body.result.message_id ? String(body.result.message_id) : '' };
}

async function claimDelivery(ref, createAllowed, payload, nowMs) {
  const claimToken = crypto.randomUUID();
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const claim = {
      status: 'sending',
      claimToken,
      claimAt: admin.firestore.Timestamp.fromMillis(nowMs),
      leaseUntil: admin.firestore.Timestamp.fromMillis(nowMs + LEASE_MS)
    };
    if (!snapshot.exists) {
      if (!createAllowed || !payload) return null;
      transaction.create(ref, Object.assign({}, payload, claim, { snoozeCount: 0, attempts: 1 }));
      return claimToken;
    }

    const current = snapshot.data() || {};
    const nextMs = current.nextSendAt && typeof current.nextSendAt.toMillis === 'function' ? current.nextSendAt.toMillis() : 0;
    const leaseMs = current.leaseUntil && typeof current.leaseUntil.toMillis === 'function' ? current.leaseUntil.toMillis() : 0;
    const pendingDue = (current.status === 'snoozed' || current.status === 'retry') && nextMs > 0 && nextMs <= nowMs;
    const staleClaim = current.status === 'sending' && leaseMs > 0 && leaseMs <= nowMs;
    if (!pendingDue && !staleClaim) return null;
    transaction.update(ref, Object.assign({}, claim, { attempts: clamp(current.attempts, 0, 1000, 0) + 1 }));
    return claimToken;
  });
}

async function updateClaim(ref, claimToken, patch) {
  return db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    if (!snapshot.exists) return false;
    const current = snapshot.data() || {};
    if (current.status !== 'sending' || current.claimToken !== claimToken) return false;
    transaction.update(ref, patch);
    return true;
  });
}

async function deliverClaim(ref, delivery, claimToken, nowMs, counters) {
  let telegramResult;
  try {
    telegramResult = await sendMessage(delivery.chatId, delivery.presetSnapshot, ref.id);
  } catch (error) {
    const patch = error.skip
      ? { status: 'blocked', leaseUntil: null, claimToken: null, lastError: String(error.message).slice(0, 200) }
      : {
          status: 'retry',
          leaseUntil: null,
          claimToken: null,
          nextSendAt: admin.firestore.Timestamp.fromMillis(nowMs + RETRY_DELAY_MS),
          lastError: String(error.message).slice(0, 200)
        };
    try { await updateClaim(ref, claimToken, patch); } catch (writeError) {
      console.error(`⚠️ Could not persist reminder failure ${ref.id}: ${writeError.message}`);
    }
    counters.failed++;
    console.error(`❌ Calculation reminder failed → ${delivery.uid || 'unknown'}: ${error.message}`);
    return;
  }

  try {
    const acknowledged = await updateClaim(ref, claimToken, {
      status: 'sent',
      sentAt: admin.firestore.FieldValue.serverTimestamp(),
      telegramMessageId: telegramResult.messageId,
      nextSendAt: null,
      leaseUntil: null,
      claimToken: null,
      lastError: null
    });
    if (!acknowledged) throw new Error('delivery claim changed before acknowledgement');
    counters.sent++;
    console.log(`✅ Calculation reminder sent → ${delivery.uid || 'unknown'} / ${delivery.presetId || ''}`);
  } catch (error) {
    // Telegram already accepted this message. Leave the lease intact so stale
    // recovery applies the documented at-least-once policy instead of racing.
    counters.failed++;
    console.error(`⚠️ Telegram accepted reminder ${ref.id}, but acknowledgement failed: ${error.message}`);
  }
}

async function processPendingDeliveries(nowMs, counters) {
  const now = admin.firestore.Timestamp.fromMillis(nowMs);
  const [dueSnapshot, staleSnapshot] = await Promise.all([
    db.collection('calculationReminderDeliveries').where('nextSendAt', '<=', now).limit(DELIVERY_LIMIT).get(),
    db.collection('calculationReminderDeliveries').where('leaseUntil', '<=', now).limit(DELIVERY_LIMIT).get()
  ]);
  const docs = new Map();
  dueSnapshot.docs.concat(staleSnapshot.docs).forEach(doc => docs.set(doc.id, doc));

  for (const doc of docs.values()) {
    const delivery = doc.data() || {};
    const pending = delivery.status === 'snoozed' || delivery.status === 'retry' || delivery.status === 'sending';
    if (!pending || !privateChatId(delivery.chatId) || !delivery.presetSnapshot) continue;
    const claimToken = await claimDelivery(doc.ref, false, null, nowMs);
    if (!claimToken) continue;
    await deliverClaim(doc.ref, delivery, claimToken, nowMs, counters);
  }
}

async function main() {
  const nowMs = Date.now();
  const today = dateKeyFromWallMs(nowMs + IST_OFFSET_MS);
  const counters = { sent: 0, skipped: 0, failed: 0 };

  // Snoozes/retries are driven by their persisted delivery snapshot. They do
  // not disappear if a user edits or deletes the source preset afterwards.
  await processPendingDeliveries(nowMs, counters);

  const [users, admins] = await Promise.all([
    db.collection('users').get(),
    db.collection('admins').get()
  ]);
  const adminUids = new Set(admins.docs.map(doc => doc.id));

  for (const userDoc of users.docs) {
    const user = userDoc.data() || {};
    const appState = user.appState || {};
    const telegram = appState.telegram || {};
    const chatId = privateChatId(telegram.chatId);
    const calculation = appState.calculationPractice || {};
    const presets = Array.isArray(calculation.presets) ? calculation.presets : [];
    const preset = presets.find(item => item && item.id === calculation.dailyPresetId);
    const schedule = candidateSchedule(preset, nowMs);
    if (!telegram.enabled || !chatId || !preset || !preset.dailyEnabled || !preset.reminder || !preset.reminder.telegramEnabled || !schedule) {
      counters.skipped++;
      continue;
    }
    if (!adminUids.has(userDoc.id) && !isProUser(user, today)) {
      counters.skipped++;
      continue;
    }

    const id = deliveryId(userDoc.id, preset.id, schedule.practiceDate);
    const ref = db.collection('calculationReminderDeliveries').doc(id);
    const snapshot = presetSnapshot(preset);
    const payload = {
      uid: userDoc.id,
      presetId: preset.id,
      presetSnapshot: snapshot,
      practiceDate: schedule.practiceDate,
      chatId,
      authorizedTelegramUserId: chatId,
      snoozeMinutes: snapshot.reminder.snoozeMinutes,
      maxSnoozes: snapshot.reminder.maxSnoozes,
      dueAt: schedule.dueAt
    };
    const claimToken = await claimDelivery(ref, schedule.baseDue, payload, nowMs);
    if (!claimToken) {
      counters.skipped++;
      continue;
    }
    await deliverClaim(ref, payload, claimToken, nowMs, counters);
  }

  console.log(`Calculation reminders: sent=${counters.sent} skipped=${counters.skipped} failed=${counters.failed}`);
  if (counters.failed) process.exitCode = 1;
}

main().catch(error => {
  console.error('❌ Calculation reminder fatal error:', error.message);
  process.exit(1);
});
