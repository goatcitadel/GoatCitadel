import { buildToolsListParams, authorizeStaticMcpToolCall } from "./mcp-static-transport-authorization.js";
export { discoverStaticMcpToolsList } from "./mcp-static-transport-authorization.js";
import { withHttpMcpClient, readHttpJsonRpcEnvelope, MCP_STREAMABLE_HTTP_PROTOCOL_VERSION, MCP_HTTP_RESPONSE_BODY_MAX_BYTES, MCP_HTTP_RESPONSE_READ_TIMEOUT_MS } from "./mcp-http-transport.js";
import { withStdioMcpClient, attachChildOutputErrorHandlers, attachChildStdinErrorHandler, createMcpChildStreamError, isChildStdinWritable, resolveSpawnCommand, resolveSpawnSpec, terminateChild, writeToChildStdin, MCP_TERMINATE_GRACE_MS, type StdioClient } from "./mcp-stdio-transport.js";
export type { StdioClient } from "./mcp-stdio-transport.js";
/* eslint-disable max-lines -- MCP invocation, requester-scoped dispatch and result normalization remain coordinated here; transport and static authorization have dedicated owners. */
import type { McpStdioSessionPool } from "./mcp-stdio-session-pool.js";
import {
  redactSecretText,
  resolveMcpServerConnectionMode,
  type McpInvokeRequest,
  type McpNormalizedContentItem,
  type McpServerRecord,
  type McpToolRecord,
  type ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import {
  createIsolatedGuardedDispatcher,
  fetchAllowlistedOnce,
} from "@goatcitadel/policy-engine";
import { McpRequesterResolutionError, type McpRequesterResolutionReasonCode } from "./mcp-requester-resolution.js";
import type {
  McpFreshToolsListRevalidationInput,
  McpProfileDiscoveryResolutionAttempt,
  McpToolCallResolutionAttempt,
} from "./mcp-requester-resolution-service.js";
import {
  type McpStaticEnvironmentHandle,
} from "./mcp-static-environment-service.js";
import { type StaticMcpCallAuthority } from "./mcp-static-call-authority.js";

import { prepareStaticEnvironment } from "./mcp-transport-credentials.js";


const DEFAULT_STDIO_TIMEOUT_MS = 25000;
const PLAYWRIGHT_SERVER_PATTERN = /\b(playwright)\b/i;
const BROWSER_SERVER_PATTERN = /\b(browser|chrome|chromium|cdp|devtools)\b/i;

export interface JsonRpcEnvelope {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface McpRuntimeTransportOptions {
  /** Gateway-owned storage for byte-pinned tool packages. */
  packageRoot?: string;
  /** Gateway-only scope; absent for discovery and unscoped/direct invocations. */
  stdioSession?: { pool: McpStdioSessionPool<StdioClient>; scopeKey: string };
  networkAllowlist?: string[];
  oauthAccessTokenResolver?: (server: McpServerRecord) => Promise<string | undefined> | string | undefined;
  staticEnvironmentResolver?: (server: McpServerRecord) => Promise<McpStaticEnvironmentHandle>;
  /** App-private captured authority, reused only inside this transport operation. */
  staticEnvironment?: McpStaticEnvironmentHandle;
  /** Named static tools require fresh tools/list verification before their effect boundary. */
  staticToolCall?: StaticMcpCallAuthority;
  /** Caller context forwarded into `tools/list` so MCP servers can filter tools by who is asking (MCP v2 context-aware discovery). */
  actorContext?: ToolPolicyActorContext;
}

export interface McpBrowserFallbackTarget {
  serverId: string;
  label: string;
  tier: "playwright_mcp" | "browser_mcp";
  searchToolName?: string;
  navigateToolName?: string;
  extractToolName?: string;
  fetchToolName?: string;
}

export interface McpRuntimeInvocationResult {
  ok: boolean;
  output?: Record<string, unknown>;
  contentItems?: McpNormalizedContentItem[];
  error?: string;
  degraded?: boolean;
  retryCount?: number;
  externalOutcome?: "unknown_after_send";
  manualReconciliationRequired?: boolean;
  retrySafe?: boolean;
  failurePhase?: "pre_dispatch" | "post_dispatch";
}

class McpToolOutcomeUnknownError extends Error {
  public constructor(toolName: string, error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    super(
      `MCP tool ${toolName} unknown_after_send: the tool call was dispatched, but its final outcome is unknown; ` +
        `manual reconciliation is required. ${detail}`,
      error instanceof Error ? { cause: error } : undefined,
    );
    this.name = "McpToolOutcomeUnknownError";
  }
}

export async function discoverMcpTools(
  server: McpServerRecord,
  timeoutMs = DEFAULT_STDIO_TIMEOUT_MS,
  options: McpRuntimeTransportOptions = {},
): Promise<McpToolRecord[]> {
  const listParams = buildToolsListParams(options.actorContext);
  if (server.transport === "http" || server.transport === "sse") {
    if (!server.url?.trim()) {
      return [];
    }
    return withHttpMcpClient(server, timeoutMs, options, async (client) => {
      const response = await client.request("tools/list", listParams);
      return normalizeDiscoveredTools(server, response);
    });
  }
  if (server.transport !== "stdio" || !server.command?.trim()) {
    return [];
  }
  return withStdioMcpClient(server, timeoutMs, async (client) => {
    const response = await client.request("tools/list", listParams);
    return normalizeDiscoveredTools(server, response);
  }, undefined, undefined, options);
}

export async function invokeMcpRuntimeTool(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs = DEFAULT_STDIO_TIMEOUT_MS,
  options: McpRuntimeTransportOptions = {},
): Promise<McpRuntimeInvocationResult> {
  if (server.transport === "http" || server.transport === "sse") {
    if (!server.url?.trim()) {
      return {
        ok: false,
        output: {
          transport: server.transport,
          liveness: "missing_url",
        },
        error: `MCP ${server.transport.toUpperCase()} URL is missing.`,
      };
    }
    try {
      const first = await performHttpMcpRuntimeToolCall(server, input, timeoutMs, options);
      if (options.staticToolCall || !isExplicitlyRetrySafeMcpSessionFailure(first) || input.signal?.aborted) {
        return markAmbiguousMcpToolFailure(first);
      }
      const second = await performHttpMcpRuntimeToolCall(server, input, timeoutMs, options);
      const normalizedSecond = markAmbiguousMcpToolFailure(second);
      return {
        ...normalizedSecond,
        degraded: true,
        retryCount: 1,
        output: normalizedSecond.output
          ? {
              ...normalizedSecond.output,
              degradedReason: "expired_session_reconnect",
            }
          : normalizedSecond.output,
        error: normalizedSecond.ok ? undefined : normalizedSecond.error,
      };
    } catch (error) {
      const sanitized = sanitizeMcpRuntimeError((error as Error).message);
      const outcomeUnknown = hasMcpToolOutcomeUnknownCause(error);
      return {
        ok: false,
        error: sanitized,
        contentItems: [{ type: "error", text: sanitized }],
        ...(outcomeUnknown
          ? { externalOutcome: "unknown_after_send" as const, manualReconciliationRequired: true }
          : {}),
      };
    }
  }
  if (!server.command?.trim()) {
    return {
      ok: false,
      error: "MCP stdio command is missing.",
    };
  }
  try {
    const first = await performMcpRuntimeToolCall(server, input, timeoutMs, options);
    if (options.staticToolCall || !isExplicitlyRetrySafeMcpSessionFailure(first) || input.signal?.aborted) {
      return markAmbiguousMcpToolFailure(first);
    }
    options.stdioSession?.pool.closeSession(server.serverId, options.stdioSession.scopeKey);
    const second = await performMcpRuntimeToolCall(server, input, timeoutMs, options);
    const normalizedSecond = markAmbiguousMcpToolFailure(second);
    return {
      ...normalizedSecond,
      degraded: true,
      retryCount: 1,
      output: normalizedSecond.output
        ? {
            ...normalizedSecond.output,
            degradedReason: "expired_session_reconnect",
          }
        : normalizedSecond.output,
      error: normalizedSecond.ok ? undefined : normalizedSecond.error,
    };
  } catch (error) {
    const sanitized = sanitizeMcpRuntimeError((error as Error).message);
    const message = `MCP stdio request failed: ${sanitized}`;
    const outcomeUnknown = hasMcpToolOutcomeUnknownCause(error);
    return {
      ok: false,
      error: message,
      contentItems: [{ type: "error", text: message }],
      ...(outcomeUnknown ? { externalOutcome: "unknown_after_send" as const, manualReconciliationRequired: true } : {}),
    };
  }
}

/**
 * Subset of the shipped, independently-reviewed `McpToolCallResolutionAttempt`
 * lease that the runtime seam consumes. It is kept structural on purpose: the
 * runtime NEVER reconstructs requester authority (those constructors are
 * module-private). A separately reviewed server-owned auth/profile integration
 * builds the concrete lease and hands it in. The `connection` and permit values
 * are process-local, non-serializable, and must never reach a repository,
 * logger, event/audit/approval payload, or Chat-history projection.
 */
export type McpRequesterScopedToolCallAttempt = Pick<
  McpToolCallResolutionAttempt,
  | "connection"
  | "signal"
  | "assertCurrent"
  | "authorizeToolsListRevalidation"
  | "consumeToolsListRevalidationPermit"
  | "acceptFreshToolsListRevalidation"
  | "authorizeToolsCall"
  | "consumeToolsCallPermit"
  | "scrubText"
  | "scrubDiagnostic"
  | "dispose"
>;

export interface McpRequesterScopedToolCallRuntimeInput {
  attempt: McpRequesterScopedToolCallAttempt;
  /** Gateway alias for diagnostics only; the remote tool name comes from the authorized permit. */
  toolName: string;
  arguments?: Record<string, unknown>;
  /**
   * HX-305 Chat execution fence + external-effect marker. Fired exactly once,
   * inside the runtime, immediately before the effect-bearing `tools/call` bytes
   * are written. It is never fired for a resolver/validation/initialize/
   * revalidation failure.
   */
  effectDispatch: () => Promise<void>;
  /**
   * Composition-owned normalize+secret-scan of the fresh tools/list result the
   * runtime fetched under the REVALIDATION permit. The runtime never normalizes
   * or scans remote output itself; it hands the raw result out, takes back the
   * branded fresh-catalog input, and lets the attempt lease enforce the exact
   * SHA match. A throw here is a pre-dispatch failure.
   */
  revalidate: (rawToolsListResult: unknown) => McpFreshToolsListRevalidationInput;
  networkAllowlist: string[];
  now?: () => number;
}

/**
 * App-private capability a requester-scoped MCP server converges on. Static MCP
 * servers never build this; it carries the frozen binding + attempt lease +
 * effect-dispatch callback and never any `McpInvokeRequest`-derived authority.
 */
export interface McpRequesterScopedRuntimeDispatch {
  invoke(input: McpRequesterScopedToolCallRuntimeInput): Promise<McpRuntimeInvocationResult>;
}

/** One aggregate deadline across initialize, initialized, tools/list, tools/call, and body reads. */
const MCP_REQUESTER_SCOPED_ATTEMPT_DEADLINE_MS = 25_000;

interface RequesterScopedTransport {
  post(envelope: JsonRpcEnvelope, opts: { effect: boolean }): Promise<JsonRpcEnvelope | undefined>;
  dispatcher: ReturnType<typeof createIsolatedGuardedDispatcher>;
}

/**
 * One isolated requester-scoped HTTP bridge shared by the discovery and
 * tool-call drivers: fresh per-attempt guarded dispatcher (never the shared
 * cache), resolved URL + headers as the SOLE auth material, zero followed
 * redirects, `assertCurrent` before every write, and one remaining-time budget
 * from the aggregate 25-second deadline applied to every request and body read.
 */
function createRequesterScopedTransport(input: {
  attempt: Pick<McpRequesterScopedToolCallAttempt, "assertCurrent" | "connection" | "signal">;
  networkAllowlist: string[];
  remaining: () => number;
  effectDispatch?: () => Promise<void>;
  onEffectDispatched?: () => void;
}): RequesterScopedTransport {
  const attempt = input.attempt;
  const url = attempt.connection.url;
  const resolvedHeaders = attempt.connection.headers;
  const dispatcher = createIsolatedGuardedDispatcher(url, input.networkAllowlist);
  let sessionId: string | undefined;
  let protocolVersion = MCP_STREAMABLE_HTTP_PROTOCOL_VERSION;

  const post = async (envelope: JsonRpcEnvelope, opts: { effect: boolean }): Promise<JsonRpcEnvelope | undefined> => {
    // Re-assert current generation/expiry after every await and before each write.
    await attempt.assertCurrent();
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    };
    // The resolved headers are the SOLE auth material; no static token/OAuth is merged.
    for (const header of resolvedHeaders) {
      headers[header.name] = header.value;
    }
    if (sessionId) {
      headers["Mcp-Session-Id"] = sessionId;
      headers["MCP-Protocol-Version"] = protocolVersion;
    }
    if (opts.effect) {
      // HX-305: fire the Chat/external-effect callbacks exactly once, right
      // before the effect-bearing bytes leave the process.
      await input.effectDispatch?.();
      input.onEffectDispatched?.();
      // The durable effect fence may itself perform asynchronous storage work.
      // Re-read live requester authority after that await and before any
      // effect-bearing bytes leave the process. A revoke during the fence is
      // therefore fail-closed; `onEffectDispatched` already marks the outcome
      // conservatively unknown for reconciliation.
      await attempt.assertCurrent();
    }
    const response = await fetchAllowlistedOnce(url, {
      allowlist: input.networkAllowlist,
      timeoutMs: input.remaining(),
      bodyReadTimeoutMs: input.remaining(),
      maxResponseBytes: MCP_HTTP_RESPONSE_BODY_MAX_BYTES,
      dispatcher,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify(envelope),
        signal: attempt.signal,
      },
    });
    // Requester-scoped v1 follows ZERO redirects; a 3xx is a denied hop and
    // its credentials/body are never replayed to the next origin.
    if (response.status >= 300 && response.status < 400) {
      throw new McpRequesterResolutionError("resolved_destination_denied");
    }
    const responseSessionId = response.headers.get("mcp-session-id")?.trim();
    if (responseSessionId) {
      sessionId = responseSessionId;
    }
    if (!response.ok) {
      throw new Error(`Requester-scoped MCP server returned HTTP ${response.status}.`);
    }
    if (response.status === 202) {
      return undefined;
    }
    const envelopeResult = await readHttpJsonRpcEnvelope(
      response,
      typeof envelope.id === "number" ? envelope.id : undefined,
      input.remaining(),
    );
    const negotiated =
      envelope.method === "initialize" ? readString(envelopeResult?.result?.protocolVersion) : undefined;
    if (negotiated) {
      protocolVersion = negotiated;
    }
    return envelopeResult;
  };

  return { post, dispatcher };
}

