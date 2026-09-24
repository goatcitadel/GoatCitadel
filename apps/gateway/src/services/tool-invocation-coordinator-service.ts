import { executeMcpRuntime, redactSecretsDeep } from "./mcp-runtime-execution-service.js";
/* eslint-disable max-lines -- Tool invocation coordination keeps policy, MCP, audit, and grant evidence in one reviewable runtime seam. */
import { randomUUID } from "node:crypto";
import { posix as posixPath, win32 as winPath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { StaticMcpChatDispatchPort } from "./mcp-static-chat-service.js";
import {
  classifyToolEffectPotential,
  isToolEffectPotentialRecord,
  type ApprovalRequest,
  type AutonomousActivationGrantEvaluationInput,
  type AutonomousActivationGrantEvaluationResult,
  type AutonomousActivationRiskLevel,
  type AutonomousActivationRuntimeEvidence,
  resolveMcpServerConnectionMode,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type McpServerRecord,
  type McpToolRecord,
  type RealtimeEvent,
  type ToolInvokeRequest,
  type ToolInvokeResult,
  type ToolEffectInvocationContext,
  type ToolEffectPotentialRecord,
  type ToolEffectReceiptEnvelope,
  type ChatTurnCapabilityToolRuntimeOwnerBinding,
  type WorkspacePathBridgeReasonCode,
  type WardEffect,
} from "@goatcitadel/contracts";
import {
  ToolExecutionPreconditionError,
  type McpToolPolicyBinding,
  type MeshToolPolicyBinding,
  type ToolProcessSpawnBoundary,
} from "@goatcitadel/policy-engine";
import type { HooksService } from "./hooks-service.js";
import { parseToolCallHookPatch } from "./hook-patch-helpers.js";
import {
  type ApprovalInboxPort,
  type ListMcpElicitations,
  type RespondToMcpElicitation,
} from "./mcp-approval-inbox.js";
import { type McpDurableTasksPort } from "./mcp-durable-tasks.js";
import {
  buildMcpStaleAuthInvokeError,
  isMcpAuthReadinessInvokeBlocked,
  resolveMcpInvokeAuthReadiness,
} from "./mcp-oauth-token-service.js";
import type { McpRequesterScopedTurnContextHandle } from "./mcp-requester-resolution-service.js";
import {
  isMeshChatToolName,
  type MeshChatTurnContextHandle,
  type MeshChatToolBinding,
} from "./gateway/mesh-chat-binding.js";
import {
  dispatchMeshChatTool,
  type MeshChatDispatchPort,
  type MeshChatDispatchOptions,
} from "./gateway/mesh-chat-dispatch.js";
import type { McpRuntimeInvocationResult } from "./mcp-runtime.js";
import { toMcpInvokeRequest, toolInvokeResultFromMcpRuntime } from "./gateway/external-runtime-approval-adapter.js";
import { isNativeMcpToolName, type NativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import type {
  PluginToolExecutionContext,
  PluginToolHandler,
  PluginToolOverrideService,
} from "./plugin-tool-override-service.js";
import { runtimeLifecycleHookDispatcher } from "./runtime-lifecycle-hook-dispatcher.js";
import type { EvidenceEnvelopeCreateRequest } from "./evidence-envelope-service.js";
import { evaluateComputerUseSafety } from "../browser-runtime-guardrails.js";
import {
  buildToolRuntimeOwnerBinding,
  type ToolCallBeforeHookInterpositionBinding,
} from "./tool-runtime-interposition.js";

type ToolCallHookPatch = Record<string, unknown> & {
  toolName?: string;
  args?: Record<string, unknown>;
};

interface ToolPolicyAccessResult {
  allowed: boolean;
  requiresApproval: boolean;
  reasonCodes: string[];
}

export interface ToolExternalSideEffectBoundary {
  /** Record immediately before a concrete provider or irreversible mutation starts. */
  markStarted(): void | Promise<void>;
  /** Record that execution finished or failed without crossing that boundary. */
  markNotRequired(): void;
}

interface McpPolicyRequestShape {
  toolName: "mcp.invoke";
  args: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  agentId: string;
  sessionId: string;
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: ToolInvokeRequest["surface"];
  policyContext?: ToolInvokeRequest["policyContext"];
  consentContext?: ToolInvokeRequest["consentContext"];
}

interface McpPolicyEvaluation {
  access: ToolPolicyAccessResult;
  decision: ToolInvokeResult;
}

type RealtimePublishOptions = Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;
const APPROVAL_REASON_RE = /^approval:([A-Za-z0-9_-]+)$/;

function buildExternalRuntimePolicyFailure(
  finalPolicyCheck: ToolInvokeResult,
  runtimeLabel = "plugin override",
): ToolInvokeResult | undefined {
  if (finalPolicyCheck.outcome === "blocked" || finalPolicyCheck.outcome === "approval_required") {
    return finalPolicyCheck;
  }
  if (readDryRunRequiresApproval(finalPolicyCheck.result)) {
    return {
      outcome: "blocked",
      policyReason: `blocked: ${runtimeLabel} requires policy approval before execution (${finalPolicyCheck.policyReason})`,
      auditEventId: finalPolicyCheck.auditEventId,
      result: finalPolicyCheck.result,
      internalCall: finalPolicyCheck.internalCall,
      internalResult: finalPolicyCheck.internalResult,
      audit: finalPolicyCheck.audit,
    };
  }
  return undefined;
}

function readDryRunRequiresApproval(result: ToolInvokeResult["result"]): boolean {
  const policy = result?.policy;
  return Boolean(policy && typeof policy === "object" && "requiresApproval" in policy && policy.requiresApproval);
}

function buildPluginToolExecutionContext(
  request: ToolInvokeRequest,
  policyResult?: ToolInvokeResult,
  approvedExternalRuntimeReplayId?: string,
): PluginToolExecutionContext {
  const policyContext = mergePolicyContexts(request.policyContext, readPolicyContextFromResult(policyResult));
  return {
    request: policyContext ? { ...request, policyContext } : request,
    policyContext,
    policyResult,
    signal: request.signal,
    approvedExternalRuntimeReplayId,
  };
}

function readPolicyContextFromResult(result: ToolInvokeResult | undefined): ToolInvokeRequest["policyContext"] {
  const raw = result?.result?.policyContext;
  return isRecord(raw) ? (raw as ToolInvokeRequest["policyContext"]) : undefined;
}

function mergePolicyContexts(
  base: ToolInvokeRequest["policyContext"],
  evaluated: ToolInvokeRequest["policyContext"],
): ToolInvokeRequest["policyContext"] {
  if (!base && !evaluated) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(evaluated ?? {}),
    matchedGrantAllowedHosts:
      evaluated?.matchedGrantAllowedHosts && evaluated.matchedGrantAllowedHosts.length > 0
        ? evaluated.matchedGrantAllowedHosts
        : base?.matchedGrantAllowedHosts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export type WorkspacePathBridgeExecutionDecision =
  | { status: "not_applicable" }
  | {
      status: "verified";
      snapshotId: string;
      canonicalCwd: string;
      /** Stable fingerprint excluding phase-specific id and creation time. */
      snapshotFingerprintSha256?: string;
      gitIdentitySha256?: string;
    }
  | { status: "blocked"; reasonCode: WorkspacePathBridgeReasonCode; snapshotId?: string };

export interface WorkspacePathBridgeResolutionContext {
  invocationId: string;
  phase: "policy" | "pre_execute";
  /** Process-local cancellation authority; never derive this from tool arguments. */
  signal?: AbortSignal;
}

const WORKSPACE_PATH_BRIDGE_CWD_TOOLS = new Set([
  "shell.exec",
  "shell.exec_background",
  "tests.run",
  "lint.run",
  "build.run",
]);

export function isWorkspacePathBridgeCwdTool(toolName: string): boolean {
  return WORKSPACE_PATH_BRIDGE_CWD_TOOLS.has(toolName);
}

const WORKSPACE_PATH_BRIDGE_REASON_CODES = new Set<WorkspacePathBridgeReasonCode>([
  "invalid_path",
  "outside_jail",
  "canonicalization_failed",
  "symlink_escape",
  "round_trip_mismatch",
  "wsl_unavailable",
  "wsl_conversion_failed",
  "git_not_repository",
  "git_unavailable",
  "git_verification_failed",
  "git_identity_mismatch",
]);

function hasWorkspacePathBridgeControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function isBoundedBridgeString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    !hasWorkspacePathBridgeControlCharacter(value)
  );
}

function isCanonicalHostExecutionCwd(value: unknown): value is string {
  if (!isBoundedBridgeString(value, 2_048) || value.normalize("NFKC") !== value) return false;
  if (value.startsWith("/")) {
    return (
      !value.startsWith("//") &&
      !value.includes("\\") &&
      posixPath.normalize(value) === value &&
      value !== posixPath.parse(value).root
    );
  }
  return (
    /^[A-Za-z]:\\/u.test(value) &&
    !value.includes("/") &&
    winPath.normalize(value) === value &&
    winPath.normalize(value) !== winPath.parse(value).root
  );
}

function isWorkspacePathBridgeExecutionDecision(value: unknown): value is WorkspacePathBridgeExecutionDecision {
  if (!isRecord(value) || typeof value.status !== "string") {
    return false;
  }
  const keys = Object.keys(value).sort();
  if (value.status === "not_applicable") {
    return keys.length === 1 && keys[0] === "status";
  }
  if (value.status === "blocked") {
    const hasSnapshotId = Object.prototype.hasOwnProperty.call(value, "snapshotId");
    return (
      keys.length === (hasSnapshotId ? 3 : 2) &&
      keys[0] === "reasonCode" &&
      keys[1] === (hasSnapshotId ? "snapshotId" : "status") &&
      (!hasSnapshotId || (keys[2] === "status" && isBoundedBridgeString(value.snapshotId, 256))) &&
      typeof value.reasonCode === "string" &&
      WORKSPACE_PATH_BRIDGE_REASON_CODES.has(value.reasonCode as WorkspacePathBridgeReasonCode)
    );
  }
  if (value.status !== "verified") return false;
  const allowedKeys = new Set([
    "canonicalCwd",
    "gitIdentitySha256",
    "snapshotFingerprintSha256",
    "snapshotId",
    "status",
  ]);
  if (!keys.every((key) => allowedKeys.has(key)) || keys.length < 3 || keys.length > 5) return false;
  if (
    !isBoundedBridgeString(value.snapshotId, 256) ||
    !isCanonicalHostExecutionCwd(value.canonicalCwd) ||
    (value.snapshotFingerprintSha256 !== undefined &&
      (typeof value.snapshotFingerprintSha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(value.snapshotFingerprintSha256))) ||
    (value.gitIdentitySha256 !== undefined &&
      (typeof value.gitIdentitySha256 !== "string" ||
        value.snapshotFingerprintSha256 === undefined ||
        !/^[a-f0-9]{64}$/u.test(value.gitIdentitySha256)))
  ) {
    return false;
  }
  return true;
}

function buildWorkspacePathBridgeBlockedResult(
  reasonCode?: WorkspacePathBridgeReasonCode,
  snapshotId?: string,
): ToolInvokeResult {
  return {
    outcome: "blocked",
    policyReason: "blocked: workspace path was not freshly verified for execution",
    auditEventId: randomUUID(),
    result: {
      workspacePathBridge: {
        status: "blocked",
        ...(reasonCode ? { reasonCode } : {}),
        ...(snapshotId ? { snapshotId } : {}),
      },
    },
  };
}

function buildPluginRuntimeOwnerDriftResult(): ToolInvokeResult {
  return {
    outcome: "blocked",
    policyReason: "blocked: immutable Chat tool runtime owner binding drifted",
    auditEventId: randomUUID(),
  };
}

function buildApprovedExternalRuntimeCancelledResult(): ToolInvokeResult {
  return {
    outcome: "blocked",
    policyReason: "blocked: approved external runtime invocation was cancelled before execution",
    auditEventId: randomUUID(),
  };
}

function buildToolInvocationCancelledResult(): ToolInvokeResult {
  return {
    outcome: "blocked",
    policyReason: "blocked: tool invocation was cancelled before execution",
    auditEventId: randomUUID(),
  };
}

type WorkspacePathBridgeApplication =
  | {
      ok: true;
      request: ToolInvokeRequest;
      snapshotId?: string;
      snapshotFingerprintSha256?: string;
      gitIdentitySha256?: string;
    }
  | { ok: false; result: ToolInvokeResult };

async function applyFreshWorkspacePathBridge(
  host: ToolInvocationCoordinatorHost,
  request: ToolInvokeRequest,
  context: WorkspacePathBridgeResolutionContext,
): Promise<WorkspacePathBridgeApplication> {
  if (!isWorkspacePathBridgeCwdTool(request.toolName)) {
    return { ok: true, request };
  }
  if (!host.resolveWorkspacePathBridgeBeforeExecution) {
    return { ok: false, result: buildWorkspacePathBridgeBlockedResult() };
  }

  let decision: WorkspacePathBridgeExecutionDecision;
  try {
    decision = await host.resolveWorkspacePathBridgeBeforeExecution({ ...request, args: { ...request.args } }, context);
  } catch {
    return { ok: false, result: buildWorkspacePathBridgeBlockedResult() };
  }
  if (!isWorkspacePathBridgeExecutionDecision(decision) || decision.status === "not_applicable") {
    return { ok: false, result: buildWorkspacePathBridgeBlockedResult() };
  }
  if (decision.status === "blocked") {
    return {
      ok: false,
      result: buildWorkspacePathBridgeBlockedResult(decision.reasonCode, decision.snapshotId),
    };
  }
  if (typeof request.args.cwd !== "string") {
    return { ok: false, result: buildWorkspacePathBridgeBlockedResult() };
  }
  return {
    ok: true,
    request: {
      ...request,
      args: {
        ...request.args,
        cwd: decision.canonicalCwd,
      },
    },
    snapshotId: decision.snapshotId,
    snapshotFingerprintSha256: decision.snapshotFingerprintSha256,
    gitIdentitySha256: decision.gitIdentitySha256,
  };
}

function createDeepWorkspacePathBridgePrecondition(input: {
  host: ToolInvocationCoordinatorHost;
  request: ToolInvokeRequest;
  initial: Extract<WorkspacePathBridgeApplication, { ok: true }>;
  invocationId: string;
  snapshotIds: string[];
  signal?: AbortSignal;
  executionFence?: () => Promise<void>;
}): (boundary?: ToolProcessSpawnBoundary) => Promise<void> {
  return async (boundary) => {
    if (input.signal?.aborted) {
      throw executionPreconditionFromResult(buildToolInvocationCancelledResult());
    }
    const fresh = await applyFreshWorkspacePathBridge(input.host, input.request, {
      invocationId: input.invocationId,
      phase: "pre_execute",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!fresh.ok) {
      throw executionPreconditionFromResult(
        input.signal?.aborted ? buildToolInvocationCancelledResult() : fresh.result,
      );
    }
    if (fresh.snapshotId) input.snapshotIds.push(fresh.snapshotId);

    if (
      !boundary ||
      boundary.toolName !== input.request.toolName ||
      typeof boundary.cwd !== "string" ||
      typeof input.request.args.cwd !== "string" ||
      !sameCanonicalExecutionCwd(boundary.cwd, input.request.args.cwd)
    ) {
      throw executionPreconditionFromResult(
        buildWorkspacePathBridgeBlockedResult("round_trip_mismatch", fresh.snapshotId),
      );
    }
    const driftReason = compareWorkspacePathBridgeApplications(input.initial, fresh, {
      requireSnapshotFingerprint: true,
    });
    if (driftReason) {
      throw executionPreconditionFromResult(buildWorkspacePathBridgeBlockedResult(driftReason, fresh.snapshotId));
    }
    if (input.signal?.aborted) {
      throw executionPreconditionFromResult(buildToolInvocationCancelledResult());
    }
    await input.executionFence?.();
    if (input.signal?.aborted) {
      throw executionPreconditionFromResult(buildToolInvocationCancelledResult());
    }
  };
}

function compareWorkspacePathBridgeApplications(
  initial: Extract<WorkspacePathBridgeApplication, { ok: true }>,
  fresh: Extract<WorkspacePathBridgeApplication, { ok: true }>,
  options: { requireSnapshotFingerprint?: boolean } = {},
): WorkspacePathBridgeReasonCode | undefined {
  const initialCwd = initial.request.args.cwd;
  const freshCwd = fresh.request.args.cwd;
  if (
    typeof initialCwd !== "string" ||
    typeof freshCwd !== "string" ||
    !sameCanonicalExecutionCwd(initialCwd, freshCwd)
  ) {
    return "round_trip_mismatch";
  }
  if (initial.gitIdentitySha256 !== fresh.gitIdentitySha256) {
    return "git_identity_mismatch";
  }
  const fingerprintRequired =
    options.requireSnapshotFingerprint === true ||
    initial.snapshotFingerprintSha256 !== undefined ||
    fresh.snapshotFingerprintSha256 !== undefined;
  if (
    fingerprintRequired &&
    (!initial.snapshotFingerprintSha256 ||
      !fresh.snapshotFingerprintSha256 ||
      initial.snapshotFingerprintSha256 !== fresh.snapshotFingerprintSha256)
  ) {
    return "canonicalization_failed";
  }
  return undefined;
}

function executionPreconditionFromResult(
  result: ToolInvokeResult,
  snapshotIds: readonly string[] = [],
): ToolExecutionPreconditionError {
  const evidenced = withWorkspacePathBridgeEvidence(result, snapshotIds);
  return new ToolExecutionPreconditionError(evidenced.policyReason.replace(/^blocked:\s*/u, ""), evidenced.result);
}

function sameCanonicalExecutionCwd(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.startsWith("/") || right.startsWith("/")) {
    return left.startsWith("/") && right.startsWith("/") && posixPath.normalize(left) === posixPath.normalize(right);
  }
  return winPath.normalize(left).toLocaleLowerCase("en-US") === winPath.normalize(right).toLocaleLowerCase("en-US");
}

function withWorkspacePathBridgeEvidence(result: ToolInvokeResult, snapshotIds: readonly string[]): ToolInvokeResult {
  if (snapshotIds.length === 0) {
    return result;
  }
  const uniqueSnapshotIds = [...new Set(snapshotIds)];
  const currentEvidence = result.result?.workspacePathBridge;
  if (isRecord(currentEvidence) && currentEvidence.status === "blocked") {
    return {
      ...result,
      result: {
        ...(result.result ?? {}),
        workspacePathBridge: {
          ...currentEvidence,
          priorVerifiedSnapshotIds: uniqueSnapshotIds,
        },
      },
    };
  }
  // Successful tool output is a public payload and must remain byte-identical.
  // Verified snapshot IDs are linked through realtime, diagnostics, and the
  // durable evidence envelope below rather than being injected into tool data.
  return result;
}

export interface RequesterScopedMcpDispatchInput {
  server: McpServerRecord;
  toolName: string;
  arguments?: Record<string, unknown>;
  signal?: AbortSignal;
  /**
   * HX-415 app-private, server-built turn context. Present ONLY when the
   * chat-turn runner (which holds the frozen capability profile) threaded a
   * branded handle through the invocation options — never derived from
   * `McpInvokeRequest`. The dispatch provider brand-asserts it; a missing or
   * forged (plain-object) value fails closed `requester_context_missing`.
   */
  mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle;
}

/**
 * HX-415 app-private port. The provider derives requester authority from
 * server-owned request context, resolves a per-attempt ephemeral connection,
 * and drives the isolated requester-scoped runtime, firing `effectDispatch`
 * exactly once at the effect-bearing `tools/call` write. It is never given, and
 * must never trust, `McpInvokeRequest` authority/scope fields.
 */
export interface RequesterScopedMcpDispatchPort {
  invoke(
    input: RequesterScopedMcpDispatchInput,
    options: { effectDispatch: () => Promise<void> },
  ): Promise<McpRuntimeInvocationResult>;
}

export interface ToolInvocationCoordinatorHost {
  readonly approvalInbox: ApprovalInboxPort;
  readonly durableTasks: McpDurableTasksPort;
  readonly respondToMcpElicitation: RespondToMcpElicitation;
  readonly listMcpElicitations: ListMcpElicitations;
  /** Required capability-scope gate. Throws when the requested MCP server is not
   *  available in the active workspace/citadel scope. Missing wiring fails closed. */
  assertMcpServerInScope?: (request: McpInvokeRequest) => Promise<void>;
  readonly policyEngine: {
    invoke(
      request: ToolInvokeRequest,
      options?: {
        beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void>;
        externalSideEffect?: ToolExternalSideEffectBoundary;
        mcpToolBinding?: McpToolPolicyBinding;
        meshToolBinding?: MeshToolPolicyBinding;
      },
    ): Promise<ToolInvokeResult>;
    evaluateAccess(request: {
      toolName: "mcp.invoke";
      args: {
        serverId: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
      agentId: string;
      sessionId: string;
      taskId?: string;
    }): Promise<ToolPolicyAccessResult>;
  };
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  normalizeToolInvokeRequest(request: ToolInvokeRequest): Promise<ToolInvokeRequest>;
  /** Re-read canonical Chat consent immediately before hooks and dispatch. */
  assertChatToolDispatchAllowed?(request: ToolInvokeRequest): Promise<void>;
  resolveNativeMcpChatToolBinding?(
    request: ToolInvokeRequest,
    handle: McpRequesterScopedTurnContextHandle | undefined,
  ): Promise<NativeMcpChatToolBinding | undefined>;
  resolveMeshChatToolBinding?: MeshChatDispatchPort["resolveBinding"];
  dispatchMeshCapabilityInvocation?: MeshChatDispatchPort["dispatch"];
  isValidToolName(name: string): boolean;
  evaluateToolDeploymentGuard(request: ToolInvokeRequest): { reason: string } | null | undefined;
  isFeatureEnabled?(flag: "computerUseGuardrailsV1Enabled"): Promise<boolean>;
  resolveToolHookWorkspaceId(request: ToolInvokeRequest): Promise<string>;
  /**
   * Re-resolves any process working directory against current filesystem and
   * Git evidence. Historical snapshot inspection is never execution authority.
   */
  resolveWorkspacePathBridgeBeforeExecution?(
    request: ToolInvokeRequest,
    context: WorkspacePathBridgeResolutionContext,
  ): Promise<WorkspacePathBridgeExecutionDecision>;
  resolveToolCallBeforeHookInterposition?(workspaceId: string): Promise<ToolCallBeforeHookInterpositionBinding>;
  primeToolApprovalLifecycle(approvalId: string, request: ToolInvokeRequest): Promise<ApprovalRequest>;
  scheduleApprovalExplanationById(approvalId: string): Promise<void>;
  evaluateAutonomousActivationGrant?(
    input: AutonomousActivationGrantEvaluationInput,
  ): Promise<AutonomousActivationGrantEvaluationResult>;
  recordAutonomousActivationGrantUse?(grantId: string, estimatedCostUsd?: number): Promise<unknown>;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: RealtimePublishOptions,
  ): Promise<unknown>;
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  listMcpTools(serverId: string): Promise<McpToolRecord[]>;
  matchesWildcard(value: string, pattern: string): boolean;
  isMcpToolApproved(serverId: string, toolName: string): Promise<boolean>;
  invokeMcpRuntimeTool(
    server: McpServerRecord,
    input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal" | "workspaceId" | "sessionId" | "policyContext">,
  ): Promise<McpRuntimeInvocationResult>;
  /**
   * HX-415 app-private requester-scoped MCP dispatch. Undefined until a
   * separately reviewed auth/profile integration composes server-built
   * requester authority + attempt lease. It receives ONLY the tool
   * name/arguments/signal plus the effect-dispatch callback and derives
   * authority from server-owned request context — never from `McpInvokeRequest`.
   */
  readonly requesterScopedMcpDispatch?: RequesterScopedMcpDispatchPort;
  readonly staticMcpChatDispatch?: StaticMcpChatDispatchPort;
  resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    connectorId: string;
    decision: "approve" | "reject" | "edit";
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<{ approval: ApprovalRequest }>;
  applyMcpRedaction(
    output: Record<string, unknown>,
    mode: McpServerRecord["policy"]["redactionMode"],
  ): Record<string, unknown>;
  recordEvidenceEnvelope?(input: EvidenceEnvelopeCreateRequest): Promise<unknown>;
  recordDevDiagnostic?(input: {
    level: "debug" | "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    taskId?: string;
    toolRunId?: string;
    toolName?: string;
    durationMs?: number;
    runtimeKind?: string;
    runtimeStatus?: "started" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "degraded";
    runtimeError?: {
      name?: string;
      message: string;
      code?: string;
      retryable?: boolean;
    };
    context?: Record<string, unknown>;
  }): void;
  readonly pluginToolOverrideService?: Pick<PluginToolOverrideService, "resolveActiveHandler"> &
    Partial<Pick<PluginToolOverrideService, "resolveRuntimeOwnerBinding">>;
}

export interface ToolInvocationRuntimeOptions {
  /** Private profile identity for mesh authority; never accepted from a tool request body. */
  meshTurnContext?: MeshChatTurnContextHandle;
  /** Process-local cancellation signal for fresh workspace-path verification. */
  workspacePathBridgeSignal?: AbortSignal;
  /**
   * HX-415 app-private branded turn context for requester-scoped MCP dispatch.
   * Originated only by Chat/Gateway composition from a frozen capability-profile
   * record. Direct routes and callers without that canonical context continue
   * to fail closed (`requester_context_missing`) one level deeper.
   * Never serialized; brand-checked at the dispatch provider.
   */
  mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle;
  /** Process-local durable fence immediately before the main tool executor. */
  executionFence?: () => Promise<void>;
  /** Canonical owner's execution receipt, after policy and deepest spawn fences. */
  beforeBuiltinExecute?: () => Promise<void>;
  /**
   * Process-local durable fence immediately before an auxiliary hook effect.
   * This is deliberately distinct from the main executor boundary so an
   * approval decision reached after a webhook remains actionable.
   */
  auxiliaryEffectFence?: () => Promise<void>;
  /** Process-local concrete external-side-effect boundary; never serialize this object. */
  externalSideEffect?: ToolExternalSideEffectBoundary;
  /**
   * Process-local Chat correlation reserved for a canonical execution owner.
   * The coordinator does not infer receipts from result payloads and currently
   * has no owner that can prove the exact Chat toolRun/idempotency linkage.
   */
  effectContext?: ToolEffectInvocationContext;
  /** Frozen planning-time classification for the original Chat tool owner. */
  effectPotential?: ToolEffectPotentialRecord;
  /** Exact hook set admitted by the immutable Chat capability profile. */
  toolCallBeforeHookInterposition?: ToolCallBeforeHookInterpositionBinding;
  /** Exact tool runtime owner admitted by the immutable Chat profile. */
  toolRuntimeOwner?: ChatTurnCapabilityToolRuntimeOwnerBinding;
  /**
   * Called before the execution fence when an allowed runtime-owner override
   * invalidates a frozen `none` classification.
   */
  onEffectPotentialEscalated?: (potential: ToolEffectPotentialRecord) => Promise<void>;
  /**
   * Reserved owner-to-caller receipt channel. Until a canonical owner invokes
   * this after committing a matching receipt, concrete Chat settlement remains
   * intentionally unreachable in production.
   */
  onEffectReceipt?: (receipt: ToolEffectReceiptEnvelope) => void;
}

export interface ToolInvocationCoordinator {
  invokeTool(request: ToolInvokeRequest, options?: ToolInvocationRuntimeOptions): Promise<ToolInvokeResult>;
  invokeMcpTool(input: McpInvokeRequest, options?: ToolInvocationRuntimeOptions): Promise<McpInvokeResponse>;
  invokeApprovedExternalRuntimeTool(
    request: ToolInvokeRequest,
    markExternalCallStarted?: () => void | Promise<void>,
    options?: ApprovedExternalRuntimeInvocationOptions,
  ): Promise<ToolInvokeResult>;
  invokeApprovedMcpRuntime(
    input: McpInvokeRequest,
    markExternalCallStarted?: () => void | Promise<void>,
  ): Promise<McpInvokeResponse>;
}

export interface ApprovedExternalRuntimeInvocationOptions {
  /** Process-local approval-worker cancellation authority; never deserialize from model input. */
  signal?: AbortSignal;
  runtimeOwner?: ChatTurnCapabilityToolRuntimeOwnerBinding;
}

export class ToolInvocationCoordinatorService implements ToolInvocationCoordinator {
  public constructor(private readonly host: ToolInvocationCoordinatorHost) {}

  /** The Chat tool-closure fence, rechecked at every dispatch boundary; absent outside Chat. */
  private async assertChatToolDispatchAllowed(request: ToolInvokeRequest): Promise<void> {
    await this.host.assertChatToolDispatchAllowed?.(request);
  }

  /**
   * Rebuilds the deepest-spawn precondition for the canonical approval worker,
   * whose policy replay bypasses invokeTool but must not bypass cwd/Git checks.
   */
  public async prepareApprovedBuiltinBeforeExecute(
    request: ToolInvokeRequest,
    options: { invocationId: string; signal?: AbortSignal; runtimeOwner?: ChatTurnCapabilityToolRuntimeOwnerBinding },
  ): Promise<((boundary?: ToolProcessSpawnBoundary) => Promise<void>) | undefined> {
    await this.assertChatToolDispatchAllowed(request);
    const checkOwner = () => {
      if (!options.runtimeOwner) return;
      const owner = this.resolveCurrentToolRuntimeOwnerBinding(request.toolName);
      if (owner?.kind !== options.runtimeOwner.kind || owner.bindingHash !== options.runtimeOwner.bindingHash)
        throw new ToolExecutionPreconditionError("Approved tool runtime owner changed from its admitted binding.");
    };
    checkOwner();
    if (!isWorkspacePathBridgeCwdTool(request.toolName)) {
      return async () => {
        await this.assertChatToolDispatchAllowed(request);
        checkOwner();
      };
    }
    const initial = await applyFreshWorkspacePathBridge(this.host, request, {
      invocationId: options.invocationId,
      phase: "policy",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!initial.ok) {
      return async () => {
        throw executionPreconditionFromResult(initial.result);
      };
    }
    const snapshotIds = initial.snapshotId ? [initial.snapshotId] : [];
    const bridge = createDeepWorkspacePathBridgePrecondition({
      host: this.host,
      request: initial.request,
      initial,
      invocationId: options.invocationId,
      snapshotIds,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return async (boundary) => {
      await this.assertChatToolDispatchAllowed(request);
      checkOwner();
      await bridge(boundary);
      checkOwner();
    };
  }

  private resolveCurrentToolRuntimeOwnerBinding(
    toolName: string,
  ): ChatTurnCapabilityToolRuntimeOwnerBinding | undefined {
    const service = this.host.pluginToolOverrideService;
    if (!service) return buildToolRuntimeOwnerBinding("builtin");
    const binding = service.resolveRuntimeOwnerBinding?.(toolName);
    if (binding) return binding;
    // A legacy override host cannot prove a stable handler generation. Treat
    // an active handler as unbound; no-handler falls through to the builtin.
    return service.resolveActiveHandler(toolName) ? undefined : buildToolRuntimeOwnerBinding("builtin");
  }

  private admitPluginRuntimeOwner(
    toolName: string,
    handler: PluginToolHandler,
  ): ChatTurnCapabilityToolRuntimeOwnerBinding | undefined {
    const currentHandler = this.host.pluginToolOverrideService?.resolveActiveHandler(toolName);
    const currentOwner = this.resolveCurrentToolRuntimeOwnerBinding(toolName);
    return currentHandler === handler && currentOwner?.kind === "plugin" ? currentOwner : undefined;
  }

  private isPluginRuntimeOwnerAdmissionCurrent(
    toolName: string,
    handler: PluginToolHandler,
    admittedOwner: ChatTurnCapabilityToolRuntimeOwnerBinding,
  ): boolean {
    const currentHandler = this.host.pluginToolOverrideService?.resolveActiveHandler(toolName);
    const currentOwner = this.resolveCurrentToolRuntimeOwnerBinding(toolName);
    return (
      currentHandler === handler &&
      currentOwner?.kind === "plugin" &&
      admittedOwner.kind === "plugin" &&
      currentOwner.bindingHash === admittedOwner.bindingHash
    );
  }

  private async runPostCommitConsumer(
    consumer: string,
    request: ToolInvokeRequest,
    callback: () => void | Promise<void>,
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      try {
        this.host.recordDevDiagnostic?.({
          level: "warn",
          category: "tools",
          event: "tool.invocation.post_commit_consumer_failed",
          message: `Tool invocation completed, but ${consumer} failed.`,
          sessionId: request.sessionId,
          taskId: request.taskId,
          toolName: request.toolName,
          runtimeKind: "tool.invocation.post_commit",
          runtimeStatus: "degraded",
          runtimeError: {
            name: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
          context: { consumer, runId: request.runId ?? request.policyContext?.runId },
        });
      } catch {
        // A completed external mutation must never be replayed because reporting failed.
        return;
      }
    }
  }

  private buildMcpPolicyRequest(input: McpInvokeRequest): McpPolicyRequestShape {
    return {
      toolName: "mcp.invoke",
      args: {
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      agentId: input.agentId?.trim() || "operator",
      sessionId: input.sessionId?.trim() || `mcp:${input.serverId}`,
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      surface: input.surface ?? "mcp",
      policyContext: input.policyContext,
      consentContext: input.consentContext,
    };
  }

  private async evaluateMcpPolicy(
    input: McpInvokeRequest,
    options?: { externalRuntime?: boolean },
  ): Promise<McpPolicyEvaluation> {
    // Use the same server-owned workspace, Citadel and permission resolution
    // as Chat tool calls before evaluating either MCP policy identity.
    const wrapper = this.buildMcpPolicyRequest(input);
    const request = {
      ...(await this.host.normalizeToolInvokeRequest(wrapper)),
      // Policy must inspect the exact target/arguments the MCP owner will send.
      toolName: wrapper.toolName,
      args: wrapper.args,
    };
    return {
      access: await this.host.policyEngine.evaluateAccess(request),
      decision: await this.host.policyEngine.invoke({
        ...request,
        dryRun: options?.externalRuntime === true ? undefined : true,
        externalRuntime: options?.externalRuntime === true ? true : undefined,
        consentContext: {
          ...(request.consentContext ?? {}),
          source: "agent",
          reason: `MCP tool invoke ${input.serverId}/${input.toolName}`,
        },
      }),
    };
  }

  private buildMcpPolicyFailure(
    evaluation: McpPolicyEvaluation,
    autonomousActivation?: AutonomousActivationRuntimeEvidence,
  ): {
    ok: false;
    error: string;
    approvalRequired?: boolean;
    approvalId?: string;
    policyReason?: string;
    reasonCodes?: string[];
    autonomousActivation?: AutonomousActivationRuntimeEvidence;
  } | null {
    if (evaluation.decision.outcome === "approval_required") {
      return {
        ok: false,
        error: "MCP invoke requires approval.",
        approvalRequired: true,
        approvalId: evaluation.decision.approvalId,
        policyReason: evaluation.decision.policyReason,
        reasonCodes: evaluation.access.reasonCodes,
        autonomousActivation,
      };
    }
    if (evaluation.decision.outcome === "blocked") {
      return {
        ok: false,
        error: evaluation.decision.policyReason,
        policyReason: evaluation.decision.policyReason,
        reasonCodes: evaluation.access.reasonCodes,
        autonomousActivation,
      };
    }
    return null;
  }

  public async invokeTool(
    request: ToolInvokeRequest,
    options: ToolInvocationRuntimeOptions = {},
  ): Promise<ToolInvokeResult> {
    if (!this.host.isValidToolName(request.toolName) && !isMeshChatToolName(request.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid tool name format",
        auditEventId: randomUUID(),
      };
    }
    if (options.effectPotential !== undefined && !isToolEffectPotentialRecord(options.effectPotential)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: malformed frozen tool-effect classification",
        auditEventId: randomUUID(),
      };
    }

    const normalizedRequest = await this.host.normalizeToolInvokeRequest(request);
    await this.assertChatToolDispatchAllowed(normalizedRequest);
    const previousExecutionFence = options.executionFence;
    const previousAuxiliaryFence = options.auxiliaryEffectFence ?? previousExecutionFence;
    options = {
      ...options,
      executionFence: async () => {
        await this.assertChatToolDispatchAllowed(normalizedRequest);
        await previousExecutionFence?.();
      },
      auxiliaryEffectFence: async () => {
        await this.assertChatToolDispatchAllowed(normalizedRequest);
        await previousAuxiliaryFence?.();
      },
    };
    if (isMeshChatToolName(normalizedRequest.toolName)) {
      try {
        await this.resolveMeshBinding(normalizedRequest, options);
      } catch {
        return {
          outcome: "blocked",
          policyReason: "blocked: mesh tool requires its exact frozen Chat capability binding",
          auditEventId: randomUUID(),
        };
      }
    }
    if (isNativeMcpToolName(normalizedRequest.toolName)) {
      try {
        await this.resolveNativeMcpBinding(normalizedRequest, options);
      } catch {
        return {
          outcome: "blocked",
          policyReason: "blocked: native MCP tool requires its exact frozen Chat capability binding",
          auditEventId: randomUUID(),
        };
      }
    }
    if (containsRawApprovalActionBearer(normalizedRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter tool hooks or policy",
        auditEventId: randomUUID(),
      };
    }
    const isCodeModeWrapperInvocation = Boolean(normalizedRequest.policyContext?.approvedCodeModeRunId);
    const toolHookWorkspaceId = await this.host.resolveToolHookWorkspaceId(normalizedRequest);
    const toolHookEntityId = `${normalizedRequest.sessionId}:${randomUUID()}`;
    let admittedToolCallBeforeHookInterposition: ToolCallBeforeHookInterpositionBinding | undefined;
    if (options.effectPotential) {
      const currentInterposition = await this.host.resolveToolCallBeforeHookInterposition?.(toolHookWorkspaceId);
      const expected = options.toolCallBeforeHookInterposition;
      const expectedValid =
        expected === undefined ||
        (/^[a-f0-9]{64}$/u.test(expected.hash) && Number.isInteger(expected.count) && expected.count >= 0);
      const exactBinding =
        expected !== undefined &&
        currentInterposition !== undefined &&
        currentInterposition.hash === expected.hash &&
        currentInterposition.count === expected.count;
      const acceptedLegacyEmptyBinding = expected === undefined && currentInterposition?.count === 0;
      if (!expectedValid || (!exactBinding && !acceptedLegacyEmptyBinding)) {
        return {
          outcome: "blocked",
          policyReason: "blocked: immutable Chat tool-hook interposition binding drifted",
          auditEventId: randomUUID(),
        };
      }
      admittedToolCallBeforeHookInterposition = currentInterposition;

      const currentOwner = this.resolveCurrentToolRuntimeOwnerBinding(normalizedRequest.toolName);
      const expectedOwner = options.toolRuntimeOwner;
      const expectedOwnerValid =
        expectedOwner === undefined ||
        ((expectedOwner.kind === "builtin" || expectedOwner.kind === "plugin") &&
          /^[a-f0-9]{64}$/u.test(expectedOwner.bindingHash));
      const exactOwner =
        expectedOwner !== undefined &&
        currentOwner !== undefined &&
        expectedOwner.kind === currentOwner.kind &&
        expectedOwner.bindingHash === currentOwner.bindingHash;
      const acceptedLegacyBuiltinOwner = expectedOwner === undefined && currentOwner?.kind === "builtin";
      if (!expectedOwnerValid || (!exactOwner && !acceptedLegacyBuiltinOwner)) {
        return {
          outcome: "blocked",
          policyReason: "blocked: immutable Chat tool runtime owner binding drifted",
          auditEventId: randomUUID(),
        };
      }
    }
    const deploymentGuard = this.host.evaluateToolDeploymentGuard(normalizedRequest);
    if (deploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${deploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }

    const beforeHook = isCodeModeWrapperInvocation
      ? { runs: [] }
      : await this.host.hooksService.runInlineHooks<ToolCallHookPatch>({
          workspaceId: toolHookWorkspaceId,
          trigger: "tool.call.before",
          entityType: "tool_call",
          entityId: toolHookEntityId,
          payload: {
            toolName: normalizedRequest.toolName,
            args: normalizedRequest.args,
            agentId: normalizedRequest.agentId,
            sessionId: normalizedRequest.sessionId,
            taskId: normalizedRequest.taskId,
          },
          parsePatch: (value) => parseToolCallHookPatch(value as Record<string, unknown>),
          mergePatch: (current, next) => ({
            ...(current ?? {}),
            ...next,
          }),
          expectedInterposition: admittedToolCallBeforeHookInterposition,
          beforeExternalDispatch: async () => {
            if (options.effectPotential?.potential === "none") {
              if (!options.onEffectPotentialEscalated) {
                throw new Error("Inline hook dispatch cannot retain an unchangeable no-effect classification.");
              }
              await options.onEffectPotentialEscalated(
                classifyToolEffectPotential({
                  toolName: normalizedRequest.toolName,
                  trustedBuiltin: false,
                  sourceKind: "remote",
                }),
              );
            }
            await (options.auxiliaryEffectFence ?? options.executionFence)?.();
          },
        });
    if (beforeHook.blockedBy) {
      return {
        outcome: "blocked",
        policyReason: `hook blocked: ${beforeHook.blockedBy.reason}`,
        auditEventId: randomUUID(),
      };
    }

    const hookableRequest = beforeHook.patch
      ? {
          ...normalizedRequest,
          ...(beforeHook.patch.toolName ? { toolName: beforeHook.patch.toolName } : {}),
          ...(beforeHook.patch.args ? { args: beforeHook.patch.args } : {}),
        }
      : normalizedRequest;

    if (
      beforeHook.patch &&
      hasApprovalActionTemplate(normalizedRequest) &&
      !isProtectedApprovalActionBindingUnchanged(normalizedRequest, hookableRequest)
    ) {
      return {
        outcome: "blocked",
        policyReason: "blocked: protected approval action binding cannot be rewritten by tool hooks",
        auditEventId: randomUUID(),
      };
    }
    if (containsRawApprovalActionBearer(hookableRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter tool policy",
        auditEventId: randomUUID(),
      };
    }

    if (options.effectPotential && options.toolRuntimeOwner) {
      const currentOwner = this.resolveCurrentToolRuntimeOwnerBinding(hookableRequest.toolName);
      if (
        !currentOwner ||
        currentOwner.kind !== options.toolRuntimeOwner.kind ||
        currentOwner.bindingHash !== options.toolRuntimeOwner.bindingHash
      ) {
        return {
          outcome: "blocked",
          policyReason: "blocked: immutable Chat tool runtime owner binding drifted",
          auditEventId: randomUUID(),
        };
      }
    }

    if (
      (options.effectPotential ||
        isNativeMcpToolName(normalizedRequest.toolName) ||
        isMeshChatToolName(normalizedRequest.toolName)) &&
      hookableRequest.toolName !== normalizedRequest.toolName
    ) {
      return {
        outcome: "blocked",
        policyReason: "blocked: tool hook cannot rewrite an immutable Chat capability binding",
        auditEventId: randomUUID(),
      };
    }

    if (
      isCodeModeWrapperInvocation &&
      (hookableRequest.toolName !== normalizedRequest.toolName || hookableRequest.args !== normalizedRequest.args)
    ) {
      return {
        outcome: "blocked",
        policyReason: "blocked: Code Mode wrapper invocation cannot be rewritten by tool hooks",
        auditEventId: randomUUID(),
      };
    }

    if (!this.host.isValidToolName(hookableRequest.toolName) && !isMeshChatToolName(hookableRequest.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid post-hook tool name format",
        auditEventId: randomUUID(),
      };
    }

    const finalDeploymentGuard = beforeHook.patch ? this.host.evaluateToolDeploymentGuard(hookableRequest) : undefined;
    if (finalDeploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${finalDeploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }
    if (await this.host.isFeatureEnabled?.("computerUseGuardrailsV1Enabled")) {
      const safety = evaluateComputerUseSafety(hookableRequest.toolName, hookableRequest.args ?? {});
      if (safety.requiresVerification && !safety.verified) {
        return {
          outcome: "blocked",
          policyReason:
            "blocked: Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true).",
          auditEventId: randomUUID(),
          result: { computerUseGuardrail: safety },
        };
      }
      if (safety.requiresConfirmation && !safety.confirmed) {
        return {
          outcome: "blocked",
          policyReason:
            "blocked: Computer-use guardrail: confirm-before-submit required (set args.confirmBeforeSubmit=true).",
          auditEventId: randomUUID(),
          result: { computerUseGuardrail: safety },
        };
      }
    }

    const protectedApprovalActionDelivery = hasApprovalActionTemplate(hookableRequest);
    const overrideHandler =
      isCodeModeWrapperInvocation || protectedApprovalActionDelivery
        ? undefined
        : this.host.pluginToolOverrideService?.resolveActiveHandler(hookableRequest.toolName);
    const admittedOverrideRuntimeOwner = overrideHandler
      ? this.admitPluginRuntimeOwner(hookableRequest.toolName, overrideHandler)
      : undefined;
    if (
      overrideHandler &&
      (isNativeMcpToolName(hookableRequest.toolName) || isMeshChatToolName(hookableRequest.toolName))
    ) {
      return buildPluginRuntimeOwnerDriftResult();
    }
    if (overrideHandler && !admittedOverrideRuntimeOwner) {
      return buildPluginRuntimeOwnerDriftResult();
    }
    if (
      overrideHandler &&
      options.effectPotential &&
      (!options.toolRuntimeOwner ||
        options.toolRuntimeOwner.kind !== "plugin" ||
        options.toolRuntimeOwner.bindingHash !== admittedOverrideRuntimeOwner?.bindingHash)
    ) {
      return buildPluginRuntimeOwnerDriftResult();
    }
    if (overrideHandler && options.effectPotential?.potential === "none" && !options.onEffectPotentialEscalated) {
      return {
        outcome: "blocked",
        policyReason: "blocked: plugin override cannot execute under an unchangeable no-effect classification",
        auditEventId: randomUUID(),
      };
    }
    const bridgeApplication = await applyFreshWorkspacePathBridge(this.host, hookableRequest, {
      invocationId: toolHookEntityId,
      phase: "policy",
      ...(options.workspacePathBridgeSignal ? { signal: options.workspacePathBridgeSignal } : {}),
    });
    if (!bridgeApplication.ok) {
      return bridgeApplication.result;
    }
    let executionRequest = bridgeApplication.request;
    const workspacePathBridgeSnapshotIds = bridgeApplication.snapshotId ? [bridgeApplication.snapshotId] : [];
    let approvedExternalRuntimeReplayId: string | undefined;
    let finalPolicyCheck: ToolInvokeResult | undefined;
    if (overrideHandler) {
      finalPolicyCheck = await this.host.policyEngine.invoke({
        ...executionRequest,
        externalRuntime: true,
      });
      const overridePolicyFailure = buildExternalRuntimePolicyFailure(finalPolicyCheck);
      if (overridePolicyFailure) {
        return overridePolicyFailure;
      }
      approvedExternalRuntimeReplayId = extractVerifiedApprovalReplayId(finalPolicyCheck, executionRequest);
      if (approvedExternalRuntimeReplayId) {
        return {
          outcome: "blocked",
          policyReason:
            "blocked: approved external-runtime actions execute only through the canonical approval-effect worker",
          auditEventId: finalPolicyCheck.auditEventId,
          result: {
            approvalId: approvedExternalRuntimeReplayId,
            executionOwner: "approval_effect",
          },
          audit: finalPolicyCheck.audit,
        };
      }
    }
    let result: ToolInvokeResult;
    const toolStartedAt = Date.now();
    this.host.recordDevDiagnostic?.({
      level: "debug",
      category: "tools",
      event: "tool.invocation.start",
      message: "Starting tool invocation",
      sessionId: hookableRequest.sessionId,
      taskId: hookableRequest.taskId,
      toolRunId: toolHookEntityId,
      toolName: hookableRequest.toolName,
      runtimeKind: overrideHandler ? "tool.invocation.override" : "tool.invocation",
      runtimeStatus: "started",
      context: {
        agentId: hookableRequest.agentId,
      },
    });
    try {
      if (overrideHandler) {
        if (!admittedOverrideRuntimeOwner) {
          return buildPluginRuntimeOwnerDriftResult();
        }
        if (options.effectPotential?.potential === "none") {
          await options.onEffectPotentialEscalated?.(
            classifyToolEffectPotential({
              toolName: hookableRequest.toolName,
              trustedBuiltin: false,
              sourceKind: "plugin",
            }),
          );
        }
        const preExecuteBridge = await applyFreshWorkspacePathBridge(this.host, executionRequest, {
          invocationId: toolHookEntityId,
          phase: "pre_execute",
          ...(options.workspacePathBridgeSignal ? { signal: options.workspacePathBridgeSignal } : {}),
        });
        const preExecuteDriftReason =
          preExecuteBridge.ok && isWorkspacePathBridgeCwdTool(executionRequest.toolName)
            ? compareWorkspacePathBridgeApplications(bridgeApplication, preExecuteBridge, {
                requireSnapshotFingerprint: true,
              })
            : undefined;
        if (!preExecuteBridge.ok) {
          result = preExecuteBridge.result;
        } else if (preExecuteDriftReason) {
          if (preExecuteBridge.snapshotId) workspacePathBridgeSnapshotIds.push(preExecuteBridge.snapshotId);
          result = buildWorkspacePathBridgeBlockedResult(preExecuteDriftReason, preExecuteBridge.snapshotId);
        } else {
          executionRequest = preExecuteBridge.request;
          if (preExecuteBridge.snapshotId) {
            workspacePathBridgeSnapshotIds.push(preExecuteBridge.snapshotId);
          }
          if (
            !this.isPluginRuntimeOwnerAdmissionCurrent(
              hookableRequest.toolName,
              overrideHandler,
              admittedOverrideRuntimeOwner,
            ) ||
            options.workspacePathBridgeSignal?.aborted
          ) {
            result = options.workspacePathBridgeSignal?.aborted
              ? buildToolInvocationCancelledResult()
              : buildPluginRuntimeOwnerDriftResult();
          } else {
            await options.executionFence?.();
            if (
              !this.isPluginRuntimeOwnerAdmissionCurrent(
                hookableRequest.toolName,
                overrideHandler,
                admittedOverrideRuntimeOwner,
              ) ||
              options.workspacePathBridgeSignal?.aborted
            ) {
              result = options.workspacePathBridgeSignal?.aborted
                ? buildToolInvocationCancelledResult()
                : buildPluginRuntimeOwnerDriftResult();
            } else {
              // Plugin handlers do not expose a deeper provider adapter boundary, so
              // conservatively record it immediately before the approved handler.
              await options.externalSideEffect?.markStarted();
              if (
                !this.isPluginRuntimeOwnerAdmissionCurrent(
                  hookableRequest.toolName,
                  overrideHandler,
                  admittedOverrideRuntimeOwner,
                ) ||
                options.workspacePathBridgeSignal?.aborted
              ) {
                result = options.workspacePathBridgeSignal?.aborted
                  ? buildToolInvocationCancelledResult()
                  : buildPluginRuntimeOwnerDriftResult();
              } else {
                result = await overrideHandler(
                  executionRequest.args ?? {},
                  buildPluginToolExecutionContext(executionRequest, finalPolicyCheck, approvedExternalRuntimeReplayId),
                );
              }
            }
          }
        }
      } else if (isMeshChatToolName(executionRequest.toolName)) {
        result = await this.invokeMeshToolFromToolRequest(executionRequest, options);
      } else if (executionRequest.toolName === "mcp.invoke" || isNativeMcpToolName(executionRequest.toolName)) {
        result = await this.invokeMcpToolFromToolRequest(executionRequest, options);
      } else {
        const beforeExecutionFence = isWorkspacePathBridgeCwdTool(executionRequest.toolName)
          ? createDeepWorkspacePathBridgePrecondition({
              host: this.host,
              request: executionRequest,
              initial: bridgeApplication,
              invocationId: toolHookEntityId,
              snapshotIds: workspacePathBridgeSnapshotIds,
              ...(options.workspacePathBridgeSignal ? { signal: options.workspacePathBridgeSignal } : {}),
              ...(options.executionFence ? { executionFence: options.executionFence } : {}),
            })
          : options.executionFence;
        const beforeExecute = options.beforeBuiltinExecute
          ? async (boundary?: ToolProcessSpawnBoundary) => {
              await beforeExecutionFence?.(boundary);
              await options.beforeBuiltinExecute!();
            }
          : beforeExecutionFence;
        const policyOptions = {
          ...(beforeExecute ? { beforeExecute } : {}),
          ...(options.externalSideEffect ? { externalSideEffect: options.externalSideEffect } : {}),
        };
        result =
          beforeExecute || options.externalSideEffect
            ? await this.host.policyEngine.invoke(executionRequest, policyOptions)
            : await this.host.policyEngine.invoke(executionRequest);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.host.recordDevDiagnostic?.({
        level: "error",
        category: "tools",
        event: "tool.invocation.failed",
        message: "Tool invocation failed",
        sessionId: hookableRequest.sessionId,
        taskId: hookableRequest.taskId,
        toolRunId: toolHookEntityId,
        toolName: hookableRequest.toolName,
        durationMs: Date.now() - toolStartedAt,
        runtimeKind: overrideHandler ? "tool.invocation.override" : "tool.invocation",
        runtimeStatus: "failed",
        runtimeError: {
          name: error instanceof Error ? error.name : undefined,
          message: errorMessage,
          retryable: false,
        },
      });
      await this.host.hooksService.enqueueAfterHooks({
        workspaceId: toolHookWorkspaceId,
        trigger: "tool.call.error",
        entityType: "tool_call",
        entityId: toolHookEntityId,
        payload: {
          toolName: hookableRequest.toolName,
          args: hookableRequest.args,
          sessionId: hookableRequest.sessionId,
          taskId: hookableRequest.taskId,
          error: errorMessage,
        },
        expectedInterposition: admittedToolCallBeforeHookInterposition,
        beforeExternalDispatch: options.auxiliaryEffectFence ?? options.executionFence,
      });
      throw error;
    }
    // Citadel Ward "redact" effect: when the resolved policy decision flagged this
    // invocation for redaction, scrub the tool's output before it flows into the
    // model context, the approval-replay record, after-hooks, or evidence. This is
    // the seam where BOTH the produced output (result.result) and the ward decision
    // (result.wardEffect, surfaced by the policy engine in slice 3.1a) are in scope.
    // Non-redact invocations are untouched, so behavior is byte-identical to before.
    // Plugin-override results carry no wardEffect of their own, so thread it from the
    // pre-execution policy check (finalPolicyCheck) so the ward is not silently dropped
    // on that path; for the engine path finalPolicyCheck is undefined and the result's
    // own wardEffect is used, preserving prior behavior exactly.
    result = withWorkspacePathBridgeEvidence(result, workspacePathBridgeSnapshotIds);
    result = withRedactWardApplied(result, finalPolicyCheck);

    const approvalForResult =
      result.outcome === "approval_required" && result.approvalId
        ? await this.host.primeToolApprovalLifecycle(result.approvalId, executionRequest)
        : undefined;
    const permissionProfileId =
      hookableRequest.policyContext?.permissionProfileId ?? hookableRequest.permissionProfileId;
    const localOperatorOverrideId =
      hookableRequest.policyContext?.localOperatorOverrideId ?? hookableRequest.localOperatorOverrideId;
    const linkedRunId =
      hookableRequest.runId ?? hookableRequest.policyContext?.runId ?? approvalForResult?.linkage?.durableRunId;

    await this.runPostCommitConsumer("realtime projection", hookableRequest, async () => {
      await this.host.publishRealtime(
        "tool_invoked",
        "policy",
        {
          toolName: hookableRequest.toolName,
          sessionId: hookableRequest.sessionId,
          agentId: hookableRequest.agentId,
          taskId: hookableRequest.taskId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          approvalId: result.approvalId,
          auditEventId: result.auditEventId,
          permissionProfileId,
          localOperatorOverrideId,
          runId: linkedRunId,
          workspacePathBridgeSnapshotId: workspacePathBridgeSnapshotIds.at(-1),
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            sessionId: hookableRequest.sessionId,
            taskId: hookableRequest.taskId,
            approvalId: result.approvalId,
            runId: linkedRunId,
          },
        },
      );
    });

    await this.runPostCommitConsumer("completion diagnostic", hookableRequest, () => {
      this.host.recordDevDiagnostic?.({
        level: result.outcome === "blocked" ? "warn" : "info",
        category: "tools",
        event: "tool.invocation.complete",
        message: "Tool invocation completed",
        sessionId: hookableRequest.sessionId,
        taskId: hookableRequest.taskId,
        toolRunId: toolHookEntityId,
        toolName: hookableRequest.toolName,
        durationMs: Date.now() - toolStartedAt,
        runtimeKind: overrideHandler ? "tool.invocation.override" : "tool.invocation",
        runtimeStatus: result.outcome === "blocked" || result.outcome === "approval_required" ? "blocked" : "completed",
        context: {
          outcome: result.outcome,
          approvalId: result.approvalId,
          policyReason: result.policyReason,
          permissionProfileId,
          localOperatorOverrideId,
          runId: linkedRunId,
          workspacePathBridgeSnapshotId: workspacePathBridgeSnapshotIds.at(-1),
        },
      });
    });
    await this.runPostCommitConsumer("evidence recording", hookableRequest, async () => {
      await this.host.recordEvidenceEnvelope?.({
        eventKind: "tool_invocation",
        sessionId: hookableRequest.sessionId,
        runId: linkedRunId,
        approvalId: result.approvalId,
        toolCallHashes: [result.auditEventId ?? toolHookEntityId],
        metadata: {
          runtime: overrideHandler ? "plugin_override" : "policy",
          toolName: hookableRequest.toolName,
          taskId: hookableRequest.taskId,
          agentId: hookableRequest.agentId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          permissionProfileId,
          localOperatorOverrideId,
          workspacePathBridgeSnapshotIds,
        },
      });
    });

    if (result.outcome === "approval_required" && result.approvalId) {
      await this.runPostCommitConsumer("approval explanation scheduling", hookableRequest, async () => {
        await this.host.scheduleApprovalExplanationById(result.approvalId!);
      });
    }

    await this.runPostCommitConsumer("tool.call.after hook enqueue", hookableRequest, async () => {
      await this.host.hooksService.enqueueAfterHooks({
        workspaceId: toolHookWorkspaceId,
        trigger: "tool.call.after",
        entityType: "tool_call",
        entityId: toolHookEntityId,
        payload: {
          toolName: hookableRequest.toolName,
          args: hookableRequest.args,
          sessionId: hookableRequest.sessionId,
          taskId: hookableRequest.taskId,
          result,
        },
        expectedInterposition: admittedToolCallBeforeHookInterposition,
        beforeExternalDispatch: options.auxiliaryEffectFence ?? options.executionFence,
      });
    });
    await this.runPostCommitConsumer("lifecycle observe hook enqueue", hookableRequest, async () => {
      await runtimeLifecycleHookDispatcher.enqueueObserveHook(this.host.hooksService, {
        workspaceId: toolHookWorkspaceId,
        trigger: "after_tool_call",
        entityType: "tool_call",
        entityId: toolHookEntityId,
        payload: {
          workspaceId: toolHookWorkspaceId,
          sessionId: hookableRequest.sessionId,
          taskId: hookableRequest.taskId,
          approvalId: result.approvalId,
          toolName: hookableRequest.toolName,
          outcome: result.outcome,
          auditEventId: result.auditEventId,
          policyReason: result.policyReason,
        },
        expectedInterposition: admittedToolCallBeforeHookInterposition,
        beforeExternalDispatch: options.auxiliaryEffectFence ?? options.executionFence,
      });
    });

    return result;
  }

  public async invokeApprovedExternalRuntimeTool(
    request: ToolInvokeRequest,
    markExternalCallStarted?: () => void | Promise<void>,
    options: ApprovedExternalRuntimeInvocationOptions = {},
  ): Promise<ToolInvokeResult> {
    await this.assertChatToolDispatchAllowed(request);
    if (!this.host.isValidToolName(request.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid tool name format",
        auditEventId: randomUUID(),
      };
    }
    const normalizedRequest = await this.host.normalizeToolInvokeRequest(request);
    if (containsRawApprovalActionBearer(normalizedRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter an external runtime",
        auditEventId: randomUUID(),
      };
    }
    if (hasApprovalActionTemplate(normalizedRequest)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: protected approval action delivery cannot execute through an external runtime",
        auditEventId: randomUUID(),
      };
    }
    const deploymentGuard = this.host.evaluateToolDeploymentGuard(normalizedRequest);
    if (deploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${deploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }
    const overrideHandler = this.host.pluginToolOverrideService?.resolveActiveHandler(normalizedRequest.toolName);
    if (!overrideHandler) {
      return {
        outcome: "blocked",
        policyReason: `blocked: approved external runtime handler is unavailable for ${normalizedRequest.toolName}`,
        auditEventId: randomUUID(),
      };
    }
    const admittedOverrideRuntimeOwner = this.admitPluginRuntimeOwner(normalizedRequest.toolName, overrideHandler);
    if (!admittedOverrideRuntimeOwner) {
      return buildPluginRuntimeOwnerDriftResult();
    }
    if (
      options.runtimeOwner &&
      (options.runtimeOwner.kind !== admittedOverrideRuntimeOwner.kind ||
        options.runtimeOwner.bindingHash !== admittedOverrideRuntimeOwner.bindingHash)
    )
      return buildPluginRuntimeOwnerDriftResult();
    const workspacePathBridgeInvocationId = `approved:${randomUUID()}`;
    const policyBridge = await applyFreshWorkspacePathBridge(this.host, normalizedRequest, {
      invocationId: workspacePathBridgeInvocationId,
      phase: "policy",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!policyBridge.ok) {
      return policyBridge.result;
    }
    if (options.signal?.aborted) {
      return buildApprovedExternalRuntimeCancelledResult();
    }
    let executionRequest = policyBridge.request;
    const workspacePathBridgeSnapshotIds = policyBridge.snapshotId ? [policyBridge.snapshotId] : [];
    const finalPolicyCheck = await this.host.policyEngine.invoke({
      ...executionRequest,
      externalRuntime: true,
    });
    const overridePolicyFailure = buildExternalRuntimePolicyFailure(finalPolicyCheck);
    if (overridePolicyFailure) {
      return overridePolicyFailure;
    }
    const toolRunId = workspacePathBridgeInvocationId;
    this.host.recordDevDiagnostic?.({
      level: "debug",
      category: "tools",
      event: "tool.invocation.start",
      message: "Starting approved external runtime invocation",
      sessionId: executionRequest.sessionId,
      taskId: executionRequest.taskId,
      toolRunId,
      toolName: executionRequest.toolName,
      runtimeKind: "tool.invocation.override",
      runtimeStatus: "started",
      context: {
        agentId: executionRequest.agentId,
        approvalReplay: true,
        workspacePathBridgeSnapshotId: workspacePathBridgeSnapshotIds.at(-1),
      },
    });
    const preExecuteBridge = await applyFreshWorkspacePathBridge(this.host, executionRequest, {
      invocationId: workspacePathBridgeInvocationId,
      phase: "pre_execute",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!preExecuteBridge.ok) {
      return withWorkspacePathBridgeEvidence(preExecuteBridge.result, workspacePathBridgeSnapshotIds);
    }
    const preExecuteDriftReason = isWorkspacePathBridgeCwdTool(executionRequest.toolName)
      ? compareWorkspacePathBridgeApplications(policyBridge, preExecuteBridge, {
          requireSnapshotFingerprint: true,
        })
      : undefined;
    if (preExecuteDriftReason) {
      if (preExecuteBridge.snapshotId) workspacePathBridgeSnapshotIds.push(preExecuteBridge.snapshotId);
      return withWorkspacePathBridgeEvidence(
        buildWorkspacePathBridgeBlockedResult(preExecuteDriftReason, preExecuteBridge.snapshotId),
        workspacePathBridgeSnapshotIds,
      );
    }
    executionRequest = preExecuteBridge.request;
    if (preExecuteBridge.snapshotId) {
      workspacePathBridgeSnapshotIds.push(preExecuteBridge.snapshotId);
    }
    if (
      options.signal?.aborted ||
      !this.isPluginRuntimeOwnerAdmissionCurrent(
        executionRequest.toolName,
        overrideHandler,
        admittedOverrideRuntimeOwner,
      )
    ) {
      return options.signal?.aborted
        ? buildApprovedExternalRuntimeCancelledResult()
        : buildPluginRuntimeOwnerDriftResult();
    }
    await this.assertChatToolDispatchAllowed(executionRequest);
    await markExternalCallStarted?.();
    if (
      options.signal?.aborted ||
      !this.isPluginRuntimeOwnerAdmissionCurrent(
        executionRequest.toolName,
        overrideHandler,
        admittedOverrideRuntimeOwner,
      )
    ) {
      return options.signal?.aborted
        ? buildApprovedExternalRuntimeCancelledResult()
        : buildPluginRuntimeOwnerDriftResult();
    }
    // Apply the redact ward before the result flows into realtime projection and the
    // evidence envelope below; the plugin result carries no wardEffect, so thread the
    // decision from finalPolicyCheck (mirrors the primary invocation seam).
    const result = withRedactWardApplied(
      await overrideHandler(
        executionRequest.args ?? {},
        buildPluginToolExecutionContext(executionRequest, finalPolicyCheck, undefined),
      ),
      finalPolicyCheck,
    );
    const permissionProfileId =
      executionRequest.policyContext?.permissionProfileId ?? executionRequest.permissionProfileId;
    const localOperatorOverrideId =
      executionRequest.policyContext?.localOperatorOverrideId ?? executionRequest.localOperatorOverrideId;
    const linkedRunId = executionRequest.runId ?? executionRequest.policyContext?.runId;
    await this.runPostCommitConsumer("approved external-runtime realtime projection", executionRequest, async () => {
      await this.host.publishRealtime(
        "tool_invoked",
        "policy",
        {
          toolName: executionRequest.toolName,
          sessionId: executionRequest.sessionId,
          agentId: executionRequest.agentId,
          taskId: executionRequest.taskId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          approvalId: result.approvalId,
          auditEventId: result.auditEventId,
          permissionProfileId,
          localOperatorOverrideId,
          runId: linkedRunId,
          workspacePathBridgeSnapshotId: workspacePathBridgeSnapshotIds.at(-1),
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            sessionId: executionRequest.sessionId,
            taskId: executionRequest.taskId,
            approvalId: result.approvalId,
            runId: linkedRunId,
          },
        },
      );
    });
    await this.runPostCommitConsumer("approved external-runtime evidence recording", executionRequest, async () => {
      await this.host.recordEvidenceEnvelope?.({
        eventKind: "tool_invocation",
        sessionId: executionRequest.sessionId,
        runId: linkedRunId,
        approvalId: result.approvalId,
        toolCallHashes: [result.auditEventId ?? toolRunId],
        metadata: {
          runtime: "plugin_override",
          toolName: executionRequest.toolName,
          taskId: executionRequest.taskId,
          agentId: executionRequest.agentId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          permissionProfileId,
          localOperatorOverrideId,
          approvalReplay: true,
          workspacePathBridgeSnapshotIds,
        },
      });
    });
    return result;
  }

  private async resolveMeshBinding(
    request: ToolInvokeRequest,
    options: Pick<ToolInvocationRuntimeOptions, "meshTurnContext">,
  ): Promise<MeshChatToolBinding> {
    if (!request.turnId || !request.toolRunId || !this.host.dispatchMeshCapabilityInvocation) {
      throw new ToolExecutionPreconditionError(
        "Mesh invocation requires canonical Chat correlation and its runtime owner",
      );
    }
    const binding = await this.host.resolveMeshChatToolBinding?.(request, options.meshTurnContext);
    if (!binding) throw new ToolExecutionPreconditionError("Mesh invocation has no frozen target binding");
    return binding;
  }

  private async invokeMeshToolFromToolRequest(
    request: ToolInvokeRequest,
    options: ToolInvocationRuntimeOptions,
  ): Promise<ToolInvokeResult> {
    const binding = await this.resolveMeshBinding(request, options);
    const policyResult = await this.host.policyEngine.invoke(
      { ...request, externalRuntime: true },
      {
        meshToolBinding: binding.schema.policyBinding,
      },
    );
    const failure = buildExternalRuntimePolicyFailure(policyResult, "Mesh runtime");
    if (failure) return failure;
    const approvalId = extractVerifiedApprovalReplayId(policyResult, request);
    if (approvalId)
      return {
        ...policyResult,
        outcome: "blocked",
        policyReason: "blocked: approved mesh actions execute only through the canonical approval-effect worker",
        result: { approvalId, executionOwner: "approval_effect" },
      };
    return this.invokeApprovedMeshRuntime(request, policyResult, {
      meshTurnContext: options.meshTurnContext,
      executionFence: options.executionFence,
      ...(options.externalSideEffect
        ? { markExternalCallStarted: () => options.externalSideEffect!.markStarted() }
        : {}),
    });
  }

  public async invokeApprovedMeshRuntime(
    request: ToolInvokeRequest,
    policyResult: ToolInvokeResult,
    options: MeshChatDispatchOptions,
  ): Promise<ToolInvokeResult> {
    await this.assertChatToolDispatchAllowed(request);
    const priorFence = options.executionFence;
    options = {
      ...options,
      executionFence: async () => {
        await this.assertChatToolDispatchAllowed(request);
        await priorFence?.();
      },
    };
    const result = await dispatchMeshChatTool(
      {
        resolveBinding: async (input, context) => {
          if (this.host.pluginToolOverrideService?.resolveActiveHandler(input.toolName))
            throw new ToolExecutionPreconditionError("Mesh runtime owner drifted");
          return this.resolveMeshBinding(input, { meshTurnContext: context });
        },
        dispatch: (input, dispatchOptions) => this.host.dispatchMeshCapabilityInvocation!(input, dispatchOptions),
      },
      request,
      policyResult,
      options,
    );
    return withRedactWardApplied(result, policyResult);
  }

  private async resolveNativeMcpBinding(
    request: ToolInvokeRequest,
    options: ToolInvocationRuntimeOptions,
  ): Promise<NativeMcpChatToolBinding | undefined> {
    if (!isNativeMcpToolName(request.toolName)) return undefined;
    if (!request.turnId || !request.toolRunId) {
      throw new ToolExecutionPreconditionError("Native MCP invocation requires canonical Chat correlation");
    }
    const binding = await this.host.resolveNativeMcpChatToolBinding?.(request, options.mcpRequesterTurnContext);
    if (!binding) throw new ToolExecutionPreconditionError("Native MCP invocation has no frozen target binding");
    return binding;
  }

  private async invokeMcpToolFromToolRequest(
    request: ToolInvokeRequest,
    options: ToolInvocationRuntimeOptions,
  ): Promise<ToolInvokeResult> {
    // Retain the exact Chat/worker invocation and correlation in policy. MCP has
    // its own transport owner; the ordinary built-in executor cannot run it.
    const nativeBinding = await this.resolveNativeMcpBinding(request, options);
    const policyRequest = { ...request, externalRuntime: true };
    const policyResult = nativeBinding
      ? await this.host.policyEngine.invoke(policyRequest, { mcpToolBinding: nativeBinding.policyBinding })
      : await this.host.policyEngine.invoke(policyRequest);
    const failure = buildExternalRuntimePolicyFailure(policyResult, "MCP runtime");
    if (failure) return failure;
    const approvalId = extractVerifiedApprovalReplayId(policyResult, request);
    if (approvalId) {
      return {
        outcome: "blocked",
        policyReason:
          "blocked: approved external-runtime actions execute only through the canonical approval-effect worker",
        auditEventId: policyResult.auditEventId,
        result: { approvalId, executionOwner: "approval_effect" },
        audit: policyResult.audit,
      };
    }
    if (request.dryRun || policyResult.result?.dryRun === true) return policyResult;
    const input = toMcpInvokeRequest(
      {
        ...request,
        policyContext: mergePolicyContexts(request.policyContext, readPolicyContextFromResult(policyResult)),
      },
      request.signal ?? options.workspacePathBridgeSignal,
      nativeBinding,
    );
    const runtimeStartedAt = Date.now();
    // A tool grant does not replace the server's first-use approval or auth,
    // native-tool allowlist, capability scope, and requester-resolution checks.
    const server = await this.resolveMcpRuntimeTarget(input);
    if (
      nativeBinding &&
      "serverId" in server &&
      resolveMcpServerConnectionMode(server) !== (nativeBinding.staticBinding ? "static" : "requester_scoped")
    ) {
      throw new ToolExecutionPreconditionError("Native MCP server connection mode drifted from the frozen binding");
    }
    const response =
      "serverId" in server
        ? await this.executeMcpRuntime(
            input,
            server,
            runtimeStartedAt,
            undefined,
            policyResult.wardEffect,
            options.externalSideEffect ? () => options.externalSideEffect!.markStarted() : undefined,
            options.executionFence,
            options.mcpRequesterTurnContext,
            nativeBinding ? request.toolName : undefined,
          )
        : server;
    return toolInvokeResultFromMcpRuntime(policyResult, response, "", request.toolName);
  }

  public async invokeApprovedMcpRuntime(
    input: McpInvokeRequest,
    markExternalCallStarted?: () => void | Promise<void>,
    options: Pick<ToolInvocationRuntimeOptions, "mcpRequesterTurnContext" | "executionFence"> & {
      wardEffect?: WardEffect;
      nativeCanonicalToolName?: string;
    } = {},
  ): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
    // This app-private entry point is reached only after the canonical pending
    // invocation has passed approval replay and current deny-wins policy. That
    // exact invocation satisfies first-use consent; it grants no future access.
    const server = await this.resolveMcpRuntimeTarget(input, { approvedInvocation: true });
    if (!("serverId" in server)) {
      return server;
    }
    if (
      options.nativeCanonicalToolName &&
      ((resolveMcpServerConnectionMode(server) === "static" && !options.mcpRequesterTurnContext) ||
        options.nativeCanonicalToolName !== `mcp.${input.serverId}.${input.toolName}` ||
        this.host.pluginToolOverrideService?.resolveActiveHandler(options.nativeCanonicalToolName))
    ) {
      throw new ToolExecutionPreconditionError("Approved native MCP target or runtime owner drifted");
    }
    return this.executeMcpRuntime(
      input,
      server,
      runtimeStartedAt,
      undefined,
      options.wardEffect,
      markExternalCallStarted,
      options.executionFence,
      options.mcpRequesterTurnContext,
      options.nativeCanonicalToolName,
    );
  }

  public async invokeMcpTool(
    input: McpInvokeRequest,
    options: ToolInvocationRuntimeOptions = {},
  ): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
    const server = await this.resolveMcpRuntimeTarget(input);
    if (!("serverId" in server)) {
      return server;
    }

    const autonomyGate = await this.evaluateMcpAutonomousActivation(input, server);
    if ("ok" in autonomyGate) {
      return autonomyGate;
    }

    const previewEvaluation = await this.evaluateMcpPolicy(input);
    const previewFailure = this.buildMcpPolicyFailure(previewEvaluation, autonomyGate.evidence);
    if (previewFailure) {
      return previewFailure;
    }

    const runtimeEvaluation = await this.evaluateMcpPolicy(input, { externalRuntime: true });
    const runtimeFailure = this.buildMcpPolicyFailure(runtimeEvaluation, autonomyGate.evidence);
    if (runtimeFailure) {
      return runtimeFailure;
    }

    const grantUseFailure = await this.recordMcpAutonomousGrantUse(input, autonomyGate.evidence);
    if (grantUseFailure) {
      return grantUseFailure;
    }

    // The runtime policy decision (slice 3.1a) surfaces the matched Citadel Ward
    // effect; pass it so a `redact` Ward scrubs the MCP output below. Note: the
    // approved entry point receives its ward decision from the canonical policy
    // replay owner instead of performing a second policy evaluation here.
    return this.executeMcpRuntime(
      input,
      server,
      runtimeStartedAt,
      autonomyGate.evidence,
      runtimeEvaluation.decision.wardEffect,
      options.externalSideEffect ? () => options.externalSideEffect!.markStarted() : undefined,
      options.executionFence,
      options.mcpRequesterTurnContext,
    );
  }

  private async evaluateMcpAutonomousActivation(
    input: McpInvokeRequest,
    server: McpServerRecord,
  ): Promise<{ evidence?: AutonomousActivationRuntimeEvidence } | McpInvokeResponse> {
    if (input.autonomousActivation !== true) {
      return {};
    }
    if (!this.host.evaluateAutonomousActivationGrant || !this.host.recordAutonomousActivationGrantUse) {
      return buildMcpAutonomousActivationFailure({
        allowed: false,
        blockers: ["Gateway runtime has no autonomous activation grant service wired for MCP execution."],
        governance: [
          "Agentic activation is disabled unless an active expiring operator grant matches the request.",
          "Missing grant enforcement wiring is treated as fail-closed.",
        ],
      });
    }
    const grantInput = buildMcpAutonomousActivationGrantInput(input, server);
    const result = await this.host.evaluateAutonomousActivationGrant(grantInput);
    const evidence: AutonomousActivationRuntimeEvidence = {
      requested: true,
      allowed: result.allowed,
      matchedGrantId: result.matchedGrantId,
      riskLevel: grantInput.riskLevel,
      governance: result.governance,
      blockers: result.blockers,
    };
    if (!result.allowed) {
      return buildMcpAutonomousActivationFailure(evidence);
    }
    return { evidence };
  }

  private async recordMcpAutonomousGrantUse(
    input: McpInvokeRequest,
    evidence: AutonomousActivationRuntimeEvidence | undefined,
  ): Promise<McpInvokeResponse | null> {
    if (!evidence?.matchedGrantId) {
      return null;
    }
    try {
      await this.host.recordAutonomousActivationGrantUse?.(evidence.matchedGrantId, input.estimatedCostUsd ?? 0);
      return null;
    } catch (error) {
      return {
        ok: false,
        autonomousActivation: {
          ...evidence,
          allowed: false,
          blockers: [
            ...evidence.blockers,
            "Autonomous activation grant use could not be recorded before runtime execution.",
          ],
        },
        error: "Autonomous MCP activation could not record grant use; refusing runtime execution.",
        policyReason: error instanceof Error ? error.message : String(error),
        reasonCodes: ["autonomous_activation_grant_record_failed"],
      };
    }
  }

  private async resolveMcpRuntimeTarget(
    input: McpInvokeRequest,
    consent?: { approvedInvocation: true },
  ): Promise<McpServerRecord | McpInvokeResponse> {
    const server = await this.host.requireMcpServer(input.serverId);
    if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
      // HX-415 precondition routing: a requester-scoped server never joins global
      // connect/discovery/status/tool state (connectMcpServer fails closed before
      // any status patch; requester-scoped discovery never writes the global tool
      // cache). The static-oriented preconditions below — `status === "connected"`,
      // static OAuth/token readiness, and the global-tool-enabled lookup — are
      // therefore inapplicable and must NOT gate it, or the app-private requester
      // branch in executeMcpRuntime is unreachable in production. Authorization
      // instead converges on that requester branch (which fails closed with
      // `requester_context_missing` until a server-built dispatch is composed) plus
      // the capability-scope gate and deny-wins policy already evaluated on the
      // invoke path. Static safety gates that still apply are kept: a disabled or
      // quarantined server is blocked. The static path below is left unchanged.
      if (!server.enabled) {
        return {
          ok: false,
          error: "MCP server is not enabled.",
        };
      }
      if (server.trustTier === "quarantined") {
        return {
          ok: false,
          error: `MCP server ${server.label} is quarantined and cannot execute tools.`,
        };
      }
      return (await this.checkMcpServerToolPolicy(input, server, consent)) ?? server;
    }
    if (!server.enabled || server.status !== "connected") {
      return {
        ok: false,
        error: "MCP server is not connected.",
      };
    }
    if (server.trustTier === "quarantined") {
      return {
        ok: false,
        error: `MCP server ${server.label} is quarantined and cannot execute tools.`,
      };
    }
    // Fail closed on stale/missing OAuth (needs_auth/expired) so the shared
    // agent/chat/durable invoke path matches the HTTP route's gate: a logically
    // expired-but-still-connected token must not reach the runtime.
    const authReadiness = resolveMcpInvokeAuthReadiness(server);
    if (isMcpAuthReadinessInvokeBlocked(authReadiness)) {
      return {
        ok: false,
        error: buildMcpStaleAuthInvokeError(server, authReadiness),
      };
    }

    const tool = (await this.host.listMcpTools(input.serverId)).find(
      (candidate) => candidate.toolName === input.toolName && candidate.enabled,
    );
    if (!tool) {
      return {
        ok: false,
        error: `MCP tool ${input.toolName} is not enabled on server ${input.serverId}.`,
      };
    }
    return (await this.checkMcpServerToolPolicy(input, server, consent)) ?? server;
  }

  private async checkMcpServerToolPolicy(
    input: McpInvokeRequest,
    server: McpServerRecord,
    consent?: { approvedInvocation: true },
  ): Promise<McpInvokeResponse | undefined> {
    if (server.policy.blockedToolPatterns.some((pattern) => this.host.matchesWildcard(input.toolName, pattern))) {
      return {
        ok: false,
        error: `MCP policy blocked tool ${input.toolName} on server ${server.serverId}.`,
      };
    }
    if (
      server.policy.allowedToolPatterns.length > 0 &&
      !server.policy.allowedToolPatterns.some((pattern) => this.host.matchesWildcard(input.toolName, pattern))
    ) {
      return {
        ok: false,
        error: `MCP policy does not allow tool ${input.toolName} on server ${server.serverId}.`,
      };
    }
    if (
      server.policy.requireFirstToolApproval &&
      !consent?.approvedInvocation &&
      !(await this.host.isMcpToolApproved(input.serverId, input.toolName))
    ) {
      return {
        ok: false,
        error: `First-use approval required for ${input.toolName}. Request this MCP invocation in Chat and approve the displayed tool action.`,
      };
    }
    return undefined;
  }

  private async executeMcpRuntime(
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
    return executeMcpRuntime(
      this.host,
      input,
      server,
      runtimeStartedAt,
      autonomousActivation,
      wardEffect,
      markExternalCallStarted,
      executionFence,
      mcpRequesterTurnContext,
      nativeCanonicalToolName,
    );
  }
}

function hasApprovalActionTemplate(request: ToolInvokeRequest): boolean {
  return request.args.interactiveActionTemplate !== undefined;
}

function containsRawApprovalActionBearer(value: unknown): boolean {
  return /grat_[A-Za-z0-9_-]{43}/i.test(JSON.stringify(value ?? null));
}

function isProtectedApprovalActionBindingUnchanged(before: ToolInvokeRequest, after: ToolInvokeRequest): boolean {
  return isDeepStrictEqual(
    {
      toolName: before.toolName,
      args: before.args,
    },
    {
      toolName: after.toolName,
      args: after.args,
    },
  );
}

function buildMcpAutonomousActivationGrantInput(
  input: McpInvokeRequest,
  server: McpServerRecord,
): AutonomousActivationGrantEvaluationInput {
  return {
    workspaceId: input.workspaceId,
    surface: input.surface ?? "mcp",
    riskLevel: classifyMcpAutonomousActivationRisk(server),
    activationKind: "mcp_tool",
    capabilityId: `mcp:${server.serverId}`,
    toolName: `mcp.${server.serverId}.${input.toolName}`,
    estimatedCostUsd: input.estimatedCostUsd,
  };
}

function classifyMcpAutonomousActivationRisk(server: McpServerRecord): AutonomousActivationRiskLevel {
  if (server.costTier === "paid") {
    return "danger";
  }
  if (server.trustTier === "trusted" && server.costTier === "free") {
    return "caution";
  }
  return "danger";
}

function buildMcpAutonomousActivationFailure(
  evidence: Omit<AutonomousActivationRuntimeEvidence, "requested" | "riskLevel"> &
    Partial<Pick<AutonomousActivationRuntimeEvidence, "requested" | "riskLevel">>,
): McpInvokeResponse {
  return {
    ok: false,
    autonomousActivation: {
      requested: true,
      allowed: evidence.allowed,
      matchedGrantId: evidence.matchedGrantId,
      riskLevel: evidence.riskLevel,
      governance: evidence.governance,
      blockers: evidence.blockers,
    },
    error: "Autonomous MCP activation requires an active matching operator grant.",
    policyReason: evidence.blockers.join(" "),
    reasonCodes: ["autonomous_activation_grant_required"],
  };
}

function extractApprovalReplayId(request: ToolInvokeRequest): string | undefined {
  const reason = request.consentContext?.reason?.trim();
  if (!reason) {
    return undefined;
  }
  return APPROVAL_REASON_RE.exec(reason)?.[1];
}

function extractVerifiedApprovalReplayId(result: ToolInvokeResult, request: ToolInvokeRequest): string | undefined {
  const requestApprovalId = extractApprovalReplayId(request);
  if (!requestApprovalId || result.audit?.approvalId !== requestApprovalId) {
    return undefined;
  }
  return requestApprovalId;
}

/**
 * Enforce the Citadel Ward "redact" effect on a completed tool invocation.
 *
 * SCOPE (be honest): this scrubs KNOWN SECRET PATTERNS from the tool's output —
 * API keys, bearer/basic auth headers, `*_token`/`*_secret`/`password` assignments,
 * provider key shapes (sk-/gh*_/AKIA…/xox…), credential-in-URL, etc. — via the same
 * `redactSecretText` matcher the rest of the gateway uses. It is NOT full semantic
 * PII removal (names, addresses, free-text identifiers); that would be a separate
 * NLP feature. It reduces the blast radius of a Ward-flagged tool feeding secrets
 * back into the model, but is not a guarantee against every sensitive value.
 *
 * Shape is preserved: we walk the output and rewrite string leaf values in place,
 * never dropping fields or altering non-string values. When the decision carries no
 * `redact` ward (or there is no output) the result is returned untouched, so a
 * non-redact invocation is byte-identical to before this effect existed.
 */
function applyRedactWardEffect(result: ToolInvokeResult): ToolInvokeResult {
  if (result.wardEffect !== "redact" || !result.result) {
    return result;
  }
  return {
    ...result,
    result: redactSecretsDeep(result.result) as Record<string, unknown>,
  };
}

/**
 * Applies the redact Citadel Ward to a result, threading the ward decision from the
 * pre-execution policy check when the produced result does not already carry one.
 *
 * Plugin-override handlers return a plain result with no `wardEffect` (they know
 * nothing about wards), so on those paths the ward decision lives only on the
 * pre-execution `policyCheck`. Without this, a `redact` ward matched for a
 * plugin-overridden tool would be silently dropped — enforced on the engine and MCP
 * seams but not on the plugin-override sibling path.
 */
function withRedactWardApplied(result: ToolInvokeResult, policyCheck: ToolInvokeResult | undefined): ToolInvokeResult {
  const withWard =
    result.wardEffect === undefined && policyCheck?.wardEffect !== undefined
      ? { ...result, wardEffect: policyCheck.wardEffect }
      : result;
  return applyRedactWardEffect(withWard);
}
