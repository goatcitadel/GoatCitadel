import { describe, expect, it, vi } from "vitest";
import type { ChatDelegateRequest, ChatDelegateResponse, ChatDelegationStepRecord } from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";

vi.mock("sqlite", () => ({}));
vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function createStep(
  overrides: Partial<ChatDelegationStepRecord> = {},
): ChatDelegationStepRecord {
  return {
    stepId: "step-1",
    runId: "run-1",
    role: "architect",
    status: "running",
    index: 0,
    startedAt: "2026-03-31T00:00:00.000Z",
    ...overrides,
  };
}

describe("GatewayService delegation stream bridge", () => {
  it("emits progress chunks before the final done chunk", async () => {
    const gateway = Object.create(GatewayService.prototype) as GatewayService & {
      runChatDelegation: ReturnType<typeof vi.fn>;
    };
    gateway.runChatDelegation = vi.fn(async (
      _sessionId: string,
      _input: ChatDelegateRequest,
      callbacks?: {
        onStatus?: (event: { runId: string; taskId: string; message: string }) => Promise<void> | void;
        onStep?: (step: ChatDelegationStepRecord) => Promise<void> | void;
      },
    ): Promise<ChatDelegateResponse> => {
      const runningStep = createStep();
      const completedStep = createStep({
        status: "completed",
        finishedAt: "2026-03-31T00:00:01.000Z",
        durationMs: 1000,
        output: "Done",
      });

      await callbacks?.onStatus?.({
        runId: "run-1",
        taskId: "task-1",
        message: "Delegation started.",
      });
      await Promise.resolve();
      await callbacks?.onStep?.(runningStep);
      await Promise.resolve();
      await callbacks?.onStep?.(completedStep);

      return {
        runId: "run-1",
        taskId: "task-1",
        steps: [completedStep],
        stitchedOutput: "### Architect\nDone",
        citations: [],
      };
    });

    const chunks: Array<{
      type: "status" | "step" | "done" | "error";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }> = [];

    for await (const chunk of GatewayService.prototype.runChatDelegationStream.call(gateway, "sess-1", {
      objective: "Implement the fix",
      roles: ["Architect"],
      mode: "sequential",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual(["status", "step", "step", "done"]);
    expect(chunks[0]).toMatchObject({
      type: "status",
      runId: "run-1",
      taskId: "task-1",
      message: "Delegation started.",
    });
    expect(chunks[1]?.step?.status).toBe("running");
    expect(chunks[2]?.step?.status).toBe("completed");
    expect(chunks[3]).toMatchObject({
      type: "done",
      runId: "run-1",
      taskId: "task-1",
      result: {
        runId: "run-1",
        taskId: "task-1",
      },
    });
  });
});
