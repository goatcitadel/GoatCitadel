import {
  REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS,
  appendRemoteWorkerChatToolResults,
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerChatInferenceIdentity,
  remoteWorkerInferenceCanonicalSha256,
  type RemoteWorkerChatToolResult,
} from "@goatcitadel/contracts";
import type { LeaseBinding, RouteContext } from "./connected-worker-routes.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { exchangeWorkerChatTool } from "./worker-chat-tool-execution.js";
import { withRenewingWorkerLease } from "./worker-execution-lease.js";
import { buildWorkerInferenceSubmission, exchangeWorkerInference } from "./worker-inference-execution.js";
import type { ConnectedWorkerStage } from "./worker-runtime-config.js";
import { normalizeRemoteWorkerNativeChatContext, remoteWorkerNativeChatContextSha256, normalizeRemoteWorkerNativeChatHistory } from "@goatcitadel/contracts";

/** Restart reconstructs the same bounded sequence through Gateway receipts.
 * Local state never decides that a model request or tool effect completed. */
export async function runWorkerChatWorkflow(input: {
  context: RouteContext;
  owner: WorkerAssignmentLeaseOwner;
  lease: LeaseBinding;
  workload: Record<string, unknown>;
  observed: Record<string, unknown>;
  stages: ConnectedWorkerStage[];
  stopAfter: ConnectedWorkerStage;
}): Promise<{ lease: LeaseBinding; completed: boolean; lines: readonly string[]; usageEventIds: readonly string[] }> {
  const base = buildWorkerInferenceSubmission(input.workload, input.lease);
  const history = input.workload.nativeChatHistory ? normalizeRemoteWorkerNativeChatHistory(input.workload.nativeChatHistory) : undefined;
  const priorModelSteps = history?.priorModelSteps ?? 0;
  const continuationSha256 = input.workload.nativeChatContext
    ? remoteWorkerNativeChatContextSha256(normalizeRemoteWorkerNativeChatContext(input.workload.nativeChatContext)) : undefined;
  let lease = input.lease;
  let messages = base.messages;
  let usageEventIds: readonly string[] = history?.usageEventIds ?? [];
  const stopped = () => ({ lease, completed: false, lines: [], usageEventIds });
  const stage = (value: ConnectedWorkerStage) => {
    if (!input.stages.includes(value)) input.stages.push(value);
  };
  for (let stepIndex = 0; stepIndex < REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS - priorModelSteps; stepIndex++) {
    const identity = remoteWorkerChatInferenceIdentity({ ...base, continuationSha256 }, stepIndex);
    const execution = await withRenewingWorkerLease(
      { ...input, lease, workerSentThrough: input.owner.workerSentThrough() },
      async (current, signal) =>
        await exchangeWorkerInference(
          input.context,
          {
            ...base,
            ...identity,
            leaseToken: current.leaseToken,
            messages,
            inputSha256: remoteWorkerInferenceCanonicalSha256(messages),
          },
          signal,
        ),
    );
    lease = execution.lease;
    const inference = execution.value;
    const retainedUsage = [...usageEventIds, ...inference.usageEventIds];
    // A blocked or approval-waiting request may not have dispatched any attempt.
    usageEventIds = retainedUsage.length ? normalizeRemoteWorkerInferenceUsageEventIds(retainedUsage) : [];
    Object.assign(input.observed, {
      inferenceStatus: inference.status,
      inferenceStepCount: priorModelSteps + stepIndex + 1,
      pendingToolCallCount: inference.toolCalls?.length ?? 0,
      inferenceRequestSha256: inference.requestSha256,
      usageEventIds,
    });
    stage("inference");
    if (input.stopAfter === "inference") return stopped();
    if (inference.status === "completed") return { lease, completed: true, lines: inference.lines, usageEventIds };
    if (inference.status !== "requires_tools" || !inference.toolCalls) return stopped();
    if (priorModelSteps + stepIndex + 1 === REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS) {
      input.observed["awaiting"] = "model_step_limit";
      return stopped();
    }
    const results: RemoteWorkerChatToolResult[] = [];
    for (let callIndex = 0; callIndex < inference.toolCalls.length; callIndex++) {
      const execution = await withRenewingWorkerLease(
        { ...input, lease, workerSentThrough: input.owner.workerSentThrough() },
        async (current, signal) =>
          await exchangeWorkerChatTool(
            input.context,
            current,
            {
              kind: "chat.tool",
              inferenceRequestId: identity.inferenceRequestId,
              attempt: identity.attempt,
              callIndex,
            },
            inference,
            signal,
          ),
      );
      lease = execution.lease;
      input.observed["toolStatus"] = execution.value.status;
      if (execution.value.status !== "completed") {
        input.observed["awaiting"] = execution.value.status === "waiting_approval" ? "approval_resolution" : "tool_reconciliation";
        return stopped();
      }
      results.push(execution.value);
    }
    stage("tools");
    input.observed["pendingToolCallCount"] = 0;
    if (input.stopAfter === "tools") {
      input.observed["awaiting"] = "model_continuation";
      return stopped();
    }
    messages = appendRemoteWorkerChatToolResults(
      messages,
      {
        text: inference.lines.join(""),
        toolCalls: inference.toolCalls,
      },
      results,
    );
  }
  return stopped();
}
