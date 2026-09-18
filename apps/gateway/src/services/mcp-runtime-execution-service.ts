import {
  resolveMcpServerConnectionMode,
  redactSecretText,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type McpServerRecord,
  type AutonomousActivationRuntimeEvidence,
  type WardEffect,
  type McpNormalizedContentItem,
  type RealtimeEvent,
} from "@goatcitadel/contracts";
import { handleInternalMcpApprovalInboxInvoke, isInternalMcpApprovalInboxServer } from "./mcp-approval-inbox.js";
import { handleInternalMcpDurableTasksInvoke, isInternalMcpDurableTasksServer } from "./mcp-durable-tasks.js";
import type { McpRequesterScopedTurnContextHandle } from "./mcp-requester-resolution-service.js";
import type { McpRuntimeInvocationResult } from "./mcp-runtime.js";
import type { ToolInvocationCoordinatorHost } from "./tool-invocation-coordinator-service.js";

type McpRuntimeExecutionHost = Pick<
  ToolInvocationCoordinatorHost,
  | "requesterScopedMcpDispatch"
  | "staticMcpChatDispatch"
  | "approvalInbox"
  | "resolveApprovalWithRemoteTokenId"
  | "respondToMcpElicitation"
  | "listMcpElicitations"
  | "durableTasks"
  | "invokeMcpRuntimeTool"
  | "recordDevDiagnostic"
  | "applyMcpRedaction"
  | "publishRealtime"
  | "recordEvidenceEnvelope"
  | "assertMcpServerInScope"
>;
type RealtimePublishOptions = Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;

