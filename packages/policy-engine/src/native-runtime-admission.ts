import {
  canonicalJsonString,
  remoteWorkerAssignmentCanonicalSha256,
  normalizeRemoteWorkerRuntimeResultExpectation,
  type ToolAccessEvaluateRequest,
  type ToolAccessEvaluateResponse,
} from "@goatcitadel/contracts";
import { normalizeWindowsRuntimeDispatch } from "@goatcitadel/contracts/remote-worker-runtime-node";
import {
  snapshotRemoteWorkerCellCapacityInventoryAdmission,
  type AsyncStorage,
  type RemoteWorkerRuntimeAdmissionInput,
  type RemoteWorkerRuntimeAdmissionResult,
} from "@goatcitadel/storage";

type Storage = Pick<
  AsyncStorage,
  | "runImmediateTransaction"
  | "approvals"
  | "remoteWorkerAssignments"
  | "remoteWorkerRuntimeAdmissions"
  | "remoteWorkerNativePolicyReservations"
  | "toolGrants"
  | "toolAccessDecisions"
>;
export type NativeRuntimePolicyAdmissionInput = RemoteWorkerRuntimeAdmissionInput & { readonly signal?: AbortSignal };

/** Internal policy/commit boundary. The repository validates the exact native
 * approval and resumed parent. No ordinary tool approval is forged and no local
 * executor is called. A failed grant debit or audit write rolls admission back. */
export async function admitNativeRuntimeWithPolicy(
  storage: Storage,
  evaluate: (request: ToolAccessEvaluateRequest) => Promise<ToolAccessEvaluateResponse>,
  policyRequest: ToolAccessEvaluateRequest,
  input: NativeRuntimePolicyAdmissionInput,
): Promise<RemoteWorkerRuntimeAdmissionResult> {
  const signal = input.signal,
    approvalId = input.approvalId;
  const command = {
    ...snapshotRemoteWorkerCellCapacityInventoryAdmission(input),
    approvalId,
    request: normalizeWindowsRuntimeDispatch(input.request),
    expectation: normalizeRemoteWorkerRuntimeResultExpectation(input.expectation),
  };
  const request = structuredClone(policyRequest);
  signal?.throwIfAborted();
  const imagePrefix = `"${command.request.launch.image}"`;
  if (
    !command.request.launch.commandLine.startsWith(imagePrefix) ||
    (command.request.launch.commandLine.length > imagePrefix.length &&
      !/^[ \t]/u.test(command.request.launch.commandLine.slice(imagePrefix.length)))
  )
    throw new Error("Native admission requires the exact quoted executable image.");
  if (
    request.toolName !== "shell.exec" ||
    request.agentId !== "assistant" ||
    request.surface !== "chat" ||
    canonicalJsonString(request.args) !==
      canonicalJsonString({ command: command.request.launch.commandLine, cwd: command.request.launch.directory })
  )
    throw new Error("Native admission requires the exact shell policy request.");
  return storage.runImmediateTransaction(async () => {
    signal?.throwIfAborted();
    // Match the native repository's approval -> credential -> assignment lock
    // order before resolving execution authority inside this transaction.
    await storage.approvals.lockApprovedForUpdate(command.approvalId);
    const execution = await storage.remoteWorkerAssignments.resolveActiveChatExecution(
      command,
      command.protectedAuthority,
    );
    const manifest = execution.authority.assignment.manifest;
    if (
      request.sessionId !== manifest.sessionId ||
      request.workspaceId !== manifest.executionWorkspaceId ||
      request.taskId !== manifest.taskId ||
      request.runId !== manifest.durableRunId
    )
      throw new Error("Native admission policy scope differs from its active Chat execution.");
    const decision = await evaluate(request);
    signal?.throwIfAborted();
    if (
      !decision.allowed ||
      decision.toolName !== "shell.exec" ||
      (decision.wardEffect !== undefined &&
        decision.wardEffect !== "allow" &&
        decision.wardEffect !== "require_approval")
    )
      throw new Error("Native admission is denied by current tool policy.");
    const admission = await storage.remoteWorkerRuntimeAdmissions.admitPreparedForAssignment(command);
    signal?.throwIfAborted();
    if (admission.decision !== "accept") return admission;
    if (decision.matchedGrantId && !(await storage.toolGrants.consumeOne(decision.matchedGrantId)))
      throw new Error("Native admission tool grant is no longer available.");
    const recorded = await storage.toolAccessDecisions.record({
      toolName: request.toolName,
      agentId: request.agentId,
      sessionId: request.sessionId,
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      runId: request.runId,
      allowed: true,
      reasonCodes: decision.reasonCodes,
      matchedGrantId: decision.matchedGrantId,
      requiresApproval: decision.requiresApproval,
      riskLevel: decision.riskLevel,
      permissionProfileId: decision.permissionProfileId,
      localOperatorOverrideId: decision.localOperatorOverrideId,
      countsTowardLimits: true,
    });
    await storage.remoteWorkerNativePolicyReservations.retainForAssignment({
      ...command,
      nonce: command.expectation.nonce,
      requestSha256: command.expectation.requestSha256,
      policyRequestSha256: remoteWorkerAssignmentCanonicalSha256(request),
      decisionId: recorded.decisionId,
    });
    signal?.throwIfAborted();
    return admission;
  });
}
