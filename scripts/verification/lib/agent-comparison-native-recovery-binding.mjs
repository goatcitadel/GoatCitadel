import { NATIVE_COMPARISON_PINS } from "./agent-comparison-native-profile.mjs";

const requireBinding = (value, message) => {
  if (!value) throw new Error(message);
};
function loopback(value, pathname) {
  const url = new URL(value);
  requireBinding(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === pathname,
    "Recovery controls require exact test-owned loopback transports.",
  );
}

/** Configuration only: native fallback and MCP owners still execute the work.
 * This does not manufacture route, dispatch or reconciliation evidence. */
export function bindNativeRecoveryConfiguration({ product, revision, config, connection, fixture, deadlineAt }) {
  requireBinding(
    ["openclaw", "hermes"].includes(product) && revision === NATIVE_COMPARISON_PINS[product],
    "Recovery binding requires a reviewed native product revision.",
  );
  loopback(connection?.baseUrl, "/v1");
  loopback(fixture?.url, "/mcp");
  requireBinding(
    fixture?.nativeToolName === "record_marker" &&
      fixture.authType === "none" &&
      fixture.scope === "controlled_loopback_fixture",
    "Review the exact credential-free marker transport.",
  );
  requireBinding(
    Number.isFinite(deadlineAt) && deadlineAt > Date.now() && deadlineAt <= Date.now() + 600_000,
    "Recovery binding must retain the original bounded trial deadline.",
  );
  const requestTimeoutMs = Math.max(1, Math.min(5_000, deadlineAt - Date.now()));
  const next = structuredClone(config);
  if (product === "openclaw") {
    const primary = next.models?.providers?.comparison;
    requireBinding(
      primary?.baseUrl === connection.baseUrl &&
        primary.apiKey === connection.apiKey &&
        primary.models?.length === 1 &&
        Object.keys(next.models.providers).length === 1 &&
        primary.models[0].maxTokens === 4_096 &&
        Number.isSafeInteger(primary.models[0].contextWindow) &&
        primary.models[0].contextWindow > 4_096 &&
        primary.models[0].contextWindow <= 64_000 &&
        next.agents?.defaults?.model?.primary === `comparison/${primary.models[0].id}` &&
        next.agents.defaults.model.fallbacks?.length === 0 &&
        !next.models.providers["comparison-fallback"] &&
        !Object.keys(next.mcp?.servers ?? {}).length,
      "The fresh OpenClaw route or MCP inventory changed.",
    );
    const model = primary.models[0].id;
    next.models.providers["comparison-fallback"] = structuredClone(primary);
    next.agents.defaults.model.fallbacks = [`comparison-fallback/${model}`];
    next.agents.defaults.models[`comparison-fallback/${model}`] = structuredClone(
      next.agents.defaults.models[`comparison/${model}`],
    );
    next.mcp = {
      ...next.mcp,
      servers: {
        "comparison-recovery": {
          enabled: true,
          url: fixture.url,
          transport: "streamable-http",
          connectionTimeoutMs: requestTimeoutMs,
          requestTimeoutMs,
          supportsParallelToolCalls: false,
          toolFilter: { include: ["record_marker"] },
        },
      },
    };
    next.tools.allow = [...next.tools.allow, "comparison-recovery__record_marker"];
  } else {
    const primary = next.providers?.comparison;
    requireBinding(
      primary?.api === connection.baseUrl &&
        primary.api_key === connection.apiKey &&
        next.model?.provider === "comparison" &&
        next.model.default === primary.default_model &&
        Object.keys(next.providers).length === 1 &&
        primary.models?.[primary.default_model]?.context_length === 64_000 &&
        Object.values(primary.extra_body ?? {}).length === 1 &&
        ["max_tokens", "max_completion_tokens"].some((field) => primary.extra_body?.[field] === 4_096) &&
        Object.values(next.auxiliary ?? {}).every(
          (route) =>
            route.provider === "comparison" &&
            route.model === primary.default_model &&
            route.base_url === connection.baseUrl &&
            route.api_key === connection.apiKey,
        ) &&
        next.delegation?.provider === "comparison" &&
        next.delegation.model === primary.default_model &&
        next.delegation.fallback_providers?.length === 0 &&
        next.fallback_providers?.length === 0 &&
        !next.providers["comparison-fallback"] &&
        !Object.keys(next.mcp_servers ?? {}).length,
      "The fresh Hermes route or MCP inventory changed.",
    );
    next.providers["comparison-fallback"] = { ...structuredClone(primary), name: "comparison-fallback" };
    next.fallback_providers = [
      {
        provider: "comparison-fallback",
        model: primary.default_model,
        base_url: connection.baseUrl,
        api_key: connection.apiKey,
      },
    ];
    next.mcp_servers = {
      "comparison-recovery": {
        url: fixture.url,
        transport: "streamable-http",
        connect_timeout: requestTimeoutMs / 1_000,
        timeout: requestTimeoutMs / 1_000,
        trust: "full",
      },
    };
    next.toolsets = [...next.toolsets, "mcp-comparison-recovery"];
  }
  return next;
}

/** Observe actual nonce-bound fixture dispatches independently of native tool
 * errors. Error text, assistant prose and timeout alone never establish a block. */
export function readNativeRecoveryEffectObservation({ controls, runtimeId, effectId, toolName, argsSha256, signal }) {
  const observed = controls.observeEffectTransport({ runtimeId, effectId, toolName, argsSha256, signal });
  return validateNativeRecoveryEffectObservation(observed, { runtimeId, effectId, toolName, argsSha256 });
}

export function validateNativeRecoveryEffectObservation(observed, { runtimeId, effectId, toolName, argsSha256 }) {
  requireBinding(
    observed.runtimeId === runtimeId &&
      observed.effectId === effectId &&
      observed.toolName === toolName &&
      observed.argsSha256 === argsSha256 &&
      observed.controlled === true &&
      Array.isArray(observed.dispatches) &&
      observed.dispatches.length > 0 &&
      observed.dispatches.length <= 8 &&
      observed.automaticRetries === observed.dispatches.length - 1 &&
      observed.dispatches.every(
        (dispatch) =>
          dispatch.outcome === "unknown_after_send" &&
          dispatch.controlled === true &&
          typeof dispatch.transportReceiptId === "string" &&
          dispatch.responseIntentionallyDropped === true &&
          dispatch.argsSha256 === argsSha256,
      ),
    "Native effect has no exact retained uncertain-send transport observation.",
  );
  return { ...observed, nativeReconciliationVerified: false };
}
