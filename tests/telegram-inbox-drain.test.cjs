const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../js/features/telegram.js'), 'utf8');

function createHarness({ saveProgressNow, inbox }) {
  const writes = [];
  let remoteInbox = inbox.slice();
  const context = {
    console,
    appState: { tasks: {}, telegramProcessedIds: [] },
    currentUser: { uid: 'user-1' },
    db: {
      collection() {
        return {
          doc() {
            return {
              update(payload) {
                writes.push(payload);
                return Promise.resolve();
              },
            };
          },
        };
      },
      runTransaction(callback) {
        const transaction = {
          get: async () => ({ exists: true, data: () => ({ telegramInbox: remoteInbox }) }),
          update: (_ref, payload) => {
            remoteInbox = payload.telegramInbox;
            writes.push(payload);
          },
        };
        return callback(transaction);
      },
    },
    fmtDate: () => '2026-08-21',
    saveProgress() {},
    saveProgressNow,
    buildPlannerCalendar() {},
    resolveTelegramTaskSubjects() {},
    showToast() {},
    isTaskDeleted() { return false; },
    addTgUploadImage() { return false; },
    document: { getElementById() { return null; } },
    window: {},
  };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__drainTelegramInbox = drainTelegramInbox;`, context);
  return { context, writes, inbox };
}

async function run() {
  const item = {
    id: 'tg-task-1',
    kind: 'task',
    text: 'Revise Economics GDP',
    date: '2026-08-21',
    priority: 'normal',
  };

  const saved = createHarness({
    saveProgressNow: async () => true,
    inbox: [item],
  });
  await saved.context.__drainTelegramInbox({ telegramInbox: saved.inbox });
  assert.equal(saved.context.appState.tasks['2026-08-21'].length, 1);
  assert.equal(saved.context.appState.tasks['2026-08-21'][0].fromTelegram, true);
  assert.equal(saved.writes.length, 1);
  assert.equal(saved.writes[0].telegramInbox.length, 0);

  const failed = createHarness({
    saveProgressNow: async () => false,
    inbox: [item],
  });
  await failed.context.__drainTelegramInbox({ telegramInbox: failed.inbox });
  assert.equal(failed.context.appState.tasks['2026-08-21'].length, 1);
  assert.equal(failed.writes.length, 0, 'the inbox must remain queued when persistence has not succeeded');

  console.log('telegram inbox drain harness passed');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
