import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { ChatSteerService } from "./chat-steer-service.js";
import type { ChatTurnStreamHost } from "./chat-turn-stream-service.js";
import { routeWithModelRouter } from "./model-router-decision-service.js";

vi.mock("./chat-turn-helpers.js", () => ({
  buildDelegationFailureGuidance: () => "fallback guidance",
  buildEmptyAssistantTurnFallbackText: () => "Recovered empty assistant output.",
  buildIncompleteDelegatedTraceFailureGuidance: (failure: { failureClass?: string } | undefined) =>
    failure?.failureClass === "tool_run_budget_exceeded"
      ? "continue from gathered leads guidance"
      : "fallback guidance",
  ChatTurnCancelledError: class ChatTurnCancelledError extends Error {},
  dedupeChatCitations: (items: unknown[]) => items,
  isIncompleteDelegatedTraceFailure: (failure: { failureClass?: string } | undefined) =>
    failure?.failureClass === "tool_run_budget_exceeded",
  isChatTurnCancelledError: () => false,
  mergeExecutionPlanStepStatuses: (_steps: unknown, next: unknown) => next,
  renderExecutionPlanAsMarkdown: () => "execution plan",
  splitIntoChunks: (value: string) => [value],
  toTitleCase: (value: string) => value,
  truncateSummaryLine: (value: string) => value,
}));

vi.mock("./chat-turn-realtime.js", () => ({
  buildChatTurnRealtimeOptions: () => undefined,
}));

const {
  collectOrchestrationToolRuns,
  executeDelegatedPlanStep,
  executePreparedModeOrchestration,
  streamPreparedAgentChatTurn,
} = await import("./chat-turn-stream-service.js");

