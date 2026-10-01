import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  remoteWorkerInferenceCanonicalSha256 as digest,
  type RemoteWorkerChatToolResult,
  type RemoteWorkerChatToolSubmission,
  type RemoteWorkerInferenceRequestSubmission,
} from "@goatcitadel/contracts";
import { runWorkerChatWorkflow } from "./worker-chat-workflow.js";
import { buildWorkerInferenceSubmission, exchangeWorkerInference } from "./worker-inference-execution.js";
import { readControl, type LeaseBinding, type RouteContext } from "./connected-worker-routes.js";
import { callProtectedRoute, WorkerProtectedRouteError } from "./worker-protected-route-client.js";
import type { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";

// The lease helper, tool exchange, and tool receipt verifier are real. Only the
// inference, control/wire, and lease-owner scheduling boundaries are simulated;
// the native restart matrix separately proves the authenticated transport.
vi.mock("./worker-inference-execution.js", () => ({
  buildWorkerInferenceSubmission: vi.fn(),
  exchangeWorkerInference: vi.fn(),
}));
vi.mock("./connected-worker-routes.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./connected-worker-routes.js")>(),
  readControl: vi.fn(),
}));
vi.mock("./worker-protected-route-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./worker-protected-route-client.js")>(),
  callProtectedRoute: vi.fn(),
}));

