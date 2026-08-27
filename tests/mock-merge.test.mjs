import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(rootDir, 'src/shared/storageService.js'), 'utf8');

function extract(name) {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start !== -1, `missing ${name}`);
  let depth = 0;
  for (let index = source.indexOf('{', start); index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (!depth) return source.slice(start, index + 1).replace('export ', '');
    }
  }
  throw new Error('unterminated function');
}

const api = vm.runInNewContext(`
function syncFieldRecord(value) {
  if (value && typeof value === 'object') {
    return {
      updatedAt: Math.max(0, Number(value.updatedAt) || 0),
      deleted: value.deleted === true,
      pending: value.pending === true
    };
  }
  return { updatedAt: Math.max(0, Number(value) || 0), deleted: false, pending: false };
}
function mergeMockState(localMocks, remoteMocks) {
  const local = localMocks && typeof localMocks === 'object' ? localMocks : {};
  const remote = remoteMocks && typeof remoteMocks === 'object' ? remoteMocks : {};
  const merged = {};
  const exams = new Set([...Object.keys(remote), ...Object.keys(local)]);

  exams.forEach(exam => {
    const localTiers = local[exam] && typeof local[exam] === 'object' ? local[exam] : {};
    const remoteTiers = remote[exam] && typeof remote[exam] === 'object' ? remote[exam] : {};
    const tiers = new Set([...Object.keys(remoteTiers), ...Object.keys(localTiers)]);
    merged[exam] = {};

    tiers.forEach(tier => {
      const localAttempts = Array.isArray(localTiers[tier]) ? localTiers[tier] : [];
      const remoteAttempts = Array.isArray(remoteTiers[tier]) ? remoteTiers[tier] : [];
      const byId = new Map();
      remoteAttempts.forEach(attempt => { if (attempt && attempt.id != null) byId.set(String(attempt.id), attempt); });
      localAttempts.forEach(attempt => { if (attempt && attempt.id != null) byId.set(String(attempt.id), attempt); });
      merged[exam][tier] = Array.from(byId.values());
    });
  });

  return merged;
}
${extract('mergeAppStateByRevision')};({ mergeAppStateByRevision });`, { JSON, Object, Array, Set, Map, Number, String, Math });

const local = {
  mocks: { cgl: { t1: [{ id: 'a', name: 'Local', total: 100 }], t2: [{ id: 'b', name: 'Keep', total: 50 }] } },
  _syncMeta: { version: 2, revision: 2, fields: { mocks: { updatedAt: 2, pending: true } } }
};
const remote = {
  _syncMeta: { version: 2, revision: 3, fields: {} }
};

const merged = api.mergeAppStateByRevision(local, remote);
assert.equal(merged.mocks.cgl.t1[0].id, 'a');
assert.equal(merged.mocks.cgl.t2[0].id, 'b');

console.log('mock merge regression passed');