describe("streamPreparedAgentChatTurn", () => {
  it("collects child turn tool runs in delegation step order", () => {
    const host = createHost();
    host.storage.chatDelegationSteps.listByRun = vi.fn(() => [
      { stepId: "step-1", childTurnId: "child-2" },
      { stepId: "step-2" },
      { stepId: "step-3", childTurnId: "child-1" },
    ]) as never;
    host.storage.chatToolRuns.listByTurnIds = vi.fn(
      () =>
        new Map([
          ["child-1", [{ toolRunId: "run-child-1", toolName: "browser.search", status: "executed" }]],
          ["child-2", [{ toolRunId: "run-child-2", toolName: "memory.search", status: "executed" }]],
        ]),
    ) as never;

    expect(collectOrchestrationToolRuns(host, "run-1").map((toolRun) => toolRun.toolRunId)).toEqual([
      "run-child-2",
      "run-child-1",
    ]);
  });

  it("executes delegated steps through a child session with filtered prompt-lab local tools", async () => {
    const host = createHost();
    host.resolveToolPolicyContext = vi.fn((input) => ({
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      surface: input.surface,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
    }));
    host.agentSendChatMessage = vi.fn(async () => ({
      sessionId: "delegate-session",
      userMessage: { messageId: "delegate-user" },
      assistantMessage: {
        messageId: "delegate-assistant",
        content: "Reviewed the release notes and produced the final synthesis.",
      },
      turnId: "delegate-turn",
      trace: {
        turnId: "delegate-turn",
        sessionId: "delegate-session",
        status: "completed",
        model: "delegate-model",
        routing: { effectiveProviderId: "delegate-provider" },
      },
      citations: [{ citationId: "citation-1", title: "Release notes" }],
      routing: { effectiveProviderId: "delegate-provider" },
    })) as never;
    const prepared = createPreparedTurn({ mode: "cowork", normalizationProfile: "prompt_pack_harness" });
    const abortController = new AbortController();

    const result = await executeDelegatedPlanStep(host, prepared, {
      ...createDelegatedStepInput(),
      priorSteps: [
        {
          stepId: "planner",
          role: "planner",
          index: 0,
          status: "completed",
          output: "Planner output with concrete handoff.",
          summary: "Planner summary",
        },
      ],
      operatorId: "operator-1",
      authActorId: "operator-1",
      authActorSource: "token",
      permissionProfileId: "profile-parent",
      localOperatorOverrideId: "override-parent",
      signal: abortController.signal,
    } as never);

    const delegatedRequest = vi.mocked(host.agentSendChatMessage).mock.calls[0]?.[1] as {
      content: string;
      permissionProfileId?: string;
      localOperatorOverrideId?: string;
      policyRunId?: string;
      policyTaskId?: string;
      parentDelegationStepId?: string;
    };
    expect(host.resolveToolPolicyContext).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionProfileId: "profile-parent",
        localOperatorOverrideId: "override-parent",
        taskId: "chat-orchestration:turn-1",
        runId: "run-1",
      }),
    );
    expect(host.createChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        title: "Delegate · synthesis",
        mode: "cowork",
      }),
    );
    expect(host.updateChatSessionPrefs).toHaveBeenCalledWith(
      "delegate-session",
      expect.objectContaining({
        orchestrationEnabled: false,
        subagentPolicy: "off",
        providerId: "delegate-provider",
        model: "delegate-model",
      }),
    );
    expect(delegatedRequest.content).toContain("Prior handoffs");
    expect(delegatedRequest.content).toContain("browser.search");
    expect(delegatedRequest.content).not.toContain("file.find");
    expect(delegatedRequest.permissionProfileId).toBe("profile-parent");
    expect(delegatedRequest.localOperatorOverrideId).toBe("override-parent");
    expect(delegatedRequest.policyRunId).toBe("run-1");
    expect(delegatedRequest.policyTaskId).toBe("chat-orchestration:turn-1");
    expect(delegatedRequest.parentDelegationStepId).toBe("run-1:orch-step-synthesis");
    expect(vi.mocked(host.agentSendChatMessage).mock.calls[0]?.[2]).toEqual({ abortSignal: abortController.signal });
    expect(result).toEqual(
      expect.objectContaining({
        status: "completed",
        providerId: "delegate-provider",
        model: "delegate-model",
        childSessionId: "delegate-session",
        childTurnId: "delegate-turn",
        citations: [expect.objectContaining({ citationId: "citation-1" })],
      }),
    );
  });

  it("labels delegated timeout failures before provider results with recovery guidance", async () => {
    const host = createHost();
    host.agentSendChatMessage = vi.fn(async () => {
      throw new Error("deadline exceeded before provider result");
    }) as never;

    const result = await executeDelegatedPlanStep(host, createPreparedTurn({ mode: "cowork" }), {
      ...createDelegatedStepInput(),
      step: {
        ...createDelegatedStepInput().step,
        role: "researcher",
        delegatedRole: "researcher",
      },
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        summary: "researcher failed",
        error: "deadline exceeded before provider result",
        failureGuidance: "fallback guidance",
        childSessionId: "delegate-session",
      }),
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "orchestration.step.timeout_without_provider_result",
        runtimeError: expect.objectContaining({
          retryable: true,
        }),
        context: expect.objectContaining({
          delegatedDispatchStarted: true,
          delegatedResponseReceived: false,
          timeoutClassification: "timeout_without_provider_result",
        }),
      }),
    );
  });

  it("converts delegated child failure responses into failed step results with guidance", async () => {
    const host = createHost();
    host.agentSendChatMessage = vi.fn(async () => ({
      sessionId: "delegate-session",
      userMessage: { messageId: "delegate-user" },
      assistantMessage: undefined,
      turnId: "delegate-turn-failed",
      trace: {
        turnId: "delegate-turn-failed",
        sessionId: "delegate-session",
        status: "failed",
        model: "delegate-model",
        failure: {
          failureClass: "tool_failed",
          message: "delegate tool failed",
          retryable: true,
        },
      },
      citations: [],
      routing: { effectiveProviderId: "delegate-provider" },
    })) as never;

    const result = await executeDelegatedPlanStep(host, createPreparedTurn({ mode: "cowork" }), {
      ...createDelegatedStepInput(),
      step: {
        ...createDelegatedStepInput().step,
        role: "qa-validator",
        delegatedRole: "qa-validator",
      },
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        output: "delegate tool failed",
        error: "delegate tool failed",
        failureGuidance: "fallback guidance",
        childTurnId: "delegate-turn-failed",
      }),
    );
  });

  it("does not treat child tool-budget traces as clean completed delegated steps", async () => {
    const host = createHost();
    host.agentSendChatMessage = vi.fn(async () => ({
      sessionId: "delegate-session",
      userMessage: { messageId: "delegate-user" },
      assistantMessage: {
        messageId: "delegate-assistant",
        content: "Strong leads gathered; hours and email still need verification.",
      },
      turnId: "delegate-turn-budget",
      trace: {
        turnId: "delegate-turn-budget",
        sessionId: "delegate-session",
        status: "completed",
        model: "delegate-model",
        failure: {
          failureClass: "tool_run_budget_exceeded",
          message: "Tool run budget exceeded for this turn after 7 tool calls.",
          retryable: true,
        },
      },
      citations: [],
      routing: { effectiveProviderId: "delegate-provider" },
    })) as never;

    const result = await executeDelegatedPlanStep(host, createPreparedTurn({ mode: "cowork" }), {
      ...createDelegatedStepInput(),
      step: {
        ...createDelegatedStepInput().step,
        role: "researcher",
        delegatedRole: "researcher",
      },
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        output: "Strong leads gathered; hours and email still need verification.",
        error: "Tool run budget exceeded for this turn after 7 tool calls.",
        failureGuidance: "continue from gathered leads guidance",
        childTurnId: "delegate-turn-budget",
      }),
    );
  });

  it("records delegated aborts before dispatch without calling the child turn runtime", async () => {
    const host = createHost();
    const controller = new AbortController();
    controller.abort(new Error("operator stopped delegation"));

    const result = await executeDelegatedPlanStep(host, createPreparedTurn({ mode: "cowork" }), {
      ...createDelegatedStepInput(),
      signal: controller.signal,
    } as never);

    expect(host.agentSendChatMessage).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        status: "cancelled",
        summary: "synthesis cancelled",
        error: "turn-1",
        childSessionId: "delegate-session",
      }),
    );
    expect(host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "orchestration.step.cancelled_before_result",
        runtimeStatus: "cancelled",
        context: expect.objectContaining({
          delegatedDispatchStarted: false,
          delegatedResponseReceived: false,
        }),
      }),
    );
  });

  it("marks empty-output stream recovery as repaired in both the trace and message_done", async () => {
    const host = createHost();
    const chunks = [];

    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "hello", mode: "chat" } as never,
      createPreparedTurn(),
      "chat_thread_turn_appended",
    )) {
      chunks.push(chunk);
    }

    const messageDone = chunks.find((chunk) => chunk.type === "message_done");
    const traceUpdate = [...chunks].reverse().find((chunk) => chunk.type === "trace_update");

    expect(messageDone).toEqual(
      expect.objectContaining({
        type: "message_done",
        content: "Recovered empty assistant output.",
        repaired: true,
        repair: {
          applied: true,
          kind: "deterministic_empty_output_synthesis",
          source: "stream_layer",
          preRepairContent: "",
          postRepairContent: "Recovered empty assistant output.",
        },
      }),
    );
    expect(traceUpdate).toEqual(
      expect.objectContaining({
        type: "trace_update",
        trace: expect.objectContaining({
          completion: expect.objectContaining({
            status: "complete",
            repaired: true,
            repair: expect.objectContaining({
              applied: true,
              kind: "deterministic_empty_output_synthesis",
              source: "stream_layer",
            }),
          }),
        }),
      }),
    );
    expect(host.storage.chatTurnTraces.get("turn-1").completion).toEqual({
      status: "complete",
      repaired: true,
      repair: {
        applied: true,
        kind: "deterministic_empty_output_synthesis",
        source: "stream_layer",
        preRepairContent: "",
        postRepairContent: "Recovered empty assistant output.",
      },
    });
    expect(host.hooksService.runInlineHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "before_message_write",
        payload: expect.objectContaining({
          turnId: "turn-1",
          messageId: "assistant-1",
          contentLength: "Recovered empty assistant output.".length,
          stream: true,
        }),
      }),
    );
    expect(host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "agent_end",
        payload: expect.objectContaining({
          turnId: "turn-1",
          status: "completed",
          stream: true,
          repaired: true,
        }),
      }),
    );
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        type: "done",
      }),
    );
  });

  it("streams orchestration progress and final synthesized deltas before message_done", async () => {
    const host = createHost();
    host.resolvePreparedTurnOrchestration = vi.fn(async () => createModeOrchestrationResolution()) as never;
    host.createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { content: "Planner output" }, finish_reason: "stop" }],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            message: { content: "## Dinner Party Plan\n\nFinal host-ready checklist." },
            finish_reason: "stop",
          },
        ],
      }) as never;

    const chunks = [];
    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "plan dinner", mode: "cowork" } as never,
      createPreparedTurn({ mode: "cowork" }),
      "chat_thread_turn_appended",
      createModeOrchestrationResolution(),
    )) {
      chunks.push(chunk);
    }

    const messageDoneIndex = chunks.findIndex((chunk) => chunk.type === "message_done");
    const progressTraceIndex = chunks.findIndex(
      (chunk) => chunk.type === "trace_update" && Boolean(chunk.trace.orchestration?.steps.length),
    );
    const deltaIndex = chunks.findIndex((chunk) => chunk.type === "delta");

    expect(progressTraceIndex).toBeGreaterThan(0);
    expect(progressTraceIndex).toBeLessThan(messageDoneIndex);
    expect(deltaIndex).toBeGreaterThan(progressTraceIndex);
    expect(deltaIndex).toBeLessThan(messageDoneIndex);
    expect(chunks[deltaIndex]).toEqual(
      expect.objectContaining({
        type: "delta",
        delta: "## Dinner Party Plan\n\nFinal host-ready checklist.",
      }),
    );
    expect(chunks[messageDoneIndex]).toEqual(
      expect.objectContaining({
        type: "message_done",
        content: "## Dinner Party Plan\n\nFinal host-ready checklist.",
      }),
    );
  });

  it("emits capability_upgrade_suggestion in-band on a normal completion", async () => {
    const host = createHost();
    host.resolvePreparedTurnOrchestration = vi.fn(async () => createModeOrchestrationResolution()) as never;
    host.collectCapabilityUpgradeSuggestions = vi.fn(async () => [
      {
        suggestionId: "capability-1",
        capabilityId: "shell.exec",
        label: "Shell execution",
        reason: "A follow-up step would benefit from shell access.",
      },
    ]) as never;
    host.createChatCompletion = vi
      .fn()
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { content: "Planner output" }, finish_reason: "stop" }],
      })
      .mockResolvedValueOnce({
        model: "gpt-5.4",
        choices: [{ index: 0, message: { content: "Final host-ready checklist." }, finish_reason: "stop" }],
      }) as never;

    const chunks = [];
    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "plan dinner", mode: "cowork" } as never,
      createPreparedTurn({ mode: "cowork" }),
      "chat_thread_turn_appended",
      createModeOrchestrationResolution(),
    )) {
      chunks.push(chunk);
    }

    // Regression guard: capability suggestions must be emitted in-band on normal
    // completions (not silently deferred to an unconsumed realtime event).
    expect(chunks.some((chunk) => chunk.type === "message_done")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "capability_upgrade_suggestion")).toBe(true);
  });

  it("persists advisory-only orchestration plans without delegated execution", async () => {
    const host = createHost();
    const progress: Array<Record<string, unknown>> = [];
    const resolution = createModeOrchestrationResolution() as any;
    resolution.executionPlanDraft.advisoryOnly = true;

    const result = await executePreparedModeOrchestration(
      host,
      createPreparedTurn({ mode: "cowork" }),
      { content: "plan dinner", mode: "cowork" } as never,
      undefined,
      (summary) => {
        progress.push(summary);
      },
      resolution,
    );

    expect(result).toEqual(
      expect.objectContaining({
        finalOutput: "execution plan",
        finalSummary: "Dinner planning workflow.",
        citations: [],
        stepResults: [],
        executionPlanId: "plan-1",
      }),
    );
    expect(progress).toHaveLength(2);
    expect(host.createChatCompletion).not.toHaveBeenCalled();
    expect(host.storage.chatDelegationRuns.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: "completed",
        finalSummary: "Dinner planning workflow.",
        stitchedOutput: "execution plan",
        citations: [],
      }),
    );
    expect(host.storage.chatExecutionPlans.patch).toHaveBeenCalledWith(
      "plan-1",
      expect.objectContaining({
        status: "ready",
        summary: "Dinner planning workflow.",
      }),
    );
  });

  it("rejects prepared mode orchestration when the prepared turn no longer resolves", async () => {
    await expect(
      executePreparedModeOrchestration(createHost(), createPreparedTurn({ mode: "cowork" }), {
        content: "plan dinner",
        mode: "cowork",
      } as never),
    ).rejects.toThrow("Prepared chat turn is not eligible for orchestration");
  });

  it("finalizes approval-required streams without writing an assistant message", async () => {
    const host = createHost();
    host.turnRuntime.runStream = vi.fn(async function* () {
      yield {
        type: "approval_required",
        sessionId: "session-1",
        turnId: "turn-1",
        approvalId: "approval-1",
      };
    }) as never;
    host.storage.chatToolRuns.listByTurn = vi.fn(() => [
      {
        toolRunId: "tool-1",
        turnId: "turn-1",
        toolName: "shell.exec",
        status: "approval_required",
        approvalId: "approval-1",
      },
    ]) as never;
    host.collectCapabilityUpgradeSuggestions = vi.fn(async () => [
      {
        suggestionId: "capability-1",
        capabilityId: "shell.exec",
        label: "Shell execution",
        reason: "Approval is waiting on a shell command.",
      },
    ]) as never;

    const chunks = [];
    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "run command", mode: "code" } as never,
      createPreparedTurn({ mode: "code" }),
      "chat_thread_turn_appended",
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "message_start",
      "approval_required",
      "capability_upgrade_suggestion",
      "trace_update",
    ]);
    expect(host.ingestEvent).not.toHaveBeenCalled();
    expect(host.updateActiveLeafOrThrow).toHaveBeenCalledWith("session-1", "turn-0", "turn-1");
    expect(host.recordCapabilityGapFromTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        turnId: "turn-1",
      }),
    );
    expect(host.hooksService.enqueueAfterHooks).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: "agent_end",
        payload: expect.objectContaining({
          turnId: "turn-1",
          approvalId: "approval-1",
          toolRunCount: 1,
          stream: true,
        }),
      }),
    );
  });

  it("finalizes user-input-required streams without done or assistant persistence", async () => {
    const host = createHost();
    const prompt = {
      promptId: "clarify-1",
      message: "Which repository should I inspect?",
      choices: ["gateway", "mission-control"],
    };
    host.turnRuntime.runStream = vi.fn(async function* () {
      yield {
        type: "user_input_required",
        sessionId: "session-1",
        turnId: "turn-1",
        prompt,
      };
    }) as never;

    const chunks = [];
    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "inspect it", mode: "chat" } as never,
      createPreparedTurn(),
      "chat_thread_turn_appended",
      undefined,
      { skipMessageStart: true },
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual(["user_input_required", "trace_update"]);
    expect(chunks[1]).toEqual(
      expect.objectContaining({
        trace: expect.objectContaining({
          status: "waiting_for_user_input",
          pendingUserInput: prompt,
        }),
      }),
    );
    expect(host.ingestEvent).not.toHaveBeenCalled();
    expect(chunks.some((chunk) => chunk.type === "done")).toBe(false);
  });

  it("marks an aborted stream as cancelled and still ends the active execution", async () => {
    const host = createHost();
    let controller: AbortController | undefined;
    host.beginActiveChatTurnExecution = vi.fn((_sessionId, _turnId, _eventType) => {
      controller = new AbortController();
      return controller;
    }) as never;
    host.turnRuntime.runStream = vi.fn(async function* () {
      yield* [] as Iterable<never>;
      controller?.abort();
      throw new Error("aborted during provider stream");
    }) as never;
    host.markChatTurnCancelled = vi.fn(() => ({
      turnId: "turn-1",
      sessionId: "session-1",
      userMessageId: "user-1",
      parentTurnId: "turn-0",
      branchKind: "append",
      status: "cancelled",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      startedAt: "2026-04-18T00:00:00.000Z",
      toolRuns: [],
      citations: [],
      routing: {},
      failure: {
        failureClass: "cancelled",
        message: "Cancelled by operator.",
        retryable: true,
      },
    })) as never;

    const chunks = [];
    for await (const chunk of streamPreparedAgentChatTurn(
      host,
      "session-1",
      { content: "cancel", mode: "chat" } as never,
      createPreparedTurn(),
      "chat_thread_turn_appended",
    )) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.type)).toEqual(["message_start", "trace_update"]);
    expect(chunks.at(-1)).toEqual(
      expect.objectContaining({
        trace: expect.objectContaining({
          status: "cancelled",
          failure: expect.objectContaining({ failureClass: "cancelled" }),
        }),
      }),
    );
    expect(host.markChatTurnCancelled).toHaveBeenCalledWith("session-1", "turn-1");
    expect(host.endActiveChatTurnExecution).toHaveBeenCalledWith("turn-1", controller);
  });
});

