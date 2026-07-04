import { describe, expect, it, vi } from "vitest";
import { NotFoundError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import type { OrchestrationStepExecutionResult } from "../orchestration/types.js";
import {
  createSubagentFanoutExecutor,
  parseSubagentFanoutSubtasks,
  shouldRegisterSubagentFanoutExecutor,
  SUBAGENT_FANOUT_MAX_SUBTASKS,
  SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT,
  SUBAGENT_FANOUT_TOOL_NAME,
  SubagentFanoutRuntime,
} from "./chat-subagent-fanout-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import { createTurnSubagentFanoutExecutor, type ChatTurnStreamHost } from "./chat-turn-stream-service.js";

function fanoutRequest(args: Record<string, unknown>, sessionId = "sess-fanout"): ToolInvokeRequest {
  return { toolName: SUBAGENT_FANOUT_TOOL_NAME, args, agentId: "assistant", sessionId };
}

function completedStep(input: {
  stepId: string;
  index: number;
  objective?: string;
  output?: string;
  status?: OrchestrationStepExecutionResult["status"];
  waitStatus?: OrchestrationStepExecutionResult["waitStatus"];
  error?: string;
}): OrchestrationStepExecutionResult {
  return {
    stepId: input.stepId,
    role: "worker",
    index: input.index,
    startedAt: "2026-07-03T00:00:00.000Z",
    finishedAt: "2026-07-03T00:00:01.000Z",
    durationMs: 1000,
    status: input.status ?? "completed",
    waitStatus: input.waitStatus,
    output: input.output ?? "worker output",
    summary: "worker summary",
    error: input.error,
    citations: [],
    childSessionId: `child-${input.index}`,
    childTurnId: `child-turn-${input.index}`,
  };
}

function preparedFake(): PreparedAgentChatTurn {
  return {
    session: { sessionId: "sess-fanout" },
    workspaceId: "ws-1",
    turnId: "turn-parent",
    content: "Compare vendors A, B, and C on pricing.",
    prefs: {
      providerId: "glm",
      model: "glm-5",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "minimal",
      speedMode: "standard",
      orchestrationProviderPreference: "balanced",
      orchestrationReviewDepth: "standard",
      codeAutoApply: "manual",
    },
    effectiveToolAutonomy: "safe_auto",
    autonomy: { retrievalMode: "standard" },
    normalized: { normalizationProfile: "live" },
    history: [],
  } as never;
}

describe("parseSubagentFanoutSubtasks", () => {
  it("accepts 1..3 well-formed subtasks and trims fields", () => {
    const parsed = parseSubagentFanoutSubtasks({
      subtasks: [
        { objective: "  Research vendor A  ", label: " A ", expectedOutput: " price table " },
        { objective: "Research vendor B" },
        { objective: "Research vendor C" },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.subtasks).toHaveLength(3);
    expect(parsed.subtasks[0]).toMatchObject({
      objective: "Research vendor A",
      label: "A",
      expectedOutput: "price table",
    });
  });

  it("rejects a missing or empty subtasks array", () => {
    expect(parseSubagentFanoutSubtasks({})).toMatchObject({ ok: false });
    expect(parseSubagentFanoutSubtasks({ subtasks: [] })).toMatchObject({ ok: false });
    expect(parseSubagentFanoutSubtasks({ subtasks: "not-an-array" })).toMatchObject({ ok: false });
  });

  it(`rejects more than ${SUBAGENT_FANOUT_MAX_SUBTASKS} subtasks with actionable guidance`, () => {
    const parsed = parseSubagentFanoutSubtasks({
      subtasks: [{ objective: "One" }, { objective: "Two" }, { objective: "Three" }, { objective: "Four" }],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toMatch(/at most 3/i);
  });

  it("rejects entries without a non-empty string objective", () => {
    expect(parseSubagentFanoutSubtasks({ subtasks: [{ objective: "   " }] })).toMatchObject({ ok: false });
    expect(parseSubagentFanoutSubtasks({ subtasks: [{ objective: 42 }] })).toMatchObject({ ok: false });
    expect(parseSubagentFanoutSubtasks({ subtasks: ["just a string"] })).toMatchObject({ ok: false });
  });

  it("clamps oversized objectives instead of failing the whole call", () => {
    const parsed = parseSubagentFanoutSubtasks({ subtasks: [{ objective: "x".repeat(5000) }] });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.subtasks[0]!.objective.length).toBeLessThanOrEqual(2000);
  });
});

describe("shouldRegisterSubagentFanoutExecutor", () => {
  function preparedWith(input: {
    mode: string;
    normalizedSubagentPolicy?: string;
    prefsSubagentPolicy?: string;
  }): PreparedAgentChatTurn {
    return {
      session: { sessionId: "sess-eligibility" },
      prefs: { mode: input.mode, subagentPolicy: input.prefsSubagentPolicy },
      normalized: { mode: input.mode, subagentPolicy: input.normalizedSubagentPolicy },
    } as never;
  }

  it("allows registration for cowork/code turns whose subagentPolicy permits subagents", () => {
    expect(
      shouldRegisterSubagentFanoutExecutor(
        preparedWith({ mode: "cowork", normalizedSubagentPolicy: "ask_when_useful" }),
      ),
    ).toBe(true);
    expect(
      shouldRegisterSubagentFanoutExecutor(preparedWith({ mode: "code", prefsSubagentPolicy: "auto_when_useful" })),
    ).toBe(true);
    // Contract default when the pref is absent is ask_when_useful.
    expect(shouldRegisterSubagentFanoutExecutor(preparedWith({ mode: "cowork" }))).toBe(true);
  });

  it("refuses registration outside cowork/code", () => {
    expect(
      shouldRegisterSubagentFanoutExecutor(preparedWith({ mode: "chat", normalizedSubagentPolicy: "ask_when_useful" })),
    ).toBe(false);
  });

  it("refuses registration when the turn is floored to subagentPolicy off (the delegated-child shape)", () => {
    expect(
      shouldRegisterSubagentFanoutExecutor(preparedWith({ mode: "cowork", normalizedSubagentPolicy: "off" })),
    ).toBe(false);
    expect(shouldRegisterSubagentFanoutExecutor(preparedWith({ mode: "cowork", prefsSubagentPolicy: "off" }))).toBe(
      false,
    );
    // The normalized (request-level) floor wins over a permissive session pref.
    expect(
      shouldRegisterSubagentFanoutExecutor(
        preparedWith({ mode: "cowork", normalizedSubagentPolicy: "off", prefsSubagentPolicy: "ask_when_useful" }),
      ),
    ).toBe(false);
  });
});

describe("SubagentFanoutRuntime", () => {
  it("routes an invoke to the executor registered for the request's session", async () => {
    const runtime = new SubagentFanoutRuntime();
    const executor = vi.fn(async () => ({ status: "completed" }));
    runtime.register("sess-fanout", executor);

    const result = await runtime.execute(fanoutRequest({ subtasks: [{ objective: "Research A" }] }));

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith({ subtasks: [{ objective: "Research A" }] });
    expect(result).toMatchObject({ status: "completed" });
  });

  it("fails closed when no executor is registered for the session", async () => {
    const runtime = new SubagentFanoutRuntime();
    await expect(runtime.execute(fanoutRequest({ subtasks: [{ objective: "A" }] }))).rejects.toThrow(
      /no active .*turn/i,
    );
  });

  it("fails closed when the kill switch is on, without consulting the executor", async () => {
    const runtime = new SubagentFanoutRuntime({ isDisabled: () => true });
    const executor = vi.fn(async () => ({ status: "completed" }));
    runtime.register("sess-fanout", executor);

    await expect(runtime.execute(fanoutRequest({ subtasks: [{ objective: "A" }] }))).rejects.toThrow(/disabled/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it("rejects malformed args before reaching the executor", async () => {
    const runtime = new SubagentFanoutRuntime();
    const executor = vi.fn(async () => ({ status: "completed" }));
    runtime.register("sess-fanout", executor);

    await expect(runtime.execute(fanoutRequest({ subtasks: [] }))).rejects.toThrow(/subtask/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it("unregisters only its own registration (a stale disposer must not evict a newer turn)", async () => {
    const runtime = new SubagentFanoutRuntime();
    const first = vi.fn(async () => ({ status: "completed", from: "first" }));
    const second = vi.fn(async () => ({ status: "completed", from: "second" }));
    const disposeFirst = runtime.register("sess-fanout", first);
    runtime.register("sess-fanout", second);

    disposeFirst();
    const result = await runtime.execute(fanoutRequest({ subtasks: [{ objective: "A" }] }));
    expect(result).toMatchObject({ from: "second" });
    expect(first).not.toHaveBeenCalled();
  });

  it("removes the registration when its own disposer runs", async () => {
    const runtime = new SubagentFanoutRuntime();
    const dispose = runtime.register("sess-fanout", async () => ({ status: "completed" }));
    dispose();
    await expect(runtime.execute(fanoutRequest({ subtasks: [{ objective: "A" }] }))).rejects.toThrow(
      /no active .*turn/i,
    );
  });
});

describe("createSubagentFanoutExecutor", () => {
  it("runs every subtask through the delegated-step machinery and aggregates results in subtask order", async () => {
    const seenSteps: Array<{ objective: string; role: string; index: number; runId: string; mode: string }> = [];
    const runDelegatedStep = vi.fn(
      async (
        _host: unknown,
        _prepared: unknown,
        input: {
          task: { mode: string };
          step: { objective: string; role: string };
          stepIndex: number;
          runId: string;
        },
      ) => {
        seenSteps.push({
          objective: input.step.objective,
          role: input.step.role,
          index: input.stepIndex,
          runId: input.runId,
          mode: input.task.mode,
        });
        // Resolve out of order: the aggregate must still follow subtask order.
        await new Promise((resolve) => setTimeout(resolve, input.stepIndex === 0 ? 30 : 5));
        return completedStep({
          stepId: `step-${input.stepIndex}`,
          index: input.stepIndex,
          output: `output for ${input.step.objective}`,
        });
      },
    );
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      runDelegatedStep: runDelegatedStep as never,
    });

    const result = (await executor({
      subtasks: [{ objective: "Research A" }, { objective: "Research B" }, { objective: "Research C" }],
    })) as {
      status: string;
      subtaskCount: number;
      completedCount: number;
      failedCount: number;
      results: Array<Record<string, unknown>>;
    };

    expect(runDelegatedStep).toHaveBeenCalledTimes(3);
    expect(seenSteps.every((step) => step.role === "worker")).toBe(true);
    expect(seenSteps.every((step) => step.mode === "cowork" || step.mode === "code" || step.mode === "chat")).toBe(
      true,
    );
    expect(new Set(seenSteps.map((step) => step.runId)).size).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.subtaskCount).toBe(3);
    expect(result.completedCount).toBe(3);
    expect(result.failedCount).toBe(0);
    expect(result.results.map((entry) => entry.objective)).toEqual(["Research A", "Research B", "Research C"]);
    expect(result.results.map((entry) => entry.output)).toEqual([
      "output for Research A",
      "output for Research B",
      "output for Research C",
    ]);
    expect(result.results.map((entry) => entry.childSessionId)).toEqual(["child-0", "child-1", "child-2"]);
  });

  it("threads the parent turn's abort signal into every delegated child run", async () => {
    const abortController = new AbortController();
    const seenSignals: Array<AbortSignal | undefined> = [];
    const runDelegatedStep = vi.fn(
      async (_host: unknown, _prepared: unknown, input: { stepIndex: number; signal?: AbortSignal }) => {
        seenSignals.push(input.signal);
        return completedStep({ stepId: `step-${input.stepIndex}`, index: input.stepIndex });
      },
    );
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      runDelegatedStep: runDelegatedStep as never,
      signal: abortController.signal,
    });

    await executor({ subtasks: [{ objective: "A" }, { objective: "B" }] });

    expect(seenSignals).toHaveLength(2);
    for (const signal of seenSignals) {
      expect(signal).toBe(abortController.signal);
    }
  });

  it("starts independent subtasks concurrently instead of serially", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runDelegatedStep = vi.fn(async (_host: unknown, _prepared: unknown, input: { stepIndex: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return completedStep({ stepId: `step-${input.stepIndex}`, index: input.stepIndex });
    });
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      runDelegatedStep: runDelegatedStep as never,
    });

    await executor({ subtasks: [{ objective: "A" }, { objective: "B" }, { objective: "C" }] });

    expect(maxInFlight).toBe(3);
  });

  it("isolates one subtask failure: the others still complete and the aggregate reports partial", async () => {
    const runDelegatedStep = vi.fn(async (_host: unknown, _prepared: unknown, input: { stepIndex: number }) => {
      if (input.stepIndex === 1) {
        throw new Error("synthetic delegated failure");
      }
      return completedStep({ stepId: `step-${input.stepIndex}`, index: input.stepIndex });
    });
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      runDelegatedStep: runDelegatedStep as never,
    });

    const result = (await executor({
      subtasks: [{ objective: "A" }, { objective: "B" }, { objective: "C" }],
    })) as {
      status: string;
      completedCount: number;
      failedCount: number;
      results: Array<Record<string, unknown>>;
    };

    expect(result.status).toBe("partial");
    expect(result.completedCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.results[1]).toMatchObject({ status: "failed" });
    expect(String(result.results[1]!.error)).toMatch(/synthetic delegated failure/);
  });

  it("truncates oversized child outputs with an explicit marker", async () => {
    const longOutput = "y".repeat(SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT + 500);
    const runDelegatedStep = vi.fn(async (_host: unknown, _prepared: unknown, input: { stepIndex: number }) =>
      completedStep({ stepId: `step-${input.stepIndex}`, index: input.stepIndex, output: longOutput }),
    );
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      runDelegatedStep: runDelegatedStep as never,
    });

    const result = (await executor({ subtasks: [{ objective: "A" }] })) as {
      results: Array<{ output?: string; outputTruncated?: boolean }>;
    };

    expect(result.results[0]!.output).toHaveLength(SUBAGENT_FANOUT_OUTPUT_EXCERPT_LIMIT);
    expect(result.results[0]!.outputTruncated).toBe(true);
  });

  it("maps a parked (waiting) child to an incomplete subtask instead of claiming completion", async () => {
    const runDelegatedStep = vi.fn(async (_host: unknown, _prepared: unknown, input: { stepIndex: number }) =>
      completedStep({
        stepId: `step-${input.stepIndex}`,
        index: input.stepIndex,
        status: "running",
        waitStatus: "waiting_for_approval",
        output: "Delegate is waiting for approval.",
      }),
    );
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      runDelegatedStep: runDelegatedStep as never,
    });

    const result = (await executor({ subtasks: [{ objective: "A" }] })) as {
      status: string;
      results: Array<Record<string, unknown>>;
    };

    expect(result.results[0]).toMatchObject({ status: "incomplete" });
    expect(result.status).toBe("failed");
  });

  it("drives the real executeDelegatedPlanStep with a buffered child send and hard child floors", async () => {
    const prefsPatches: Array<Record<string, unknown>> = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    let childCounter = 0;
    const host = {
      storage: {
        chatSessionProjects: { get: () => undefined },
        chatDelegationSteps: {
          patch: () => {
            throw new NotFoundError("no persisted delegation step");
          },
        },
      },
      createChatSession: (input: Record<string, unknown>) => {
        childCounter += 1;
        return { sessionId: `child-sess-${childCounter}`, workspaceId: input.workspaceId };
      },
      inheritDelegatedSessionToolGrants: vi.fn(),
      updateChatSessionPrefs: (_sessionId: string, patch: Record<string, unknown>) => {
        prefsPatches.push(patch);
        return {};
      },
      recordDevDiagnostic: vi.fn(),
      agentSendChatMessage: vi.fn(async (_sessionId: string, request: Record<string, unknown>) => {
        sentRequests.push(request);
        return {
          turnId: `child-turn-${sentRequests.length}`,
          assistantMessage: { content: `child answer ${sentRequests.length}` },
          trace: { status: "completed" },
          citations: [],
        };
      }),
      agentSendChatMessageStream: vi.fn(),
    } as unknown as ChatTurnStreamHost;

    // The production composition: the stream service binds the real
    // executeDelegatedPlanStep into the executor factory.
    const executor = createTurnSubagentFanoutExecutor(host, preparedFake(), {});
    const result = (await executor({
      subtasks: [{ objective: "Research vendor A" }, { objective: "Research vendor B" }],
    })) as {
      status: string;
      results: Array<Record<string, unknown>>;
    };

    // No recursion by construction: every child turn is floored to
    // subagentPolicy "off" and orchestrationEnabled false.
    expect(prefsPatches).toHaveLength(2);
    for (const patch of prefsPatches) {
      expect(patch).toMatchObject({ subagentPolicy: "off", orchestrationEnabled: false });
    }
    for (const request of sentRequests) {
      expect(request).toMatchObject({ subagentPolicy: "off" });
    }
    // Buffered child sends only (competitor parity: delegated children buffer;
    // the streaming child path is reserved for the terminal synthesizer).
    expect(host.agentSendChatMessageStream).not.toHaveBeenCalled();
    expect(result.status).toBe("completed");
    expect(result.results.map((entry) => entry.output)).toEqual(["child answer 1", "child answer 2"]);
    expect(result.results.map((entry) => entry.childSessionId)).toEqual(["child-sess-1", "child-sess-2"]);
  });
});
