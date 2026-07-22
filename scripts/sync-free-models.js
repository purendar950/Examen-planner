/*
 * Daily model catalog refresh
 * ---------------------------
 * Admins maintain two mutually-exclusive provider lists in config/ai:
 *   dailyFreeModelProviders — verified zero-price models only
 *   dailyAllModelProviders  — every current text/chat model, free and paid
 *
 * A selected provider's providerModels entry is replaced only after a complete,
 * non-empty catalog fetch. Failed, malformed, timed-out, or empty responses
 * record an error but never remove the previous model list.
 */

const admin = require('firebase-admin');

const REFRESHABLE_PROVIDERS = {
  openrouter: {
    label: 'OpenRouter',
    keyField: 'openrouterApiKeys',
    modelField: 'openrouterModel',
    catalogUrl: 'https://openrouter.ai/api/v1/models',
  },
};

const CATALOG_MODES = {
  free: {
    providerField: 'dailyFreeModelProviders',
    statusField: 'dailyFreeModelSyncStatus',
    label: 'verified free',
  },
  all: {
    providerField: 'dailyAllModelProviders',
    statusField: 'dailyAllModelSyncStatus',
    label: 'free and paid',
  },
};

function catalogMode(mode) {
  return CATALOG_MODES[mode] || CATALOG_MODES.free;
}

function configuredKeys(config, field) {
  const raw = config && config[field];
  const values = Array.isArray(raw) ? raw : String(raw || '').split(/[\n,]+/);
  return values.map((value) => String(value || '').trim()).filter(Boolean);
}

function isZeroPrice(value) {
  if ((typeof value !== 'string' && typeof value !== 'number') ||
      (typeof value === 'string' && !value.trim())) return false;
  const number = Number(value);
  return Number.isFinite(number) && number === 0;
}

function hasModelId(model) {
  return !!(model && typeof model.id === 'string' && model.id.trim());
}

function isFreeOpenRouterModel(model) {
  if (!hasModelId(model)) return false;
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== 'object') return false;

  // A model is free only when OpenRouter reports zero input and output price.
  // If request-level pricing is present, it must also be zero.
  if (!isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) return false;
  return !Object.prototype.hasOwnProperty.call(pricing, 'request') || isZeroPrice(pricing.request);
}

async function fetchOpenRouterModels(config, fetchImpl, mode = 'free') {
  const provider = REFRESHABLE_PROVIDERS.openrouter;
  const keys = configuredKeys(config, provider.keyField);
  const modeInfo = catalogMode(mode);
  if (!keys.length) {
    throw new Error('OpenRouter needs an API key before its ' + modeInfo.label + ' catalog can be refreshed.');
  }

  const params = new URLSearchParams({ output_modalities: 'text' });
  if (mode === 'free') {
    params.set('max_price', '0');
    params.set('max_output_price', '0');
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(provider.catalogUrl + '?' + params.toString(), {
      headers: {
        Authorization: 'Bearer ' + keys[0],
        Accept: 'application/json',
      },
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error('OpenRouter catalog timed out after 20 seconds.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 180);
    throw new Error('OpenRouter catalog returned HTTP ' + response.status + (detail ? ': ' + detail : ''));
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error('OpenRouter catalog did not return valid JSON.');
  }
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error('OpenRouter catalog response is missing its model list.');
  }

  const models = [...new Set(payload.data
    .filter(mode === 'free' ? isFreeOpenRouterModel : hasModelId)
    .map((model) => model.id.trim()))].sort((left, right) => left.localeCompare(right));

  if (!models.length) {
    throw new Error('OpenRouter catalog returned no ' + modeInfo.label + ' text models; existing models were preserved.');
  }
  return models;
}

function fetchOpenRouterFreeModels(config, fetchImpl) {
  return fetchOpenRouterModels(config, fetchImpl, 'free');
}

function fetchCatalog(providerId, config, fetchImpl, mode = 'free') {
  if (providerId === 'openrouter') return fetchOpenRouterModels(config, fetchImpl, mode);
  throw new Error('Automatic model discovery is not supported for this provider.');
}

function cleanModelList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((model) => String(model || '').trim()).filter(Boolean))]
    : [];
}

function configuredProviderList(config, mode = 'free') {
  const listed = Array.isArray(config && config[catalogMode(mode).providerField])
    ? config[catalogMode(mode).providerField]
    : [];
  return [...new Set(listed.map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean))];
}

function catalogSelections(config, providerIds) {
  // providerIds is retained as a free-only test/compatibility override.
  if (providerIds) return providerIds.map((providerId) => ({ providerId, mode: 'free' }));

  const freeProviders = configuredProviderList(config, 'free');
  const freeSet = new Set(freeProviders);
  const allProviders = configuredProviderList(config, 'all').filter((providerId) => !freeSet.has(providerId));
  return freeProviders.map((providerId) => ({ providerId, mode: 'free' }))
    .concat(allProviders.map((providerId) => ({ providerId, mode: 'all' })));
}

