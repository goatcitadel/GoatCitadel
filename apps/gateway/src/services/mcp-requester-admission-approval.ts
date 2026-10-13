import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  type PendingApprovalAction,
  type ToolInvokeRequest,
  type ToolInvokeResult,
  type McpRequesterAdmissionScope,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { assertChatFeatureBindingCurrent } from "./chat-feature-binding-current.js";
import { isRecord } from "./companion-auth-helpers.js";
import {
  toToolInvokeRequest,
  approvedExternalRuntimeRequestMatches,
} from "./gateway/external-runtime-approval-adapter.js";
import { isNativeMcpToolName } from "./gateway/native-mcp-chat-binding.js";
import {
  isMeshChatToolName,
  readMeshAdmissionTurnContext,
  type MeshChatTurnContextHandle,
} from "./gateway/mesh-chat-binding.js";
import { assertMcpRequesterAdmissionConnection } from "./mcp-requester-admission-authority.js";
import { assertStaticMcpAdmissionReceipt } from "./mcp-static-admission.js";
import { assertMcpRequesterAdmissionScopeCurrent } from "./mcp-requester-admission-scope.js";
import {
  readMcpRequesterAdmissionTurnContext,
  type McpRequesterAdmissionTurnContextHandle,
} from "./mcp-requester-admission-context.js";

/** The approval effect records a handoff; only a resumed durable Chat claim can dispatch. */
export class RequesterMcpApprovalResumeRequiredError extends Error {
  constructor() {
    super("Admitted external-tool approval requires its resumed durable Chat owner.");
    this.name = "RequesterMcpApprovalResumeRequiredError";
  }
}
export type AdmittedExternalTurnContextHandle = McpRequesterAdmissionTurnContextHandle | MeshChatTurnContextHandle;
export function readAdmittedExternalTurnContext(handle: AdmittedExternalTurnContextHandle | undefined) {
  return (
    readMcpRequesterAdmissionTurnContext(handle) ??
    readMeshAdmissionTurnContext(handle as MeshChatTurnContextHandle | undefined)
  );
}
type ApprovalStorage = Pick<
  AsyncStorage,
  | "approvals"
  | "pendingApprovalActions"
  | "chatToolRuns"
  | "chatTurnTraces"
  | "chatDelegationSteps"
  | "durableRuns"
  | "sessionMutationAdmissions"
  | "sessionControls"
  | "externalSideEffectRuns"
  | "chatInlineApprovals"
  | "runImmediateTransaction"
>;

