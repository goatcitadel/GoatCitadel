import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ChatSendMessageResponse,
  ChatSessionRecord,
  DurableRunRecord,
  OrchestrationPhase,
  OrchestrationPlan,
  OrchestrationRun,
} from "@goatcitadel/contracts";
import { OrchestrationPhaseExecutionService } from "./orchestration-phase-execution-service.js";

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
    });
    expect(createChatSession).toHaveBeenCalledWith(expect.objectContaining({ mode: "cowork", origin: "system" }));
    expect(updateChatSessionPrefs).toHaveBeenCalledWith(
      "child-session-1",
      expect.objectContaining({ mode: "cowork", orchestrationEnabled: false }),
    );
    expect(agentSendChatMessage.mock.calls[0]?.[1].content).toContain("Validate the release blocker.");
    expect(agentSendChatMessage.mock.calls[0]?.[1]).toMatchObject({
      operatorId: "operator-1",
      authActorId: "auth-operator-1",
      authActorSource: "loopback",
      permissionProfileId: "trusted-local-power",
      localOperatorOverrideId: "override-1",
      policyRunId: "run-1",
      policyTaskId: "phase-1",
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

  it("maps child approval waits to waiting phase results", async () => {
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
      outputSummary: "Tool approval required.",
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
      outputSummary: undefined,
      outputText: undefined,
      error: undefined,
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
