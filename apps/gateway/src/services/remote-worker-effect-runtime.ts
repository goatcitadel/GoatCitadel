import {
  NotFoundError,
  TOOL_EFFECT_CLASSIFICATION_VERSION,
  canonicalJsonString,
  remoteWorkerInferenceCanonicalSha256 as digest,
  type ChatToolRunRecord,
  type ChatTurnCapabilityToolRuntimeOwnerBinding,
  type ChatTurnCapabilityProfileRecord,
  type PendingApprovalAction,
  type ExternalSideEffectRunRecord,
  type ToolInvokeResult,
  type ToolEffectPotential,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { runIdempotentExternalSideEffect } from "./external-side-effect-runner-service.js";
import {
  resolveRemoteWorkerChatProfile,
  type RemoteWorkerChatAuthorityDependencies,
} from "./remote-worker-chat-authority.js";
import {
  RemoteWorkerEffectSettlementService,
  type DispatchRemoteWorkerEffectInput,
  type RemoteWorkerEffectCoordinatorPort,
  type RemoteWorkerEffectDispatchOutcome,
} from "./remote-worker-effect-settlement-service.js";
import type { ToolInvocationCoordinator } from "./tool-invocation-coordinator-service.js";
import type { McpRequesterScopedTurnContextHandle } from "./mcp-requester-resolution-service.js";
import { toolInvokeResultFromPendingAction } from "./approved-external-runtime-side-effect-service.js";
import { isNativeMcpToolName, resolveNativeMcpChatToolBinding } from "./gateway/native-mcp-chat-binding.js";
import type { MeshChatTurnContextHandle } from "./gateway/mesh-chat-binding.js";
import type { MeshChatDispatchPort } from "./gateway/mesh-chat-dispatch.js";

type EffectStorage = Pick<
  AsyncStorage,
  | "remoteWorkerAssignments"
  | "remoteWorkerEffects"
  | "chatToolRuns"
  | "approvals"
  | "pendingApprovalActions"
  | "mutationIdempotency"
  | "externalSideEffectRuns"
  | "runImmediateTransaction"
> &
  RemoteWorkerChatAuthorityDependencies["storage"];
export interface RemoteWorkerEffectRuntimeDependencies extends RemoteWorkerChatAuthorityDependencies {
  storage: EffectStorage;
  coordinator: Pick<ToolInvocationCoordinator, "invokeTool">;
  executeApprovedAction?(input: RemoteWorkerApprovedActionInput): Promise<ToolInvokeResult>;
  /** Gateway-only factory; the profile is reloaded and verified by this effect owner. */
  createMcpRequesterTurnContext?(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopedTurnContextHandle | undefined;
  createMeshTurnContext?(profile: ChatTurnCapabilityProfileRecord): MeshChatTurnContextHandle;
  resolveMeshChatToolBinding?: MeshChatDispatchPort["resolveBinding"];
  withToolModelBudget(input: RemoteWorkerToolModelBudgetInput, operation: () => Promise<ToolInvokeResult>): Promise<ToolInvokeResult>;
}
export interface RemoteWorkerToolModelBudgetInput {
  fence: DispatchInput["fence"];
  intent: Awaited<ReturnType<EffectStorage["remoteWorkerEffects"]["readIntentForDispatch"]>>["intent"];
  checkExecution(): Promise<void>;
}
/** Only the native effect owner creates this in-process continuation port. */
export interface RemoteWorkerApprovedActionInput {
  approvalId: string;
  pending: PendingApprovalAction;
  runtimeOwner: ChatTurnCapabilityToolRuntimeOwnerBinding;
  effectPotential: ToolEffectPotential;
  mcpRequesterTurnContext?: McpRequesterScopedTurnContextHandle;
  meshTurnContext?: MeshChatTurnContextHandle;
  checkExecution(): Promise<void>;
  signal?: AbortSignal;
}
type DispatchInput = Parameters<RemoteWorkerEffectCoordinatorPort["dispatch"]>[0];

/**
 * Remote requests select an admitted tool; Gateway owns its retained arguments,
 * Chat invocation, policy, durable effect boundary and terminal evidence.
 * A stranded started invocation always needs reconciliation, never redispatch.
 */
export class RemoteWorkerEffectRuntime {
  private readonly settlement: RemoteWorkerEffectSettlementService;
  private readonly pending = new Map<string, Promise<RemoteWorkerEffectDispatchOutcome>>();
  public constructor(private readonly dependencies: RemoteWorkerEffectRuntimeDependencies) {
    if (typeof dependencies.withToolModelBudget !== "function")
      throw new Error("Worker effect execution requires its model budget owner.");
    this.settlement = new RemoteWorkerEffectSettlementService({
      repository: dependencies.storage.remoteWorkerEffects,
      coordinator: { dispatch: (input) => this.dispatch(input) },
    });
  }

  public async dispatchEffect(input: DispatchRemoteWorkerEffectInput) {
    input.signal?.throwIfAborted();
    return await this.settlement.dispatchEffect(input);
  }

  private async dispatch(input: DispatchInput): Promise<RemoteWorkerEffectDispatchOutcome> {
    // Include all immutable request fields. A colliding intent with different
    // arguments must reach the repository's exact-binding rejection.
    const key = digest({
      fence: input.fence,
      intentId: input.intentId,
      effectSelector: input.effectSelector,
      canonicalArgsSha256: input.canonicalArgsSha256,
      workerIdempotencyKey: input.workerIdempotencyKey,
    });
    const pending = this.pending.get(key);
    if (pending) return await pending;
    const work = this.dispatchOnce(input);
    this.pending.set(key, work);
    try {
      return await work;
    } finally {
      this.pending.delete(key);
    }
  }

  private async dispatchOnce(input: DispatchInput): Promise<RemoteWorkerEffectDispatchOutcome> {
    const { storage } = this.dependencies;
    const protectedAuthority = input.fence.protectedAuthority;
    if (!protectedAuthority) throw new Error("Worker effects require protected native authority.");
    const retained = await storage.remoteWorkerEffects.readIntentForDispatch({ ...input.fence, ...input });
    const check = async () => {
      input.signal?.throwIfAborted();
      const execution = await storage.remoteWorkerAssignments.resolveActiveChatExecution(
        input.fence,
        protectedAuthority,
      );
      const binding = await resolveRemoteWorkerChatProfile(this.dependencies, execution);
      const selected = binding.profile.selection.tools.find(
        (tool) => tool.canonicalName === retained.intent.effectSelector,
      );
      if (!execution.authority.assignment.manifest.requiredCapabilityClasses.includes("governed_tool") || !selected)
        throw new Error("Worker effect is outside its admitted tool capabilities.");
      if (!selected.runtimeOwner || !selected.effectPotential)
        throw new Error("Worker effect requires a frozen runtime owner and effect classification.");
      // Scoped tools enter their existing Gateway owner with a context minted
      // from this verified profile; a worker-supplied selector is not authority.
      if ((selected.meshPublication && (!this.dependencies.createMeshTurnContext || !this.dependencies.resolveMeshChatToolBinding)) ||
        (isNativeMcpToolName(selected.canonicalName) && !selected.mcpRequesterResolution && !selected.mcpStaticBinding))
        throw new Error("Worker effect requires its canonical scoped runtime owner.");
      return { execution, ...binding, selected };
    };
    const binding = await check();
    const withModelBudget = (checkExecution: () => Promise<void>, operation: () => Promise<ToolInvokeResult>) =>
      this.dependencies.withToolModelBudget({ fence: input.fence, intent: retained.intent, checkExecution }, operation);
    const { profile, policy, selected } = binding;
    const mcpRequesterTurnContext = selected.canonicalName === "mcp.invoke" || selected.mcpRequesterResolution || selected.mcpStaticBinding
      ? this.dependencies.createMcpRequesterTurnContext?.(profile)
      : undefined;
    const meshTurnContext = selected.meshPublication ? this.dependencies.createMeshTurnContext?.(profile) : undefined;
    const manifest = binding.execution.authority.assignment.manifest;
    const toolRunId = `remote-tool:${retained.intent.intentId}`;
    const idempotencyKey = `chat-tool-effect:${toolRunId}`;
    const actorScope = profile.identity.workspaceId;
    const routePath = `external_side_effect:remote_worker_tool:${selected.canonicalName}:unknown_connection:${toolRunId}`;
    const context = {
      toolRunId,
      toolName: selected.canonicalName,
      sessionId: profile.identity.sessionId,
      turnId: profile.identity.turnId,
      workspaceId: profile.identity.workspaceId,
      runId: manifest.durableRunId,
      idempotencyKey,
    };
    // Validate the brand and exact profile/actor/target before starting a Chat
    // tool run. Native arguments cannot mint or redirect requester authority.
    await resolveNativeMcpChatToolBinding(storage, {
      ...context,
      args: retained.args,
      agentId: "assistant",
      citadelId: profile.identity.citadelId,
      policyContext: policy,
    }, mcpRequesterTurnContext);
    if (selected.meshPublication && (!meshTurnContext || !await this.dependencies.resolveMeshChatToolBinding?.({
      ...context, args: retained.args, agentId: "assistant", citadelId: profile.identity.citadelId,
      policyContext: policy, permissionProfileId: policy.permissionProfileId,
    }, meshTurnContext))) throw new Error("Worker mesh effect has no exact current frozen binding.");

    const previous = await storage.runImmediateTransaction(async () => {
      await check();
      try {
        return await storage.chatToolRuns.get(toolRunId);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      await storage.chatToolRuns.create({
        ...context,
        args: retained.args,
        status: "started",
        effectPotential: selected.effectPotential?.potential ?? "unknown",
        effectDisposition: "none",
        effectOutcomeKind: "none",
        effectEvidence: {
          version: TOOL_EFFECT_CLASSIFICATION_VERSION,
          outcomeKind: "none",
          reason: "planned_before_dispatch",
          refs: [],
        },
      });
      return undefined;
    });
    const readOutcome = async () => {
      const tool = await storage.chatToolRuns.get(toolRunId);
      if (tool.approvalId) {
        const approvedKey = `approved-external-runtime:${tool.approvalId}`;
        const approvedOwner = await storage.externalSideEffectRuns.findByIdempotency(
          `external_side_effect:approved_external_runtime:${tool.toolName}:unknown_connection:${tool.approvalId}`,
          approvedKey, actorScope);
        if (approvedOwner) return await this.outcome(tool, approvedOwner,
          { ...context, idempotencyKey: approvedKey, sideEffectActionId: tool.approvalId }, retained.args);
      }
      const owner = await storage.externalSideEffectRuns.findByIdempotency(routePath, idempotencyKey, actorScope);
      return await this.outcome(tool, owner, context, retained.args);
    };
    if (previous) {
      if (previous.status === "approval_required" && previous.approvalId && this.dependencies.executeApprovedAction) {
        const approval = await storage.approvals.get(previous.approvalId);
        if (approval.status === "approved") {
          const resume = await storage.remoteWorkerAssignments.resolveActiveChatApprovalResume(input.fence, protectedAuthority);
          if (resume?.material.approvalId === approval.approvalId && resume.material.intentId === retained.intent.intentId) {
            const checkApproved = async () => {
              await check();
              const currentResume = await storage.remoteWorkerAssignments.resolveActiveChatApprovalResume(input.fence, protectedAuthority);
              const currentApproval = await storage.approvals.get(approval.approvalId);
              const pendingAction = await storage.pendingApprovalActions.find(approval.approvalId);
              if (!pendingAction) throw new Error("Worker approved action has no pending request.");
              const original: PendingApprovalAction = { ...pendingAction, resolutionStatus: "pending" };
              delete original.resolvedAt;
              delete original.result;
              if (currentResume?.materialSha256 !== resume.materialSha256 ||
                currentApproval.status !== "approved" || digest(currentApproval) !== resume.material.approvalSha256 ||
                digest(original) !== resume.material.pendingActionSha256)
                throw new Error("Worker approved action drifted from its canonical handoff.");
              return pendingAction;
            };
            const pendingAction = await checkApproved();
            const result = pendingAction.resolutionStatus === "pending"
              ? await withModelBudget(async () => { await checkApproved(); }, () => this.dependencies.executeApprovedAction!({
                  approvalId: approval.approvalId, pending: pendingAction, runtimeOwner: selected.runtimeOwner!,
                  effectPotential: selected.effectPotential!.potential,
                  ...(mcpRequesterTurnContext ? { mcpRequesterTurnContext } : {}),
                  ...(meshTurnContext ? { meshTurnContext } : {}),
                  checkExecution: async () => { await checkApproved(); }, signal: input.signal }))
              : toolInvokeResultFromPendingAction(pendingAction);
            await storage.runImmediateTransaction(async () => {
              // Persist already-settled effect truth even if the worker lease
              // expires after dispatch; later execution still needs fresh authority.
              const settled = await storage.pendingApprovalActions.find(approval.approvalId);
              const approvedOwner = await storage.externalSideEffectRuns.findByIdempotency(
                `external_side_effect:approved_external_runtime:${selected.canonicalName}:unknown_connection:${approval.approvalId}`,
                `approved-external-runtime:${approval.approvalId}`, actorScope);
              if (!settled || settled.resolutionStatus === "pending" || !approvedOwner)
                throw new Error("Worker approval execution has no canonical terminal owner.");
              const original: PendingApprovalAction = { ...settled, resolutionStatus: "pending" };
              delete original.resolvedAt;
              delete original.result;
              const resultRecord = { outcome: result.outcome, policyReason: result.policyReason,
                auditEventId: result.auditEventId, result: result.result };
              if (digest(original) !== resume.material.pendingActionSha256 ||
                settled.resolutionStatus !== (result.outcome === "executed" ? "executed" : "failed") ||
                canonicalJsonString(settled.result) !== canonicalJsonString(resultRecord) ||
                !["completed", "unknown_external_outcome", "failed_before_boundary"].includes(approvedOwner.status) ||
                (approvedOwner.status === "completed" &&
                  canonicalJsonString(approvedOwner.responsePayload) !== canonicalJsonString(resultRecord)))
                throw new Error("Worker approved result differs from its canonical terminal evidence.");
              const currentTool = await storage.chatToolRuns.get(toolRunId);
              if (currentTool.approvalId !== approval.approvalId || currentTool.toolName !== selected.canonicalName ||
                canonicalJsonString(currentTool.args) !== canonicalJsonString(retained.args))
                throw new Error("Worker approved tool materialization changed its invocation.");
              const successful = result.outcome === "executed" && !reportedFailure(result) && approvedOwner.status === "completed";
              const crossed = Boolean(approvedOwner.externalCallStartedAt);
              const missingEffectReceipt = successful && !crossed && selected.effectPotential?.potential !== "none";
              const uncertain = (crossed && !successful) || approvedOwner.status === "unknown_external_outcome" ||
                result.result?.manualReconciliationRequired === true || missingEffectReceipt;
              const kind = uncertain ? "uncertain" : crossed ? "concrete" : "none";
              await storage.chatToolRuns.patch(toolRunId, { status: successful ? "executed" : "failed",
                result: result.result ?? {}, finishedAt: approvedOwner.completedAt ?? new Date().toISOString(),
                effectDisposition: uncertain ? "unknown" : crossed ? null : "none", effectOutcomeKind: kind,
                effectEvidence: { version: TOOL_EFFECT_CLASSIFICATION_VERSION, outcomeKind: kind,
                  reason: missingEffectReceipt ? "completed_without_canonical_effect_receipt" : uncertain ? "dispatch_may_have_occurred" : crossed ? "canonical_effect_receipt_linked" : successful ? "trusted_safe_read" : "pre_dispatch_blocked",
                  refs: kind === "concrete" ? [{ owner: "external_side_effect", refId: approvedOwner.runId }] : [] } });
            });
          }
        }
      }
      return await readOutcome();
    }

    let observedResult: ToolInvokeResult | undefined;
    const sideEffect = await runIdempotentExternalSideEffect({
      mutationStore: storage.mutationIdempotency,
      sideEffectRunStore: storage.externalSideEffectRuns,
      runClaimTransaction: (work) => storage.runImmediateTransaction(work),
      workspaceId: actorScope,
      boundary: "remote_worker_tool",
      catalogId: selected.canonicalName,
      actionId: toolRunId,
      actorScope,
      idempotencyKey,
      checkedAt: new Date().toISOString(),
      payload: {
        ...context,
        intentId: retained.intent.intentId,
        intentSha256: retained.intent.intentSha256,
        canonicalArgsSha256: retained.intent.canonicalArgsSha256,
      },
      label: "Remote worker tool",
      requireMutationClaimOwnership: true,
      requireDurableBoundaryRecord: true,
      execute: async (claim) => {
        const boundary = async () => {
          await storage.runImmediateTransaction(async () => {
            await check();
            await claim.markExternalCallStarted();
            await storage.chatToolRuns.patch(toolRunId, {
              effectDisposition: "unknown",
              effectOutcomeKind: "uncertain",
              effectEvidence: {
                version: TOOL_EFFECT_CLASSIFICATION_VERSION,
                outcomeKind: "uncertain",
                reason: "dispatch_may_have_occurred",
                refs: [],
              },
            });
          });
        };
        const result = await withModelBudget(async () => { await check(); }, () => this.dependencies.coordinator.invokeTool(
          {
            ...context,
            args: retained.args,
            agentId: "assistant",
            taskId: manifest.taskId,
            citadelId: profile.identity.citadelId,
            surface: "chat",
            policyContext: policy,
            signal: input.signal,
            permissionProfileId: policy.permissionProfileId,
            localOperatorOverrideId: policy.localOperatorOverrideId,
          },
          {
            executionFence: async () => {
              await check();
            },
            auxiliaryEffectFence: boundary,
            ...(selected.effectPotential?.potential === "unknown" ? { beforeBuiltinExecute: boundary } : {}),
            externalSideEffect: { markStarted: boundary, markNotRequired: () => {
              if (!claim.externalCallStarted) claim.markExternalCallNotRequired();
            } },
            effectContext: context,
            effectPotential: selected.effectPotential,
            ...(mcpRequesterTurnContext ? { mcpRequesterTurnContext } : {}),
            ...(meshTurnContext ? { meshTurnContext } : {}),
            toolRuntimeOwner: selected.runtimeOwner,
            ...(profile.catalog.runtimeInterpositionHash === undefined ||
            profile.catalog.toolCallBeforeHookCount === undefined
              ? {}
              : {
                  toolCallBeforeHookInterposition: {
                    hash: profile.catalog.runtimeInterpositionHash,
                    count: profile.catalog.toolCallBeforeHookCount,
                  },
                }),
          },
        ));
        observedResult = result;
        if (!claim.externalCallStarted) claim.markExternalCallNotRequired();
        // A channel failure can be returned as a tool result. It cannot certify
        // a completed external effect merely because the invocation returned.
        if (claim.externalCallStarted && (result.outcome !== "executed" || reportedFailure(result)))
          throw new Error("Worker tool crossed its boundary without a confirmed successful result.");
        return result;
      },
      commitCompleted: async (claim, result) => {
        await storage.runImmediateTransaction(async () => {
          if (
            !claim.claimToken ||
            !claim.sideEffectRunId ||
            !(await storage.mutationIdempotency.markCompleted({
              method: "POST",
              routePath: claim.routePath,
              idempotencyKey: claim.idempotencyKey,
              actorScope: claim.actorScope,
              claimToken: claim.claimToken,
              updatedAt: new Date().toISOString(),
            }))
          )
            throw new Error("Worker effect lost canonical mutation ownership.");
          const owner = await storage.externalSideEffectRuns.markCompleted(claim.sideEffectRunId, {
            responsePayload: { toolRunId, outcome: result.outcome, auditEventId: result.auditEventId },
          });
          const concrete = claim.externalCallStarted && result.outcome === "executed";
          const uncertain =
            !concrete && result.outcome === "executed" && selected.effectPotential?.potential !== "none";
          const outcomeKind = concrete ? "concrete" : uncertain ? "uncertain" : "none";
          await storage.chatToolRuns.patch(toolRunId, {
            status: result.outcome,
            approvalId: result.approvalId,
            result: result.result ?? {},
            finishedAt: owner.completedAt,
            effectDisposition: concrete ? null : uncertain ? "unknown" : "none",
            effectOutcomeKind: outcomeKind,
            effectEvidence: {
              version: TOOL_EFFECT_CLASSIFICATION_VERSION,
              outcomeKind,
              reason: concrete
                ? "canonical_effect_receipt_linked"
                : uncertain
                  ? "completed_without_canonical_effect_receipt"
                  : result.outcome === "executed"
                    ? "trusted_safe_read"
                    : result.outcome === "approval_required"
                      ? "approval_wait_before_dispatch"
                      : "pre_dispatch_blocked",
              refs: concrete ? [{ owner: "external_side_effect", refId: owner.runId }] : [],
            },
          });
        });
      },
    });
    if (sideEffect.status === "failed") {
      const crossed = sideEffect.claim.resumeState !== "manual_retry_after_recorded_failure";
      await storage.chatToolRuns.patch(toolRunId, {
        status: observedResult?.outcome === "approval_required" ? "approval_required" : "failed",
        approvalId: observedResult?.approvalId,
        error: crossed ? "External outcome requires reconciliation." : "Tool failed before its external boundary.",
        finishedAt: new Date().toISOString(),
        effectDisposition: crossed ? "unknown" : "none",
        effectOutcomeKind: crossed ? "uncertain" : "none",
        effectEvidence: {
          version: TOOL_EFFECT_CLASSIFICATION_VERSION,
          outcomeKind: crossed ? "uncertain" : "none",
          reason: crossed ? "interrupted_after_possible_dispatch" : "pre_dispatch_blocked",
          refs: [],
        },
      });
    }
    return await readOutcome();
  }

  private async outcome(
    tool: ChatToolRunRecord,
    owner: ExternalSideEffectRunRecord | undefined,
    context: {
      toolRunId: string;
      toolName: string;
      sessionId: string;
      turnId: string;
      workspaceId: string;
      runId: string;
      idempotencyKey: string;
      sideEffectActionId?: string;
    },
    args: Record<string, unknown>,
  ): Promise<RemoteWorkerEffectDispatchOutcome> {
    if (
      tool.toolRunId !== context.toolRunId ||
      tool.toolName !== context.toolName ||
      tool.sessionId !== context.sessionId ||
      tool.turnId !== context.turnId ||
      canonicalJsonString(tool.args ?? {}) !== canonicalJsonString(args) ||
      (owner &&
        (owner.workspaceId !== context.workspaceId ||
          owner.idempotencyKey !== context.idempotencyKey ||
          owner.actionId !== (context.sideEffectActionId ?? tool.toolRunId) ||
          owner.catalogId !== tool.toolName))
    )
      throw new Error("Worker effect canonical correlation changed.");
    if (tool.status === "started")
      throw new Error("Worker effect is in progress or requires reconciliation; redispatch is disabled.");
    const approval = tool.approvalId ? await this.dependencies.storage.approvals.get(tool.approvalId) : undefined;
    if (
      approval &&
      (approval.linkage?.workspaceId !== context.workspaceId ||
        approval.linkage.sessionId !== context.sessionId ||
        approval.linkage.turnId !== context.turnId ||
        approval.linkage.runId !== context.runId ||
        approval.linkage.toolName !== context.toolName)
    )
      throw new Error("Worker approval is not linked to its canonical Chat invocation.");
    const approvalRecordSha256 = approval ? digest(approval) : null;
    const boundaryReceiptSha256 = owner?.externalCallStartedAt
      ? digest({
          schemaVersion: "goatcitadel.remote-worker-effect-boundary.v1",
          runId: owner.runId,
          workspaceId: owner.workspaceId,
          idempotencyKey: owner.idempotencyKey,
          payloadHash: owner.payloadHash,
          externalCallStartedAt: owner.externalCallStartedAt,
        })
      : null;
    if (
      tool.effectOutcomeKind === "concrete" &&
      tool.status === "executed" &&
      owner?.status === "completed" &&
      (context.sideEffectActionId !== undefined || owner.responsePayload?.toolRunId === tool.toolRunId) &&
      owner.responsePayload?.outcome === "executed" &&
      tool.effectEvidence?.refs.some((ref) => ref.owner === "external_side_effect" && ref.refId === owner.runId) &&
      boundaryReceiptSha256
    )
      return {
        kind: "completed_with_effect",
        externalSideEffectRunId: owner.runId,
        boundaryReceiptSha256,
        hx305OutcomeSha256: digest(tool),
      };
    if (tool.effectOutcomeKind === "none" && !owner?.externalCallStartedAt) {
      if (tool.status === "failed")
        return { kind: "failed_before_boundary", sanitizedError: "Tool failed before its external boundary." };
      if (tool.status === "executed") {
        if (owner?.status !== "completed") throw new Error("Worker effect completion owner is unavailable.");
        return {
          kind: "completed_no_effect",
          externalSideEffectRunId: owner.runId,
          boundaryReceiptSha256: digest({
            schemaVersion: "goatcitadel.remote-worker-effect-no-boundary.v1",
            runId: owner.runId,
            idempotencyKey: owner.idempotencyKey,
            completedAt: owner.completedAt,
          }),
        };
      }
      if (tool.status === "approval_required" && approval && (approval.status === "pending" || approval.status === "approved"))
        return { kind: "waiting_approval", approvalRecordSha256: digest(approval) };
      return {
        kind: "blocked_before_dispatch",
        approvalRecordSha256,
        approvalWaited: tool.status === "approval_required",
        sanitizedError:
          tool.status === "approval_required"
            ? "The tool approval did not authorize execution."
            : "Current policy blocked the tool.",
      };
    }
    if (!owner) throw new Error("Worker effect owner is unavailable; reconciliation is required.");
    return {
      kind: "manual_reconciliation",
      externalSideEffectRunId: owner.runId,
      boundaryReceiptSha256,
      approvalRecordSha256,
      approvalWaited: tool.status === "approval_required",
      sanitizedError: "External outcome requires canonical owner reconciliation; automatic replay is disabled.",
    };
  }
}

function reportedFailure(result: ToolInvokeResult): boolean {
  return (
    result.result?.ok === false ||
    result.result?.success === false ||
    ["failed", "error", "unknown", "not_available", "unknown_after_send"].includes(
      String(result.result?.status ?? ""),
    ) ||
    ["failed", "not_available", "unknown_after_send"].includes(String(result.result?.deliveryStatus ?? ""))
  );
}
