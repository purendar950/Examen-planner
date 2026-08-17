# Ask Command Failover Fix — Bugfix Design

## Overview

The Telegram bot's `/ask` command currently tries only the single active study AI provider (plus the legacy Groq fallback) and fails with a generic error when that provider is unreachable — even though multiple other providers with valid API keys are configured in the admin panel. The fix introduces a sequential cross-provider failover mechanism: when the active provider's keys are exhausted, the handler walks through all other configured providers (those with valid keys and an OpenAI-compatible transport) until one succeeds or every provider has been tried. The fix is surgically contained to the `/ask` handler path in `bot/bot-server.js` and does not alter the admin panel, the config schema, or any other bot command.

## Glossary

- **Bug_Condition (C)**: The active study AI provider fails for all its keys (network error, timeout, or 5xx) AND at least one other configured provider with valid API keys exists that could answer the question
- **Property (P)**: When the bug condition holds, the bot SHALL try the remaining configured providers in sequence and return the first successful answer to the user
- **Preservation**: All existing behaviors for non-failover paths — successful primary provider responses, HTTP 400 short-circuits, rate limiting, disabled-AI messages, and missing-provider messages — must remain identical
- **`studyProviderFromConfig(cfg)`**: Function in `bot-server.js` that reads the mirrored `studyBaseUrl` / `studyApiKeys` / `studyModel` fields from the Firestore `config/ai` document and returns a provider object or `null`
- **`groqFallbackProvider(cfg)`**: Function that builds a provider object from the legacy `groqApiKey` field
- **`callStudyProvider(provider, messages)`**: Function that iterates through a single provider's key array, calling the chat completions endpoint with each key until one succeeds, throws `{status: 400}` for bad requests, or throws `{status: 502}` when all keys fail
- **`STUDY_PROVIDERS`**: Constant in `js/admin/admin-actions.js` defining every supported provider's `baseUrl`, `keyField`, `modelField`, `transport`, and default model
- **`config/ai`**: Firestore document holding all provider keys (e.g., `mistralApiKeys`, `cerebrasApiKeys`) and the active provider mirror fields

## Bug Details

### Bug Condition

The bug manifests when the active study AI provider is unreachable or returns 5xx errors for all its configured keys, while other providers have valid API keys stored in the `config/ai` Firestore document. The current code path is:

1. `studyProviderFromConfig(cfg)` → returns only the active provider (or null)
2. Fall through to `groqFallbackProvider(cfg)` → returns only the legacy Groq key (or null)
3. `callStudyProvider(provider, messages)` → exhausts keys of the single provider
4. Throws `{status: 502}` → catch block shows generic error

No code path ever examines the per-provider key fields (`mistralApiKeys`, `cerebrasApiKeys`, etc.) to construct alternative providers.

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type { cfg: AiConfig, question: string }
  OUTPUT: boolean
  
  activeProvider ← studyProviderFromConfig(input.cfg)
  groqFallback ← groqFallbackProvider(input.cfg)
  primaryProvider ← activeProvider OR groqFallback
  otherProviders ← buildFallbackProviderList(input.cfg, primaryProvider)

  RETURN primaryProvider ≠ null
     AND callStudyProvider(primaryProvider, buildTutorMessages(input.question)) THROWS {status: 502}
     AND otherProviders.length > 0
