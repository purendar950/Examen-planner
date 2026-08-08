# Bugfix Requirements Document

## Introduction

The Telegram bot's `/ask` command fails with a generic error ("AI se jawab nahi aaya. Thodi der baad try karo.") when the active study AI provider is unreachable, even though multiple other providers with valid API keys are configured in the admin panel. The bot currently attempts only the single selected provider and the legacy Groq fallback, with no cross-provider failover. This leaves users unable to get answers during provider outages despite redundant infrastructure being available.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the active study AI provider is down (network error, timeout, or endpoint unreachable) AND other providers with valid API keys are configured THEN the system exhausts all keys of the single active provider and returns "AI se jawab nahi aaya. Thodi der baad try karo." without trying any other configured provider

1.2 WHEN the active study AI provider returns 5xx server errors for all its keys AND other providers with valid API keys are configured THEN the system throws a status-502 error and shows the generic failure message without attempting alternate providers

1.3 WHEN the active study AI provider is down AND the legacy Groq fallback key is not configured (groqApiKey is empty) THEN the system has no fallback path at all and fails immediately after the single provider's keys are exhausted

1.4 WHEN `studyProviderFromConfig(cfg)` returns null (e.g., transport is not openai_chat, or baseUrl/keys are missing) THEN the system only tries `groqFallbackProvider(cfg)` as the single alternative, ignoring all other configured providers that have valid keys

### Expected Behavior (Correct)

2.1 WHEN the active study AI provider fails (network error, timeout, or endpoint unreachable) for all its keys AND other providers with valid API keys are configured THEN the system SHALL automatically attempt the next available configured provider until one succeeds or all providers are exhausted

2.2 WHEN the active study AI provider returns 5xx server errors for all its keys AND other providers with valid API keys are configured THEN the system SHALL failover to the next configured provider rather than immediately showing an error to the user

2.3 WHEN the active study AI provider is down AND the legacy Groq fallback is not configured BUT other providers have valid API keys THEN the system SHALL try those other configured providers before giving up

2.4 WHEN all configured providers (including the active one, all fallbacks, and legacy Groq) have been attempted and all fail THEN the system SHALL show the error message "AI se jawab nahi aaya. Thodi der baad try karo." only after every provider has been exhausted

2.5 WHEN a fallback provider succeeds in answering the question THEN the system SHALL return the answer to the user in the same format as if the primary provider had answered (with the question header and escaped HTML)

### Unchanged Behavior (Regression Prevention)

3.1 WHEN the active study AI provider is working and responds successfully THEN the system SHALL CONTINUE TO use the active provider and return the answer without attempting other providers

3.2 WHEN a provider returns HTTP 400 (bad request) for the user's question THEN the system SHALL CONTINUE TO immediately show the actionable error message ("AI ne yeh sawaal accept nahi kiya. Thoda chhota karke poocho.") without trying other providers, since the question itself is the problem

3.3 WHEN AI is disabled in the config (cfg.enabled === false) THEN the system SHALL CONTINUE TO show the "AI abhi off hai" message without attempting any provider

3.4 WHEN no providers at all have valid API keys configured THEN the system SHALL CONTINUE TO show "AI provider set nahi hai" message prompting the admin to configure keys

3.5 WHEN the user sends `/ask` without a question THEN the system SHALL CONTINUE TO show the usage help message with examples

3.6 WHEN the user exceeds the rate limit (4 questions per minute) THEN the system SHALL CONTINUE TO enforce the rate limit before attempting any provider call

---

## Bug Condition Derivation

**Bug Condition Function** — Identifies inputs that trigger the bug:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type AskRequest (contains: cfg, question, activeProvider)
  OUTPUT: boolean
  
  // The bug triggers when the active provider fails but other providers exist
  activeProvider ← studyProviderFromConfig(X.cfg)
  fallback ← groqFallbackProvider(X.cfg)
  otherProviders ← configuredProvidersWithKeys(X.cfg) \ {activeProvider, fallback}
  
  RETURN activeProviderFails(activeProvider, X.question)
     AND otherProviders ≠ ∅
     AND at_least_one_would_succeed(otherProviders, X.question)
END FUNCTION
```

**Property Specification** — Defines correct behavior for buggy inputs:

```pascal
// Property: Fix Checking — Cross-Provider Failover
FOR ALL X WHERE isBugCondition(X) DO
  result ← handleAskCommand'(X)
  ASSERT result.answered = true
     AND result.errorShown = false
     AND result.providerUsed ∈ configuredProvidersWithKeys(X.cfg)
END FOR
```

**Preservation Goal** — Expressed in structured pseudocode:

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT handleAskCommand(X) = handleAskCommand'(X)
END FOR
```

This ensures that when the active provider succeeds (or when no alternative providers exist), the fixed code behaves identically to the original — same answer, same error messages, same rate limiting.
