import {
  canonicalJsonString,
  readDurableChatTurnExecutionPayloadAuthority,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import { assertChatFeatureBindingCurrent } from "./chat-feature-binding-current.js";

/** Approval effects may wake the parent; only its live turn may launch children. */
export class ChatFanoutApprovalResumeRequiredError extends Error {
  constructor() {
    super("Automatic fanout approval requires its resumed durable Chat owner.");
    this.name = "ChatFanoutApprovalResumeRequiredError";
  }
}

/** The effect worker yields to the durable Chat owner without launching children. */
export async function yieldFanoutApprovalEffect(
  host: { storage: Pick<AsyncStorage, "approvalEffects"> },
  error: unknown,
  effect: { effectId: string; version: number },
  workerId: string,
  actionType: string,
): Promise<boolean> {
  if (!(error instanceof ChatFanoutApprovalResumeRequiredError)) return false;
  await host.storage.approvalEffects.skipEffect(effect.effectId, workerId, effect.version, {
    result: { reason: "chat_fanout_resume_required", actionType, resolutionStatus: "pending" },
  });
  return true;
}

type FanoutApprovalStorage = Pick<
  AsyncStorage,
  | "durableRuns"
  | "sessionMutationAdmissions"
  | "chatToolRuns"
  | "pendingApprovalActions"
  | "approvals"
  | "chatInlineApprovals"
  | "chatFanoutInvocations"
>;

export async function resumeChatFanoutApprovals(
  host: {
    storage: FanoutApprovalStorage;
    refreshPolicy(approvalId: string): Promise<void>;
    executeApprovedAction(
      approvalId: string,
      beforeExecute: () => Promise<void>,
    ): Promise<ToolInvokeResult | undefined>;
    readToolResult(parentRunId: string, toolRunId: string): Promise<Record<string, unknown> | undefined>;
  },
  input: ChatTurnAgentRunnerInput,
): Promise<void> {
  const runId = input.canonicalDurableRunId ?? input.policyRunId;
  const fence = input.canonicalWriteFence;
  if (!fence || !runId || input.parentDelegationStepId)
    throw new Error("Fanout approval requires the current durable parent claim.");
  const assertCurrent = async () => {
    if (input.signal?.aborted) throw new Error("Fanout approval turn was cancelled.");
    await fence(async () => {
      const run = await host.storage.durableRuns.getRun(runId);
      const authority = readDurableChatTurnExecutionPayloadAuthority({
        workflowKey: run.workflowKey,
        durableRunId: runId,
        payload: run.payload,
      });
      if (
        !authority ||
        run.status !== "running" ||
        authority.sessionId !== input.sessionId ||
        authority.turnId !== input.turnId ||
        authority.workspaceId !== input.workspaceId ||
        authority.requestActor.authActorId !== input.authActorId ||
        authority.requestActor.authActorSource !== input.authActorSource
      )
        throw new Error("Fanout approval durable authority changed.");
    });
    if (input.featureAdmission) await assertChatFeatureBindingCurrent(host.storage, input);
  };
  await assertCurrent();
  for (const tool of await host.storage.chatToolRuns.listByTurn(input.turnId)) {
    if (tool.toolName !== "agent.fanout" || tool.status !== "approval_required" || !tool.approvalId) continue;
    const approval = await host.storage.approvals.get(tool.approvalId);
    // Public edit is withdrawal of the exact action, not authority to dispatch.
    if (approval.status !== "approved") continue;
    let pending = await host.storage.pendingApprovalActions.find(tool.approvalId);
    const assertBinding = () => {
      const request = pending?.request;
      const actor = request?.policyContext as Record<string, unknown> | undefined;
      if (
        !pending ||
        pending.actionType !== "tool.invoke" ||
        request?.toolName !== "agent.fanout" ||
        request.sessionId !== input.sessionId ||
        request.turnId !== input.turnId ||
        request.toolRunId !== tool.toolRunId ||
        request.runId !== runId ||
        request.workspaceId !== input.workspaceId ||
        actor?.authActorId !== input.authActorId ||
        actor?.authActorSource !== input.authActorSource ||
        canonicalJsonString(request.args ?? {}) !== canonicalJsonString(tool.args ?? {}) ||
        approval.linkage?.sessionId !== input.sessionId ||
        approval.linkage.turnId !== input.turnId ||
        approval.linkage.runId !== runId ||
        approval.linkage.toolName !== "agent.fanout"
      ) {
        throw new Error("Fanout approval no longer matches its exact pending parent action.");
      }
    };
    assertBinding();
    let result: ToolInvokeResult | undefined;
    if (pending!.resolutionStatus === "pending") {
      await host.refreshPolicy(tool.approvalId);
      pending = await host.storage.pendingApprovalActions.find(tool.approvalId);
      assertBinding();
      await assertCurrent();
      result = await host.executeApprovedAction(tool.approvalId, assertCurrent);
    } else {
      const stored = pending!.result;
      if (
        !stored ||
        !["executed", "blocked"].includes(String(stored.outcome)) ||
        typeof stored.policyReason !== "string" ||
        typeof stored.auditEventId !== "string"
      )
        throw new Error("Fanout approval terminal receipt is unavailable.");
      result = stored as unknown as ToolInvokeResult;
    }
    if (!result) throw new Error("Fanout approval has no policy execution receipt.");
    await assertCurrent();
    await fence(async () => {
      const invocation = await host.storage.chatFanoutInvocations.findByParentAndTool(runId, tool.toolRunId);
      if (
        result.outcome === "executed" &&
        (!invocation ||
          result.result?.fanoutInvocationId !== invocation.invocationId ||
          result.result?.parentRunId !== runId ||
          result.result?.toolRunId !== tool.toolRunId)
      ) {
        throw new Error("Fanout approval result has no exact canonical aggregate.");
      }
      await host.storage.chatToolRuns.patch(tool.toolRunId, {
        status: result.outcome === "executed" ? "executed" : "blocked",
        result: result.result ?? {},
        ...(result.outcome === "executed" ? {} : { error: result.policyReason }),
        // Child state is proven by the fanout aggregate, not an external-effect receipt.
        effectPotential: "unknown",
        effectDisposition: "unknown",
        effectOutcomeKind: "uncertain",
        effectEvidence: {
          version: "goatcitadel.tool-effect.v1",
          outcomeKind: "uncertain",
          reason: "completed_without_canonical_effect_receipt",
          refs: [],
        },
        finishedAt: new Date().toISOString(),
      });
      const inline = await host.storage.chatInlineApprovals.get(tool.approvalId!);
      if (inline)
        await host.storage.chatInlineApprovals.upsert({
          ...inline,
          status: "approved",
          resolvedAt: new Date().toISOString(),
        });
    });
  }
  // A child wake reuses the original tool call. Refresh its bounded committed
  // output before the runner decides whether to park or synthesize; never ask
  // the model to issue a second fanout to recover the first one's results.
  await assertCurrent();
  await fence(async () => {
    for (const tool of await host.storage.chatToolRuns.listByTurn(input.turnId)) {
      if (tool.toolName !== "agent.fanout" || tool.status !== "executed") continue;
      const result = await host.readToolResult(runId, tool.toolRunId);
      if (
        !result ||
        result.parentRunId !== runId ||
        result.toolRunId !== tool.toolRunId ||
        result.fanoutInvocationId !== tool.result?.fanoutInvocationId
      )
        throw new Error("Resumed fanout has no exact canonical result.");
      if (canonicalJsonString(result) !== canonicalJsonString(tool.result))
        await host.storage.chatToolRuns.patch(tool.toolRunId, { result });
    }
  });
}