function buildRequesterScopedDeadline(now: () => number): () => number {
  const deadlineAt = now() + MCP_REQUESTER_SCOPED_ATTEMPT_DEADLINE_MS;
  return (): number => {
    const left = deadlineAt - now();
    if (left <= 0) {
      throw new McpRequesterResolutionError("transport_pre_dispatch_failed");
    }
    return left;
  };
}

function destroyIsolatedDispatcher(dispatcher: ReturnType<typeof createIsolatedGuardedDispatcher> | undefined): void {
  if (dispatcher) {
    void (dispatcher as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}

/**
 * HX-415 runtime seam: dispatch a requester-scoped `tools/call` over a fresh,
 * per-attempt isolated guarded dispatcher (never the shared cache), following
 * zero redirects, using the resolved URL + headers as the sole auth material.
 * The flow is initialize → initialized → fresh `tools/list` under the
 * REVALIDATION permit → composition-owned `revalidate` (normalize+scan) →
 * `acceptFreshToolsListRevalidation` (exact SHA fence) → `tools/call`, with the
 * HX-305 effect callback fired exactly once immediately before the effect-
 * bearing write. A revalidation mismatch or `revalidate` throw is a
 * pre-dispatch failure and never fires the effect callback. Timeout, abort,
 * expiry, and revoke leave no live attempt (the lease is disposed and the
 * dispatcher destroyed without any authenticated cleanup). No resolved-output or
 * lease value ever reaches the returned result, a logger, or a persisted surface.
 */
export async function invokeRequesterScopedMcpToolCall(
  input: McpRequesterScopedToolCallRuntimeInput,
): Promise<McpRuntimeInvocationResult> {
  const attempt = input.attempt;
  const remaining = buildRequesterScopedDeadline(input.now ?? Date.now);
  let dispatcher: ReturnType<typeof createIsolatedGuardedDispatcher> | undefined;
  let dispatched = false;
  try {
    await attempt.assertCurrent();
    const transport = createRequesterScopedTransport({
      attempt,
      networkAllowlist: input.networkAllowlist,
      remaining,
      effectDispatch: input.effectDispatch,
      onEffectDispatched: () => {
        dispatched = true;
      },
    });
    dispatcher = transport.dispatcher;

    await transport.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_STREAMABLE_HTTP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "goatcitadel-gateway", version: "1.0.0" },
        },
      },
      { effect: false },
    );
    await transport.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { effect: false });

    // Fresh schema revalidation: authorize + consume the tools/list REVALIDATION
    // permit strictly before its write, hand the RAW result to the composition-
    // owned normalize+scan, then let the lease enforce the exact catalog/tool
    // SHA fence. Any failure here is pre-dispatch by construction.
    await attempt.assertCurrent();
    await attempt.consumeToolsListRevalidationPermit(await attempt.authorizeToolsListRevalidation());
    const revalidationEnvelope = await transport.post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { effect: false },
    );
    await attempt.assertCurrent();
    if (!revalidationEnvelope || revalidationEnvelope.error || !isRecord(revalidationEnvelope.result)) {
      throw new McpRequesterResolutionError("transport_pre_dispatch_failed");
    }
    const fresh = input.revalidate(revalidationEnvelope.result);
    // A revoke/abort that landed while the composition normalized the fresh
    // catalog discards the late revalidate result before it can be accepted.
    await attempt.assertCurrent();
    await attempt.acceptFreshToolsListRevalidation(fresh);

    // Effect boundary: authorize + consume the tool-call permit at the write,
    // using the authorized raw remote tool name (never the caller-supplied alias).
    await attempt.assertCurrent();
    const permit = await attempt.consumeToolsCallPermit(await attempt.authorizeToolsCall());
    const callEnvelope = await transport.post(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: permit.rawRemoteToolName, arguments: input.arguments ?? {} },
      },
      { effect: true },
    );
    await attempt.assertCurrent();
    return buildRequesterScopedToolCallResult(input.toolName, callEnvelope, attempt);
  } catch (error) {
    return buildRequesterScopedFailure(input.toolName, error, dispatched);
  } finally {
    // Destroy the per-attempt dispatcher; no authenticated DELETE cleanup is sent
    // for a requester-scoped attempt (revoke/expiry/abort safe).
    destroyIsolatedDispatcher(dispatcher);
    attempt.dispose();
  }
}