END FUNCTION
```

### Examples

- **Example 1**: Active provider is OmniRoute (ngrok tunnel down), Mistral keys are configured → currently fails with generic error; should failover to Mistral and answer
- **Example 2**: Active provider is NVIDIA (returning 503 for all keys), Cerebras and Google keys configured → currently fails; should try Cerebras, then Google
- **Example 3**: Active provider is Bynara (timeout on all keys), only Groq legacy key configured → current code already handles this via `groqFallbackProvider` (not a bug condition for this specific case since Groq IS tried)
- **Example 4 (edge)**: Active provider fails, only `google_interactions` provider has keys (transport: `google_interactions`, not `openai_chat`) → should still fail gracefully because `google_interactions` cannot be used as OpenAI-compatible fallback

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- When the active provider succeeds on the first attempt, the answer is returned immediately without consulting other providers
- HTTP 400 responses (bad question) throw immediately and display "AI ne yeh sawaal accept nahi kiya" without trying other providers
- Rate limiting (4 questions/minute) is enforced before any provider call
- "AI abhi off hai" message when `cfg.enabled === false`
- "AI provider set nahi hai" message when no providers have valid keys at all
- Usage help message when `/ask` is sent without a question
- Private-chat-only enforcement for `/ask`
- Answer formatting: question header + escaped HTML + 3500-char limit
- Console logging of successful answers with provider/model info

**Scope:**
All inputs where the primary provider succeeds (or where no alternative providers exist) should produce exactly the same behavior as before. The fix only activates when `callStudyProvider` throws a non-400 error AND additional providers are available.

## Hypothesized Root Cause

Based on the code analysis, the root cause is a **missing failover loop** in the `/ask` handler:

1. **Single-provider architecture**: The handler was designed when only one provider (Groq) existed. When multi-provider support was added to the admin panel, the bot was updated to read the "active" provider's mirrored fields but never given logic to iterate through alternatives.

2. **Config structure mismatch**: The admin panel saves per-provider keys to individual Firestore fields (`mistralApiKeys`, `cerebrasApiKeys`, etc.) and mirrors only the selected provider into generic fields (`studyApiKeys`, `studyBaseUrl`). The bot reads only the generic mirror and has no code to enumerate the per-provider fields.

3. **Fallback limited to legacy Groq**: The `groqFallbackProvider` function was a stop-gap for installations that only configured the auto-scheduler's Groq key. It was never generalized into a multi-provider fallback chain.

4. **No provider registry on the server side**: The `STUDY_PROVIDERS` constant (with baseUrls and keyFields) lives only in the client-side admin panel JS. The bot server has no equivalent mapping to construct provider objects from arbitrary key fields.

## Correctness Properties

Property 1: Bug Condition — Cross-Provider Failover

_For any_ input where the active study provider fails (callStudyProvider throws with status !== 400) AND at least one other configured provider has valid API keys with openai_chat transport, the fixed `/ask` handler SHALL attempt each remaining provider in sequence and return the first successful answer to the user in the standard format.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation — Non-Failover Path Behavior

_For any_ input where the active study provider succeeds on the first attempt (or where no alternative providers exist, or where the error is HTTP 400), the fixed `/ask` handler SHALL produce exactly the same output as the original handler — same answer text, same error messages, same rate limiting, same logging.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

## Fix Implementation

### Changes Required

All changes are confined to **`bot/bot-server.js`**.

**1. Add a `FAILOVER_PROVIDERS` mapping constant** (near the existing `studyProviderFromConfig` function):

A server-side registry of all supported OpenAI-compatible providers, mapping each provider's Firestore key field to its known baseUrl and default model. This mirrors the relevant subset of the client-side `STUDY_PROVIDERS` constant.

```
FAILOVER_PROVIDERS = [
  { id: 'bynara',      keyField: 'bynaraApiKeys',      modelField: 'bynaraModel',      baseUrl: 'https://router.bynara.id',                            defaultModel: 'mistral-large' },
  { id: 'mistral',     keyField: 'mistralApiKeys',     modelField: 'mistralModel',     baseUrl: 'https://api.mistral.ai/v1',                           defaultModel: 'mistral-large-latest' },
  { id: 'cerebras',    keyField: 'cerebrasApiKeys',    modelField: 'cerebrasModel',    baseUrl: 'https://api.cerebras.ai/v1',                          defaultModel: 'gpt-oss-120b' },
  { id: 'openrouter',  keyField: 'openrouterApiKeys',  modelField: 'openrouterModel',  baseUrl: 'https://openrouter.ai/api/v1',                        defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
  { id: 'nvidia',      keyField: 'nvidiaApiKeys',      modelField: 'nvidiaModel',      baseUrl: 'https://integrate.api.nvidia.com/v1',                  defaultModel: 'deepseek-ai/deepseek-v4-pro' },
  { id: 'google',      keyField: 'googleApiKeys',      modelField: 'googleModel',      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-flash-latest' },
  { id: 'hcnsec',      keyField: 'hcnsecApiKeys',      modelField: 'hcnsecModel',      baseUrl: 'https://api.hcnsec.cn/v1',                            defaultModel: 'DeepSeek-V4-Pro' },
  { id: 'bluesminds',  keyField: 'bluesmindsApiKeys',  modelField: 'bluesmindsModel',  baseUrl: 'https://api.bluesminds.com/v1',                       defaultModel: 'gpt-5.2-chat' },
  { id: 'aicampus',    keyField: 'aicampusApiKeys',    modelField: 'aicampusModel',    baseUrl: 'https://ai-hub.aicampus.my/v1',                       defaultModel: 'minimax-m3' },
  { id: 'omniroute',   keyField: 'omnirouteApiKeys',   modelField: 'omnirouteModel',   baseUrl: 'resolved from config/ai.omnirouteBaseUrl',                     defaultModel: 'auto' },
  { id: 'kiro',        keyField: 'kiroApiKeys',        modelField: 'kiroModel',        baseUrl: 'https://kiro-key-test-s6io.onrender.com/v1',           defaultModel: 'auto' },
]
// NOTE: google_interactions is intentionally excluded (transport !== 'openai_chat')
```

**2. Add `buildFallbackProviderList(cfg, excludeProvider)` function**:

Iterates `FAILOVER_PROVIDERS`, reads keys from `cfg[entry.keyField]`, skips the already-tried active provider (matched by baseUrl), and returns an array of provider objects in registry order.

```
FUNCTION buildFallbackProviderList(cfg, excludeProvider)
  INPUT: cfg (Firestore config/ai document), excludeProvider (provider object already tried, or null)
  OUTPUT: Array of { provider, url, keys, model }

  result ← []
  excludeUrl ← excludeProvider ? excludeProvider.url : null

  FOR EACH entry IN FAILOVER_PROVIDERS DO
    keys ← studyApiKeyList(cfg[entry.keyField])
    IF keys.length = 0 THEN CONTINUE
    url ← entry.baseUrl + '/chat/completions'
    IF url = excludeUrl THEN CONTINUE
    model ← cfg[entry.modelField] OR entry.defaultModel
    result.push({ provider: entry.id, url, keys, model })
  END FOR

  // Also include Groq fallback if not already excluded
  IF excludeProvider?.provider ≠ 'groq' THEN
    groq ← groqFallbackProvider(cfg)
    IF groq ≠ null THEN result.push(groq)
  END IF

  RETURN result
END FUNCTION
```

**3. Add `callWithFailover(providers, messages)` function**:

Tries each provider in sequence using the existing `callStudyProvider`. Re-throws HTTP 400 immediately (bad question — no point retrying). Swallows 502/network errors and moves to the next provider. If all providers fail, throws the last error.

```
FUNCTION callWithFailover(providers, messages)
  INPUT: providers (Array of provider objects), messages (chat messages)
  OUTPUT: { answer: string, provider: providerObject }

  lastError ← null
  FOR EACH provider IN providers DO
    TRY
      answer ← callStudyProvider(provider, messages)
      IF answer THEN RETURN { answer, provider }
    CATCH error
      IF error.status = 400 THEN THROW error   // bad question — don't retry
      lastError ← error
      CONTINUE
    END TRY
  END FOR

  IF lastError THEN THROW lastError
  THROW new Error('no providers available') with status 502
END FUNCTION
```

**4. Modify the `/ask` handler** (the `bot.onText(/^\/ask…/)` callback):

Replace the current single-provider call:
```javascript
// BEFORE:
const provider = studyProviderFromConfig(cfg) || groqFallbackProvider(cfg);
if (!provider) { /* no provider message */ return; }
const answer = await callStudyProvider(provider, buildTutorMessages(question));
```

With the failover chain:
```javascript
// AFTER:
const primaryProvider = studyProviderFromConfig(cfg) || groqFallbackProvider(cfg);
const fallbacks = buildFallbackProviderList(cfg, primaryProvider);
if (!primaryProvider && fallbacks.length === 0) { /* no provider message */ return; }

const allProviders = primaryProvider ? [primaryProvider, ...fallbacks] : fallbacks;
const messages = buildTutorMessages(question);
const { answer, provider } = await callWithFailover(allProviders, messages);
```

**5. Update the success log line** to include failover info:

```javascript
console.log(`✅ /ask → uid:${account.uid} via ${provider.provider}/${provider.model}`);
// (already uses provider from callWithFailover result — no change needed to format)
```

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code (all alternative providers are ignored), then verify the fix works correctly and preserves existing behavior.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm that the current handler attempts only the primary provider and Groq fallback.

**Test Plan**: Mock `callStudyProvider` to throw `{status: 502}` for the primary provider. Configure `cfg` with keys for Mistral and Cerebras. Run the `/ask` handler and observe that it shows the generic error message without ever constructing or calling those alternative providers.

**Test Cases**:
1. **Primary Provider Down, Alternatives Available**: Set active provider to OmniRoute (keys configured), configure Mistral keys in cfg. Mock OmniRoute to throw 502. Assert handler shows generic error (will fail on unfixed code — never tries Mistral).
2. **Primary Null, Groq Down, Alternatives Available**: Set `studyBaseUrl` to empty (so `studyProviderFromConfig` returns null), set `groqApiKey` to a key that 502s. Configure NVIDIA keys. Assert handler shows generic error (will fail on unfixed code).
3. **All Keys Timeout, Alternatives Available**: Set active provider with 3 keys that all timeout. Configure Cerebras with valid key. Assert handler shows generic error (will fail on unfixed code).
4. **Primary Down, Only google_interactions Has Keys**: Active provider 502s. Only `googleInteractionsApiKeys` has keys (transport ≠ openai_chat). Assert handler correctly fails (should still fail — not a valid fallback).

**Expected Counterexamples**:
- The handler never reads `mistralApiKeys`, `cerebrasApiKeys`, etc. from the config
- Only `studyApiKeys` (mirror of active provider) and `groqApiKey` are accessed
- Possible root cause confirmed: missing provider enumeration logic

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed function produces the expected behavior.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := handleAskCommand_fixed(input)
  ASSERT result.answered = true
  ASSERT result.errorShown = false
  ASSERT result.providerUsed ∈ configuredProvidersWithKeys(input.cfg)
  ASSERT result.messageFormat = standard_ask_format(input.question, result.answer)
END FOR
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed function produces the same result as the original function.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT handleAskCommand_original(input) = handleAskCommand_fixed(input)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test configurations (various cfg shapes, provider availability combinations)
- It catches edge cases like empty key arrays, whitespace-only keys, missing model fields
- It provides strong guarantees that the "happy path" (primary succeeds) is unchanged

**Test Plan**: Observe behavior on UNFIXED code first for successful primary-provider calls and 400 errors, then write property-based tests asserting the fixed code produces identical results.

**Test Cases**:
1. **Primary Success Preservation**: Mock primary provider to succeed. Assert fixed handler returns same answer, same format, same log — never calls `buildFallbackProviderList`.
2. **HTTP 400 Short-Circuit Preservation**: Mock primary provider to throw `{status: 400}`. Assert fixed handler shows same "bad question" message. Assert no fallback providers attempted.
3. **Rate Limit Preservation**: Exceed 4 questions/minute. Assert fixed handler enforces rate limit before any provider construction or call.
4. **Disabled AI Preservation**: Set `cfg.enabled = false`. Assert same "AI off" message without constructing providers.
5. **No Keys At All Preservation**: Empty all key fields. Assert same "provider set nahi hai" message.

### Unit Tests

- `buildFallbackProviderList` returns correct providers (keys present, baseUrl matches, skips excluded provider)
- `buildFallbackProviderList` skips entries with empty/whitespace-only keys
- `buildFallbackProviderList` excludes `google_interactions` (not in the FAILOVER_PROVIDERS list)
- `buildFallbackProviderList` includes Groq fallback when not excluded
- `callWithFailover` returns first successful answer
- `callWithFailover` re-throws 400 immediately without trying next provider
- `callWithFailover` skips 502/network errors and tries next provider
- `callWithFailover` throws when all providers fail

### Property-Based Tests

- Generate random `cfg` objects with subsets of provider keys filled, verify `buildFallbackProviderList` output length ≤ total providers and excludes the active one
- Generate random provider orderings and failure patterns, verify `callWithFailover` returns the first success or re-throws 400
- Generate random successful-provider scenarios, verify the handler's output matches the original handler identically (preservation)

### Integration Tests

- End-to-end: primary provider timeout → failover to second provider → answer returned to chat
- End-to-end: all providers fail → generic error message shown after all exhausted
- End-to-end: primary returns 400 → immediate "bad question" error, no failover attempted
- End-to-end: verify Telegram message format preserved (HTML escaping, character limit, question header)