/** Read evidence only. A successful read never mints a lease or executable handle. */
export async function readApprovedRequesterAdmission(
  storage: ApprovalStorage,
  approvalId: string,
  request: ToolInvokeRequest,
  allowSettled = false,
): Promise<{ scope: McpRequesterAdmissionScope; referenceSha256: string } | undefined> {
  if (
    (!isNativeMcpToolName(request.toolName) && !isMeshChatToolName(request.toolName)) ||
    !request.runId ||
    !request.turnId ||
    !request.toolRunId ||
    !request.workspaceId
  )
    return undefined;
  const [pending, approval, tool, trace] = await Promise.all([
    storage.pendingApprovalActions.find(approvalId),
    storage.approvals.get(approvalId),
    storage.chatToolRuns.get(request.toolRunId),
    storage.chatTurnTraces.get(request.turnId),
  ]);
  if (
    !pending ||
    pending.approvalId !== approvalId ||
    approval.approvalId !== approvalId ||
    pending.actionType !== "tool.invoke" ||
    (!allowSettled && pending.resolutionStatus !== "pending") ||
    !approvedExternalRuntimeRequestMatches(pending.request, request) ||
    approval.status !== "approved" ||
    tool.approvalId !== approvalId ||
    tool.toolRunId !== request.toolRunId ||
    tool.toolName !== request.toolName ||
    tool.sessionId !== request.sessionId ||
    tool.turnId !== request.turnId ||
    tool.status !== "approval_required" ||
    trace.sessionId !== request.sessionId ||
    trace.turnId !== request.turnId ||
    !trace.durable?.runId
  )
    return undefined;
  const run = await storage.durableRuns.getRun(trace.durable.runId);
  const authority = readDurableChatTurnExecutionPayloadAuthority({
    workflowKey: run.workflowKey,
    durableRunId: run.runId,
    payload: run.payload,
  });
  if (
    !authority ||
    run.runId !== trace.durable.runId ||
    (authority.request.policyRunId ?? run.runId) !== request.runId ||
    authority.capabilityProfileId ||
    !authority.featureReferenceSha256 ||
    authority.sessionId !== request.sessionId ||
    authority.turnId !== request.turnId ||
    authority.workspaceId !== request.workspaceId ||
    authority.requestActor.authActorId !== request.policyContext?.authActorId ||
    authority.requestActor.authActorSource !== request.policyContext?.authActorSource
  )
    return undefined;
  const stepId = authority.request.parentDelegationStepId;
  if (stepId || request.runId !== run.runId) {
    if (typeof stepId !== "string" || !stepId.trim()) return undefined;
    const step = await storage.chatDelegationSteps.get(stepId);
    if (
      step.stepId !== stepId ||
      step.runId !== request.runId ||
      step.status !== "running" ||
      step.childSessionId !== request.sessionId ||
      step.childTurnId !== request.turnId ||
      step.durableRunId !== run.runId
    ) {
      return undefined;
    }
  }
  const linkage = approval.linkage;
  if (
    !linkage ||
    linkage.sessionId !== request.sessionId ||
    linkage.turnId !== request.turnId ||
    linkage.workspaceId !== request.workspaceId ||
    linkage.runId !== request.runId ||
    linkage.toolName !== request.toolName ||
    (linkage.authActorId !== undefined && linkage.authActorId !== request.policyContext?.authActorId) ||
    (linkage.authActorSource !== undefined && linkage.authActorSource !== request.policyContext?.authActorSource)
  )
    return undefined;
  // Generic tool approvals use linkage.durableRunId for the approval-wait
  // workflow (ApprovalWaitRunService). linkage.runId retains policy accounting
  // (the delegation aggregate for a child). The canonical trace, decoded Chat
  // payload and exact child step above identify execution; the wait is not authority.
  const identity = {
    admissionId: authority.admissionId,
    sessionIncarnationId: authority.sessionIncarnationId,
    workspaceId: authority.workspaceId,
    sessionId: authority.sessionId,
    turnId: authority.turnId,
    aggregateRevision: authority.admissionAggregateRevision,
    controllerGeneration: authority.admissionControllerGeneration,
    materialSha256: authority.admissionMaterialSha256,
  };
  const [binding, durableBinding] = await Promise.all([
    storage.sessionMutationAdmissions.findFeatureReferences(identity),
    storage.sessionMutationAdmissions.findDurableRunBinding(identity),
  ]);
  if (
    !binding ||
    durableBinding?.durableRunId !== run.runId ||
    binding.referenceSha256 !== authority.featureReferenceSha256
  )
    return undefined;
  const receipts = (binding.references.requesterConnections ?? [])
    .filter((receipt) => "version" in receipt)
    .map(assertMcpRequesterAdmissionConnection);
  const selected = receipts.filter((receipt) =>
    receipt.selectedTools.some((tool) => tool.canonicalToolName === request.toolName),
  );
  const selectedStatic = (binding.references.selectedStaticMcp ?? [])
    .map(assertStaticMcpAdmissionReceipt)
    .filter((receipt) => receipt.selectedTools.some((tool) => tool.canonicalToolName === request.toolName));
  const mesh = binding.references.selectedMeshCapabilities;
  const selectedMesh = mesh?.selected.filter((item) => item.capabilityId === request.toolName) ?? [];
  if (selected.length + selectedMesh.length + selectedStatic.length !== 1) return undefined;
  const scope = selected[0]?.scope ?? selectedStatic[0]?.scope ?? mesh!.scope;
  if (
    canonicalJsonString({
      ...identity,
      actorId: authority.requestActor.authActorId,
      actorSource: authority.requestActor.authActorSource,
    }) !== canonicalJsonString(scope)
  )
    return undefined;
  await assertMcpRequesterAdmissionScopeCurrent(storage, scope);
  return { scope, referenceSha256: binding.referenceSha256 };
}

/** Materialize the existing effect owner's terminal receipt under the live Chat fence. Never dispatch here. */
export async function materializeRequesterAdmissionApproval(
  storage: ApprovalStorage,
  request: ToolInvokeRequest,
  approvalId: string,
  handle: AdmittedExternalTurnContextHandle,
  result: ToolInvokeResult,
): Promise<void> {
  const context = readAdmittedExternalTurnContext(handle);
  if (!context) throw new Error("Requester MCP live admission handle is missing.");
  await context.assertCurrent();
  const restored = await readApprovedRequesterAdmission(storage, approvalId, request, true);
  if (
    !restored ||
    restored.referenceSha256 !== context.referenceSha256 ||
    canonicalJsonString(restored.scope) !== canonicalJsonString(context.scope)
  ) {
    throw new Error("Requester MCP approved action no longer matches its live admission.");
  }
  await storage.runImmediateTransaction(async () => {
    await context.assertCurrent();
    const pending = await storage.pendingApprovalActions.find(approvalId);
    if (
      !pending ||
      !["executed", "failed"].includes(pending.resolutionStatus ?? "") ||
      canonicalJsonString(pending.result?.result ?? null) !== canonicalJsonString(result.result ?? null) ||
      pending.result?.auditEventId !== result.auditEventId ||
      pending.result?.outcome !== result.outcome
    )
      throw new Error("Approved requester MCP has no exact terminal effect receipt.");
    const receipt = await storage.externalSideEffectRuns.findByIdempotency(
      `external_side_effect:approved_external_runtime:${request.toolName}:unknown_connection:${approvalId}`,
      `approved-external-runtime:${approvalId}`,
      request.workspaceId!,
    );
    const receiptMatches =
      receipt?.status === "completed" &&
      receipt.workspaceId === request.workspaceId &&
      receipt.actionId === approvalId &&
      receipt.catalogId === request.toolName &&
      canonicalJsonString(receipt.responsePayload ?? null) === canonicalJsonString(pending.result ?? null);
    const uncertain =
      !receiptMatches ||
      result.result?.manualReconciliationRequired === true ||
      result.result?.externalOutcome === "unknown_after_send";
    const completed = result.outcome === "executed";
    await storage.chatToolRuns.patch(request.toolRunId!, {
      status: completed ? "executed" : "blocked",
      result: result.result ?? {},
      effectPotential: "unknown",
      effectDisposition: uncertain ? "unknown" : null,
      effectOutcomeKind: uncertain ? "uncertain" : "concrete",
      effectEvidence: uncertain
        ? {
            version: "goatcitadel.tool-effect.v1",
            outcomeKind: "uncertain",
            reason: "dispatch_may_have_occurred",
            refs: [],
          }
        : {
            version: "goatcitadel.tool-effect.v1",
            outcomeKind: "concrete",
            reason: "canonical_effect_receipt_linked",
            refs: [{ owner: "external_side_effect", refId: receipt!.runId }],
          },
      failureGuidance: uncertain ? "Inspect the persisted external outcome before retrying." : "",
      ...(completed ? {} : { error: result.policyReason }),
      finishedAt: new Date().toISOString(),
    });
    const inline = await storage.chatInlineApprovals.get(approvalId);
    if (inline)
      await storage.chatInlineApprovals.upsert({ ...inline, status: "approved", resolvedAt: new Date().toISOString() });
  });
}

