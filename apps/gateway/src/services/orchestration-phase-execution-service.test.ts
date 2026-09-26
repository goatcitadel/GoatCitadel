import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatSendMessageResponse,
  ChatSessionRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
  OrchestrationPhase,
  OrchestrationPlan,
  OrchestrationRun,
} from "@goatcitadel/contracts";
import {
  buildOrchestrationPhaseTurnIdentity,
  OrchestrationPhaseExecutionService,
  type OrchestrationPhaseExecutionServiceDeps,
} from "./orchestration-phase-execution-service.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function buildPlan(): OrchestrationPlan {
  return {
    planId: "plan-1",
    goal: "Ship safely",
    mode: "auto",
    maxIterations: 3,
    maxRuntimeMinutes: 15,
    maxCostUsd: 5,
    waves: [],
  };
}

function buildRun(worktreePath: string): OrchestrationRun {
  return {
    runId: "run-1",
    planId: "plan-1",
    status: "running",
    startedAt: "2026-04-12T00:00:00.000Z",
    totalIterations: 0,
    totalCostUsd: 0,
    workspaceId: "default",
    executionState: "running",
    worktreePath,
    worktreeStatus: "ready",
  };
}

function buildPhase(): OrchestrationPhase {
  return {
    phaseId: "phase-1",
    ownerAgentId: "agent-1",
    specPath: "spec.md",
    loopMode: "fresh-context",
    requiresApproval: false,
  };
}