function createHost(): ChatTurnStreamHost & {
  storage: {
    chatTurnTraces: {
      get: (turnId: string) => ChatTurnTraceRecord;
      patch: ReturnType<typeof vi.fn>;
    };
  };
  hooksService: {
    runInlineHooks: ReturnType<typeof vi.fn>;
    enqueueAfterHooks: ReturnType<typeof vi.fn>;
  };
} {
  let trace: ChatTurnTraceRecord = {
    turnId: "turn-1",
    sessionId: "session-1",
    userMessageId: "user-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    status: "running",
    mode: "chat",
    webMode: "off",
    memoryMode: "off",
    thinkingLevel: "standard",
    startedAt: "2026-04-18T00:00:00.000Z",
    toolRuns: [],
    citations: [],
    routing: {},
  };

  const patchTrace = vi.fn((_turnId: string, patch: Partial<ChatTurnTraceRecord>) => {
    trace = { ...trace, ...patch };
    return trace;
  });

  return {
    storage: {
      chatDelegationSteps: {
        create: vi.fn((input) => ({
          ...input,
          status: input.status ?? "pending",
          startedAt: input.startedAt ?? "2026-04-18T00:00:00.000Z",
        })),
        patch: vi.fn((stepId, input) => ({
          stepId,
          runId: "run-1",
          role: "synthesizer",
          index: 1,
          startedAt: "2026-04-18T00:00:00.000Z",
          ...input,
        })),
        listByRun: vi.fn(() => []),
      },
      chatToolRuns: {
        listByTurn: vi.fn(() => []),
        listByTurnIds: vi.fn(() => new Map()),
      },
      chatExecutionPlans: {
        create: vi.fn((input) => ({
          planId: "plan-1",
          ...input,
          steps: input.steps ?? [],
        })),
        patch: vi.fn(),
        get: vi.fn(() => ({ planId: "plan-1", steps: [] })),
      },
      chatDelegationRuns: {
        create: vi.fn(),
        patch: vi.fn(),
      },
      chatSessionProjects: {
        get: vi.fn(),
      },
      chatTurnTraces: {
        create: vi.fn(() => trace),
        patch: patchTrace,
        get: vi.fn((_turnId: string) => trace),
      },
    },
    turnRuntime: {
      runStream: vi.fn(async function* () {}),
    },
    hooksService: {
      runInlineHooks: vi.fn(async () => ({ runs: [] })),
      enqueueAfterHooks: vi.fn(),
    } as never,
    resolvePreparedTurnOrchestration: vi.fn(async () => undefined),
    createChatCompletion: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    buildChatOrchestrationSummary: vi.fn((input) => ({
      runId: input.runId,
      objective: input.objective,
      workflowTemplate: input.routeDecision.workflowTemplate,
      status: input.finalized ? "completed" : "running",
      modePolicy: input.modePolicy,
      visibility: input.routeDecision.visibility,
      finalSummary: input.finalSummary,
      integritySignals: input.integritySignals,
      routeDecision: input.routeDecision,
      steps: input.stepResults.map((step: any) => ({
        stepId: step.stepId,
        role: step.role,
        label: step.label,
        index: step.index,
        status: step.status,
        providerId: step.providerId,
        model: step.model,
        startedAt: step.startedAt,
        finishedAt: step.finishedAt,
        durationMs: step.durationMs,
        summary: step.summary,
        error: step.error,
      })),
    })),
    createChatSession: vi.fn(() => ({
      sessionId: "delegate-session",
      sessionKey: "mission:operator:delegate-session",
      workspaceId: "default",
      scope: "mission",
      includeInHistory: true,
      pinned: false,
      lifecycleStatus: "active",
      channel: "mission",
      account: "operator",
      updatedAt: "2026-04-18T00:00:00.000Z",
      lastActivityAt: "2026-04-18T00:00:00.000Z",
      tokenTotal: 0,
      costUsdTotal: 0,
    })),
    inheritDelegatedSessionToolGrants: vi.fn(),
    updateChatSessionPrefs: vi.fn(),
    agentSendChatMessage: vi.fn(),
    beginActiveChatTurnExecution: vi.fn(() => new AbortController()),
    endActiveChatTurnExecution: vi.fn(),
    steerService: new ChatSteerService(),
    ingestEvent: vi.fn(async () => undefined),
    updateActiveLeafOrThrow: vi.fn(),
    collectCapabilityUpgradeSuggestions: vi.fn(async () => []),
    collectSpecialistCandidateSuggestions: vi.fn(() => []),
    publishRealtime: vi.fn(),
    extractAndPersistLearnedMemory: vi.fn(),
    scheduleChatMemoryContextPrewarm: vi.fn(),
    scheduleMemoryMaintenancePostTurnEvaluation: vi.fn(),
    recordCapabilityGapFromTrace: vi.fn(),
    markChatTurnCancelled: vi.fn(() => trace),
  } as unknown as ChatTurnStreamHost & {
    storage: {
      chatTurnTraces: {
        get: (turnId: string) => ChatTurnTraceRecord;
        patch: ReturnType<typeof vi.fn>;
      };
    };
    hooksService: {
      runInlineHooks: ReturnType<typeof vi.fn>;
      enqueueAfterHooks: ReturnType<typeof vi.fn>;
    };
  };
}