async function syncModelCatalogs({ db, fetchImpl = global.fetch, providerIds } = {}) {
  if (!db) throw new Error('Firestore database is required.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const configRef = db.collection('config').doc('ai');
  const initialSnapshot = await configRef.get();
  const initialConfig = initialSnapshot.exists ? (initialSnapshot.data() || {}) : {};
  const selected = catalogSelections(initialConfig, providerIds);
  if (!selected.length) return { selected: [], results: {}, changed: false };

  const results = {};
  const catalogs = {};
  for (const selection of selected) {
    const { providerId, mode } = selection;
    if (!REFRESHABLE_PROVIDERS[providerId]) {
      results[providerId] = { ok: false, mode, error: 'Automatic model discovery is not supported for this provider.' };
      continue;
    }
    try {
      catalogs[providerId] = await fetchCatalog(providerId, initialConfig, fetchImpl, mode);
      results[providerId] = { ok: true, mode, modelCount: catalogs[providerId].length };
    } catch (error) {
      results[providerId] = { ok: false, mode, error: error && error.message ? error.message : String(error) };
    }
  }

  let changed = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(configRef);
    const config = snapshot.exists ? (snapshot.data() || {}) : {};
    const providerModels = Object.assign({}, config.providerModels || {});
    const statuses = {};
    Object.keys(CATALOG_MODES).forEach((mode) => {
      statuses[mode] = Object.assign({}, config[CATALOG_MODES[mode].statusField] || {});
    });
    const updates = {};

    selected.forEach((selection) => {
      const { providerId, mode } = selection;
      if (!configuredProviderList(config, mode).includes(providerId)) return;
      // If a stale config manually contains a provider in both lists, the
      // free-only list wins and prevents the all-model refresh from overwriting it.
      if (mode === 'all' && configuredProviderList(config, 'free').includes(providerId)) return;

      const priorStatus = Object.assign({}, statuses[mode][providerId] || {});
      const result = results[providerId];
      if (!result || !result.ok) {
        statuses[mode][providerId] = Object.assign(priorStatus, {
          state: 'error',
          lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
          lastError: (result && result.error) || 'Catalog refresh failed.',
        });
        return;
      }

      const previous = cleanModelList(providerModels[providerId]);
      const next = catalogs[providerId];
      const previousSet = new Set(previous);
      const nextSet = new Set(next);
      const added = next.filter((model) => !previousSet.has(model));
      const removed = previous.filter((model) => !nextSet.has(model));
      providerModels[providerId] = next;

      const provider = REFRESHABLE_PROVIDERS[providerId];
      const activeModel = String(config[provider.modelField] || '').trim();
      const activeStudyModel = String(config.studyModel || '').trim();
      let replacementModel = '';
      if (activeModel && !nextSet.has(activeModel)) {
        replacementModel = next[0];
        updates[provider.modelField] = replacementModel;
      }
      if (String(config.studyProvider || '').trim().toLowerCase() === providerId && activeStudyModel && !nextSet.has(activeStudyModel)) {
        replacementModel = next[0];
        updates.studyModel = replacementModel;
      }

      statuses[mode][providerId] = {
        state: 'success',
        lastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
        lastSuccessAt: admin.firestore.FieldValue.serverTimestamp(),
        lastError: '',
        added: added.length,
        removed: removed.length,
        modelCount: next.length,
        activeModelReplaced: replacementModel || '',
      };
      results[providerId] = Object.assign(result, {
        added: added.length,
        removed: removed.length,
        activeModelReplaced: replacementModel || '',
      });
      changed = true;
    });

    const statusUpdates = {};
    Object.keys(CATALOG_MODES).forEach((mode) => {
      statusUpdates[CATALOG_MODES[mode].statusField] = statuses[mode];
    });
    transaction.set(configRef, Object.assign({ providerModels }, statusUpdates, updates), { merge: true });
  });

  return { selected: selected.map((selection) => selection.providerId), results, changed };
}

// Compatibility name for existing callers/tests; it now synchronizes both
// configured lists when no providerIds override is supplied.
function syncFreeModels(options) {
  return syncModelCatalogs(options);
}

function loadServiceAccount() {
  try {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  } catch (error) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON: ' + error.message);
  }
}

async function main() {
  const serviceAccount = loadServiceAccount();
  if (!serviceAccount.project_id || !serviceAccount.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is incomplete (project_id and private_key are required).');
  }
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  const outcome = await syncModelCatalogs({ db: admin.firestore() });

  if (!outcome.selected.length) {
    console.log('No providers are enabled for model catalog refresh. Nothing to do.');
    return;
  }
  Object.entries(outcome.results).forEach(([providerId, result]) => {
    if (result.ok) {
      console.log('✓ ' + providerId + ' (' + catalogMode(result.mode).label + '): ' + result.modelCount + ' models (+' + result.added + ', -' + result.removed + ')' +
        (result.activeModelReplaced ? '; active model moved to ' + result.activeModelReplaced : ''));
    } else {
      console.error('✗ ' + providerId + ' (' + catalogMode(result.mode).label + '): ' + result.error);
    }
  });
  const failures = Object.values(outcome.results).filter((result) => !result.ok);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Model catalog refresh failed:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  CATALOG_MODES,
  REFRESHABLE_PROVIDERS,
  catalogSelections,
  configuredProviderList,
  fetchOpenRouterFreeModels,
  fetchOpenRouterModels,
  isFreeOpenRouterModel,
  syncFreeModels,
  syncModelCatalogs,
};
