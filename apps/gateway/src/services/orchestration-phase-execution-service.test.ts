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
      run: buildRun(worktreePath),
      phase: buildPhase(),
      durableRun: buildDurableRun(),
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