function buildDurableRun(): DurableRunRecord {
  return {
    runId: "durable-run-1",
    workflowKey: "orchestration.plan.execute",
    status: "running",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: {},
    metadata: {},
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gc-phase-exec-"));
  tempDirs.push(dir);
  return dir;
}

describe("OrchestrationPhaseExecutionService", () => {
  it("executes a phase in a child Cowork session with the phase spec included", async () => {
    const worktreePath = await makeTempDir();
    await fs.writeFile(path.join(worktreePath, "spec.md"), "Validate the release blocker.", "utf8");
    const createChatSession = vi.fn(
      () =>
        ({
          sessionId: "child-session-1",
        }) as ChatSessionRecord,
    );
    const updateChatSessionPrefs = vi.fn();
    const agentSendChatMessage = vi.fn(
      async () =>
        ({
          sessionId: "child-session-1",
          userMessage: {} as never,
          assistantMessage: {
            content: "Phase completed with evidence.",
            costUsd: 0.25,
            tokenInput: 10,
            tokenOutput: 20,
          } as never,
          transport: "llm",
          model: "gpt-test",
          turnId: "turn-1",
          trace: {
            status: "completed",
            durable: { runId: "child-run-1" },
          } as never,
        }) as ChatSendMessageResponse,
    );
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession,
      updateChatSessionPrefs,
      agentSendChatMessage,
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: {
        ...buildRun(worktreePath),
        permissionProfileId: "ignored-run-profile",
        localOperatorOverrideId: "ignored-run-override",
      },
      phase: buildPhase(),
      durableRun: buildDurableRun(),
      policyContext: {
        operatorId: "operator-1",
        authActorId: "auth-operator-1",
        authActorSource: "loopback",
        permissionProfileId: "trusted-local-power",
        localOperatorOverrideId: "override-1",
      },
    });

    expect(result).toMatchObject({
      phaseId: "phase-1",
      status: "completed",
      childSessionId: "child-session-1",
      childTurnId: "turn-1",
      childRunId: "child-run-1",
      outputSummary: "Phase completed with evidence.",
      prompt: {
        promptId: "orchestration.durable.phase.execute",
        promptVersion: "v1",
        promptHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
    expect(createChatSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "cowork", origin: "system" }));
    expect(updateChatSessionPrefs).toHaveBeenCalledWith(
      "child-session-1",
      expect.objectContaining({
        mode: "cowork",
        orchestrationEnabled: false,
        proactiveMode: "off",
        reflectionMode: "off",
        subagentPolicy: "off",
      }),
    );
    const sentPrompt = agentSendChatMessage.mock.calls[0]?.[1].content ?? "";
    // Assert each bounded metadata field is present rather than snapshotting exact
    // line positions, so benign prompt-formatting changes don't false-fail this guard.
    expect(sentPrompt).toContain("You are executing one GoatCitadel Cowork orchestration phase.");
    expect(sentPrompt).toContain("Goal: Ship safely");
    expect(sentPrompt).toContain("Run: run-1");
    expect(sentPrompt).toContain("Durable run: durable-run-1");
    expect(sentPrompt).toContain("Phase: phase-1");
    expect(sentPrompt).toContain("Owner agent: agent-1");
    expect(sentPrompt).toContain("Loop mode: fresh-context");
    expect(sentPrompt).toContain("Spec path: spec.md");
    expect(sentPrompt).toContain("Phase spec:\nValidate the release blocker.");
    expect(sentPrompt).toContain("Do not claim later phases are complete.");
    expect(sentPrompt).not.toContain("ignored-run-profile");
    expect(agentSendChatMessage.mock.calls[0]?.[1]).toMatchObject({
      subagentPolicy: "off",
      prefsOverride: expect.objectContaining({
        proactiveMode: "off",
        reflectionMode: "off",
        subagentPolicy: "off",
      }),
      operatorId: "operator-1",
      authActorId: "auth-operator-1",
      authActorSource: "loopback",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
      policyRunId: "run-1",
      policyTaskId: "phase-1",
    });
  });

  it("reports the child dispatch linkage before and after the durable child run is launched", async () => {
    const worktreePath = await makeTempDir();
    await fs.writeFile(path.join(worktreePath, "spec.md"), "Validate the release blocker.", "utf8");
    const dispatches: Array<{ phaseId: string; childSessionId?: string; childRunId?: string }> = [];
    const agentSendChatMessage = vi.fn(async (_sessionId: string, _input: unknown, options?: unknown) => {
      // The dispatch layer surfaces the launched durable child run id as soon as
      // the child run row exists, before the (possibly long) turn settles.
      (options as { onChildDurableRunLaunched?: (runId: string) => void } | undefined)?.onChildDurableRunLaunched?.(
        "child-run-1",
      );
      return {
        sessionId: "child-session-1",
        userMessage: {} as never,
        assistantMessage: { content: "Phase completed with evidence." } as never,
        transport: "llm",
        model: "gpt-test",
        turnId: "turn-1",
        trace: { status: "completed", durable: { runId: "child-run-1" } } as never,
      } as ChatSendMessageResponse;
    });
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(() => ({ sessionId: "child-session-1" }) as ChatSessionRecord),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage,
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
      onChildDispatched: (dispatch) => dispatches.push(dispatch),
    });

    const childTurnId = buildOrchestrationPhaseTurnIdentity("run-1", "phase-1").turnId;
    expect(result.status).toBe("completed");
    // First breadcrumb: session and deterministic turn known before dispatch, run id not yet known.
    expect(dispatches[0]).toEqual({ phaseId: "phase-1", childSessionId: "child-session-1", childTurnId });
    // Second breadcrumb: durable child run id surfaced the instant it is created.
    expect(dispatches[1]).toEqual({
      phaseId: "phase-1",
      childSessionId: "child-session-1",
      childTurnId,
      childRunId: "child-run-1",
    });
  });

  it("maps child session send failures to failed phase results", async () => {
    const worktreePath = await makeTempDir();
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(async () => {
        throw new Error("provider unavailable");
      }),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      phaseId: "phase-1",
      status: "failed",
      childSessionId: "child-session-1",
      error: "provider unavailable",
    });
  });

  it("maps a child waiting on an approval to a phase that waits on the child, not the approval", async () => {
    const worktreePath = await makeTempDir();
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(
        async () =>
          ({
            sessionId: "child-session-1",
            userMessage: {} as never,
            assistantMessage: undefined,
            transport: "llm",
            model: "gpt-test",
            turnId: "turn-approval",
            trace: {
              status: "waiting_for_approval",
              waitStatus: "waiting_for_approval",
              durable: { runId: "child-run-approval" },
              pendingApprovalSummary: {
                approvalId: "approval-phase-1",
              },
              failure: {
                failureClass: "approval_required",
                message: "Tool approval required.",
              },
            } as never,
          }) as ChatSendMessageResponse,
      ),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      phaseId: "phase-1",
      status: "waiting",
      childSessionId: "child-session-1",
      childTurnId: "turn-approval",
      childRunId: "child-run-approval",
    });
    // The operator resolves the approval in Chat; the parent only waits for the child to settle.
    expect(result.approvalId).toBeUndefined();
    expect(result.outputSummary).toBeUndefined();
  });

  it("fails a phase whose child turn stops for user input orchestration cannot answer", async () => {
    const worktreePath = await makeTempDir();
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(
        async () =>
          ({
            sessionId: "child-session-1",
            userMessage: {} as never,
            assistantMessage: {
              content: "Need operator input.",
            } as never,
            transport: "llm",
            model: "gpt-test",
            turnId: "turn-user-input",
            trace: {
              status: "waiting_for_user_input",
              waitStatus: "waiting_for_user_input",
              durable: { runId: "child-run-user-input" },
            } as never,
          }) as ChatSendMessageResponse,
      ),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      phaseId: "phase-1",
      status: "failed",
      childSessionId: "child-session-1",
      childTurnId: "turn-user-input",
      childRunId: "child-run-user-input",
      error:
        "Phase child turn is waiting for user input, but durable orchestration can only pause/resume approval waits. Refactor this phase to: (1) detect where input is needed, (2) emit an approval-required tool/action and return waiting_for_approval, and (3) resume the run after approval to continue execution.",
    });
  });

  it("does not treat provider messages containing cancelled as operator phase aborts", async () => {
    const worktreePath = await makeTempDir();
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(async () => {
        throw new Error("provider cancelled request upstream");
      }),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      phaseId: "phase-1",
      status: "failed",
      childSessionId: "child-session-1",
      error: "provider cancelled request upstream",
    });
  });

  it("refuses aborted phase execution before creating a child session", async () => {
    const worktreePath = await makeTempDir();
    const createChatSession = vi.fn(
      () =>
        ({
          sessionId: "child-session-1",
        }) as ChatSessionRecord,
    );
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession,
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });
    const abortReason = new Error("operator cancelled phase");

    await expect(
      service.execute({
        plan: buildPlan(),
        run: buildRun(worktreePath),
        phase: buildPhase(),
        durableRun: buildDurableRun(),
        signal: AbortSignal.abort(abortReason),
      }),
    ).rejects.toThrow("operator cancelled phase");
    expect(createChatSession).not.toHaveBeenCalled();
  });

  it("propagates in-flight phase cancellation into the child chat turn", async () => {
    const worktreePath = await makeTempDir();
    const abortController = new AbortController();
    let childAbortSignal: AbortSignal | undefined;
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(
        async (_sessionId, _input, options) =>
          new Promise<ChatSendMessageResponse>((_resolve, reject) => {
            childAbortSignal = options?.abortSignal;
            options?.abortSignal?.addEventListener(
              "abort",
              () => reject(options.abortSignal?.reason ?? new Error("child turn aborted")),
              { once: true },
            );
          }),
      ),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const promise = service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
      signal: abortController.signal,
    });
    await vi.waitFor(() => {
      expect(childAbortSignal).toBe(abortController.signal);
    });
    abortController.abort(new Error("operator cancelled child turn"));

    await expect(promise).rejects.toThrow("operator cancelled child turn");
  });

  it("keeps unreadable or escaped phase specs inside the child prompt as explicit operator evidence", async () => {
    const worktreePath = await makeTempDir();
    const createChatSession = vi.fn(
      () =>
        ({
          sessionId: "child-session-1",
        }) as ChatSessionRecord,
    );
    const agentSendChatMessage = vi.fn(
      async () =>
        ({
          sessionId: "child-session-1",
          userMessage: {} as never,
          assistantMessage: {
            content: "Recovered from metadata.",
          } as never,
          transport: "llm",
          turnId: "turn-1",
          trace: {
            status: "completed",
          } as never,
        }) as ChatSendMessageResponse,
    );
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession,
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage,
      normalizeWorkspaceId: (workspaceId) => `normalized-${workspaceId}`,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: {
        ...buildPhase(),
        specPath: "../outside.md",
      },
      durableRun: buildDurableRun(),
    });

    expect(result.status).toBe("completed");
    expect(createChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "normalized-default",
      }),
    );
    expect(agentSendChatMessage.mock.calls[0]?.[1].content).toContain(
      "Spec path ../outside.md resolves outside the orchestration workspace and was not read.",
    );
  });

  it("maps failed child traces without assistant text to failed phase output", async () => {
    const worktreePath = await makeTempDir();
    const service = new OrchestrationPhaseExecutionService({
      rootDir: worktreePath,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(
        async () =>
          ({
            sessionId: "child-session-1",
            userMessage: {} as never,
            assistantMessage: {
              content: "   ",
            } as never,
            transport: "llm",
            turnId: "turn-1",
            trace: {
              status: "failed",
              failure: {
                failureClass: "provider_error",
              },
            } as never,
          }) as ChatSendMessageResponse,
      ),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      status: "failed",
      outputSummary: "provider_error",
      outputText: "provider_error",
      error: "provider_error",
    });
  });

  it("truncates oversized specs and empty child output without inventing completion evidence", async () => {
    const rootDir = await makeTempDir();
    await fs.writeFile(path.join(rootDir, "large.md"), "x".repeat(24_050), "utf8");
    const agentSendChatMessage = vi.fn(
      async () =>
        ({
          sessionId: "child-session-1",
          userMessage: {} as never,
          assistantMessage: {
            content: "   ",
          } as never,
          transport: "llm",
          turnId: "turn-1",
          trace: {
            status: "completed",
          } as never,
        }) as ChatSendMessageResponse,
    );
    const service = new OrchestrationPhaseExecutionService({
      rootDir,
      createChatSession: vi.fn(
        () =>
          ({
            sessionId: "child-session-1",
          }) as ChatSessionRecord,
      ),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage,
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: {
        ...buildRun(rootDir),
        workspaceId: undefined,
        worktreePath: undefined,
      },
      phase: {
        ...buildPhase(),
        specPath: "large.md",
      },
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      status: "failed",
      outputSummary: "Phase child turn finished without assistant output.",
      outputText: "Phase child turn finished without assistant output.",
      error: "Phase child turn finished without assistant output.",
    });
    expect(agentSendChatMessage.mock.calls[0]?.[1].content).toContain("[Spec truncated after 24000 characters.]");
  });

  it("uses a generic abort error when the signal has no Error reason", async () => {
    const service = new OrchestrationPhaseExecutionService({
      rootDir: await makeTempDir(),
      createChatSession: vi.fn(),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
    });
    const controller = new AbortController();
    controller.abort("stop");

    await expect(
      service.execute({
        plan: buildPlan(),
        run: buildRun(await makeTempDir()),
        phase: buildPhase(),
        durableRun: buildDurableRun(),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Orchestration phase aborted.");
  });
});

describe("OrchestrationPhaseExecutionService child parking", () => {
  function buildTrace(overrides: Partial<ChatTurnTraceRecord> = {}): ChatTurnTraceRecord {
    return {
      turnId: "turn-1",
      sessionId: "child-session-1",
      status: "completed",
      startedAt: "2026-04-12T00:00:01.000Z",
      finishedAt: "2026-04-12T00:00:09.000Z",
      assistantMessageId: "assistant-1",
      model: "gpt-test",
      toolRuns: [],
      citations: [],
      ...overrides,
    } as ChatTurnTraceRecord;
  }

  function buildService(overrides: Partial<OrchestrationPhaseExecutionServiceDeps> = {}) {
    return new OrchestrationPhaseExecutionService({
      rootDir: os.tmpdir(),
      createChatSession: vi.fn(() => ({ sessionId: "child-session-1" }) as ChatSessionRecord),
      updateChatSessionPrefs: vi.fn(),
      agentSendChatMessage: vi.fn(),
      normalizeWorkspaceId: (workspaceId) => workspaceId,
      readChatTurnTrace: vi.fn(async () => buildTrace()),
      readChatMessageContent: vi.fn(async () => "Phase output from the child."),
      readChatTurnUsage: vi.fn(async () => ({ costUsd: 0.42, costComplete: true, inputTokens: 100, outputTokens: 40 })),
      ...overrides,
    });
  }

  const harvestInput = {
    phaseId: "phase-1",
    ownerAgentId: "agent-1",
    childRunId: "child-run-1",
    childSessionId: "child-session-1",
    childTurnId: "turn-1",
    startedAt: "2026-04-12T00:00:00.500Z",
  };

  it("dispatches a deterministic child turn and returns once the child is admitted", async () => {
    const worktreePath = await makeTempDir();
    const agentSendChatMessage = vi.fn(async () => ({
      sessionId: "child-session-1",
      userMessage: {} as never,
      transport: "llm" as const,
      turnId: "orchestration-turn-x",
      trace: { status: "running", durable: { runId: "child-run-1" } } as never,
    }));
    const service = buildService({ agentSendChatMessage });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({
      status: "waiting",
      childSessionId: "child-session-1",
      childTurnId: "orchestration-turn-x",
      childRunId: "child-run-1",
    });
    const options = agentSendChatMessage.mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(options).toMatchObject({
      turnIdentity: buildOrchestrationPhaseTurnIdentity("run-1", "phase-1"),
      returnAfterDurableAdmission: true,
      onChildDurableRunLaunched: expect.any(Function),
    });
  });

  it("derives a stable child turn identity per run and phase", () => {
    const identity = buildOrchestrationPhaseTurnIdentity("run-1", "phase-1");
    expect(buildOrchestrationPhaseTurnIdentity("run-1", "phase-1")).toEqual(identity);
    expect(buildOrchestrationPhaseTurnIdentity("run-1", "phase-2").turnId).not.toBe(identity.turnId);
    expect(buildOrchestrationPhaseTurnIdentity("run-2", "phase-1").turnId).not.toBe(identity.turnId);
    // Length-prefixed parts keep ("a|b", "c") and ("a", "b|c") distinct.
    expect(buildOrchestrationPhaseTurnIdentity("a|b", "c").turnId).not.toBe(
      buildOrchestrationPhaseTurnIdentity("a", "b|c").turnId,
    );
    expect(identity.turnId).toMatch(/^orchestration-turn-[a-f0-9]{32}$/);
    expect(identity.userMessageId).toMatch(/^orchestration-user-[a-f0-9]{32}$/);
    expect(identity.assistantMessageId).toMatch(/^orchestration-assistant-[a-f0-9]{32}$/);
  });

  it("harvests a completed child from its canonical trace, message and model usage", async () => {
    const service = buildService();

    const result = await service.harvest(harvestInput);

    expect(result).toMatchObject({
      phaseId: "phase-1",
      ownerAgentId: "agent-1",
      status: "completed",
      startedAt: "2026-04-12T00:00:00.500Z",
      finishedAt: "2026-04-12T00:00:09.000Z",
      outputText: "Phase output from the child.",
      childRunId: "child-run-1",
      childTurnId: "turn-1",
      model: "gpt-test",
      costUsd: 0.42,
      inputTokens: 100,
      outputTokens: 40,
    });
    expect(result?.costUnreported).toBeUndefined();
    expect(result?.error).toBeUndefined();
  });

  it("flags harvested cost as unreported when a model call reported none", async () => {
    const service = buildService({
      readChatTurnUsage: vi.fn(async () => ({ costUsd: 0.1, costComplete: false })),
    });

    const result = await service.harvest(harvestInput);

    expect(result).toMatchObject({ status: "completed", costUsd: 0.1, costUnreported: true });
  });

  it("flags cost as unreported when usage cannot be read", async () => {
    const service = buildService({ readChatTurnUsage: undefined });

    const result = await service.harvest(harvestInput);

    expect(result).toMatchObject({ status: "completed", costUnreported: true });
    expect(result?.costUsd).toBeUndefined();
  });

  it.each(["queued", "running", "waiting_for_approval", "waiting_for_tool"] as const)(
    "keeps waiting while the child turn is %s",
    async (status) => {
      const service = buildService({ readChatTurnTrace: vi.fn(async () => buildTrace({ status })) });

      await expect(service.harvest(harvestInput)).resolves.toBeUndefined();
    },
  );

  it("keeps waiting when the child trace or turn id is not available", async () => {
    await expect(buildService({ readChatTurnTrace: vi.fn(async () => undefined) }).harvest(harvestInput)).resolves.toBe(
      undefined,
    );
    await expect(buildService().harvest({ ...harvestInput, childTurnId: undefined })).resolves.toBeUndefined();
  });

  it("fails the phase when the child turn stops for user input", async () => {
    const service = buildService({
      readChatTurnTrace: vi.fn(async () => buildTrace({ status: "waiting_for_user_input", finishedAt: undefined })),
      readChatMessageContent: vi.fn(async () => "Which environment should I use?"),
    });

    const result = await service.harvest(harvestInput);

    expect(result).toMatchObject({
      status: "failed",
      outputText: "Which environment should I use?",
      error: expect.stringContaining("waiting for user input"),
    });
  });

  it("fails the phase with the child's failure when the child turn failed", async () => {
    const service = buildService({
      readChatTurnTrace: vi.fn(async () =>
        buildTrace({
          status: "failed",
          assistantMessageId: undefined,
          failure: { failureClass: "provider_error", message: "Provider rejected the request." } as never,
        }),
      ),
    });

    const result = await service.harvest(harvestInput);

    expect(result).toMatchObject({
      status: "failed",
      outputText: "Provider rejected the request.",
      error: "Provider rejected the request.",
    });
  });

  it("reads an already settled replayed child through its canonical records", async () => {
    const worktreePath = await makeTempDir();
    const service = buildService({
      agentSendChatMessage: vi.fn(async () => ({
        sessionId: "child-session-1",
        userMessage: {} as never,
        // The replayed response's own message cost covers only the last model call.
        assistantMessage: { content: "Phase output from the child.", costUsd: 0.01 } as never,
        transport: "llm" as const,
        turnId: "turn-1",
        trace: { status: "completed", durable: { runId: "child-run-1" } } as never,
      })),
    });

    const result = await service.execute({
      plan: buildPlan(),
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
    });

    expect(result).toMatchObject({ status: "completed", childRunId: "child-run-1", costUsd: 0.42 });
  });
});