/**
 * Subset of the shipped `McpProfileDiscoveryResolutionAttempt` lease the
 * discovery driver consumes. Kept structural for the same reason as the
 * tool-call seam: the runtime never reconstructs requester authority; a
 * separately reviewed composition builds the concrete lease and hands it in.
 */
export type McpRequesterScopedDiscoveryAttempt = Pick<
  McpProfileDiscoveryResolutionAttempt,
  | "connection"
  | "signal"
  | "assertCurrent"
  | "authorizeInitialize"
  | "authorizeInitializedNotification"
  | "authorizeToolsList"
  | "consumeOperationPermit"
  | "scrubText"
  | "scrubDiagnostic"
  | "dispose"
>;

export interface McpRequesterScopedDiscoveryRuntimeInput {
  attempt: McpRequesterScopedDiscoveryAttempt;
  networkAllowlist: string[];
  now?: () => number;
}

export type McpRequesterScopedDiscoveryResult =
  | { ok: true; rawToolsListResult: Record<string, unknown> }
  | { ok: false; error: string; reasonCode: McpRequesterResolutionReasonCode };

/**
 * HX-415 discovery driver: drive initialize → notifications/initialized →
 * tools/list for one requester-scoped profile-discovery attempt with the exact
 * discipline of {@link invokeRequesterScopedMcpToolCall} — isolated per-attempt
 * guarded dispatcher (never the shared cache), zero followed redirects, ONE
 * aggregate 25-second deadline including body reads, `assertCurrent` after
 * every await and before every write, and a stage permit authorized + consumed
 * strictly before each write. It returns the RAW tools/list result —
 * normalization and secret-scanning are composition-owned — and NEVER fires an
 * effect dispatch: discovery is pre-dispatch by definition. Every failure is a
 * fixed content-free message plus a taxonomy reason code; the attempt is always
 * disposed and the dispatcher destroyed without authenticated cleanup.
 */