export async function executeMcpRuntime(
  host: McpRuntimeExecutionHost,
  input: McpInvokeRequest,
  server: McpServerRecord,
  runtimeStartedAt: number,
  autonomousActivation?: AutonomousActivationRuntimeEvidence,
  wardEffect?: WardEffect,
  markExternalCallStarted?: () => void | Promise<void>,
  executionFence?: () => Promise<void>,
  mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle,
  nativeCanonicalToolName?: string,
): Promise<McpInvokeResponse> {
  // Capability-scope choke point: every MCP invocation path converges here (model
  // approval-replay via invokeApprovedMcpRuntime, plus REST/durable/connector via
  // invokeMcpTool). The gate is fail-closed and applies to internal MCP surfaces too,
  // including durable tasks, because they expose operator runtime state.
  const scopeFailure = await enforceMcpServerScope(host, input);
  if (scopeFailure) {
    return scopeFailure;
  }
  let runtime: McpRuntimeInvocationResult;
  if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
    // HX-415: requester-scoped servers converge on the app-private dispatch
    // port. Direct routes and approval request DTOs cannot manufacture a
    // requester profile from `McpInvokeRequest`; without a server-built
    // dispatch provider this server is not callable, and the HX-305 execution
    // fence / external-effect marker stay untouched (a pre-dispatch failure).
    // When composed, the provider fires them once, inside the runtime, at the
    // effect-bearing `tools/call` write.
    const dispatch = host.requesterScopedMcpDispatch;
    if (!dispatch) {
      return {
        ok: false,
        error:
          "This MCP server resolves its connection per authenticated requester and cannot be invoked without a server-built requester context.",
        reasonCodes: ["requester_context_missing"],
      };
    }
    runtime = await dispatch.invoke(
      {
        server,
        toolName: input.toolName,
        arguments: input.arguments,
        signal: input.signal,
        // Server-built turn context threads ONLY from the app-private runtime
        // options (Chat/Gateway origin). `McpInvokeRequest` fields can never
        // populate it; callers without a canonical profile fail closed.
        ...(mcpRequesterTurnContext ? { mcpRequesterTurnContext } : {}),
      },
      {
        effectDispatch: async () => {
          await executionFence?.();
          await markExternalCallStarted?.();
        },
      },
    );
  } else if (nativeCanonicalToolName) {
    if (!host.staticMcpChatDispatch || nativeCanonicalToolName !== `mcp.${server.serverId}.${input.toolName}`) {
      return { ok: false, error: "Static MCP tool requires its canonical Chat execution owner." };
    }
    runtime = await host.staticMcpChatDispatch.invoke(
      { server, toolName: input.toolName, arguments: input.arguments, signal: input.signal, mcpRequesterTurnContext },
      {
        effectDispatch: async () => {
          await executionFence?.();
          await markExternalCallStarted?.();
        },
      },
    );
  } else {
    await executionFence?.();
    await markExternalCallStarted?.();
    runtime = isInternalMcpApprovalInboxServer(server)
      ? await handleInternalMcpApprovalInboxInvoke(server, input, {
          approvalInbox: host.approvalInbox,
          resolveApprovalWithRemoteTokenId: (request) => host.resolveApprovalWithRemoteTokenId(request),
          respondToMcpElicitation: (request) => host.respondToMcpElicitation(request),
          listMcpElicitations: (filter) => host.listMcpElicitations(filter),
        })
      : isInternalMcpDurableTasksServer(server)
        ? await handleInternalMcpDurableTasksInvoke(server, input, host.durableTasks)
        : await host.invokeMcpRuntimeTool(server, {
            toolName: input.toolName,
            arguments: input.arguments,
            signal: input.signal,
            ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.policyContext ? { policyContext: input.policyContext } : {}),
          });
  }
  const runtimeRetryCount = "retryCount" in runtime ? runtime.retryCount : undefined;
  const runtimeDegraded = "degraded" in runtime ? runtime.degraded : undefined;
  const runtimeExternalOutcome = "externalOutcome" in runtime ? runtime.externalOutcome : undefined;
  const runtimeManualReconciliationRequired =
    "manualReconciliationRequired" in runtime ? runtime.manualReconciliationRequired : undefined;
  if (runtimeRetryCount || runtime.output?.degradedReason) {
    host.recordDevDiagnostic?.({
      level: "warn",
      category: "mcp",
      event: "mcp.transport.degraded",
      message: "MCP tool invocation recovered after a degraded transport state",
      sessionId: input.sessionId,
      taskId: input.taskId,
      toolName: input.toolName,
      durationMs: Date.now() - runtimeStartedAt,
      runtimeKind: "mcp.transport",
      runtimeStatus: "degraded",
      context: {
        serverId: input.serverId,
        retryCount: runtimeRetryCount ?? 0,
        degradedReason: runtime.output?.degradedReason,
      },
    });
  }

  const output = runtime.output
    ? {
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments ?? {},
        ...runtime.output,
      }
    : undefined;
  // Layer the Citadel Ward "redact" effect on top of the server's own
  // redactionMode: a matched `redact` Ward scrubs known secret patterns from the
  // MCP output even when the server policy is "off". Same known-secret-pattern
  // scope caveat as the tool path (see applyRedactWardEffect); not full PII removal.
  const applyWardRedaction = wardEffect === "redact";
  const redactedOutput = output
    ? applyWardRedaction
      ? (redactSecretsDeep(host.applyMcpRedaction(output, server.policy.redactionMode)) as Record<string, unknown>)
      : host.applyMcpRedaction(output, server.policy.redactionMode)
    : undefined;
  const policyRedactedContentItems = redactMcpContentItems(
    runtime.contentItems,
    server.policy.redactionMode,
    host.applyMcpRedaction,
  );
  const redactedContentItems =
    applyWardRedaction && policyRedactedContentItems
      ? (redactSecretsDeep(policyRedactedContentItems) as McpNormalizedContentItem[])
      : policyRedactedContentItems;
  const sanitizedRuntimeError = redactMcpRuntimeError(runtime.error, server.policy.redactionMode);

  await host.publishRealtime(
    "tool_invoked",
    "mcp",
    {
      type: "mcp_tool_invoked",
      serverId: input.serverId,
      toolName: input.toolName,
      sessionId: input.sessionId,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      permissionProfileId: input.policyContext?.permissionProfileId ?? input.permissionProfileId,
      localOperatorOverrideId: input.policyContext?.localOperatorOverrideId ?? input.localOperatorOverrideId,
      trustTier: server.trustTier,
      autonomousActivation,
      externalOutcome: runtimeExternalOutcome,
      manualReconciliationRequired: runtimeManualReconciliationRequired,
    },
    buildMcpInvocationRealtimeOptions({
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
    }),
  );
  await host.recordEvidenceEnvelope?.({
    eventKind: "tool_invocation",
    sessionId: input.sessionId,
    runId: input.runId,
    toolCallHashes: [`mcp:${input.serverId}:${input.toolName}:${runtimeStartedAt}`],
    metadata: {
      runtime: "mcp",
      serverId: input.serverId,
      toolName: input.toolName,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      permissionProfileId: input.policyContext?.permissionProfileId ?? input.permissionProfileId,
      localOperatorOverrideId: input.policyContext?.localOperatorOverrideId ?? input.localOperatorOverrideId,
      trustTier: server.trustTier,
      autonomousActivation,
      ok: runtime.ok,
      error: runtime.ok ? undefined : sanitizedRuntimeError,
      externalOutcome: runtimeExternalOutcome,
      manualReconciliationRequired: runtimeManualReconciliationRequired,
    },
  });

  if (!runtime.ok) {
    return {
      ok: false,
      output: redactedOutput,
      contentItems: redactedContentItems,
      diagnostics: {
        transport: server.transport,
        degraded: runtimeDegraded,
        retryCount: runtimeRetryCount,
        sanitizedError: sanitizedRuntimeError,
        externalOutcome: runtimeExternalOutcome,
        manualReconciliationRequired: runtimeManualReconciliationRequired,
      },
      autonomousActivation,
      error: sanitizedRuntimeError ?? `MCP tool ${input.toolName} failed.`,
      externalOutcome: runtimeExternalOutcome,
      manualReconciliationRequired: runtimeManualReconciliationRequired,
    };
  }

  return {
    ok: true,
    output: redactedOutput,
    contentItems: redactedContentItems,
    diagnostics: {
      transport: server.transport,
      degraded: runtimeDegraded,
      retryCount: runtimeRetryCount,
      externalOutcome: runtimeExternalOutcome,
      manualReconciliationRequired: runtimeManualReconciliationRequired,
    },
    autonomousActivation,
    externalOutcome: runtimeExternalOutcome,
    manualReconciliationRequired: runtimeManualReconciliationRequired,
  };
}

