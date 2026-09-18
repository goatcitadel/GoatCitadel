import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS,
  remoteWorkerInferenceCanonicalSha256 as digest,
} from "@goatcitadel/contracts";
import { runWorkerChatWorkflow } from "./worker-chat-workflow.js";
import { buildWorkerInferenceSubmission, exchangeWorkerInference } from "./worker-inference-execution.js";
import { exchangeWorkerChatTool } from "./worker-chat-tool-execution.js";
import type { LeaseBinding } from "./connected-worker-routes.js";

vi.mock("./worker-inference-execution.js", () => ({
  buildWorkerInferenceSubmission: vi.fn(),
  exchangeWorkerInference: vi.fn(),
}));
vi.mock("./worker-chat-tool-execution.js", () => ({ exchangeWorkerChatTool: vi.fn() }));
vi.mock("./worker-execution-lease.js", () => ({
  withRenewingWorkerLease: async (
    input: { lease: LeaseBinding },
    execute: (lease: LeaseBinding, signal: AbortSignal) => Promise<unknown>,
  ) => ({ lease: input.lease, value: await execute(input.lease, new AbortController().signal) }),
}));

const lease = {
  registryWorkspaceId: "registry",
  assignmentId: "assignment",
  assignmentGeneration: 1,
  leaseRevision: 1,
  leaseToken: "lease",
};
const base = {
  ...lease,
  inferenceRequestId: "worker-assignment",
  attempt: 1,
  idempotencyKey: "inference:assignment:1",
  messages: [{ role: "user", text: "Read a note" }],
};

beforeEach(() => {
  vi.mocked(buildWorkerInferenceSubmission)
    .mockReset()
    .mockReturnValue(base as never);
  vi.mocked(exchangeWorkerInference)
    .mockReset()
    .mockImplementation(async (_context, submission) => {
      const callId = `call-${submission.inferenceRequestId}`;
      return {
        status: "requires_tools",
        lines: [],
        usageEventIds: [`usage-${submission.inferenceRequestId}`],
        requestSha256: digest(submission),
        toolCalls: [{ callId, modelToolName: "fs_read", argumentsJson: "{}" }],
      };
    });
  vi.mocked(exchangeWorkerChatTool)
    .mockReset()
    .mockImplementation(async (_context, _lease, submission, inference) => ({
      ...submission,
      status: "completed",
      requestSha256: inference.requestSha256,
      callId: inference.toolCalls![submission.callIndex]!.callId,
      modelToolName: "fs_read",
      intentId: `intent-${submission.inferenceRequestId}`,
      toolRunId: `tool-${submission.inferenceRequestId}`,
      resultJson: '{"text":"note"}',
      resultSha256: digest({ text: "note" }),
    }));
});

function input() {
  return {
    context: {} as never,
    owner: { workerSentThrough: () => 0 } as never,
    lease,
    workload: {},
    observed: {} as Record<string, unknown>,
    stages: [],
    stopAfter: "complete" as const,
  };
}

describe("worker model/tool loop boundaries", () => {
  it("keeps earlier native-history usage and spends only the remaining model step", async () => {
    const f = input();
    f.workload = { nativeChatHistory: { schemaVersion: "goatcitadel.remote-worker-native-chat-history.v1",
      nativeContextSha256: digest("native"), contextSnapshotSha256: digest("context"), priorModelSteps: 15,
      priorRequestSha256s: Array.from({ length: 15 }, (_, i) => digest(`request-${i}`)),
      usageEventIds: Array.from({ length: 15 }, (_, i) => `prior-usage-${i}`), messages: base.messages } };
    const result = await runWorkerChatWorkflow(f);
    expect(result.completed).toBe(false);
    expect(result.usageEventIds).toHaveLength(16);
    expect(f.observed.inferenceStepCount).toBe(16);
    expect(f.observed.awaiting).toBe("model_step_limit");
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
    expect(exchangeWorkerChatTool).not.toHaveBeenCalled();
  });

  it("stops at the model-step ceiling before starting tools it cannot continue", async () => {
    const f = input();
    const result = await runWorkerChatWorkflow(f);
    expect(result.completed).toBe(false);
    expect(result.lines).toEqual([]);
    expect(result.usageEventIds).toHaveLength(REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS);
    expect(f.observed.awaiting).toBe("model_step_limit");
    expect(exchangeWorkerInference).toHaveBeenCalledTimes(REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS);
    expect(exchangeWorkerChatTool).toHaveBeenCalledTimes(REMOTE_WORKER_CHAT_MAX_INFERENCE_STEPS - 1);
  });

  it.each([
    ["waiting_approval", "approval_resolution"],
    ["blocked", "tool_reconciliation"],
  ] as const)("stops on %s without another model request or a publishable result", async (status, awaiting) => {
    vi.mocked(exchangeWorkerChatTool).mockResolvedValueOnce({ status } as never);
    const f = input();
    expect(await runWorkerChatWorkflow(f)).toMatchObject({ completed: false, lines: [] });
    expect(f.observed.toolStatus).toBe(status);
    expect(f.observed.awaiting).toBe(awaiting);
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
  });

  it.each(["blocked", "waiting"] as const)(
    "preserves a %s request with no provider attempt as recoverable stopped work",
    async (status) => {
      vi.mocked(exchangeWorkerInference).mockResolvedValueOnce({
        status,
        lines: [],
        usageEventIds: [],
        requestSha256: digest("undispatched"),
      });
      const f = input();
      expect(await runWorkerChatWorkflow(f)).toMatchObject({ completed: false, lines: [], usageEventIds: [] });
      expect(f.observed.inferenceStatus).toBe(status);
      expect(f.stages).toEqual(["inference"]);
      expect(exchangeWorkerInference).toHaveBeenCalledOnce();
      expect(exchangeWorkerChatTool).not.toHaveBeenCalled();
    },
  );

  it("rejects a changed result before authorizing the next model request", async () => {
    vi.mocked(exchangeWorkerChatTool).mockResolvedValueOnce({
      status: "completed",
      callId: "call-worker-assignment",
      modelToolName: "fs_read",
      resultJson: '{"text":"changed"}',
      resultSha256: digest({ text: "note" }),
    } as never);
    await expect(runWorkerChatWorkflow(input())).rejects.toThrow("result hash changed");
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
  });
});
