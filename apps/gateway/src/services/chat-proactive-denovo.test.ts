import { describe, expect, it, vi } from "vitest";

vi.mock("@goatcitadel/storage", () => ({
  DEFAULT_SESSION_AUTONOMY_PREFS: {
    proactiveMode: "auto_full",
    maxActionsPerHour: 10,
    maxActionsPerTurn: 5,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    heartbeatEnabled: true,
    heartbeatIntervalSeconds: 3600,
    activeHours: { start: 0, end: 24 },
  },
}));

import type {
  AgentCommitmentRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  SessionMeta,
  TaskRecord,
} from "@goatcitadel/contracts";
import {
  DE_NOVO_CONFIDENCE_THRESHOLD,
  hasDeNovoContext,
  planDeNovoActions,
  type DeNovoPlanContext,
} from "./chat-proactive-denovo-planner.js";
import {
  ChatProactiveService,
  type ChatProactiveServiceCallbacks,
  type ChatProactiveServiceContext,
} from "./chat-proactive-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";

// ── pure planner module ──────────────────────────────────────────────

function completionWith(content: string): ChatCompletionResponse {
  return { choices: [{ message: { role: "assistant", content } }] } as unknown as ChatCompletionResponse;
}

function plannerDeps(content: string) {
  const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) => completionWith(content));
  return {
    createChatCompletion,
    resolveModelDefaults: () => ({ providerId: "test", model: "cheap" }),
    resolveApiStyle: () => "anthropic-messages" as const,
  };
}

function commitment(overrides: Partial<AgentCommitmentRecord> = {}): AgentCommitmentRecord {
  return {
    commitmentId: "c1",
    sessionId: "s1",
    workspaceId: "default",
    kind: "follow_up",
    dueAt: "2026-06-22T10:00:00.000Z",
    confidence: 0.9,
    dedupeKey: "interview-acme",
    suggestedText: "How did the Acme interview go?",
    status: "pending",
    createdBy: "classifier",
    createdAt: "2026-06-21T10:00:00.000Z",
    ...overrides,
  };
}

function context(overrides: Partial<DeNovoPlanContext> = {}): DeNovoPlanContext {
  return {
    commitments: [commitment()],
    openTask: undefined,
    recentAssistantText: ["Earlier I helped you prep for the Acme interview."],
    nowIso: "2026-06-22T09:00:00.000Z",
    ...overrides,
  };
}

describe("planDeNovoActions (pure planner)", () => {
  it("returns no actions when there is no context (no commitments, no task)", async () => {
    const deps = plannerDeps("{}");
    const result = await planDeNovoActions(context({ commitments: [], openTask: undefined }), deps);
    expect(result.actions).toEqual([]);
    // Must not even call the model when there is nothing to originate from.
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
  });

  it("produces tool actions from a commitment when confidence clears the conservative floor", async () => {
    const deps = plannerDeps(
      JSON.stringify({
        confidence: 0.9,
        reasoning: "The interview was earlier; gather fresh info before the check-in.",
        actions: [{ kind: "tool", toolName: "browser.search", args: { query: "Acme news" } }],
      }),
    );
    const result = await planDeNovoActions(context(), deps);
    expect(deps.createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.confidence).toBe(0.9);
    expect(result.actions).toEqual([{ kind: "tool", toolName: "browser.search", args: { query: "Acme news" } }]);
  });

  it("suppresses actions below the conservative confidence floor (stays silent)", async () => {
    expect(DE_NOVO_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.78);
    const deps = plannerDeps(
      JSON.stringify({
        confidence: DE_NOVO_CONFIDENCE_THRESHOLD - 0.05,
        reasoning: "weak hunch",
        actions: [{ kind: "tool", toolName: "browser.search", args: {} }],
      }),
    );
    const result = await planDeNovoActions(context(), deps);
    expect(result.actions).toEqual([]);
  });

  it("never proposes a mutating tool — degrades unknown/mutating tools to a note", async () => {
    const deps = plannerDeps(
      JSON.stringify({
        confidence: 0.95,
        reasoning: "draft a message",
        actions: [
          { kind: "tool", toolName: "telegram.send", args: { text: "hi" } },
          { kind: "tool", toolName: "fs.write", args: {} },
          { kind: "tool", toolName: "time.now", args: {} },
        ],
      }),
    );
    const result = await planDeNovoActions(context(), deps);
    // The two mutating tools are dropped to notes (no note text ⇒ dropped); the
    // read-only time.now survives. Nothing dangerous is ever surfaced as a tool.
    expect(result.actions).toEqual([{ kind: "tool", toolName: "time.now", args: {} }]);
  });

  it("returns no actions on model failure (silent best-effort)", async () => {
    const createChatCompletion = vi.fn(async () => {
      throw new Error("provider down");
    });
    const result = await planDeNovoActions(context(), {
      createChatCompletion,
      resolveModelDefaults: () => ({}),
      resolveApiStyle: () => "anthropic-messages" as const,
    });
    expect(result.actions).toEqual([]);
  });

  it("returns no actions on unparseable output", async () => {
    const result = await planDeNovoActions(context(), plannerDeps("not json at all"));
    expect(result.actions).toEqual([]);
  });

  it("hasDeNovoContext is true with a commitment OR an open task, false otherwise", () => {
    expect(hasDeNovoContext(context())).toBe(true);
    expect(
      hasDeNovoContext(context({ commitments: [], openTask: { taskId: "t1", title: "x", status: "in_progress" } })),
    ).toBe(true);
    expect(hasDeNovoContext(context({ commitments: [], openTask: undefined }))).toBe(false);
  });
});