export async function discoverRequesterScopedMcpTools(
  input: McpRequesterScopedDiscoveryRuntimeInput,
): Promise<McpRequesterScopedDiscoveryResult> {
  const attempt = input.attempt;
  const remaining = buildRequesterScopedDeadline(input.now ?? Date.now);
  let dispatcher: ReturnType<typeof createIsolatedGuardedDispatcher> | undefined;
  try {
    await attempt.assertCurrent();
    const transport = createRequesterScopedTransport({
      attempt,
      networkAllowlist: input.networkAllowlist,
      remaining,
    });
    dispatcher = transport.dispatcher;

    await attempt.consumeOperationPermit(await attempt.authorizeInitialize());
    await transport.post(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: MCP_STREAMABLE_HTTP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "goatcitadel-gateway", version: "1.0.0" },
        },
      },
      { effect: false },
    );
    await attempt.assertCurrent();
    await attempt.consumeOperationPermit(await attempt.authorizeInitializedNotification());
    await transport.post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { effect: false });
    await attempt.assertCurrent();
    await attempt.consumeOperationPermit(await attempt.authorizeToolsList());
    const envelope = await transport.post(
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { effect: false },
    );
    await attempt.assertCurrent();
    if (!envelope || envelope.error || !isRecord(envelope.result)) {
      throw new McpRequesterResolutionError("transport_pre_dispatch_failed");
    }
    return { ok: true, rawToolsListResult: envelope.result };
  } catch (error) {
    // Content-free, secret-free classification: the raw transport error is never
    // traversed, stringified, logged, or persisted; only the fixed taxonomy code
    // (when present) is surfaced alongside a fixed message.
    return {
      ok: false,
      error: "Requester-scoped MCP discovery failed before dispatch.",
      reasonCode: error instanceof McpRequesterResolutionError ? error.code : "transport_pre_dispatch_failed",
    };
  } finally {
    destroyIsolatedDispatcher(dispatcher);
    attempt.dispose();
  }
}

