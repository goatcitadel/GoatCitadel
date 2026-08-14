import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_PERMISSION_PROFILE_ID,
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ToolInvokeRequest,
} from "@goatcitadel/contracts";
import {
  createSubagentFanoutExecutor,
  parseSubagentFanoutSubtasks,
  shouldRegisterSubagentFanoutExecutor,
  SUBAGENT_FANOUT_MAX_SUBTASKS,
  SUBAGENT_FANOUT_TOOL_NAME,
  SubagentFanoutRuntime,
} from "./chat-subagent-fanout-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

function fanoutRequest(args: Record<string, unknown>, sessionId = "sess-fanout"): ToolInvokeRequest {
  return {
    toolName: SUBAGENT_FANOUT_TOOL_NAME,
    args,
    agentId: "assistant",
    sessionId,
    runId: "durable-parent-1",
    toolRunId: "server-tool-run-1",
  };
}

function preparedFake(): PreparedAgentChatTurn {
  return {
    session: { sessionId: "sess-fanout" },
    workspaceId: "ws-1",
    turnId: "turn-parent",
    content: "Compare vendors A, B, and C on pricing.",
    prefs: { providerId: "glm", model: "glm-5" },
    effectiveToolAutonomy: "safe_auto",
    autonomy: { retrievalMode: "standard" },
    normalized: { normalizationProfile: "live" },
    history: [],
  } as never;
}

describe("parseSubagentFanoutSubtasks", () => {
  it("accepts exactly one through three bounded subtask records", () => {
    const parsed = parseSubagentFanoutSubtasks({
      subtasks: [
        { objective: "  Research A  ", label: " A ", expectedOutput: " pricing " },
        { objective: "Research B" },
        { objective: "Research C" },
      ],
    });
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) return;
    expect(parsed.subtasks).toEqual([
      { objective: "Research A", label: "A", expectedOutput: "pricing" },
      { objective: "Research B" },
      { objective: "Research C" },
    ]);
  });

  it("rejects missing, malformed, and over-capacity plans before any durable work", () => {
    expect(parseSubagentFanoutSubtasks({})).toMatchObject({ ok: false });
    expect(parseSubagentFanoutSubtasks({ subtasks: [{ objective: "" }] })).toMatchObject({ ok: false });
    expect(
      parseSubagentFanoutSubtasks({
        subtasks: Array.from({ length: SUBAGENT_FANOUT_MAX_SUBTASKS + 1 }, (_, index) => ({
          objective: `task ${index}`,
        })),
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("automatic fan-out registration", () => {
  function preparedWith(input: {
    mode: string;
    normalizedSubagentPolicy?: string;
    routedContextSnapshot?: boolean;
  }): PreparedAgentChatTurn {
    return {
      session: { sessionId: "sess-eligibility" },
      prefs: { mode: input.mode },
      normalized: { mode: input.mode, subagentPolicy: input.normalizedSubagentPolicy },
      ...(input.routedContextSnapshot ? { routedContextSnapshot: { snapshotId: "snapshot" } } : {}),
    } as never;
  }

  it("only registers explicitly automatic, Chat-normalized, non-recursive turns", () => {
    expect(
      shouldRegisterSubagentFanoutExecutor(
        preparedWith({ mode: "chat", normalizedSubagentPolicy: "auto_when_useful" }),
      ),
    ).toBe(true);
    expect(
      shouldRegisterSubagentFanoutExecutor(preparedWith({ mode: "chat", normalizedSubagentPolicy: "ask_when_useful" })),
    ).toBe(false);
    expect(
      shouldRegisterSubagentFanoutExecutor(
        preparedWith({ mode: "chat", normalizedSubagentPolicy: "auto_when_useful" }),
        SCHEDULED_TURN_PERMISSION_PROFILE_ID,
      ),
    ).toBe(false);
    expect(
      shouldRegisterSubagentFanoutExecutor(
        preparedWith({ mode: "chat", normalizedSubagentPolicy: "auto_when_useful" }),
        HEARTBEAT_PERMISSION_PROFILE_ID,
      ),
    ).toBe(false);
    expect(
      shouldRegisterSubagentFanoutExecutor(
        preparedWith({ mode: "chat", normalizedSubagentPolicy: "auto_when_useful", routedContextSnapshot: true }),
      ),
    ).toBe(false);
  });
});

describe("SubagentFanoutRuntime", () => {
  it("fails closed by default instead of falling back to the historical in-memory path", async () => {
    const runtime = new SubagentFanoutRuntime();
    runtime.register(
      "sess-fanout",
      vi.fn(async () => ({ status: "completed" })),
    );
    await expect(runtime.execute(fanoutRequest({ subtasks: [{ objective: "A" }] }))).rejects.toThrow(
      /durable Chat fan-out rollout/i,
    );
  });

  it("forwards only server-authored parent and tool-run identities to the bound durable executor", async () => {
    const runtime = new SubagentFanoutRuntime({ isDurableEnabled: () => true });
    const executor = vi.fn(async () => ({ status: "waiting", fanoutInvocationId: "fanout-1" }));
    runtime.register("sess-fanout", executor);

    await expect(runtime.execute(fanoutRequest({ subtasks: [{ objective: "Research A" }] }))).resolves.toMatchObject({
      status: "waiting",
    });
    expect(executor).toHaveBeenCalledWith({
      subtasks: [{ objective: "Research A" }],
      parentRunId: "durable-parent-1",
      toolRunId: "server-tool-run-1",
    });
  });

  it("honors the global kill switch before consulting a registered executor", async () => {
    const runtime = new SubagentFanoutRuntime({ isDisabled: () => true, isDurableEnabled: () => true });
    const executor = vi.fn(async () => ({ status: "completed" }));
    runtime.register("sess-fanout", executor);
    await expect(runtime.execute(fanoutRequest({ subtasks: [{ objective: "A" }] }))).rejects.toThrow(/kill switch/i);
    expect(executor).not.toHaveBeenCalled();
  });
});

describe("createSubagentFanoutExecutor", () => {
  it("never provides a legacy fallback when durable fan-out composition is missing", async () => {
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {});
    await expect(executor({ subtasks: [{ objective: "A" }] })).rejects.toThrow(/fails closed/i);
  });

  it("binds prepared turn context, server identities, and abort signal to the durable aggregate", async () => {
    const abortController = new AbortController();
    const durableFanout = {
      execute: vi.fn(async () => ({ status: "waiting", fanoutInvocationId: "fanout-1" })),
    };
    const executor = createSubagentFanoutExecutor({} as never, preparedFake(), {
      durableFanout,
      signal: abortController.signal,
      operatorId: "operator-1",
      permissionProfileId: "safe",
    });

    await expect(
      executor({
        subtasks: [{ objective: "A" }, { objective: "B" }],
        parentRunId: "durable-parent-1",
        toolRunId: "server-tool-run-1",
      }),
    ).resolves.toMatchObject({ status: "waiting" });
    expect(durableFanout.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        prepared: expect.objectContaining({ turnId: "turn-parent" }),
        subtasks: [{ objective: "A" }, { objective: "B" }],
        parentRunId: "durable-parent-1",
        toolRunId: "server-tool-run-1",
        signal: abortController.signal,
        operatorId: "operator-1",
        permissionProfileId: "safe",
      }),
    );
  });
});