// ── service-level de-novo wiring ─────────────────────────────────────

type Prefs = {
  sessionId: string;
  proactiveMode: "off" | "suggest" | "auto_safe" | "auto_full";
  maxActionsPerHour: number;
  maxActionsPerTurn: number;
  cooldownSeconds: number;
  retrievalMode: "standard" | "layered";
  reflectionMode: "off" | "on";
  lastProactiveAt?: string;
  lastProactiveRunId?: string;
  heartbeatEnabled: boolean;
  heartbeatIntervalSeconds: number;
  activeHours: { start: number; end: number };
  createdAt: string;
  updatedAt: string;
};

interface HarnessOptions {
  messages?: Array<{ role: string; content: string }>;
  commitments?: AgentCommitmentRecord[];
  tasks?: TaskRecord[];
  prefs?: Partial<Prefs>;
  autonomyDisabled?: boolean;
  durableEnabled?: boolean;
  hasRunningTurn?: boolean;
  eligible?: boolean;
  wirePlanner?: boolean;
  plannerResponse?: string;
  now?: string;
}

function createHarness(options: HarnessOptions = {}) {
  const sessionId = "s1";
  // Activity is far in the past so the session is NOT reactively-eligible unless a
  // test makes it so; de-novo candidacy is then governed purely by its own gates.
  const session: SessionMeta = {
    sessionId,
    sessionKey: "chat:s1",
    kind: "dm",
    channel: "chat",
    account: "local",
    displayName: "S1",
    lastActivityAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
    health: "healthy",
    tokenInput: 0,
    tokenOutput: 0,
    tokenCachedInput: 0,
    tokenTotal: 0,
    costUsdTotal: 0,
    budgetState: "ok",
  };
  const now = options.now ?? "2026-06-22T12:00:00.000Z";
  const prefs: Prefs = {
    sessionId,
    proactiveMode: "auto_full",
    maxActionsPerHour: 10,
    maxActionsPerTurn: 5,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    // After lastActivityAt (⇒ not reactive) and older than the 1h de-novo cadence
    // floor relative to the default `now` (⇒ cadence elapsed). Tests override.
    lastProactiveAt: "2026-06-21T00:00:00.000Z",
    heartbeatEnabled: true,
    heartbeatIntervalSeconds: 3600,
    activeHours: { start: 0, end: 24 },
    createdAt: now,
    updatedAt: now,
    ...options.prefs,
  };
  const commitments = options.commitments ?? [];
  const tasks = new Map((options.tasks ?? []).map((task) => [task.taskId, task]));
  const triggered: Array<{ sessionId: string; source: string }> = [];

  const createChatCompletion = vi.fn(async (_request: ChatCompletionRequest) =>
    completionWith(
      options.plannerResponse ??
        JSON.stringify({
          confidence: 0.9,
          reasoning: "follow up",
          actions: [{ kind: "tool", toolName: "browser.search", args: { query: "x" } }],
        }),
    ),
  );

  const callbacks: ChatProactiveServiceCallbacks = {
    listChatSessions: () => [{ sessionId, lastActivityAt: session.lastActivityAt }],
    getSession: () => session,
    hasRunningTurn: () => options.hasRunningTurn ?? false,
    getSessionIdleSeconds: () => 600,
    listChatMessages: async () => options.messages ?? [],
    invokeTool: vi.fn(),
    resolveToolPolicyContext: vi.fn(),
    detectDelegationRoles: () => [],
    createDurableRun: vi.fn(),
    requestDurableRunProcessing: vi.fn(),
    ...(options.wirePlanner === false
      ? {}
      : {
          createChatCompletion: (request) => createChatCompletion(request),
          resolveModelDefaults: () => ({ providerId: "test", model: "cheap" }),
          resolveApiStyle: () => "anthropic-messages" as const,
        }),
    isProactiveDeNovoEligibleSession: () => options.eligible ?? true,
    backgroundTasks: new Set(),
    closing: false,
  };

  const ctx = {
    storage: {
      agentCommitments: {
        listBySession: (id: string) => commitments.filter((c) => c.sessionId === id),
      },
      sessionAutonomyPrefs: {
        ensure: () => prefs,
        listBySessionIds: () => new Map([[sessionId, prefs]]),
        touch: vi.fn(),
      },
      chatSessionPrefs: { ensure: () => ({ mode: "chat" }) },
      chatSessionMeta: { ensure: () => ({ workspaceId: "default" }) },
      chatMessages: { list: () => options.messages ?? [] },
      tasks: {
        find: (taskId: string) => tasks.get(taskId),
        get: (taskId: string) => tasks.get(taskId),
      },
    },
    gatewaySql: {
      prepare: () => ({
        // listChatSessionProactiveRuns lookup (used by findReusableTask) ⇒ no runs.
        get: () => undefined,
        all: () => [],
        run: () => ({ changes: 0 }),
      }),
    },
    publishRealtime: vi.fn(),
    isFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => {
      if (flag === "autonomyV1Disabled") {
        return options.autonomyDisabled ?? false;
      }
      if (flag === "durableKernelV1Enabled") {
        return options.durableEnabled ?? true;
      }
      return false;
    },
  } as unknown as ChatProactiveServiceContext;

  const service = new ChatProactiveService(ctx, callbacks);
  // Capture which sessions/sources the tick dispatches without exercising the
  // whole durable pipeline.
  (service as unknown as { triggerChatSessionProactive: (id: string, input: { source: string }) => Promise<unknown> })
    .triggerChatSessionProactive = async (id, input) => {
    triggered.push({ sessionId: id, source: input.source });
    return undefined;
  };

  return { service, triggered, createChatCompletion, sessionId };
}