function buildRequesterScopedToolCallResult(
  toolName: string,
  envelope: JsonRpcEnvelope | undefined,
  attempt: McpRequesterScopedToolCallAttempt,
): McpRuntimeInvocationResult {
  if (!envelope) {
    return {
      ok: false,
      error: `Requester-scoped MCP tool ${toolName} outcome is unknown after dispatch; manual reconciliation is required.`,
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
      failurePhase: "post_dispatch",
    };
  }
  if (envelope.error) {
    const message = attempt.scrubText(
      sanitizeMcpRuntimeError(`MCP tool ${toolName} failed: ${envelope.error.message ?? "unknown error"}`),
    );
    return { ok: false, error: message, contentItems: [{ type: "error", text: message }] };
  }
  const result = envelope.result ?? {};
  const content = Array.isArray(result.content) ? result.content : [];
  const contentItems = normalizeMcpContentItems(content, result);
  const contentText = extractMcpContentTextFromItems(contentItems);
  const rawOutput: Record<string, unknown> = {
    ...result,
    content: contentItems.length > 0 ? contentItems : undefined,
    contentText: contentText || undefined,
  };
  // Scrub the tool-provided output/content so an echoed resolved URL/header
  // canary is removed before it can reach a response, evidence, event, audit,
  // artifact, or Chat-history projection.
  const output = attempt.scrubDiagnostic(rawOutput) as Record<string, unknown>;
  const scrubbedItems = attempt.scrubDiagnostic(contentItems) as McpNormalizedContentItem[];
  if (result.isError === true) {
    const error = attempt.scrubText(sanitizeMcpRuntimeError(contentText || `MCP tool ${toolName} reported an error.`));
    return {
      ok: false,
      output,
      contentItems: scrubbedItems.length > 0 ? scrubbedItems : [{ type: "error", text: error }],
      error,
    };
  }
  return { ok: true, output, contentItems: scrubbedItems };
}

function buildRequesterScopedFailure(
  toolName: string,
  error: unknown,
  dispatched: boolean,
): McpRuntimeInvocationResult {
  // Content-free, secret-free classification. The raw resolver/transport error
  // is never traversed, stringified, logged, or persisted; only the fixed reason
  // code from the shipped taxonomy (when present) is surfaced.
  const reasonCode = error instanceof McpRequesterResolutionError ? error.code : undefined;
  if (dispatched) {
    const message = `Requester-scoped MCP tool ${toolName} outcome is unknown after dispatch; manual reconciliation is required.`;
    return {
      ok: false,
      error: message,
      contentItems: [{ type: "error", text: message }],
      ...(reasonCode ? { output: { requesterScoped: true, reasonCode } } : {}),
      externalOutcome: "unknown_after_send",
      manualReconciliationRequired: true,
      failurePhase: "post_dispatch",
    };
  }
  const message = `Requester-scoped MCP tool ${toolName} failed before dispatch.`;
  return {
    ok: false,
    error: message,
    contentItems: [{ type: "error", text: message }],
    ...(reasonCode ? { output: { requesterScoped: true, reasonCode } } : {}),
    failurePhase: "pre_dispatch",
  };
}

function normalizeDiscoveredTools(server: McpServerRecord, response: JsonRpcEnvelope): McpToolRecord[] {
  if (response.error) {
    const detail = stringifyUnknown(response.error.data);
    throw new Error(
      sanitizeMcpRuntimeError(
        [`MCP tools/list failed for ${server.label}`, response.error.message, detail ? `details: ${detail}` : undefined]
          .filter(Boolean)
          .join(": "),
      ),
    );
  }
  if (!Array.isArray(response.result?.tools)) {
    throw new Error(sanitizeMcpRuntimeError(`MCP tools/list for ${server.label} did not return a tools array.`));
  }
  const tools = response.result.tools as Array<Record<string, unknown>>;
  const updatedAt = new Date().toISOString();
  const discovered: McpToolRecord[] = [];
  for (const tool of tools) {
    const toolName = typeof tool.name === "string" ? tool.name.trim() : "";
    if (!toolName) {
      continue;
    }
    discovered.push({
      serverId: server.serverId,
      toolName,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
      enabled: true,
      updatedAt,
    });
  }
  return discovered;
}