function createPreparedTurn(overrides: { mode?: "chat" | "cowork" | "code"; normalizationProfile?: string } = {}) {
  const mode = overrides.mode ?? "chat";
  return {
    session: {
      sessionId: "session-1",
    },
    turnId: "turn-1",
    userEventId: "user-1",
    assistantMessageId: "assistant-1",
    parentTurnId: "turn-0",
    branchKind: "append",
    sourceTurnId: undefined,
    content: "hello",
    route: {
      provider: "openai",
      model: "gpt-5.4",
    },
    normalized: {
      mode,
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      normalizationProfile: overrides.normalizationProfile,
    },
    prefs: {
      mode,
      providerId: "openai",
      model: "gpt-5.4",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
    },
    history: [],
    autonomy: {
      proactiveMode: "off",
      lastProactiveRunId: undefined,
      retrievalMode: "off",
    },
    effectiveToolAutonomy: "manual",
    retrievalTrace: undefined,
    modelRouterDecision: {
      route: "direct_answer",
      requiresTools: false,
      confidenceScore: 0.8,
      orchestration: undefined,
    },
    workspaceId: "default",
    resolvedGuidance: {
      globalFilesUsed: [],
      workspaceFilesUsed: [],
      truncated: false,
    },
    modelRouterDecision: routeWithModelRouter({ prompt: "hello" }),
  } as never;
}