function callPlan(service: ChatProactiveService, sessionId: string, mode: "reactive" | "de_novo") {
  return (
    service as unknown as {
      planProactiveActions: (
        sessionId: string,
        originationMode?: "reactive" | "de_novo",
      ) => Promise<{ confidence: number; reasoningSummary: string; actions: Array<Record<string, unknown>> }>;
    }
  ).planProactiveActions(sessionId, mode);
}

function runTick(service: ChatProactiveService) {
  return (service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();
}

describe("ChatProactiveService de-novo origination (P1-F5)", () => {
  it("de_novo planProactiveActions originates from commitments with NO last-user message", async () => {
    const { service, createChatCompletion } = createHarness({
      messages: [{ role: "assistant", content: "Earlier context." }],
      commitments: [commitment()],
    });
    const result = await callPlan(service, "s1", "de_novo");
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.actions).toEqual([{ kind: "tool", toolName: "browser.search", args: { query: "x" } }]);
  });

  it("reactive mode is unchanged with no last-user message (regression — never calls the model)", async () => {
    const { service, createChatCompletion } = createHarness({
      messages: [{ role: "assistant", content: "Earlier context." }],
      commitments: [commitment()],
    });
    const result = await callPlan(service, "s1", "reactive");
    expect(result).toEqual({ confidence: 0.1, reasoningSummary: "No recent user prompt found.", actions: [] });
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("reactive heuristic path is byte-identical with a user message (regression)", async () => {
    const { service, createChatCompletion } = createHarness({
      messages: [{ role: "user", content: "What is the current time?" }],
    });
    const result = await callPlan(service, "s1", "reactive");
    expect(result).toEqual({
      confidence: 0.78,
      reasoningSummary: "Generated actions from latest user intent and route hints.",
      actions: [{ kind: "tool", toolName: "time.now", args: {} }],
    });
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("de_novo with a user message present still uses the reactive heuristic (no model call)", async () => {
    const { service, createChatCompletion } = createHarness({
      messages: [{ role: "user", content: "What is the current time?" }],
      commitments: [commitment()],
    });
    const result = await callPlan(service, "s1", "de_novo");
    expect(result.actions).toEqual([{ kind: "tool", toolName: "time.now", args: {} }]);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("de_novo yields no actions when there are no open commitments/tasks", async () => {
    const { service, createChatCompletion } = createHarness({ messages: [], commitments: [] });
    const result = await callPlan(service, "s1", "de_novo");
    expect(result.actions).toEqual([]);
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("scheduler fires a de-novo tick for an idle session with open commitments", async () => {
    // Uses the harness default lastProactiveAt (non-reactive + cadence elapsed).
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
    });
    await runTick(service);
    expect(triggered).toEqual([{ sessionId: "s1", source: "de_novo" }]);
  });

  it("scheduler does NOT loop on an idle session within the de-novo cadence floor", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      // Last self-wake 5 minutes ago ⇒ inside the 1h de-novo cadence floor.
      prefs: { lastProactiveAt: "2026-06-22T11:55:00.000Z" },
      now: "2026-06-22T12:00:00.000Z",
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo outside active hours", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      prefs: { activeHours: { start: 8, end: 9 } },
      now: "2026-06-22T12:00:00.000Z", // local hour 12, outside 08–09
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo when the master autonomy switch is off", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      autonomyDisabled: true,
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo for an ineligible (non-human/eval) session", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      eligible: false,
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo when the planner is not wired", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      wirePlanner: false,
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo while a turn is running", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      hasRunningTurn: true,
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo when cooldown is active", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      prefs: { cooldownSeconds: 600, lastProactiveAt: "2026-06-22T11:59:00.000Z" },
      now: "2026-06-22T12:00:00.000Z",
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });

  it("scheduler skips de-novo for a session with proactiveMode off", async () => {
    const { service, triggered } = createHarness({
      messages: [],
      commitments: [commitment()],
      prefs: { proactiveMode: "off" },
    });
    await runTick(service);
    expect(triggered).toEqual([]);
  });
});
