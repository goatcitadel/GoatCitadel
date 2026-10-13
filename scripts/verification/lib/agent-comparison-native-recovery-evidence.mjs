import path from "node:path";
import { sha256 } from "./agent-comparison.mjs";
import { projectHermesComparisonTurn } from "./agent-comparison-hermes-workflow.mjs";

const requireEvidence = (value, message) => {
  if (!value) throw new Error(message);
};
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}$/u.test(value);
const parse = (value) => (typeof value === "string" ? JSON.parse(value) : value);
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
const time = (value) => {
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  requireEvidence(Number.isFinite(date.getTime()), "Recovery observation has no timestamp.");
  return date.toISOString();
};

/** Public RPC terminal and complete native transcript, never assistant prose. */
export function readOpenclawRecoveryEvidence(native, { model, workspace, prompt }) {
  const result = native.result,
    meta = result?.result?.meta,
    agent = meta?.agentMeta;
  const terminal = agent?.terminalReceipt,
    report = meta?.systemPromptReport,
    history = native.history;
  requireEvidence(
    result?.status === "ok" &&
      !meta?.aborted &&
      identifier(result.runId) &&
      terminal?.runId === result.runId &&
      terminal.turnId === result.runId &&
      terminal.sessionId === agent.sessionId &&
      terminal.requested?.provider === "comparison" &&
      terminal.requested.model === model &&
      ["comparison", "comparison-fallback"].includes(terminal.effective?.provider) &&
      terminal.effective.model === model &&
      report?.source === "run" &&
      report.sessionKey === native.sessionKey &&
      report.sessionId === agent.sessionId &&
      path.resolve(report.workspaceDir ?? "") === path.resolve(workspace) &&
      history?.sessionKey === native.sessionKey &&
      history.sessionId === agent.sessionId &&
      history.hasMore !== true &&
      !history.nextOffset &&
      history.sessionInfo?.hasActiveRun !== true &&
      Array.isArray(history.messages) &&
      history.messages.length <= 500,
    "OpenClaw recovery lacks exact terminal, route, workspace or complete history evidence.",
  );
  const users = history.messages.filter((message) => message.role === "user");
  requireEvidence(users.length === 1 && text(users[0]).trim() === prompt.trim(), "Recovery prompt changed.");
  const attempts = meta.executionTrace?.attempts ?? [];
  requireEvidence(
    Array.isArray(attempts) &&
      attempts.length <= 32 &&
      attempts.every(
        (attempt) =>
          attempt &&
          typeof attempt === "object" &&
          !Array.isArray(attempt) &&
          ["comparison", "comparison-fallback"].includes(attempt.provider) &&
          attempt.model === model &&
          typeof attempt.result === "string",
      ),
    "Recovery attempt trace is unbounded or belongs to another route.",
  );
  const calls = history.messages
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === "toolCall") : [],
    );
  requireEvidence(new Set(calls.map((call) => call.id)).size === calls.length, "Recovery tool calls are duplicated.");
  const tools = calls.map((call) => {
    const matches = history.messages.filter(
      (message) => message.role === "toolResult" && message.toolCallId === call.id,
    );
    requireEvidence(
      identifier(call.id) && matches.length === 1 && matches[0].toolName === call.name,
      "Recovery tool result has no exact native call join.",
    );
    return {
      effectId: call.id,
      toolName: call.name,
      argsSha256: sha256(call.arguments),
      at: time(matches[0].timestamp),
      nativeError: matches[0].isError === true,
    };
  });
  return {
    runId: result.runId,
    turnId: result.runId,
    sessionId: agent.sessionId,
    providerId: terminal.effective.provider,
    routeReferenceSha256: sha256(terminal),
    routeSource: "native_rpc_terminal",
    attempts,
    tools,
    reconciliation: {
      status: "unavailable",
      reason: "The native terminal/history receipt does not expose a canonical reconciliation block.",
    },
  };
}

/** Stopped CLI and exact persisted user/tool segment. Billing 'custom' does not
 * distinguish two configured custom-provider aliases, so the route is unknown. */
export function readHermesRecoveryEvidence(native, context) {
  requireEvidence(
    native.process?.exitCode === 0 && native.process.cleanupUnconfirmed === false,
    "Hermes recovery requires a stopped successful process with confirmed cleanup.",
  );
  const turn = projectHermesComparisonTurn(native.transcript, context);
  const calls = turn.messages.flatMap((message) => (message.tool_calls ? parse(message.tool_calls) : []));
  requireEvidence(new Set(calls.map((call) => call.id)).size === calls.length, "Recovery tool calls are duplicated.");
  const tools = calls.map((call) => {
    const matches = turn.messages.filter((message) => message.role === "tool" && message.tool_call_id === call.id);
    requireEvidence(
      identifier(call.id) && matches.length === 1 && matches[0].tool_name === call.function?.name,
      "Hermes recovery tool result has no exact native call join.",
    );
    return {
      effectId: call.id,
      toolName: call.function.name,
      argsSha256: sha256(parse(call.function.arguments)),
      at: time(matches[0].timestamp),
      nativeEffectDisposition: matches[0].effect_disposition ?? null,
    };
  });
  return {
    ...turn,
    runId: turn.turnId,
    tools,
    providerId: null,
    attempts: [],
    routeSource: "unavailable",
    reconciliation: {
      status: "unavailable",
      reason:
        "The native session/tool transcript does not expose a canonical reconciliation block or custom-provider alias.",
    },
  };
}

export function projectNativeRecoveryOutcome(evidence, { fault, runtimeId, observedAt }) {
  const at = time(observedAt),
    records = [];
  const event = (kind, value) => ({
    kind,
    id: `${evidence.runId}:${kind}:${records.length}`,
    at,
    runId: evidence.runId,
    turnId: evidence.turnId,
    ...value,
  });
  if (
    fault &&
    fault.runtimeId === runtimeId &&
    fault.boundary === "before_upstream_forward" &&
    fault.upstreamForwarded === false &&
    fault.usefulOutputBytes === 0 &&
    fault.controlled === true &&
    evidence.attempts.some(
      (attempt) => attempt.provider === "comparison" && ["error", "failed", "failure"].includes(attempt.result),
    )
  ) {
    records.push(
      event("provider_attempt", {
        providerId: "comparison",
        outcome: "controlled_pre_forward_failure",
        controlled: true,
        nativeTransportReachedFixture: true,
        upstreamForwarded: false,
        usefulOutputBytes: 0,
        transportReceiptId: fault.transportReceiptId,
        transportReceiptSha256: sha256(fault),
      }),
    );
  }
  if (evidence.providerId)
    records.push(event("provider_attempt", { providerId: evidence.providerId, outcome: "completed" }));
  if (evidence.providerId === "comparison-fallback")
    records.push(
      event("provider_changed", {
        fromProviderId: "comparison",
        toProviderId: evidence.providerId,
        surface: "native_rpc",
        routeReferenceSha256: evidence.routeReferenceSha256,
      }),
    );
  records.push(
    event("native_recovery_observation", {
      routeSource: evidence.routeSource,
      reconciliationStatus: evidence.reconciliation.status,
      nativeChatRouteVisibilityVerified: false,
    }),
  );
  return { records };
}
