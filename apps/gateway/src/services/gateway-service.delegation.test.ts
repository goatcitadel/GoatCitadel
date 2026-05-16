import { describe, expect, it, vi } from "vitest";
import type {
  ChatDelegateResponse,
  ChatDelegationStepRecord,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
} from "@goatcitadel/contracts";
import { GatewayService } from "./gateway-service.js";
import { ChatDelegationService } from "./chat-delegation-service.js";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

function buildPrefs(): ChatSessionPrefsRecord {
  return {
    sessionId: "sess-1",
    mode: "cowork",
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "safe_auto",
    orchestrationEnabled: true,
    orchestrationIntensity: "balanced",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: "balanced",
    orchestrationReviewDepth: "standard",
    orchestrationParallelism: "parallel",
    codeAutoApply: "manual",
    proactiveMode: "off",
    retrievalMode: "layered",
    reflectionMode: "off",
    createdAt: "2026-04-19T00:00:00.000Z",
    updatedAt: "2026-04-19T00:00:00.000Z",
  };
}

function createDelegationHarness() {
  const gateway = Object.create(GatewayService.prototype) as GatewayService & Record<string, unknown>;
  const prefs = buildPrefs();
  const steps = new Map<string, ChatDelegationStepRecord>();
  const sessionRoles = new Map<string, string>();
  let childSessionCounter = 0;

  const createStepRecord = (
    input: Partial<ChatDelegationStepRecord> &
      Pick<ChatDelegationStepRecord, "stepId" | "runId" | "role" | "index" | "startedAt">,
  ): ChatDelegationStepRecord => ({
    stepId: input.stepId,
    runId: input.runId,
    role: input.role,
    status: input.status ?? "pending",
    index: input.index,
    providerId: input.providerId,
    model: input.model,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    summary: input.summary,
    output: input.output,
    error: input.error,
    failureGuidance: input.failureGuidance,
    durableRunId: input.durableRunId,
    childSessionId: input.childSessionId,
    childTurnId: input.childTurnId,
    citations: input.citations,
  });

  const buildResponse = (role: string, childSessionId: string, failed = false): ChatSendMessageResponse => ({
    sessionId: childSessionId,
    transport: "llm",
    userMessage: {
      messageId: `user-${role}`,
      sessionId: childSessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "delegate task",
      timestamp: "2026-04-19T00:00:00.000Z",
    },
    assistantMessage: {
      messageId: `assistant-${role}`,
      sessionId: childSessionId,
      role: "assistant",
      actorType: "agent",
      actorId: role,
      content: `${role} output`,
      timestamp: "2026-04-19T00:00:01.000Z",
    },
    model: "gpt-5.4",
    turnId: `child-turn-${role}`,
    citations: [],
    routing: {
      effectiveProviderId: "openai",
      effectiveModel: "gpt-5.4",
    },
    trace: {
      turnId: `child-turn-${role}`,
      sessionId: childSessionId,
      userMessageId: `user-${role}`,
      branchKind: "append",
      status: failed ? "failed" : "completed",
      mode: "cowork",
      model: "gpt-5.4",
      webMode: "auto",
      memoryMode: "auto",
      thinkingLevel: "standard",
      startedAt: "2026-04-19T00:00:00.000Z",
      finishedAt: "2026-04-19T00:00:01.000Z",
      toolRuns: [],
      citations: [],
      routing: {
        effectiveProviderId: "openai",
        effectiveModel: "gpt-5.4",
      },
      failure: failed
        ? {
            failureClass: "delegate_error",
            message: `${role} failed`,
            retryable: false,
          }
        : undefined,
      durable: {
        runId: `durable-${role}`,
        status: failed ? "failed" : "completed",
      },
    },
  });

  gateway.getSession = vi.fn(() => ({ sessionId: "sess-1" }));
  gateway.ensureChatSessionModelDefaults = vi.fn((_sessionId: string, nextPrefs: ChatSessionPrefsRecord) => nextPrefs);
  gateway.normalizeWorkspaceId = vi.fn((workspaceId?: string) => workspaceId ?? "default");
  gateway.taskLifecycleService = {
    createTask: vi.fn(() => ({ taskId: "task-1" })),
    appendTaskActivity: vi.fn(),
    appendTaskDeliverable: vi.fn(),
    updateTask: vi.fn(),
    updateTaskAgenticContext: vi.fn(),
    registerTaskSubagent: vi.fn(),
    updateTaskSubagent: vi.fn(),
  };
  gateway.extractAndPersistLearnedMemory = vi.fn();
  gateway.scheduleChatMemoryContextPrewarm = vi.fn();
  gateway.createChatSession = vi.fn((input: { title: string }) => {
    childSessionCounter += 1;
    const sessionId = `delegate-session-${childSessionCounter}`;
    const role = input.title
      .replace(/^Delegate · /, "")
      .trim()
      .toLowerCase();
    sessionRoles.set(sessionId, role);
    return { sessionId };
  });
  gateway.inheritDelegatedSessionToolGrants = vi.fn();
  gateway.updateChatSessionPrefs = vi.fn();
  gateway.agentSendChatMessage = vi.fn(async (childSessionId: string): Promise<ChatSendMessageResponse> => {
    const role = sessionRoles.get(childSessionId) ?? "delegate";
    return buildResponse(role, childSessionId);
  });
  gateway.storage = {
    chatSessionPrefs: {
      ensure: vi.fn(() => prefs),
    },
    chatSessionMeta: {
      ensure: vi.fn(() => ({ workspaceId: "default" })),
    },
    chatSessionProjects: {
      get: vi.fn(() => ({ projectId: "proj-1" })),
    },
    chatDelegationRuns: {
      create: vi.fn(),
      patch: vi.fn(),
    },
    chatDelegationSteps: {
      create: vi.fn(
        (input: {
          stepId: string;
          runId: string;
          role: string;
          index: number;
          status: ChatDelegationStepRecord["status"];
          startedAt: string;
          finishedAt?: string;
          durationMs?: number;
          error?: string;
          failureGuidance?: string;
        }) => {
          const record = createStepRecord(input);
          steps.set(record.stepId, record);
          return record;
        },
      ),
      patch: vi.fn((stepId: string, patch: Partial<ChatDelegationStepRecord>) => {
        const current = steps.get(stepId)!;
        const next = {
          ...current,
          ...patch,
        };
        steps.set(stepId, next);
        return next;
      }),
      listByRun: vi.fn((runId: string) =>
        [...steps.values()].filter((step) => step.runId === runId).sort((a, b) => a.index - b.index),
      ),
    },
    taskSubagents: {
      findByAgentSessionId: vi.fn(() => undefined),
    },
  };

  const service = new ChatDelegationService(gateway as never);

  return {
    service,
    gateway: gateway as GatewayService & {
      storage: {
        chatSessionPrefs: { ensure: ReturnType<typeof vi.fn> };
        chatSessionMeta: { ensure: ReturnType<typeof vi.fn> };
        chatSessionProjects: { get: ReturnType<typeof vi.fn> };
        chatDelegationRuns: { create: ReturnType<typeof vi.fn>; patch: ReturnType<typeof vi.fn> };
        chatDelegationSteps: {
          create: ReturnType<typeof vi.fn>;
          patch: ReturnType<typeof vi.fn>;
          listByRun: ReturnType<typeof vi.fn>;
        };
      };
      createChatSession: ReturnType<typeof vi.fn>;
      inheritDelegatedSessionToolGrants: ReturnType<typeof vi.fn>;
      updateChatSessionPrefs: ReturnType<typeof vi.fn>;
      agentSendChatMessage: ReturnType<typeof vi.fn>;
      taskLifecycleService: {
        appendTaskActivity: ReturnType<typeof vi.fn>;
        appendTaskDeliverable: ReturnType<typeof vi.fn>;
        createTask: ReturnType<typeof vi.fn>;
        registerTaskSubagent: ReturnType<typeof vi.fn>;
        updateTask: ReturnType<typeof vi.fn>;
        updateTaskAgenticContext: ReturnType<typeof vi.fn>;
        updateTaskSubagent: ReturnType<typeof vi.fn>;
      };
    },
    steps,
    sessionRoles,
    buildResponse,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error("condition not met");
}

describe("GatewayService.runChatDelegation", () => {
  it("uses a real child session runtime and persists truthful lineage for sequential delegation", async () => {
    const { gateway, service } = createDelegationHarness();

    const result = (await service.runChatDelegation("sess-1", {
      objective: "Design the change",
      roles: ["architect"],
      mode: "sequential",
    })) as ChatDelegateResponse;

    expect(gateway.createChatSession).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "default",
        projectId: "proj-1",
        mode: "cowork",
      }),
    );
    expect(gateway.taskLifecycleService.registerTaskSubagent).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        agentSessionId: "delegate-session-1",
        agentName: "architect",
        metadata: expect.objectContaining({
          parentRunId: result.runId,
          profileId: "architect",
          contextMode: "isolated",
        }),
      }),
    );
    expect(gateway.inheritDelegatedSessionToolGrants).toHaveBeenCalledWith("sess-1", "delegate-session-1");
    expect(gateway.agentSendChatMessage).toHaveBeenCalledWith(
      "delegate-session-1",
      expect.objectContaining({
        mode: "cowork",
        providerId: "openai",
        model: "gpt-5.4",
      }),
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
    );
    expect(result.steps[0]).toEqual(
      expect.objectContaining({
        status: "completed",
        childSessionId: "delegate-session-1",
        childTurnId: "child-turn-architect",
        durableRunId: "durable-architect",
      }),
    );
  });

  it("runs parallel delegation with a worker cap of four and starts dependency-gated steps only after prerequisites settle", async () => {
    const { gateway, service, sessionRoles, buildResponse } = createDelegationHarness();
    const starts: string[] = [];
    let active = 0;
    let maxActive = 0;
    let synthStartedAfterDependencies = false;
    const pending = new Map<string, () => void>();
    const completed = new Set<string>();

    gateway.agentSendChatMessage.mockImplementation((childSessionId: string) => {
      const role = sessionRoles.get(childSessionId) ?? "delegate";
      starts.push(role);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (role === "synth") {
        synthStartedAfterDependencies = ["architect", "researcher", "qa", "ops", "coder", "writer"].every((item) =>
          completed.has(item),
        );
      }
      return new Promise<ChatSendMessageResponse>((resolve) => {
        pending.set(role, () => {
          active -= 1;
          completed.add(role);
          resolve(buildResponse(role, childSessionId));
        });
      });
    });

    const runPromise = service.runChatDelegation("sess-1", {
      objective: "Ship the plan",
      roles: ["architect", "researcher", "qa", "ops", "coder", "writer", "synth"],
      mode: "parallel",
      steps: [
        { stepId: "architect-step", index: 0, role: "architect", parallelizable: true },
        { stepId: "researcher-step", index: 1, role: "researcher", parallelizable: true },
        { stepId: "qa-step", index: 2, role: "qa", parallelizable: true },
        { stepId: "ops-step", index: 3, role: "ops", parallelizable: true },
        { stepId: "coder-step", index: 4, role: "coder", parallelizable: true },
        { stepId: "writer-step", index: 5, role: "writer", parallelizable: true },
        {
          stepId: "synth-step",
          index: 6,
          role: "synth",
          parallelizable: false,
          dependsOnStepIds: ["architect-step", "researcher-step", "qa-step", "ops-step", "coder-step", "writer-step"],
        },
      ],
    }) as Promise<ChatDelegateResponse>;

    await waitFor(() => starts.length === 4);
    expect(maxActive).toBe(4);
    expect(starts).not.toContain("synth");

    for (const role of ["architect", "researcher", "qa", "ops"]) {
      pending.get(role)?.();
    }
    await waitFor(() => starts.length >= 6);

    pending.get("coder")?.();
    pending.get("writer")?.();
    await waitFor(() => starts.includes("synth"));
    expect(synthStartedAfterDependencies).toBe(true);

    pending.get("synth")?.();
    const result = await runPromise;

    expect(maxActive).toBe(4);
    expect(result.steps.map((step) => step.role)).toEqual([
      "architect",
      "researcher",
      "qa",
      "ops",
      "coder",
      "writer",
      "synth",
    ]);
    expect(result.stitchedOutput).toContain("### Architect");
    expect(result.stitchedOutput).toContain("### Synth");
    expect(gateway.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("marks downstream dependents as skipped and the run as partial when a prerequisite fails", async () => {
    const { gateway, service, sessionRoles, buildResponse } = createDelegationHarness();

    gateway.agentSendChatMessage.mockImplementation(async (childSessionId: string) => {
      const role = sessionRoles.get(childSessionId) ?? "delegate";
      return buildResponse(role, childSessionId, role === "architect");
    });

    const result = (await service.runChatDelegation("sess-1", {
      objective: "Run the split",
      roles: ["architect", "qa", "synth"],
      mode: "parallel",
      steps: [
        { stepId: "architect-step", index: 0, role: "architect", parallelizable: true },
        { stepId: "qa-step", index: 1, role: "qa", parallelizable: true },
        { stepId: "synth-step", index: 2, role: "synth", parallelizable: false, dependsOnStepIds: ["architect-step"] },
      ],
    })) as ChatDelegateResponse;

    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "architect", status: "failed" }),
        expect.objectContaining({ role: "qa", status: "completed" }),
        expect.objectContaining({ role: "synth", status: "skipped" }),
      ]),
    );
    expect(gateway.storage.chatDelegationRuns.patch).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.objectContaining({ status: "partial" }),
    );
    expect(gateway.taskLifecycleService.updateTask).toHaveBeenCalledWith("task-1", { status: "blocked" });
    expect(gateway.taskLifecycleService.updateTaskAgenticContext).toHaveBeenCalledWith(
      "task-1",
      expect.objectContaining({
        status: "failed",
        failureClass: "missing_handoff",
      }),
    );
  });
});
