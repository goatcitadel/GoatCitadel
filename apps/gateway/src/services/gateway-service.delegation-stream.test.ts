import { describe, expect, it, vi } from "vitest";
import type { ChatDelegateRequest, ChatDelegateResponse, ChatDelegationStepRecord } from "@goatcitadel/contracts";
import { ChatDelegationService } from "./chat-delegation-service.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function createStep(overrides: Partial<ChatDelegationStepRecord> = {}): ChatDelegationStepRecord {
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

describe("ChatDelegationService stream bridge", () => {
  it("emits interleaved step chunks before the final done chunk", async () => {
    const service = Object.create(ChatDelegationService.prototype) as ChatDelegationService & {
      runChatDelegation: ReturnType<typeof vi.fn>;
    };
    service.runChatDelegation = vi.fn(
      async (
        _sessionId: string,
        _input: ChatDelegateRequest,
        callbacks?: {
          onStatus?: (event: { runId: string; taskId: string; message: string }) => Promise<void> | void;
          onStep?: (step: ChatDelegationStepRecord) => Promise<void> | void;
        },
      ): Promise<ChatDelegateResponse> => {
        const runningArchitect = createStep();
        const completedQa = createStep({
          stepId: "step-2",
          role: "qa",
          index: 1,
          status: "completed",
          finishedAt: "2026-03-31T00:00:01.000Z",
          durationMs: 1000,
          output: "QA done",
        });
        const completedArchitect = createStep({
          status: "completed",
          finishedAt: "2026-03-31T00:00:02.000Z",
          durationMs: 2000,
          output: "Architect done",
        });

        await callbacks?.onStatus?.({
          runId: "run-1",
          taskId: "task-1",
          message: "Delegation started.",
        });
        await Promise.resolve();
        await callbacks?.onStep?.(runningArchitect);
        await Promise.resolve();
        await callbacks?.onStep?.(completedQa);
        await Promise.resolve();
        await callbacks?.onStep?.(completedArchitect);

        return {
          runId: "run-1",
          taskId: "task-1",
          steps: [completedArchitect, completedQa].sort((left, right) => left.index - right.index),
          stitchedOutput: "### Architect\nArchitect done\n\n### Qa\nQA done",
          citations: [],
        };
      },
    );

    const chunks: Array<{
      type: "status" | "step" | "done" | "error";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }> = [];

    for await (const chunk of ChatDelegationService.prototype.runChatDelegationStream.call(service, "sess-1", {
      objective: "Implement the fix",
      roles: ["Architect"],
      mode: "sequential",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual(["status", "step", "step", "step", "done"]);
    expect(chunks[0]).toMatchObject({
      type: "status",
      runId: "run-1",
      taskId: "task-1",
      message: "Delegation started.",
    });
    expect(chunks[1]?.step?.status).toBe("running");
    expect(chunks[2]?.step?.status).toBe("completed");
    expect(chunks[2]?.step?.role).toBe("qa");
    expect(chunks[3]?.step?.role).toBe("architect");
    expect(chunks[3]).toMatchObject({
      type: "step",
      runId: "run-1",
    });
    expect(chunks[4]).toMatchObject({
      type: "done",
      runId: "run-1",
      taskId: "task-1",
      result: {
        runId: "run-1",
        taskId: "task-1",
        stitchedOutput: "### Architect\nArchitect done\n\n### Qa\nQA done",
      },
    });
  });
});
