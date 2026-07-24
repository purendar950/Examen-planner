/*
 * Daily model catalog refresh
 * ---------------------------
 * Admins maintain two mutually-exclusive provider lists in config/ai:
 *   dailyFreeModelProviders — models whose catalog exposes zero-price metadata
 *   dailyAllModelProviders  — every current text/chat model, free and paid
 *
 * Every Study AI provider is eligible for the full-catalog refresh. The
 * free-only refresh is deliberately conservative: it writes models only when
 * the provider's live catalog proves that input, output, and any request price
 * are zero. Failed, malformed, timed-out, or empty responses record an error
 * but never remove the previous model list.
 */

const admin = require('firebase-admin');

const REFRESHABLE_PROVIDERS = {
  bynara: {
    label: 'Bynara',
    keyField: 'bynaraApiKeys',
    legacyKeyFields: ['studyApiKeys', 'studyApiKey'],
    modelField: 'bynaraModel',
    catalogUrl: 'https://router.bynara.id/v1/models',
    catalogFormat: 'openai',
    permissiveTextChat: true,
    freePlanCatalog: true,
    chatIdMarkers: ['mistral', 'tencent', 'qwen', 'deepseek', 'glm', 'kimi', 'minimax', 'gemma', 'llama'],
  },
  mistral: {
    label: 'Mistral',
    keyField: 'mistralApiKeys',
    modelField: 'mistralModel',
    catalogUrl: 'https://api.mistral.ai/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['mistral', 'codestral', 'ministral', 'devstral', 'pixtral'],
  },
  cerebras: {
    label: 'Cerebras',
    keyField: 'cerebrasApiKeys',
    modelField: 'cerebrasModel',
    catalogUrl: 'https://api.cerebras.ai/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['gpt-oss', 'zai', 'gemma', 'llama', 'qwen'],
  },
  openrouter: {
    label: 'OpenRouter',
    keyField: 'openrouterApiKeys',
    modelField: 'openrouterModel',
    catalogUrl: 'https://openrouter.ai/api/v1/models',
    catalogFormat: 'openai',
    serverSideCatalogFilters: true,
    chatIdMarkers: ['gpt', 'claude', 'gemini', 'mistral', 'qwen', 'llama', 'deepseek', 'gemma', 'nemotron', 'glm', 'minimax', 'kimi', 'cohere', 'command', 'grok', 'tencent', 'z-ai'],
  },
  nvidia: {
    label: 'NVIDIA',
    keyField: 'nvidiaApiKeys',
    modelField: 'nvidiaModel',
    catalogUrl: 'https://integrate.api.nvidia.com/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['deepseek', 'qwen', 'nemotron', 'glm', 'minimax', 'llama', 'mistral', 'gemma', 'kimi'],
  },
  google: {
    label: 'Google Gemini',
    keyField: 'googleApiKeys',
    modelField: 'googleModel',
    catalogUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    catalogFormat: 'gemini',
  },
  hcnsec: {
    label: 'HCNSec',
    keyField: 'hcnsecApiKeys',
    modelField: 'hcnsecModel',
    catalogUrl: 'https://api.hcnsec.cn/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['deepseek', 'qwen', 'nemotron', 'glm', 'minimax', 'llama', 'mistral', 'gemma', 'kimi'],
  },
  bluesminds: {
    label: 'BluesMinds',
    keyField: 'bluesmindsApiKeys',
    modelField: 'bluesmindsModel',
    catalogUrl: 'https://api.bluesminds.com/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['gpt', 'claude', 'gemini', 'deepseek', 'qwen', 'mistral', 'gemma', 'llama', 'minimax', 'kimi', 'glm'],
  },
  aicampus: {
    label: 'AICampus',
    keyField: 'aicampusApiKeys',
    modelField: 'aicampusModel',
    catalogUrl: 'https://ai-hub.aicampus.my/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['minimax', 'kimi', 'deepseek', 'qwen', 'glm', 'llama', 'mistral', 'gemma'],
  },
  kiro: {
    label: 'Kiro',
    keyField: 'kiroApiKeys',
    modelField: 'kiroModel',
    catalogUrl: 'https://kiro-key-test-s6io.onrender.com/v1/models',
    catalogFormat: 'openai',
    chatIdMarkers: ['auto', 'claude', 'gpt', 'deepseek', 'minimax', 'glm', 'qwen', 'mistral', 'gemma', 'llama', 'kimi'],
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

function providerKeys(config, provider) {
  const primary = configuredKeys(config, provider.keyField);
  if (primary.length) return primary;
  const legacy = Array.isArray(provider.legacyKeyFields)
    ? provider.legacyKeyFields.flatMap((field) => configuredKeys(config, field))
    : [];
  if (legacy.length || provider.keyField !== 'bynaraApiKeys') return legacy;
  return String(process.env.BYNARA_API_KEY || '').trim() ? [String(process.env.BYNARA_API_KEY).trim()] : [];
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

function modelId(model, gemini = false) {
  if (!model || typeof model !== 'object') return '';
  const rawId = gemini ? model.name : model.id;
  return typeof rawId === 'string' ? rawId.trim().replace(/^models\//, '') : '';
}

function hasNonChatModelMarker(id) {
  const value = String(id || '').toLowerCase();
  const markers = ['embedding', 'embed', 'transcrib', 'speech', 'whisper', 'tts', 'audio', 'moderation', 'rerank', 'dall', 'image', 'imagen', 'stable-diffusion', 'midjourney', 'flux'];
  return markers.some((marker) => value.includes(marker));
}

function isTextChatModelId(provider, id) {
  const value = String(id || '').toLowerCase();
  if (!value || hasNonChatModelMarker(value)) return false;
  // Gemini's native generateContent capability is checked separately below.
  // Catalogs without structured capability metadata use a conservative,
  // provider-specific language-model family allow-list.
  if (provider.catalogFormat === 'gemini') return true;
  return Array.isArray(provider.chatIdMarkers) && provider.chatIdMarkers
    .some((marker) => value.includes(marker));
}

function isTextChatCatalogModel(provider, model) {
  const id = modelId(model, provider.catalogFormat === 'gemini');
  if (!id || hasNonChatModelMarker(id)) return false;

  if (provider.serverSideCatalogFilters) {
    // OpenRouter publishes machine-readable architecture metadata. Use that
    // instead of a model-family allow-list so newly released families appear
    // automatically, while audio/image-generation records remain excluded.
    const architecture = model && model.architecture;
    const inputs = architecture && architecture.input_modalities;
    const outputs = architecture && architecture.output_modalities;
    return Array.isArray(inputs) && inputs.includes('text') &&
      Array.isArray(outputs) && outputs.length > 0 &&
      outputs.every((modality) => modality === 'text');
  }

  // Router-style aggregators host many families under one catalog, so a fixed
  // family allow-list drops legitimate new chat models. When enabled, accept
  // any id that is not a known non-chat (embedding/audio/image) model.
  if (provider.permissiveTextChat) return true;
  return isTextChatModelId(provider, id);
}

// Normalized field names (letters/digits only) that commonly carry a plan or
// access tier on router-style catalogs.
const PLAN_FREE_SCALAR_KEYS = ['access', 'tier', 'plan', 'plantype', 'pricingtier', 'category', 'group', 'visibility', 'scope', 'availability', 'minplan', 'requiredplan', 'billing'];
const PLAN_FREE_ARRAY_KEYS = ['tags', 'categories', 'plans', 'tiers', 'groups', 'labels', 'accesslevels'];
const PLAN_FREE_NESTED_KEYS = ['plan', 'tier', 'pricing', 'access'];
const PLAN_FREE_BOOL_KEYS = ['isfree', 'free', 'freeplan'];

function normToken(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function tokenIsFreePlan(value) {
  // "free for paid" normalizes to "freeforpaid" (contains "paid") and is
  // rejected, so limited-time promos requiring a balance never count as free.
  const token = normToken(value);
  if (!token || token.includes('paid') || token.includes('promo')) return false;
  return token === 'free' || token.startsWith('free');
}

function isPlanFreeModel(model) {
  if (!model || typeof model !== 'object') return false;
  return Object.keys(model).some((key) => {
    const normKey = normToken(key);
    const value = model[key];
    if (typeof value === 'boolean') return value && PLAN_FREE_BOOL_KEYS.includes(normKey);
    if (typeof value === 'string' || typeof value === 'number') {
      return PLAN_FREE_SCALAR_KEYS.includes(normKey) && tokenIsFreePlan(value);
    }
    if (Array.isArray(value)) {
      return PLAN_FREE_ARRAY_KEYS.includes(normKey) &&
        value.some((entry) => (typeof entry === 'string' || typeof entry === 'number') && tokenIsFreePlan(entry));
    }
    if (value && typeof value === 'object') {
      return PLAN_FREE_NESTED_KEYS.includes(normKey) &&
        ['name', 'slug', 'id', 'type', 'tier', 'level'].some((sub) => tokenIsFreePlan(value[sub]));
    }
    return false;
  });
}

function isFreeCatalogModel(provider, model) {
  if (!hasModelId(model)) return false;
  if (isVerifiedFreeModel(model)) return true;
  return !!provider.freePlanCatalog && isPlanFreeModel(model);
}

function isVerifiedFreeModel(model) {
  if (!model || typeof model !== 'object') return false;
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== 'object') return false;

  // OpenAI-compatible catalogs do not standardize the price-key names. Accept
  // the two common input/output pairs, but require both directions to be zero.
  const input = Object.prototype.hasOwnProperty.call(pricing, 'prompt') ? pricing.prompt : pricing.input;
  const output = Object.prototype.hasOwnProperty.call(pricing, 'completion') ? pricing.completion : pricing.output;
  if (!isZeroPrice(input) || !isZeroPrice(output)) return false;
  return !Object.prototype.hasOwnProperty.call(pricing, 'request') || isZeroPrice(pricing.request);
}

function requestHeaders(provider, key) {
  const headers = { Accept: 'application/json' };
  if (provider.catalogFormat === 'gemini') headers['x-goog-api-key'] = key;
  else headers.Authorization = 'Bearer ' + key;
  return headers;
}

async function fetchCatalogJson(provider, url, key, fetchImpl) {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), 20_000);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: requestHeaders(provider, key),
      signal: timeoutController.signal,
    });
  } catch (error) {
    if (timeoutController.signal.aborted) {
      throw new Error(provider.label + ' catalog timed out after 20 seconds.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = (await response.text()).replace(/\s+/g, ' ').slice(0, 180);
    throw new Error(provider.label + ' catalog returned HTTP ' + response.status + (detail ? ': ' + detail : ''));
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(provider.label + ' catalog did not return valid JSON.');
  }
}

function normalizedModelIds(provider, models, predicate) {
  const gemini = provider.catalogFormat === 'gemini';
  return [...new Set(models
    .filter(predicate)
    .map((model) => modelId(model, gemini))
    .filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function allModelPredicate(provider, model) {
  if (!isTextChatCatalogModel(provider, model)) return false;
  if (provider.catalogFormat !== 'gemini') return true;
  // Gemini exposes models for other APIs too. Restrict its native catalog to
  // models that can serve the text-generation route used by this application.
  const methods = model && model.supportedGenerationMethods;
  return Array.isArray(methods) && methods.includes('generateContent');
}

function freeModelPredicate(provider, model) {
  if (!allModelPredicate(provider, model)) return false;
  return isFreeCatalogModel(provider, model);
}

function catalogSampleFields(data) {
  // Compact, non-sensitive dump of the first catalog item so operators can see
  // exactly which fields (and values) a provider returns.
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const parts = Object.keys(item).map((key) => {
      const value = item[key];
      if (value === null || value === undefined) return '';
      if (typeof value === 'object' && !Array.isArray(value)) return key + '{' + Object.keys(value).slice(0, 6).join(',') + '}';
      if (Array.isArray(value)) return key + '[' + value.slice(0, 4).filter((x) => typeof x !== 'object').map((x) => String(x).slice(0, 16)).join(',') + ']';
      return key + '=' + String(value).slice(0, 24);
    }).filter(Boolean);
    return (parts.join('; ').slice(0, 200)) || 'no fields';
  }
  return 'no object rows';
}

function catalogModelsFromOpenAiPayload(provider, payload, mode) {
  if (!payload || !Array.isArray(payload.data)) {
    throw new Error(provider.label + ' catalog response is missing its model list.');
  }
  const models = normalizedModelIds(provider, payload.data, mode === 'free'
    ? (model) => freeModelPredicate(provider, model)
    : (model) => allModelPredicate(provider, model));
  if (mode === 'free' && !models.length && provider.freePlanCatalog) {
    throw new Error(provider.label + ' free refresh found no zero-price or Free-plan model. Sample model: ' +
      catalogSampleFields(payload.data) +
      '. Reply with which field marks Free-plan models, or keep this provider on the free & paid list.');
  }
  return models;
}

async function fetchOpenAiModels(provider, config, fetchImpl, mode = 'free') {
  const keys = providerKeys(config, provider);
  const modeInfo = catalogMode(mode);
  if (!keys.length) {
    throw new Error(provider.label + ' needs an API key before its ' + modeInfo.label + ' catalog can be refreshed.');
  }

  const params = new URLSearchParams();
  // OpenRouter is the only catalog that documents server-side price and text
  // modality filters. Other OpenAI-compatible APIs receive the standard
  // documented /models request and are filtered from their response instead.
  if (provider.serverSideCatalogFilters) {
    params.set('output_modalities', 'text');
    if (mode === 'free') {
      params.set('max_price', '0');
      params.set('max_output_price', '0');
    }
  }
  const url = provider.catalogUrl + (params.size ? '?' + params.toString() : '');
  const payload = await fetchCatalogJson(provider, url, keys[0], fetchImpl);
  const models = catalogModelsFromOpenAiPayload(provider, payload, mode);
  if (!models.length) {
    throw new Error(provider.label + ' catalog returned no ' + modeInfo.label + ' text models; existing models were preserved.');
  }
  return models;
}

async function fetchGoogleModels(config, fetchImpl, mode = 'free') {
  const provider = REFRESHABLE_PROVIDERS.google;
  const keys = providerKeys(config, provider);
  const modeInfo = catalogMode(mode);
  if (!keys.length) {
    throw new Error(provider.label + ' needs an API key before its ' + modeInfo.label + ' catalog can be refreshed.');
  }

  const records = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    if (pageCount++ >= 20) {
      throw new Error(provider.label + ' catalog exceeded 20 pages; existing models were preserved.');
    }
    const params = new URLSearchParams({ pageSize: '1000' });
    if (pageToken) params.set('pageToken', pageToken);
    const payload = await fetchCatalogJson(provider, provider.catalogUrl + '?' + params.toString(), keys[0], fetchImpl);
    if (!payload || !Array.isArray(payload.models)) {
      throw new Error(provider.label + ' catalog response is missing its model list.');
    }
    records.push(...payload.models);
    pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : '';
  } while (pageToken);

  const models = normalizedModelIds(provider, records, mode === 'free'
    ? (model) => freeModelPredicate(provider, model)
    : (model) => allModelPredicate(provider, model));
  if (!models.length) {
    throw new Error(provider.label + ' catalog returned no ' + modeInfo.label + ' text models; existing models were preserved.');
  }
  return models;
}

function fetchOpenRouterModels(config, fetchImpl, mode = 'free') {
  return fetchOpenAiModels(REFRESHABLE_PROVIDERS.openrouter, config, fetchImpl, mode);
}

function fetchOpenRouterFreeModels(config, fetchImpl) {
  return fetchOpenRouterModels(config, fetchImpl, 'free');
}

function fetchCatalog(providerId, config, fetchImpl, mode = 'free') {
  const provider = REFRESHABLE_PROVIDERS[providerId];
  if (!provider) throw new Error('Automatic model discovery is not supported for this provider.');
  if (provider.catalogFormat === 'gemini') return fetchGoogleModels(config, fetchImpl, mode);
  return fetchOpenAiModels(provider, config, fetchImpl, mode);
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
  fetchCatalog,
  fetchGoogleModels,
  fetchOpenAiModels,
  fetchOpenRouterFreeModels,
  fetchOpenRouterModels,
  catalogModelsFromOpenAiPayload,
  freeModelPredicate,
  isFreeCatalogModel,
  isPlanFreeModel,
  isTextChatCatalogModel,
  isVerifiedFreeModel,
  syncFreeModels,
  syncModelCatalogs,
};
