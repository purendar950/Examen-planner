/*
 * Daily free-model catalog refresh
 * --------------------------------
 * Reads config/ai.dailyFreeModelProviders and replaces ONLY those providers'
 * config/ai.providerModels entries after a complete, non-empty catalog fetch.
 * A failed, malformed, or unexpectedly empty response never removes models.
 *
 * Supported catalogs are deliberately limited to providers with a documented,
 * machine-readable pricing catalog. Add adapters only after verifying their
 * pricing metadata is reliable enough to decide whether a model is free.
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

function isFreeOpenRouterModel(model) {
  if (!model || typeof model.id !== 'string' || !model.id.trim()) return false;
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== 'object') return false;

  // A model is free only when OpenRouter reports zero input and output price.
  // If request-level pricing is present, it must also be zero.
  if (!isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) return false;
  return !Object.prototype.hasOwnProperty.call(pricing, 'request') || isZeroPrice(pricing.request);
}

async function fetchOpenRouterFreeModels(config, fetchImpl) {
  const provider = REFRESHABLE_PROVIDERS.openrouter;
  const keys = configuredKeys(config, provider.keyField);
  if (!keys.length) {
    throw new Error('OpenRouter needs an API key before its free-model catalog can be refreshed.');
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(provider.catalogUrl + '?max_price=0&max_output_price=0', {
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
    .filter(isFreeOpenRouterModel)
    .map((model) => model.id.trim()))].sort((left, right) => left.localeCompare(right));

  if (!models.length) {
    throw new Error('OpenRouter catalog returned no verified free text models; existing models were preserved.');
  }
  return models;
}

async function fetchCatalog(providerId, config, fetchImpl) {
  if (providerId === 'openrouter') return fetchOpenRouterFreeModels(config, fetchImpl);
  throw new Error('Automatic free-model discovery is not supported for this provider.');
}

function cleanModelList(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((model) => String(model || '').trim()).filter(Boolean))]
    : [];
}

function configuredProviderList(config) {
  const listed = Array.isArray(config && config.dailyFreeModelProviders)
    ? config.dailyFreeModelProviders
    : [];
  return [...new Set(listed.map((provider) => String(provider || '').trim().toLowerCase()).filter(Boolean))];
}

async function syncFreeModels({ db, fetchImpl = global.fetch, providerIds } = {}) {
  if (!db) throw new Error('Firestore database is required.');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  const configRef = db.collection('config').doc('ai');
  const initialSnapshot = await configRef.get();
  const initialConfig = initialSnapshot.exists ? (initialSnapshot.data() || {}) : {};
  const selected = providerIds || configuredProviderList(initialConfig);
  if (!selected.length) return { selected: [], results: {}, changed: false };

  const results = {};
  const catalogs = {};
  for (const providerId of selected) {
    if (!REFRESHABLE_PROVIDERS[providerId]) {
      results[providerId] = { ok: false, error: 'Automatic free-model discovery is not supported for this provider.' };
      continue;
    }
    try {
      catalogs[providerId] = await fetchCatalog(providerId, initialConfig, fetchImpl);
      results[providerId] = { ok: true, modelCount: catalogs[providerId].length };
    } catch (error) {
      results[providerId] = { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  let changed = false;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(configRef);
    const config = snapshot.exists ? (snapshot.data() || {}) : {};
    const stillSelected = new Set(configuredProviderList(config));
    const providerModels = Object.assign({}, config.providerModels || {});
    const statuses = Object.assign({}, config.dailyFreeModelSyncStatus || {});
    const updates = {};

    selected.forEach((providerId) => {
      if (!stillSelected.has(providerId)) return;
      const priorStatus = Object.assign({}, statuses[providerId] || {});
      const result = results[providerId];
      if (!result || !result.ok) {
        statuses[providerId] = Object.assign(priorStatus, {
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

      statuses[providerId] = {
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

    transaction.set(configRef, Object.assign({
      providerModels,
      dailyFreeModelSyncStatus: statuses,
    }, updates), { merge: true });
  });

  return { selected, results, changed };
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
  const outcome = await syncFreeModels({ db: admin.firestore() });

  if (!outcome.selected.length) {
    console.log('No providers are enabled for daily free-model refresh. Nothing to do.');
    return;
  }
  Object.entries(outcome.results).forEach(([providerId, result]) => {
    if (result.ok) {
      console.log('✓ ' + providerId + ': ' + result.modelCount + ' free models (+' + result.added + ', -' + result.removed + ')' +
        (result.activeModelReplaced ? '; active model moved to ' + result.activeModelReplaced : ''));
    } else {
      console.error('✗ ' + providerId + ': ' + result.error);
    }
  });
  const failures = Object.values(outcome.results).filter((result) => !result.ok);
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Free-model refresh failed:', error.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  REFRESHABLE_PROVIDERS,
  configuredProviderList,
  fetchOpenRouterFreeModels,
  isFreeOpenRouterModel,
  syncFreeModels,
};