export interface AdmittedExternalApprovalResumeHost {
  storage: Pick<
    AsyncStorage,
    | "chatToolRuns"
    | "approvals"
    | "pendingApprovalActions"
    | "durableRuns"
    | "sessionMutationAdmissions"
    | "sessionControls"
    | "chatTurnTraces"
    | "chatInlineApprovals"
    | "chatDelegationSteps"
    | "externalSideEffectRuns"
    | "runImmediateTransaction"
  >;
  refreshPolicy(approvalId: string): Promise<void>;
  executePending(
    approvalId: string,
    pending: PendingApprovalAction,
    signal?: AbortSignal,
    handle?: AdmittedExternalTurnContextHandle,
  ): Promise<ToolInvokeResult | undefined>;
}

/** Resume only through an existing live durable handle; never retry a settled external effect. */
export async function resumeAdmittedExternalApprovals(
  host: AdmittedExternalApprovalResumeHost,
  input: ChatTurnAgentRunnerInput,
  handle: AdmittedExternalTurnContextHandle,
): Promise<void> {
  const context = readAdmittedExternalTurnContext(handle);
  if (!context) throw new Error("Requester MCP continuation requires its live admission handle.");
  await context.assertCurrent();
  await assertChatFeatureBindingCurrent(host.storage, input);
  const selected = new Set(
    readMcpRequesterAdmissionTurnContext(handle)
      ? [
          ...(input.featureAdmission?.references.requesterConnections ?? []),
          ...(input.featureAdmission?.references.selectedStaticMcp ?? []),
        ].flatMap((connection) =>
          "selectedTools" in connection ? connection.selectedTools.map((tool) => tool.canonicalToolName) : [],
        )
      : (input.featureAdmission?.references.selectedMeshCapabilities?.selected ?? []).map((item) => item.capabilityId),
  );
  for (const tool of await host.storage.chatToolRuns.listByTurn(input.turnId)) {
    if (tool.status !== "approval_required" || !tool.approvalId || !selected.has(tool.toolName)) continue;
    const approval = await host.storage.approvals.get(tool.approvalId);
    if (approval.status !== "approved") continue;
    let pending = await host.storage.pendingApprovalActions.find(tool.approvalId);
    if (!pending) throw new Error("Approved requester MCP is missing its exact pending action.");
    let result: ToolInvokeResult | undefined;
    if (pending.resolutionStatus === "pending") {
      await host.refreshPolicy(tool.approvalId);
      pending = await host.storage.pendingApprovalActions.find(tool.approvalId);
      if (!pending) throw new Error("Approved requester MCP action disappeared.");
      await context.assertCurrent();
      result = await host.executePending(tool.approvalId, pending, input.signal, handle);
    } else {
      const stored = pending.result;
      if (
        !stored ||
        (stored.outcome !== "executed" && stored.outcome !== "blocked") ||
        typeof stored.policyReason !== "string" ||
        typeof stored.auditEventId !== "string"
      )
        throw new Error("Requester MCP terminal receipt is invalid.");
      result = {
        outcome: stored.outcome,
        policyReason: stored.policyReason,
        auditEventId: stored.auditEventId,
        ...(isRecord(stored.result) ? { result: stored.result } : {}),
      };
    }
    if (!result) throw new Error("Approved requester MCP did not produce an execution receipt.");
    await materializeRequesterAdmissionApproval(
      host.storage,
      toToolInvokeRequest(pending.request, input.signal),
      tool.approvalId,
      handle,
      result,
    );
  }
}