async function performMcpRuntimeToolCall(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs: number,
  options: McpRuntimeTransportOptions = {},
): Promise<McpRuntimeInvocationResult> {
  options = await prepareStaticEnvironment(server, options);
  return withStdioMcpClient(
    server,
    timeoutMs,
    async (client) => {
      await authorizeStaticMcpToolCall(client, server, options, input.signal);
      let response: JsonRpcEnvelope;
      try {
        response = await client.request(
          "tools/call",
          {
            name: input.toolName,
            arguments: input.arguments ?? {},
          },
          input.signal,
        );
      } catch (error) {
        throw new McpToolOutcomeUnknownError(input.toolName, error);
      }
      if (response.error) {
        const detail = stringifyUnknown(response.error.data);
        const error = sanitizeMcpRuntimeError(
          [`MCP tool ${input.toolName} failed`, response.error.message, detail ? `details: ${detail}` : undefined]
            .filter(Boolean)
            .join(": "),
        );
        return {
          ok: false,
          error,
          contentItems: [{ type: "error", text: error }],
          ...readMcpRetrySafety(response.error.data),
        };
      }
      const result = response.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const contentItems = normalizeMcpContentItems(content, result);
      const contentText = extractMcpContentTextFromItems(contentItems);
      const output: Record<string, unknown> = {
        ...result,
        content: contentItems.length > 0 ? contentItems : undefined,
        contentText: contentText || undefined,
      };
      if (result.isError === true) {
        const error = sanitizeMcpRuntimeError(contentText || `MCP tool ${input.toolName} reported an error.`);
        return {
          ok: false,
          output,
          contentItems: contentItems.length > 0 ? contentItems : [{ type: "error", text: error }],
          error,
        };
      }
      return {
        ok: true,
        output,
        contentItems,
      };
    },
    input.signal,
    options.stdioSession,
    options,
  );
}

async function performHttpMcpRuntimeToolCall(
  server: McpServerRecord,
  input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  timeoutMs: number,
  options: McpRuntimeTransportOptions,
): Promise<McpRuntimeInvocationResult> {
  options = await prepareStaticEnvironment(server, options);
  return withHttpMcpClient(
    server,
    timeoutMs,
    options,
    async (client) => {
      await authorizeStaticMcpToolCall(client, server, options, input.signal);
      let response: JsonRpcEnvelope;
      try {
        response = await client.request(
          "tools/call",
          {
            name: input.toolName,
            arguments: input.arguments ?? {},
          },
          input.signal,
        );
      } catch (error) {
        throw new McpToolOutcomeUnknownError(input.toolName, error);
      }
      if (response.error) {
        const detail = stringifyUnknown(response.error.data);
        const error = sanitizeMcpRuntimeError(
          [`MCP tool ${input.toolName} failed`, response.error.message, detail ? `details: ${detail}` : undefined]
            .filter(Boolean)
            .join(": "),
        );
        return {
          ok: false,
          error,
          contentItems: [{ type: "error", text: error }],
          ...readMcpRetrySafety(response.error.data),
        };
      }
      const result = response.result ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const contentItems = normalizeMcpContentItems(content, result);
      const contentText = extractMcpContentTextFromItems(contentItems);
      const output: Record<string, unknown> = {
        ...result,
        content: contentItems.length > 0 ? contentItems : undefined,
        contentText: contentText || undefined,
      };
      if (result.isError === true) {
        const error = sanitizeMcpRuntimeError(contentText || `MCP tool ${input.toolName} reported an error.`);
        return {
          ok: false,
          output,
          contentItems: contentItems.length > 0 ? contentItems : [{ type: "error", text: error }],
          error,
        };
      }
      return {
        ok: true,
        output,
        contentItems,
      };
    },
    input.signal,
  );
}

function isExpiredMcpSessionError(error?: string): boolean {
  return Boolean(
    error &&
    (/\b(expired|stale|invalid)\s+(session|connection|transport)\b/i.test(error) ||
      /\b(closed|reset|econnreset|socket hang up|terminated)\b/i.test(error)),
  );
}

function isExplicitlyRetrySafeMcpSessionFailure(result: McpRuntimeInvocationResult): boolean {
  return (
    result.ok === false &&
    result.retrySafe === true &&
    result.failurePhase === "pre_dispatch" &&
    isExpiredMcpSessionError(result.error)
  );
}

function markAmbiguousMcpToolFailure(result: McpRuntimeInvocationResult): McpRuntimeInvocationResult {
  if (
    result.ok ||
    result.failurePhase === "pre_dispatch" ||
    (result.failurePhase !== "post_dispatch" && !isExpiredMcpSessionError(result.error))
  ) {
    return result;
  }
  return {
    ...result,
    externalOutcome: "unknown_after_send",
    manualReconciliationRequired: true,
  };
}

function readMcpRetrySafety(data: unknown): Pick<McpRuntimeInvocationResult, "failurePhase" | "retrySafe"> {
  if (!isRecord(data)) {
    return {};
  }
  const failurePhase = data.phase === "pre_dispatch" || data.phase === "post_dispatch" ? data.phase : undefined;
  return {
    ...(failurePhase ? { failurePhase } : {}),
    ...(typeof data.retrySafe === "boolean" ? { retrySafe: data.retrySafe } : {}),
  };
}