const lease: LeaseBinding = {
  registryWorkspaceId: "registry",
  assignmentId: "assignment",
  assignmentGeneration: 1,
  leaseRevision: 1,
  leaseToken: "a".repeat(43),
};
const base: RemoteWorkerInferenceRequestSubmission = {
  ...lease,
  inferenceRequestId: "worker-assignment",
  attempt: 1,
  idempotencyKey: "inference:assignment:1",
  messages: [{ role: "user", text: "Read a note" }],
  inputSha256: digest([{ role: "user", text: "Read a note" }]),
  contextSha256: digest("context"),
  modelIntentSha256: digest("model"),
  outputTokenCeiling: 4096,
  reasoningTokenCeiling: 0,
  temperatureMilli: 0,
};
const requestSha256 = digest("verified model request");
const toolCalls = [
  { callId: "call-one", modelToolName: "fs_read", argumentsJson: '{"path":"note.txt"}' },
  { callId: "call-two", modelToolName: "fs_read", argumentsJson: '{"path":"other.txt"}' },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(buildWorkerInferenceSubmission).mockReset().mockReturnValue(base);
  vi.mocked(exchangeWorkerInference).mockReset().mockResolvedValue({
    status: "requires_tools", lines: [], usageEventIds: ["usage-one"], requestSha256, toolCalls,
  });
  vi.mocked(readControl).mockReset().mockImplementation(async (_context, current) => ({
    status: 200,
    body: {
      disposition: "active",
      assignmentId: current.assignmentId,
      assignmentGeneration: current.assignmentGeneration,
      lease: current,
    },
  }));
  vi.mocked(callProtectedRoute).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function fixture() {
  let parentWaiting = false;
  let deadline = 0;
  const rotate = async (current: LeaseBinding) => {
    if (parentWaiting) throw new WorkerProtectedRouteError("waiting parent refuses active renewal", 403, {
      error: "REMOTE_WORKER_ASSIGNMENT_REJECTED",
    });
    deadline = Date.now() + 900;
    return { ...current, leaseRevision: current.leaseRevision + 1, leaseToken: "b".repeat(43) };
  };
  const owner = {
    renew: vi.fn(rotate),
    remainingLeaseMs: () => Math.max(0, deadline - Date.now()),
    workerSentThrough: () => 0,
  };
  const input = {
    context: {} as RouteContext,
    owner: owner as unknown as WorkerAssignmentLeaseOwner,
    lease,
    workload: {},
    observed: {} as Record<string, unknown>,
    stages: [],
    stopAfter: "complete" as const,
  };
  const respond = (status: RemoteWorkerChatToolResult["status"], patch: Record<string, unknown> = {}) => {
    vi.mocked(callProtectedRoute).mockImplementation(async (call) => {
      expect(call.operation).toBe("assignment.settlement.submit");
      expect(call.payload).toMatchObject({
        registryWorkspaceId: lease.registryWorkspaceId,
        assignmentId: lease.assignmentId,
        assignmentGeneration: lease.assignmentGeneration,
        leaseRevision: 4,
      });
      expect(call.signal?.aborted).toBe(false);
      const selection = call.payload.submission as RemoteWorkerChatToolSubmission;
      // The owner moves to waiting before the authenticated receipt returns.
      if (status === "waiting_approval") parentWaiting = true;
      return {
        status: 200,
        body: {
          disposition: "chat_tool_recorded",
          tool: {
            ...selection,
            status,
            requestSha256,
            callId: toolCalls[0]!.callId,
            modelToolName: toolCalls[0]!.modelToolName,
            intentId: "intent-one",
            toolRunId: "remote-tool:intent-one",
            ...(status === "completed" ? {
              resultJson: '{"text":"note"}',
              resultSha256: digest({ text: "note" }),
            } : {}),
            ...patch,
          },
        },
      };
    });
  };
  return { input, owner, rotate, respond };
}

describe("worker Chat approval parking with real lease and tool verification", () => {
  it("parks an exact waiting receipt without a final active renewal or further model/tool work", async () => {
    const f = fixture();
    f.respond("waiting_approval");
    expect(await runWorkerChatWorkflow(f.input)).toMatchObject({
      completed: false, lines: [], usageEventIds: ["usage-one"], lease: { leaseRevision: 4 },
    });
    expect(f.input.observed.toolStatus).toBe("waiting_approval");
    expect(f.input.observed.awaiting).toBe("approval_resolution");
    expect(f.input.stages).toEqual(["inference"]);
    expect(f.owner.renew).toHaveBeenCalledTimes(3);
    expect(readControl).toHaveBeenCalledTimes(3);
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
    expect(callProtectedRoute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["request hash", { requestSha256: digest("another request") }],
    ["call identity", { callId: "another-call" }],
    ["attempt", { attempt: 2 }],
    ["completed data", { resultJson: '{"text":"unauthorized"}', resultSha256: digest({ text: "unauthorized" }) }],
  ] as const)("rejects waiting receipt with altered %s before parking", async (_label, patch) => {
    const f = fixture();
    f.respond("waiting_approval", patch);
    await expect(runWorkerChatWorkflow(f.input)).rejects.toThrow(_label === "completed data"
      ? "Unsettled worker Chat tools cannot supply completed results."
      : "Worker Chat tool result does not bind the verified model call.");
    expect(f.input.observed.toolStatus).toBeUndefined();
    expect(f.input.observed.awaiting).toBeUndefined();
    expect(f.owner.renew).toHaveBeenCalledTimes(3);
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
    expect(callProtectedRoute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["completed", "blocked"] as const)("retains the final renewal failure for a %s tool", async (status) => {
    const f = fixture();
    f.respond(status);
    const refusal = new WorkerProtectedRouteError("final active renewal refused", 403, {
      error: "REMOTE_WORKER_ASSIGNMENT_REJECTED",
    });
    f.owner.renew.mockImplementationOnce(f.rotate).mockImplementationOnce(f.rotate)
      .mockImplementationOnce(f.rotate).mockRejectedValueOnce(refusal);
    await expect(runWorkerChatWorkflow(f.input)).rejects.toBe(refusal);
    expect(f.owner.renew).toHaveBeenCalledTimes(4);
    expect(f.input.observed.toolStatus).toBeUndefined();
    expect(f.input.observed.awaiting).toBeUndefined();
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
    expect(callProtectedRoute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refreshes blocked tool authority before returning reconciliation without further work", async () => {
    const f = fixture();
    f.respond("blocked");
    expect(await runWorkerChatWorkflow(f.input)).toMatchObject({ completed: false, lines: [], lease: { leaseRevision: 5 } });
    expect(f.input.observed.toolStatus).toBe("blocked");
    expect(f.input.observed.awaiting).toBe("tool_reconciliation");
    expect(f.owner.renew).toHaveBeenCalledTimes(4);
    expect(readControl).toHaveBeenCalledTimes(4);
    expect(exchangeWorkerInference).toHaveBeenCalledOnce();
    expect(callProtectedRoute).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains final renewal failure before exposing completed inference output", async () => {
    const f = fixture();
    vi.mocked(exchangeWorkerInference).mockResolvedValueOnce({
      status: "completed", lines: ["completed output"], usageEventIds: ["usage-one"], requestSha256,
    });
    const refusal = new Error("inference final renewal unavailable");
    f.owner.renew.mockImplementationOnce(f.rotate).mockRejectedValueOnce(refusal);
    await expect(runWorkerChatWorkflow(f.input)).rejects.toBe(refusal);
    expect(f.owner.renew).toHaveBeenCalledTimes(2);
    expect(f.input.observed.inferenceStatus).toBeUndefined();
    expect(callProtectedRoute).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