function createDelegatedStepInput() {
  const step = {
    stepId: "orch-step-synthesis",
    index: 1,
    role: "synthesizer",
    delegatedRole: "synthesis",
    label: "Synthesis",
    stage: 1,
    objective: "Synthesize the final answer.",
    successCriteria: "Return a concise final handoff.",
    expectedOutput: "Final answer",
    dependsOnStepIds: ["planner"],
    suggestedTools: ["browser.search", "file.find", "code.search"],
    providerId: "delegate-provider",
    model: "delegate-model",
  };
  return {
    task: {
      sessionId: "session-1",
      workspaceId: "default",
      mode: "cowork",
      objective: "review release notes",
      prefs: {
        mode: "cowork",
        providerId: "openai",
        model: "gpt-5.4",
        webMode: "off",
        memoryMode: "off",
        thinkingLevel: "standard",
      },
      conversation: [{ role: "user", content: "Please review the release notes." }],
      historyMessages: [],
    },
    plan: {
      workflowTemplate: "cowork.plan.work.synthesize",
      summary: "Review then synthesize.",
      routeDecision: {
        modePolicy: "cowork",
        workflowTemplate: "cowork.plan.work.synthesize",
        hidden: false,
        visibility: "explicit",
        intensity: "balanced",
        providerPreference: "balanced",
        reviewDepth: "standard",
        parallelism: "sequential",
        selectedRoles: ["Planner", "Synthesis"],
        selectedProviders: [],
        triggerReason: "test",
      },
      steps: [step],
    },
    priorSteps: [],
    step,
    stepIndex: 1,
    runId: "run-1",
  };
}