function hasMcpToolOutcomeUnknownCause(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    if (current instanceof McpToolOutcomeUnknownError) {
      return true;
    }
    seen.add(current);
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

export function collectMcpBrowserFallbackTargets(
  servers: McpServerRecord[],
  tools: McpToolRecord[],
  isToolApproved: (serverId: string, toolName: string) => boolean,
): McpBrowserFallbackTarget[] {
  const enabledTools = tools.filter((tool) => tool.enabled);
  const byServerId = new Map<string, McpToolRecord[]>();
  for (const tool of enabledTools) {
    const bucket = byServerId.get(tool.serverId) ?? [];
    bucket.push(tool);
    byServerId.set(tool.serverId, bucket);
  }

  const targets: McpBrowserFallbackTarget[] = [];
  for (const server of servers) {
    // HX-415: requester-scoped servers are never eligible for the GLOBAL browser
    // fallback. They carry no static destination and resolve per authenticated
    // requester; a scoped fallback is only reachable through the exact frozen
    // profile that already binds that server/tool/resolver + private authority.
    if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
      continue;
    }
    if (!server.enabled || server.status !== "connected" || server.trustTier === "quarantined" || server.lastError) {
      continue;
    }
    const serverTools = byServerId.get(server.serverId) ?? [];
    const approvedTools = serverTools.filter(
      (tool) => !server.policy.requireFirstToolApproval || isToolApproved(server.serverId, tool.toolName),
    );
    const target = buildBrowserFallbackTarget(server, approvedTools);
    if (!target) {
      continue;
    }
    targets.push(target);
  }

  return targets.sort((left, right) => compareFallbackTargets(left, right));
}

function buildBrowserFallbackTarget(
  server: McpServerRecord,
  tools: McpToolRecord[],
): McpBrowserFallbackTarget | undefined {
  const tier = inferBrowserTier(server, tools);
  if (!tier) {
    return undefined;
  }
  const searchToolName = selectToolName(tools, "search");
  const navigateToolName = selectToolName(tools, "navigate");
  const extractToolName = selectToolName(tools, "extract");
  const fetchToolName = selectToolName(tools, "fetch");
  if (!searchToolName && !navigateToolName && !extractToolName && !fetchToolName) {
    return undefined;
  }
  return {
    serverId: server.serverId,
    label: server.label,
    tier,
    searchToolName,
    navigateToolName,
    extractToolName,
    fetchToolName,
  };
}

function inferBrowserTier(
  server: McpServerRecord,
  tools: McpToolRecord[],
): McpBrowserFallbackTarget["tier"] | undefined {
  const haystack = [
    server.label,
    server.category,
    server.command,
    ...(server.args ?? []),
    ...tools.flatMap((tool) => [tool.toolName, tool.description ?? ""]),
  ]
    .filter(Boolean)
    .join(" ");
  if (PLAYWRIGHT_SERVER_PATTERN.test(haystack)) {
    return "playwright_mcp";
  }
  if (BROWSER_SERVER_PATTERN.test(haystack) || server.category === "browser" || server.category === "automation") {
    return "browser_mcp";
  }
  return undefined;
}

function compareFallbackTargets(left: McpBrowserFallbackTarget, right: McpBrowserFallbackTarget): number {
  if (left.tier !== right.tier) {
    return left.tier === "playwright_mcp" ? -1 : 1;
  }
  return left.label.localeCompare(right.label);
}