async function enforceMcpServerScope(
  host: McpRuntimeExecutionHost,
  input: McpInvokeRequest,
): Promise<McpInvokeResponse | undefined> {
  if (!host.assertMcpServerInScope) {
    return {
      ok: false,
      error: "MCP capability scope enforcement is unavailable.",
      policyReason: "blocked: MCP capability scope gate is not wired",
      reasonCodes: ["mcp_capability_scope_unavailable"],
    };
  }
  try {
    await host.assertMcpServerInScope(input);
    return undefined;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      policyReason: error instanceof Error ? error.message : String(error),
      reasonCodes: ["mcp_capability_scope_denied"],
    };
  }
}

function buildMcpInvocationRealtimeOptions(input: {
  sessionId?: string;
  taskId?: string;
  runId?: string;
  workspaceId?: string;
}): RealtimePublishOptions {
  return {
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: {
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
    },
  };
}

function redactMcpContentItems(
  contentItems: McpNormalizedContentItem[] | undefined,
  mode: McpServerRecord["policy"]["redactionMode"],
  applyRedaction: ToolInvocationCoordinatorHost["applyMcpRedaction"],
): McpNormalizedContentItem[] | undefined {
  if (!contentItems) {
    return undefined;
  }
  const redacted = applyRedaction({ contentItems }, mode).contentItems;
  return Array.isArray(redacted) ? (redacted as McpNormalizedContentItem[]) : contentItems;
}

function redactMcpRuntimeError(
  error: string | undefined,
  mode: McpServerRecord["policy"]["redactionMode"],
): string | undefined {
  if (!error || mode === "off") {
    return error;
  }
  return redactSecretText(error).value;
}

export function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretText(value).value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(item);
    }
    return out;
  }
  return value;
}
