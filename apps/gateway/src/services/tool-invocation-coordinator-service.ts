/* eslint-disable max-lines -- Tool invocation coordination keeps policy, MCP, audit, and grant evidence in one reviewable runtime seam. */
import { randomUUID } from "node:crypto";
import { posix as posixPath, win32 as winPath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  classifyToolEffectPotential,
  isToolEffectPotentialRecord,
  redactSecretText,
  type ApprovalRequest,
  type AutonomousActivationGrantEvaluationInput,
  type AutonomousActivationGrantEvaluationResult,
  type AutonomousActivationRiskLevel,
  type AutonomousActivationRuntimeEvidence,
  resolveMcpServerConnectionMode,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type McpNormalizedContentItem,
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
import type { ApprovalInboxRepository } from "@goatcitadel/storage";
import { ToolExecutionPreconditionError, type ToolProcessSpawnBoundary } from "@goatcitadel/policy-engine";
import type { HooksService } from "./hooks-service.js";
import { parseToolCallHookPatch } from "./hook-patch-helpers.js";
import {
  handleInternalMcpApprovalInboxInvoke,
  isInternalMcpApprovalInboxServer,
  type ListMcpElicitations,
  type RespondToMcpElicitation,
} from "./mcp-approval-inbox.js";
import {
  handleInternalMcpDurableTasksInvoke,
  isInternalMcpDurableTasksServer,
  type McpDurableTasksPort,
} from "./mcp-durable-tasks.js";
import {
  buildMcpStaleAuthInvokeError,
  isMcpAuthReadinessInvokeBlocked,
  resolveMcpInvokeAuthReadiness,
} from "./mcp-oauth-token-service.js";
import type { McpRequesterScopedTurnContextHandle } from "./mcp-requester-resolution-service.js";
import type { McpRuntimeInvocationResult } from "./mcp-runtime.js";
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
  markStarted(): void;
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

function buildPluginOverridePolicyFailure(finalPolicyCheck: ToolInvokeResult): ToolInvokeResult | undefined {
  if (finalPolicyCheck.outcome === "blocked" || finalPolicyCheck.outcome === "approval_required") {
    return finalPolicyCheck;
  }
  if (readDryRunRequiresApproval(finalPolicyCheck.result)) {
    return {
      outcome: "blocked",
      policyReason: `blocked: plugin override requires policy approval before execution (${finalPolicyCheck.policyReason})`,
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
  executionFence?: () => void;
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
    input.executionFence?.();
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
    options: { effectDispatch: () => void },
  ): Promise<McpRuntimeInvocationResult>;
}

export interface ToolInvocationCoordinatorHost {
  readonly approvalInbox: Pick<
    ApprovalInboxRepository,
    "receiveMcpApprovalDelivery" | "listByReceiver" | "get" | "markResolved"
  >;
  readonly durableTasks: McpDurableTasksPort;
  readonly respondToMcpElicitation: RespondToMcpElicitation;
  readonly listMcpElicitations: ListMcpElicitations;
  /** Required capability-scope gate. Throws when the requested MCP server is not
   *  available in the active workspace/citadel scope. Missing wiring fails closed. */
  assertMcpServerInScope?: (request: McpInvokeRequest) => void;
  readonly policyEngine: {
    invoke(
      request: ToolInvokeRequest,
      options?: {
        beforeExecute?: (boundary?: ToolProcessSpawnBoundary) => void | Promise<void>;
        externalSideEffect?: ToolExternalSideEffectBoundary;
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
    }): ToolPolicyAccessResult;
  };
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  normalizeToolInvokeRequest(request: ToolInvokeRequest): ToolInvokeRequest;
  isValidToolName(name: string): boolean;
  evaluateToolDeploymentGuard(request: ToolInvokeRequest): { reason: string } | null | undefined;
  isFeatureEnabled?(flag: "computerUseGuardrailsV1Enabled"): boolean;
  resolveToolHookWorkspaceId(request: ToolInvokeRequest): string;
  /**
   * Re-resolves any process working directory against current filesystem and
   * Git evidence. Historical snapshot inspection is never execution authority.
   */
  resolveWorkspacePathBridgeBeforeExecution?(
    request: ToolInvokeRequest,
    context: WorkspacePathBridgeResolutionContext,
  ): Promise<WorkspacePathBridgeExecutionDecision>;
  resolveToolCallBeforeHookInterposition?(workspaceId: string): ToolCallBeforeHookInterpositionBinding;
  primeToolApprovalLifecycle(approvalId: string, request: ToolInvokeRequest): ApprovalRequest;
  scheduleApprovalExplanationById(approvalId: string): void;
  evaluateAutonomousActivationGrant?(
    input: AutonomousActivationGrantEvaluationInput,
  ): AutonomousActivationGrantEvaluationResult;
  recordAutonomousActivationGrantUse?(grantId: string, estimatedCostUsd?: number): void;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: RealtimePublishOptions,
  ): void;
  requireMcpServer(serverId: string): McpServerRecord;
  listMcpTools(serverId: string): McpToolRecord[];
  matchesWildcard(value: string, pattern: string): boolean;
  isMcpToolApproved(serverId: string, toolName: string): boolean;
  invokeMcpRuntimeTool(
    server: McpServerRecord,
    input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  ): Promise<McpRuntimeInvocationResult>;
  /**
   * HX-415 app-private requester-scoped MCP dispatch. Undefined until a
   * separately reviewed auth/profile integration composes server-built
   * requester authority + attempt lease. It receives ONLY the tool
   * name/arguments/signal plus the effect-dispatch callback and derives
   * authority from server-owned request context — never from `McpInvokeRequest`.
   */
  readonly requesterScopedMcpDispatch?: RequesterScopedMcpDispatchPort;
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
  recordEvidenceEnvelope?(input: EvidenceEnvelopeCreateRequest): void;
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
  /** Process-local cancellation signal for fresh workspace-path verification. */
  workspacePathBridgeSignal?: AbortSignal;
  /**
   * HX-415 app-private branded turn context for requester-scoped MCP dispatch.
   * Originated ONLY by the chat-turn runner from the frozen capability-profile
   * record; the direct route and approval replay never populate it, so those
   * paths keep failing closed (`requester_context_missing`) one level deeper.
   * Never serialized; brand-checked at the dispatch provider.
   */
  mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle;
  /** Process-local durable fence immediately before the main tool executor. */
  executionFence?: () => void;
  /**
   * Process-local durable fence immediately before an auxiliary hook effect.
   * This is deliberately distinct from the main executor boundary so an
   * approval decision reached after a webhook remains actionable.
   */
  auxiliaryEffectFence?: () => void;
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
  onEffectPotentialEscalated?: (potential: ToolEffectPotentialRecord) => void;
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
    markExternalCallStarted?: () => void,
    options?: ApprovedExternalRuntimeInvocationOptions,
  ): Promise<ToolInvokeResult>;
  invokeApprovedMcpRuntime(input: McpInvokeRequest, markExternalCallStarted?: () => void): Promise<McpInvokeResponse>;
}