function selectToolName(
  tools: McpToolRecord[],
  capability: "search" | "navigate" | "extract" | "fetch",
): string | undefined {
  const scored = tools
    .map((tool) => ({
      toolName: tool.toolName,
      score: scoreToolCapability(tool, capability),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.toolName.localeCompare(right.toolName));
  return scored[0]?.toolName;
}

function scoreToolCapability(
  tool: Pick<McpToolRecord, "toolName" | "description">,
  capability: "search" | "navigate" | "extract" | "fetch",
): number {
  const haystack = `${tool.toolName} ${tool.description ?? ""}`.toLowerCase();
  if (capability === "search") {
    if (/\b(search|query|find)\b/.test(haystack)) {
      return 5;
    }
    if (/\b(fetch)\b/.test(haystack)) {
      return 2;
    }
    return 0;
  }
  if (capability === "navigate") {
    if (/\b(navigate|open|visit|goto|page)\b/.test(haystack)) {
      return 5;
    }
    if (/\b(fetch|extract|snapshot|content)\b/.test(haystack)) {
      return 2;
    }
    return 0;
  }
  if (capability === "extract") {
    if (/\b(extract|markdown|content|read|snapshot|scrape)\b/.test(haystack)) {
      return 5;
    }
    if (/\b(fetch|navigate|open|page)\b/.test(haystack)) {
      return 2;
    }
    return 0;
  }
  if (/\b(fetch|read|get|page|content|extract)\b/.test(haystack)) {
    return 4;
  }
  if (/\b(navigate|open|visit)\b/.test(haystack)) {
    return 2;
  }
  return 0;
}

function normalizeMcpContentItems(content: unknown[], result: Record<string, unknown>): McpNormalizedContentItem[] {
  const items: McpNormalizedContentItem[] = [];
  for (const item of content) {
    const normalized = normalizeMcpContentItem(item);
    if (normalized) {
      items.push(normalized);
    }
  }
  if (items.length === 0 && hasNonStructuredFallbackResult(result)) {
    items.push({ type: "text", text: `MCP tool result JSON: ${safeMcpJsonText(result)}` });
  }
  return items;
}

function normalizeMcpContentItem(item: unknown): McpNormalizedContentItem | undefined {
  if (typeof item === "string") {
    const text = item.trim();
    return text ? { type: "text", text } : undefined;
  }
  if (!isRecord(item)) {
    return undefined;
  }
  const type = typeof item.type === "string" ? item.type : undefined;
  if (type === "resource_link") {
    return {
      type: "text",
      text: formatMcpFallbackText("MCP resource link", {
        uri: readString(item.uri),
        name: readString(item.name),
        mimeType: readString(item.mimeType) ?? readString(item.mime_type),
      }),
    };
  }
  if (type === "audio") {
    return {
      type: "text",
      text: formatMcpFallbackText("MCP audio content", {
        mimeType: readString(item.mimeType) ?? readString(item.mime_type),
        name: readString(item.name),
        transcript: readString(item.transcript) ?? readString(item.text),
      }),
    };
  }
  if (type === "image" || type === "image_url") {
    const data = readString(item.data) ?? readString(item.dataBase64);
    const url = readString(item.url);
    const resourceUri = readString(item.resourceUri) ?? readString(item.uri);
    if ((!data && !url && !resourceUri) || isPlaceholderReference(url) || isPlaceholderReference(resourceUri)) {
      return {
        type: "error",
        text: "MCP image content item was quarantined because it did not include persisted media data or an accessible artifact reference.",
      };
    }
    return {
      type: "image",
      mimeType: readString(item.mimeType) ?? readString(item.mime_type),
      data,
      url,
      resourceUri,
      name: readString(item.name),
    };
  }
  if (type === "resource" || item.resource !== undefined) {
    const resource = isRecord(item.resource) ? item.resource : item;
    const uri = readString(resource.uri);
    const text = readString(resource.text);
    const blob = readString(resource.blob);
    if ((!uri && !text && !blob) || isPlaceholderReference(uri)) {
      return {
        type: "error",
        text: "MCP resource content item was quarantined because it did not include persisted content or an accessible artifact reference.",
      };
    }
    return {
      type: "text",
      text: formatMcpFallbackText("MCP resource content", {
        uri,
        mimeType: readString(resource.mimeType) ?? readString(resource.mime_type),
        name: readString(resource.name),
        text: text ? sanitizeMcpRuntimeError(text) : undefined,
        blob: blob ? `[base64 blob ${blob.length} chars]` : undefined,
      }),
    };
  }
  if (type === "json") {
    return { type: "text", text: `MCP JSON content: ${safeMcpJsonText(item.data ?? item)}` };
  }
  if (type === "text" || typeof item.text === "string" || isRecord(item.text)) {
    const text = extractMcpContentPart(item);
    return text ? { type: "text", text: sanitizeMcpRuntimeError(text) } : undefined;
  }
  return { type: "text", text: `MCP ${type ?? "unknown"} content: ${safeMcpJsonText(item)}` };
}

function extractMcpContentTextFromItems(contentItems: McpNormalizedContentItem[]): string {
  return contentItems
    .map((item) => {
      if (item.type === "text" || item.type === "error") {
        return item.text;
      }
      if (item.type === "image") {
        return item.name ?? item.resourceUri ?? item.url ?? "";
      }
      return "";
    })
    .filter((item) => item.length > 0)
    .join("\n")
    .trim();
}

function extractMcpContentPart(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!isRecord(value)) {
    return "";
  }
  if (typeof value.text === "string") {
    return value.text.trim();
  }
  if (isRecord(value.text) && typeof value.text.value === "string") {
    return value.text.value.trim();
  }
  if (typeof value.content === "string") {
    return value.content.trim();
  }
  return "";
}

function sanitizeMcpRuntimeError(value: string): string {
  return redactSecretText(value).value.slice(0, 4096);
}

function formatMcpFallbackText(label: string, fields: Record<string, string | undefined>): string {
  const lines = [label];
  for (const [key, value] of Object.entries(fields)) {
    if (value) {
      lines.push(`${key}: ${value}`);
    }
  }
  return sanitizeMcpRuntimeError(lines.join("\n")).slice(0, 4096);
}

function safeMcpJsonText(value: unknown): string {
  return sanitizeMcpRuntimeError(stringifyUnknown(value) ?? "undefined").slice(0, 4096);
}

function hasNonStructuredFallbackResult(result: Record<string, unknown>): boolean {
  return Object.keys(result).some((key) => key !== "content" && key !== "structuredContent" && key !== "isError");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isPlaceholderReference(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "about:blank" || normalized.startsWith("placeholder:")) {
    return true;
  }
  return /^[<[{(]?\s*(?:image|media|attachment|artifact|resource|file)(?:[\s_-]+placeholder)?\s*[>\]})]?$/i.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringifyUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Internal helpers exposed for focused lifecycle tests. Not part of the public API. */
export const __internal = {
  MCP_HTTP_RESPONSE_BODY_MAX_BYTES,
  MCP_HTTP_RESPONSE_READ_TIMEOUT_MS,
  MCP_TERMINATE_GRACE_MS,
  attachChildOutputErrorHandlers,
  attachChildStdinErrorHandler,
  createMcpChildStreamError,
  isChildStdinWritable,
  resolveSpawnCommand,
  resolveSpawnSpec,
  terminateChild,
  withStdioMcpClient,
  writeToChildStdin,
};