function createModeOrchestrationResolution() {
  const routeDecision = {
    modePolicy: "cowork",
    workflowTemplate: "cowork.plan.work.synthesize",
    hidden: false,
    visibility: "explicit",
    intensity: "balanced",
    providerPreference: "balanced",
    reviewDepth: "standard",
    parallelism: "sequential",
    selectedRoles: ["Planner", "Synthesis"],
    selectedProviders: [],
    triggerReason: "test",
  };
  const steps = [
    {
      stepId: "orch-step-1",
      index: 0,
      role: "planner",
      stage: 0,
      objective: "Plan the dinner party.",
      parallelizable: false,
      providerId: "openai",
      model: "gpt-5.4",
    },
    {
      stepId: "orch-step-2",
      index: 1,
      role: "synthesizer",
      label: "Synthesis",
      stage: 1,
      objective: "Synthesize the final answer.",
      parallelizable: false,
      dependsOnStepIds: ["orch-step-1"],
      providerId: "openai",
      model: "gpt-5.4",
    },
  ];
  return {
    routerInput: {
      task: {
        sessionId: "session-1",
        workspaceId: "default",
        mode: "cowork",
        objective: "plan dinner",
        prefs: {
          mode: "cowork",
          providerId: "openai",
          model: "gpt-5.4",
          webMode: "off",
          memoryMode: "off",
          thinkingLevel: "standard",
        },
        conversation: [],
        historyMessages: [],
      },
      runtime: {},
      capabilities: [],
      policy: {},
    },
    orchestrationPlan: {
      workflowTemplate: "cowork.plan.work.synthesize",
      routeDecision,
      summary: "Dinner planning workflow.",
      source: "workflow_template",
      steps,
    },
    executionPlanDraft: {
      source: "workflow_template",
      advisoryOnly: false,
      objective: "plan dinner",
      summary: "Dinner planning workflow.",
      steps: steps.map((step) => ({
        stepId: step.stepId,
        index: step.index,
        objective: step.objective,
        parallelizable: step.parallelizable,
        dependsOnStepIds: step.dependsOnStepIds,
        status: "pending",
      })),
    },
  } as never;
}