export interface ApprovedExternalRuntimeInvocationOptions {
  /** Process-local approval-worker cancellation authority; never deserialize from model input. */
  signal?: AbortSignal;
}

export class ToolInvocationCoordinatorService implements ToolInvocationCoordinator {
  public constructor(private readonly host: ToolInvocationCoordinatorHost) {}

  /**
   * Rebuilds the deepest-spawn precondition for the canonical approval worker,
   * whose policy replay bypasses invokeTool but must not bypass cwd/Git checks.
   */
  public async prepareApprovedBuiltinBeforeExecute(
    request: ToolInvokeRequest,
    options: { invocationId: string; signal?: AbortSignal },
  ): Promise<((boundary?: ToolProcessSpawnBoundary) => Promise<void>) | undefined> {
    if (!isWorkspacePathBridgeCwdTool(request.toolName)) {
      return undefined;
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
    return createDeepWorkspacePathBridgePrecondition({
      host: this.host,
      request: initial.request,
      initial,
      invocationId: options.invocationId,
      snapshotIds,
      ...(options.signal ? { signal: options.signal } : {}),
    });
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

  private runPostCommitConsumer(consumer: string, request: ToolInvokeRequest, callback: () => void): void {
    try {
      callback();
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
    const request = this.buildMcpPolicyRequest(input);
    return {
      access: this.host.policyEngine.evaluateAccess(request),
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
    if (!this.host.isValidToolName(request.toolName)) {
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

    const normalizedRequest = this.host.normalizeToolInvokeRequest(request);
    if (containsRawApprovalActionBearer(normalizedRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter tool hooks or policy",
        auditEventId: randomUUID(),
      };
    }
    const isCodeModeWrapperInvocation = Boolean(normalizedRequest.policyContext?.approvedCodeModeRunId);
    const toolHookWorkspaceId = this.host.resolveToolHookWorkspaceId(normalizedRequest);
    const toolHookEntityId = `${normalizedRequest.sessionId}:${randomUUID()}`;
    let admittedToolCallBeforeHookInterposition: ToolCallBeforeHookInterpositionBinding | undefined;
    if (options.effectPotential) {
      const currentInterposition = this.host.resolveToolCallBeforeHookInterposition?.(toolHookWorkspaceId);
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
          beforeExternalDispatch: () => {
            if (options.effectPotential?.potential === "none") {
              if (!options.onEffectPotentialEscalated) {
                throw new Error("Inline hook dispatch cannot retain an unchangeable no-effect classification.");
              }
              options.onEffectPotentialEscalated(
                classifyToolEffectPotential({
                  toolName: normalizedRequest.toolName,
                  trustedBuiltin: false,
                  sourceKind: "remote",
                }),
              );
            }
            (options.auxiliaryEffectFence ?? options.executionFence)?.();
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

    if (options.effectPotential && hookableRequest.toolName !== normalizedRequest.toolName) {
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

    if (!this.host.isValidToolName(hookableRequest.toolName)) {
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
    if (this.host.isFeatureEnabled?.("computerUseGuardrailsV1Enabled")) {
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
      const overridePolicyFailure = buildPluginOverridePolicyFailure(finalPolicyCheck);
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
          options.onEffectPotentialEscalated?.(
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
            options.executionFence?.();
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
              options.externalSideEffect?.markStarted();
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
      } else {
        const beforeExecute = isWorkspacePathBridgeCwdTool(executionRequest.toolName)
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
      this.host.hooksService.enqueueAfterHooks({
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
        ? this.host.primeToolApprovalLifecycle(result.approvalId, executionRequest)
        : undefined;
    const permissionProfileId =
      hookableRequest.policyContext?.permissionProfileId ?? hookableRequest.permissionProfileId;
    const localOperatorOverrideId =
      hookableRequest.policyContext?.localOperatorOverrideId ?? hookableRequest.localOperatorOverrideId;
    const linkedRunId =
      hookableRequest.runId ?? hookableRequest.policyContext?.runId ?? approvalForResult?.linkage?.durableRunId;

    this.runPostCommitConsumer("realtime projection", hookableRequest, () => {
      this.host.publishRealtime(
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

    this.runPostCommitConsumer("completion diagnostic", hookableRequest, () => {
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
    this.runPostCommitConsumer("evidence recording", hookableRequest, () => {
      this.host.recordEvidenceEnvelope?.({
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
      this.runPostCommitConsumer("approval explanation scheduling", hookableRequest, () => {
        this.host.scheduleApprovalExplanationById(result.approvalId!);
      });
    }

    this.runPostCommitConsumer("tool.call.after hook enqueue", hookableRequest, () => {
      this.host.hooksService.enqueueAfterHooks({
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
    this.runPostCommitConsumer("lifecycle observe hook enqueue", hookableRequest, () => {
      runtimeLifecycleHookDispatcher.enqueueObserveHook(this.host.hooksService, {
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
    markExternalCallStarted?: () => void,
    options: ApprovedExternalRuntimeInvocationOptions = {},
  ): Promise<ToolInvokeResult> {
    if (!this.host.isValidToolName(request.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid tool name format",
        auditEventId: randomUUID(),
      };
    }
    const normalizedRequest = this.host.normalizeToolInvokeRequest(request);
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
    const overridePolicyFailure = buildPluginOverridePolicyFailure(finalPolicyCheck);
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
    markExternalCallStarted?.();
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
    this.runPostCommitConsumer("approved external-runtime realtime projection", executionRequest, () => {
      this.host.publishRealtime(
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
    this.runPostCommitConsumer("approved external-runtime evidence recording", executionRequest, () => {
      this.host.recordEvidenceEnvelope?.({
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

  public async invokeApprovedMcpRuntime(
    input: McpInvokeRequest,
    markExternalCallStarted?: () => void,
  ): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
    const server = this.resolveMcpRuntimeTarget(input);
    if (!("serverId" in server)) {
      return server;
    }
    return this.executeMcpRuntime(input, server, runtimeStartedAt, undefined, undefined, markExternalCallStarted);
  }

  public async invokeMcpTool(
    input: McpInvokeRequest,
    options: ToolInvocationRuntimeOptions = {},
  ): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
    const server = this.resolveMcpRuntimeTarget(input);
    if (!("serverId" in server)) {
      return server;
    }

    const autonomyGate = this.evaluateMcpAutonomousActivation(input, server);
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

    const grantUseFailure = this.recordMcpAutonomousGrantUse(input, autonomyGate.evidence);
    if (grantUseFailure) {
      return grantUseFailure;
    }

    // The runtime policy decision (slice 3.1a) surfaces the matched Citadel Ward
    // effect; pass it so a `redact` Ward scrubs the MCP output below. Note: the
    // model-approval-replay entry point (invokeApprovedMcpRuntime) does no policy
    // evaluation and therefore has no ward decision to honor — that gap is flagged
    // in the slice report; it still gets the server-policy redactionMode scrub.
    return this.executeMcpRuntime(
      input,
      server,
      runtimeStartedAt,
      autonomyGate.evidence,
      runtimeEvaluation.decision.wardEffect,
      undefined,
      options.executionFence,
      options.mcpRequesterTurnContext,
    );
  }

  private evaluateMcpAutonomousActivation(
    input: McpInvokeRequest,
    server: McpServerRecord,
  ): { evidence?: AutonomousActivationRuntimeEvidence } | McpInvokeResponse {
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
    const result = this.host.evaluateAutonomousActivationGrant(grantInput);
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

  private recordMcpAutonomousGrantUse(
    input: McpInvokeRequest,
    evidence: AutonomousActivationRuntimeEvidence | undefined,
  ): McpInvokeResponse | null {
    if (!evidence?.matchedGrantId) {
      return null;
    }
    try {
      this.host.recordAutonomousActivationGrantUse?.(evidence.matchedGrantId, input.estimatedCostUsd ?? 0);
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

  private resolveMcpRuntimeTarget(input: McpInvokeRequest): McpServerRecord | McpInvokeResponse {
    const server = this.host.requireMcpServer(input.serverId);
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
      return server;
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

    const tool = this.host
      .listMcpTools(input.serverId)
      .find((candidate) => candidate.toolName === input.toolName && candidate.enabled);
    if (!tool) {
      return {
        ok: false,
        error: `MCP tool ${input.toolName} is not enabled on server ${input.serverId}.`,
      };
    }
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
    if (server.policy.requireFirstToolApproval && !this.host.isMcpToolApproved(input.serverId, input.toolName)) {
      return {
        ok: false,
        error: `First-use approval required for ${input.toolName}. Approve this tool in MCP policy or disable first-use approval.`,
      };
    }
    return server;
  }

  private async executeMcpRuntime(
    input: McpInvokeRequest,
    server: McpServerRecord,
    runtimeStartedAt: number,
    autonomousActivation?: AutonomousActivationRuntimeEvidence,
    wardEffect?: WardEffect,
    markExternalCallStarted?: () => void,
    executionFence?: () => void,
    mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle,
  ): Promise<McpInvokeResponse> {
    // Capability-scope choke point: every MCP invocation path converges here (model
    // approval-replay via invokeApprovedMcpRuntime, plus REST/durable/connector via
    // invokeMcpTool). The gate is fail-closed and applies to internal MCP surfaces too,
    // including durable tasks, because they expose operator runtime state.
    const scopeFailure = this.enforceMcpServerScope(input);
    if (scopeFailure) {
      return scopeFailure;
    }
    let runtime: McpRuntimeInvocationResult;
    if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
      // HX-415: requester-scoped servers converge on the app-private dispatch
      // port. The direct route and approval replay cannot manufacture a
      // requester profile from `McpInvokeRequest`; without a server-built
      // dispatch provider this server is not callable, and the HX-305 execution
      // fence / external-effect marker stay untouched (a pre-dispatch failure).
      // When composed, the provider fires them once, inside the runtime, at the
      // effect-bearing `tools/call` write.
      const dispatch = this.host.requesterScopedMcpDispatch;
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
          // options (chat-turn runner origin). `McpInvokeRequest` fields can
          // never populate it; replay/direct callers pass no options context and
          // therefore fail closed inside the provider.
          ...(mcpRequesterTurnContext ? { mcpRequesterTurnContext } : {}),
        },
        {
          effectDispatch: () => {
            executionFence?.();
            markExternalCallStarted?.();
          },
        },
      );
    } else {
      executionFence?.();
      markExternalCallStarted?.();
      runtime = isInternalMcpApprovalInboxServer(server)
        ? await handleInternalMcpApprovalInboxInvoke(server, input, {
            approvalInbox: this.host.approvalInbox,
            resolveApprovalWithRemoteTokenId: (request) => this.host.resolveApprovalWithRemoteTokenId(request),
            respondToMcpElicitation: (request) => this.host.respondToMcpElicitation(request),
            listMcpElicitations: (filter) => this.host.listMcpElicitations(filter),
          })
        : isInternalMcpDurableTasksServer(server)
          ? await handleInternalMcpDurableTasksInvoke(server, input, this.host.durableTasks)
          : await this.host.invokeMcpRuntimeTool(server, {
              toolName: input.toolName,
              arguments: input.arguments,
              signal: input.signal,
            });
    }
    const runtimeRetryCount = "retryCount" in runtime ? runtime.retryCount : undefined;
    const runtimeDegraded = "degraded" in runtime ? runtime.degraded : undefined;
    const runtimeExternalOutcome = "externalOutcome" in runtime ? runtime.externalOutcome : undefined;
    const runtimeManualReconciliationRequired =
      "manualReconciliationRequired" in runtime ? runtime.manualReconciliationRequired : undefined;
    if (runtimeRetryCount || runtime.output?.degradedReason) {
      this.host.recordDevDiagnostic?.({
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
        ? (redactSecretsDeep(this.host.applyMcpRedaction(output, server.policy.redactionMode)) as Record<
            string,
            unknown
          >)
        : this.host.applyMcpRedaction(output, server.policy.redactionMode)
      : undefined;
    const policyRedactedContentItems = redactMcpContentItems(
      runtime.contentItems,
      server.policy.redactionMode,
      this.host.applyMcpRedaction,
    );
    const redactedContentItems =
      applyWardRedaction && policyRedactedContentItems
        ? (redactSecretsDeep(policyRedactedContentItems) as McpNormalizedContentItem[])
        : policyRedactedContentItems;
    const sanitizedRuntimeError = redactMcpRuntimeError(runtime.error, server.policy.redactionMode);

    this.host.publishRealtime(
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
    this.host.recordEvidenceEnvelope?.({
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

  private enforceMcpServerScope(input: McpInvokeRequest): McpInvokeResponse | undefined {
    if (!this.host.assertMcpServerInScope) {
      return {
        ok: false,
        error: "MCP capability scope enforcement is unavailable.",
        policyReason: "blocked: MCP capability scope gate is not wired",
        reasonCodes: ["mcp_capability_scope_unavailable"],
      };
    }
    try {
      this.host.assertMcpServerInScope(input);
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

/** Recursively rewrite string leaves through `redactSecretText`, preserving structure. */
function redactSecretsDeep(value: unknown): unknown {
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
