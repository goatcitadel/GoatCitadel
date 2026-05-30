import { describe, expect, it, vi } from "vitest";
import type { ChatMessageRecord, ChatSessionPrefsRecord } from "@goatcitadel/contracts";
import {
  applyApprovedSpecialistsToPlan,
  buildChatOrchestrationSummary,
  generatePreparedExecutionPlanDraft,
  prepareAgentChatTurn,
  resolvePreparedTurnOrchestration,
  type ChatTurnPrepHost,
} from "./chat-turn-prep-service.js";

function createPrefs(
  mode: ChatSessionPrefsRecord["mode"],
  overrides: Partial<ChatSessionPrefsRecord> = {},
): ChatSessionPrefsRecord {
  return {
    sessionId: "session-1",
    mode,
    planningMode: "off",
    providerId: "openai",
    model: "gpt-5.4-mini",
    webMode: "auto",
    memoryMode: "auto",
    thinkingLevel: "standard",
    toolAutonomy: "manual",
    proactiveMode: "off",
    speedMode: "standard",
    subagentPolicy: "ask_when_useful",
    createdAt: "2026-05-04T00:00:00.000Z",
    updatedAt: "2026-05-04T00:00:00.000Z",
    ...overrides,
  } as ChatSessionPrefsRecord;
}

function createHost(mode: ChatSessionPrefsRecord["mode"], prefsOverrides: Partial<ChatSessionPrefsRecord> = {}) {
  let guidanceSystemInstruction = "";
  const prefs = createPrefs(mode, prefsOverrides);
  const host = {
    storage: {
      chatSessionMeta: {
        ensure: vi.fn(() => ({
          sessionId: "session-1",
          workspaceId: "default",
          lifecycleStatus: "active",
        })),
      },
      chatAttachments: {
        listByIds: vi.fn(() => []),
      },
      chatSessionPrefs: {
        patch: vi.fn(() => prefs),
      },
      chatSessionProjects: {
        get: vi.fn(() => undefined),
      },
      chatSideChats: {
        getByChildSession: vi.fn(() => undefined),
      },
      chatSpecialistCandidates: {
        listAutoRoutable: vi.fn(() => []),
      },
    },
    llmService: {
      getRuntimeConfig: vi.fn(() => ({ providers: [] })),
    },
    getSession: vi.fn(() => ({ sessionId: "session-1" })),
    ensureChatSessionRuntimeGrants: vi.fn(),
    maybeAutoTitleChatSession: vi.fn(),
    normalizeWorkspaceId: vi.fn((workspaceId?: string) => workspaceId ?? "default"),
    routeFromSession: vi.fn(() => ({ channel: "chat", account: "operator" })),
    ingestEvent: vi.fn(async () => undefined),
    patchSessionAutonomyPrefs: vi.fn(() => ({
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
    })),
    ensureChatSessionModelDefaults: vi.fn(() => prefs),
    getSessionAutonomyPrefs: vi.fn(() => ({
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
    })),
    buildDefaultChatPersonalityOverlay: vi.fn(() =>
      [
        "Chat personality overlay:",
        "- Personality: Operator",
        "- Instruction: Use crisp language.",
        "- Boundary: This overlay changes voice and framing only.",
      ].join("\n"),
    ),
    resolveRuntimeGuidance: vi.fn(async () => ({ systemInstruction: "Base Chat guidance." })),
    resolveThreadKnowledgeContext: vi.fn(async () => ({ systemInstruction: "Thread knowledge.", citations: [] })),
    loadChatTurnSessionState: vi.fn(async () => ({
      traces: [],
      tracesById: new Map(),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
      turnLineageById: new Map(),
    })),
    buildLlmMessagesFromBranchPath: vi.fn(async (_sessionId, _pathTurnIds, _userMessage, options) => {
      guidanceSystemInstruction = options?.guidanceSystemInstruction ?? "";
      return [];
    }),
    createChatCompletion: vi.fn(async () => ({ id: "completion-1", message: { role: "assistant", content: "" } })),
  } as unknown as ChatTurnPrepHost;
  return {
    host,
    readGuidance: () => guidanceSystemInstruction,
  };
}

describe("prepareAgentChatTurn personality overlay", () => {
  it("adds the global personality overlay only for Chat mode", async () => {
    const chat = createHost("chat");
    await prepareAgentChatTurn(chat.host, "session-1", { content: "hello" });

    expect(chat.readGuidance()).toContain("Chat personality overlay:");
    expect(chat.readGuidance()).toContain("Use crisp language.");
    expect(chat.host.buildDefaultChatPersonalityOverlay).toHaveBeenCalled();

    const cowork = createHost("cowork");
    await prepareAgentChatTurn(cowork.host, "session-1", { content: "hello" });

    expect(cowork.readGuidance()).not.toContain("Chat personality overlay:");
    expect(cowork.host.buildDefaultChatPersonalityOverlay).not.toHaveBeenCalled();
  });

  it("ingests attachment references, applies autonomy overrides, and keeps unbound Code mode manual", async () => {
    const harness = createHost("code", { mode: "code", toolAutonomy: "safe_auto" });
    vi.mocked(harness.host.storage.chatAttachments.listByIds).mockReturnValue([
      {
        attachmentId: "attachment-1",
        sessionId: "session-1",
        workspaceId: "default",
        fileName: "notes.md",
        mimeType: "text/markdown",
        mediaType: "text",
        sizeBytes: 42,
        sha256: "sha",
        storageRelPath: "chat/default/attachments/notes.md",
        extractStatus: "ready",
        analysisStatus: "ready",
        createdAt: "2026-05-04T00:00:00.000Z",
      },
    ]);

    const prepared = await prepareAgentChatTurn(harness.host, "session-1", {
      content: "Please inspect this repo note.",
      attachments: ["attachment-1"],
      parts: [{ type: "text", text: "Attached note" }],
      prefsOverride: {
        retrievalMode: "layered",
      },
    });

    expect(harness.host.patchSessionAutonomyPrefs).toHaveBeenCalledWith("session-1", {
      retrievalMode: "layered",
    });
    expect(prepared.userMessage.attachments).toEqual([
      {
        attachmentId: "attachment-1",
        fileName: "notes.md",
        mimeType: "text/markdown",
        sizeBytes: 42,
      },
    ]);
    expect(prepared.effectiveToolAutonomy).toBe("manual");
    expect(harness.readGuidance()).toContain("Code mode requires a bound project");
    expect(harness.host.ingestEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        message: expect.objectContaining({
          attachments: [
            {
              attachmentId: "attachment-1",
              fileName: "notes.md",
              mimeType: "text/markdown",
              sizeBytes: 42,
            },
          ],
        }),
      }),
    );
  });

  it("reuses existing retry user messages without ingesting or retitling", async () => {
    const harness = createHost("chat");
    const existingUserMessage = {
      messageId: "user-existing",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Retry the previous answer.",
      timestamp: "2026-05-04T00:00:00.000Z",
    } as ChatMessageRecord;

    const prepared = await prepareAgentChatTurn(
      harness.host,
      "session-1",
      { content: "ignored when existing message is supplied" },
      {
        branchKind: "retry",
        existingUserMessage,
        ingestUserMessage: false,
        turnId: "turn-fixed",
        assistantMessageId: "assistant-fixed",
      },
    );

    expect(prepared.userEventId).toBe("user-existing");
    expect(prepared.userMessage).toBe(existingUserMessage);
    expect(prepared.branchKind).toBe("retry");
    expect(prepared.turnId).toBe("turn-fixed");
    expect(prepared.assistantMessageId).toBe("assistant-fixed");
    expect(harness.host.ingestEvent).not.toHaveBeenCalled();
    expect(harness.host.maybeAutoTitleChatSession).not.toHaveBeenCalled();
  });

  it("builds conversation context from the active branch and rejects empty content", async () => {
    const harness = createHost("chat");
    const priorUser = {
      messageId: "user-prior",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Earlier question",
      timestamp: "2026-05-04T00:00:00.000Z",
    } as ChatMessageRecord;
    const priorAssistant = {
      messageId: "assistant-prior",
      sessionId: "session-1",
      role: "assistant",
      actorType: "agent",
      actorId: "assistant",
      content: "Earlier answer",
      timestamp: "2026-05-04T00:00:01.000Z",
    } as ChatMessageRecord;
    vi.mocked(harness.host.loadChatTurnSessionState).mockResolvedValue({
      activeLeafTurnId: "turn-prior",
      traces: [],
      tracesById: new Map([
        [
          "turn-prior",
          {
            turnId: "turn-prior",
            sessionId: "session-1",
            userMessageId: "user-prior",
            assistantMessageId: "assistant-prior",
          },
        ],
      ]),
      messages: [],
      messagesById: new Map([
        ["user-prior", priorUser],
        ["assistant-prior", priorAssistant],
      ]),
      childrenByTurnId: new Map(),
      turnLineageById: new Map([["turn-prior", { turnId: "turn-prior" }]]),
    } as never);

    const prepared = await prepareAgentChatTurn(harness.host, "session-1", { content: "Continue" });

    expect(prepared.parentTurnId).toBe("turn-prior");
    expect(prepared.conversationMessages.map((message) => message.messageId)).toEqual([
      "user-prior",
      "assistant-prior",
      prepared.userMessage.messageId,
    ]);
    await expect(prepareAgentChatTurn(harness.host, "session-1", { content: "   " })).rejects.toThrow(
      /content is required/i,
    );
  });

  it("honors an explicit undefined parent when durable execution re-prepares a root turn", async () => {
    const harness = createHost("chat");
    const existingUserMessage = {
      messageId: "user-root",
      sessionId: "session-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "Root prompt",
      timestamp: "2026-05-04T00:00:00.000Z",
    } as ChatMessageRecord;
    vi.mocked(harness.host.loadChatTurnSessionState).mockResolvedValue({
      activeLeafTurnId: "turn-root",
      traces: [],
      tracesById: new Map([
        [
          "turn-root",
          {
            turnId: "turn-root",
            sessionId: "session-1",
            userMessageId: "user-root",
          },
        ],
      ]),
      messages: [],
      messagesById: new Map([["user-root", existingUserMessage]]),
      childrenByTurnId: new Map(),
      turnLineageById: new Map([["turn-root", { turnId: "turn-root" }]]),
    } as never);

    const prepared = await prepareAgentChatTurn(
      harness.host,
      "session-1",
      { content: "Root prompt" },
      {
        branchKind: "append",
        parentTurnId: undefined,
        existingUserMessage,
        ingestUserMessage: false,
        turnId: "turn-root",
        assistantMessageId: "assistant-root",
      },
    );

    expect(prepared.parentTurnId).toBeUndefined();
    expect(prepared.conversationMessages).toEqual([existingUserMessage]);
    expect(harness.host.buildLlmMessagesFromBranchPath).toHaveBeenCalledWith(
      "session-1",
      [],
      existingUserMessage,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("skips missing branch traces while preparing retry context", async () => {
    const harness = createHost("chat");
    vi.mocked(harness.host.loadChatTurnSessionState).mockResolvedValue({
      activeLeafTurnId: "turn-missing",
      traces: [],
      tracesById: new Map(),
      messages: [],
      messagesById: new Map(),
      childrenByTurnId: new Map(),
      turnLineageById: new Map([["turn-missing", { turnId: "turn-missing" }]]),
    } as never);

    const prepared = await prepareAgentChatTurn(harness.host, "session-1", { content: "Continue anyway" });

    expect(prepared.parentTurnId).toBe("turn-missing");
    expect(prepared.conversationMessages).toEqual([prepared.userMessage]);
  });

  it("leaves dynamic Cowork plans unchanged when no fresh specialist matches", () => {
    const harness = createHost("cowork");
    const plan = createPlan({
      steps: [createStep({ stepId: "research", role: "researcher", objective: "Research release evidence" })],
    });
    const prepared = {
      session: { sessionId: "session-1" },
      workspaceId: "default",
      content: "Research release evidence",
      normalized: { mode: "cowork" },
      prefs: createPrefs("cowork"),
    };

    expect(applyApprovedSpecialistsToPlan(harness.host, prepared as never, plan as never)).toBe(plan);

    vi.mocked(harness.host.storage.chatSpecialistCandidates.listAutoRoutable).mockReturnValue([
      {
        candidateId: "candidate-wrong-role",
        sessionId: "session-1",
        workspaceId: "default",
        title: "Ops helper",
        role: "ops",
        summary: "Deploy releases.",
        reason: "ops gap",
        source: "runtime_gap",
        status: "approved",
        routingMode: "strong_match_only",
        confidence: 0.99,
        requiresApproval: false,
        routingHints: { objectiveKeywords: ["release"] },
        evidence: [],
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
    ]);

    expect(applyApprovedSpecialistsToPlan(harness.host, prepared as never, plan as never)).toBe(plan);
  });

  it("injects approved fresh specialists into matching dynamic Cowork steps", () => {
    vi.setSystemTime(new Date("2026-05-04T00:00:00.000Z"));
    const harness = createHost("cowork");
    vi.mocked(harness.host.storage.chatSpecialistCandidates.listAutoRoutable).mockReturnValue([
      {
        candidateId: "candidate-research",
        sessionId: "session-1",
        workspaceId: "default",
        title: "Research release analyst",
        role: "research analyst",
        summary: "Find release notes and source evidence.",
        reason: "release research gap",
        source: "runtime_gap",
        status: "approved",
        routingMode: "strong_match_only",
        confidence: 0.95,
        requiresApproval: false,
        routingHints: { objectiveKeywords: ["release", "research"] },
        evidence: [],
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
      {
        candidateId: "candidate-stale",
        sessionId: "session-1",
        workspaceId: "default",
        title: "QA helper",
        role: "qa",
        summary: "Validate old things.",
        reason: "stale",
        source: "runtime_gap",
        status: "approved",
        routingMode: "strong_match_only",
        confidence: 1,
        requiresApproval: false,
        routingHints: { objectiveKeywords: ["release"] },
        evidence: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "not-a-date",
      },
      {
        candidateId: "candidate-qa",
        sessionId: "session-1",
        workspaceId: "default",
        title: "Release QA validator",
        role: "qa",
        summary: "Validate release evidence.",
        reason: "release QA gap",
        source: "runtime_gap",
        status: "approved",
        routingMode: "strong_match_only",
        confidence: 0.95,
        requiresApproval: false,
        routingHints: { objectiveKeywords: ["release"] },
        evidence: [],
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
      {
        candidateId: "candidate-extra-review",
        sessionId: "session-1",
        workspaceId: "default",
        title: "Release review critic",
        role: "reviewer",
        summary: "Review release evidence.",
        reason: "release review gap",
        source: "runtime_gap",
        status: "approved",
        routingMode: "strong_match_only",
        confidence: 0.95,
        requiresApproval: false,
        routingHints: { objectiveKeywords: ["release"] },
        evidence: [],
        createdAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-03T00:00:00.000Z",
      },
    ]);

    const plan = createPlan({
      steps: [
        createStep({ stepId: "research", role: "researcher", objective: "Research release evidence" }),
        createStep({ stepId: "qa", role: "qa-validator", objective: "Validate release evidence" }),
        createStep({ stepId: "review", role: "reviewer", objective: "Review release evidence" }),
      ],
    });
    const prepared = {
      session: { sessionId: "session-1" },
      workspaceId: "default",
      content: "Research release evidence",
      normalized: { mode: "cowork" },
      prefs: createPrefs("cowork"),
    };

    const updated = applyApprovedSpecialistsToPlan(harness.host, prepared as never, plan as never);

    expect(updated.routeDecision.specialistCandidates).toEqual([
      expect.objectContaining({
        candidateId: "candidate-research",
        baseRole: "researcher",
        routingMode: "strong_match_only",
      }),
      expect.objectContaining({
        candidateId: "candidate-qa",
        baseRole: "qa-validator",
        routingMode: "strong_match_only",
      }),
    ]);
    expect(updated.steps[0]?.specialistCandidate).toEqual(
      expect.objectContaining({ candidateId: "candidate-research" }),
    );
    expect(updated.steps[1]?.specialistCandidate).toEqual(expect.objectContaining({ candidateId: "candidate-qa" }));
    expect(updated.steps[2]?.specialistCandidate).toBeUndefined();
    vi.useRealTimers();
  });

  it("falls back to the template execution draft when planner completion fails", async () => {
    const harness = createHost("cowork");
    vi.mocked(harness.host.createChatCompletion).mockRejectedValue(new Error("planner unavailable"));
    const templatePlan = createPlan({
      steps: [createStep({ stepId: "research", role: "researcher", objective: "Research release notes" })],
    });
    const prepared = {
      content: "Research release notes",
      prefs: createPrefs("cowork"),
    };
    const routerInput = {
      task: {
        mode: "cowork",
      },
    };

    const draft = await generatePreparedExecutionPlanDraft(
      harness.host,
      prepared as never,
      routerInput as never,
      templatePlan as never,
      false,
    );

    expect(harness.host.createChatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "openai",
        model: "gpt-5.4-mini",
        stream: false,
        memory: { enabled: false, mode: "off" },
        response_format: { type: "json_object" },
      }),
    );
    expect(draft.steps[0]).toEqual(expect.objectContaining({ stepId: "research", delegatedRole: "researcher" }));
  });

  it("uses a valid planner completion draft before falling back to template defaults", async () => {
    const harness = createHost("cowork");
    vi.mocked(harness.host.createChatCompletion).mockResolvedValue({
      model: "gpt-5.4-mini",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              summary: "Planner refined the concrete release workflow.",
              steps: [
                {
                  objective: "Find the release notes and changelog deltas.",
                  successCriteria: "Return source-linked release evidence.",
                  suggestedTools: ["browser.search", "http.get", "browser.search"],
                  expectedOutput: "Release evidence handoff",
                  parallelizable: true,
                  dependsOnStepIds: [],
                },
              ],
            }),
          },
          finish_reason: "stop",
        },
      ],
    } as never);
    const templatePlan = createPlan({
      steps: [createStep({ stepId: "research", role: "researcher", objective: "Research release notes" })],
    });
    const prepared = {
      content: "Research release notes",
      prefs: createPrefs("cowork"),
    };

    const draft = await generatePreparedExecutionPlanDraft(
      harness.host,
      prepared as never,
      { task: { mode: "cowork" } } as never,
      templatePlan as never,
      false,
    );

    expect(draft).toEqual(
      expect.objectContaining({
        source: "planner",
        summary: "Planner refined the concrete release workflow.",
        steps: [
          expect.objectContaining({
            stepId: "research",
            objective: "Find the release notes and changelog deltas.",
            suggestedTools: ["browser.search", "http.get"],
            expectedOutput: "Release evidence handoff",
            parallelizable: true,
            delegatedRole: "researcher",
          }),
        ],
      }),
    );
  });

  it("skips orchestration for normal Chat turns and resolves advisory planning turns", async () => {
    const harness = createHost("chat");
    const normalPrepared = createPreparedTurnForOrchestration({ planningMode: "off" });
    const advisoryPrepared = createPreparedTurnForOrchestration({ planningMode: "advisory" });

    await expect(resolvePreparedTurnOrchestration(harness.host, normalPrepared as never)).resolves.toBeUndefined();
    const advisory = await resolvePreparedTurnOrchestration(harness.host, advisoryPrepared as never);

    expect(advisory).toEqual(
      expect.objectContaining({
        routerInput: expect.objectContaining({
          task: expect.objectContaining({
            mode: "chat",
            objective: "Draft a launch note",
          }),
        }),
        orchestrationPlan: expect.objectContaining({
          routeDecision: expect.objectContaining({
            modePolicy: "chat",
          }),
        }),
      }),
    );
  });

  it("maps orchestration summary status and step evidence for running, failed, partial, and advisory outcomes", () => {
    const routeDecision = createPlan({ steps: [] }).routeDecision;
    expect(
      buildChatOrchestrationSummary({
        runId: "run-running",
        objective: "Do work",
        modePolicy: "cowork",
        routeDecision,
        stepResults: [],
      }).status,
    ).toBe("running");
    expect(
      buildChatOrchestrationSummary({
        runId: "run-advisory",
        objective: "Plan work",
        modePolicy: "cowork",
        routeDecision,
        stepResults: [],
        finalized: true,
        advisoryOnly: true,
      }).status,
    ).toBe("completed");
    expect(
      buildChatOrchestrationSummary({
        runId: "run-failed",
        objective: "Do work",
        modePolicy: "cowork",
        routeDecision,
        stepResults: [createStepResult({ stepId: "failed", status: "failed", error: "no provider" })],
        finalized: true,
      }).status,
    ).toBe("failed");
    expect(
      buildChatOrchestrationSummary({
        runId: "run-partial-child",
        objective: "Do work",
        modePolicy: "cowork",
        routeDecision,
        stepResults: [
          createStepResult({
            stepId: "failed-with-output",
            status: "failed",
            error: "Tool run budget exceeded.",
            output: "Strong leads gathered.",
          }),
        ],
        finalized: true,
      }).status,
    ).toBe("partial");
    expect(
      buildChatOrchestrationSummary({
        runId: "run-completed",
        objective: "Do work",
        modePolicy: "cowork",
        routeDecision,
        stepResults: [createStepResult({ stepId: "completed", status: "completed", summary: "done" })],
        finalized: true,
      }).status,
    ).toBe("completed");
    expect(
      buildChatOrchestrationSummary({
        runId: "run-incomplete-completed-children",
        objective: "Find local stores.",
        modePolicy: "cowork",
        routeDecision,
        stepResults: [
          createStepResult({ stepId: "planner", role: "planner", status: "completed" }),
          createStepResult({ stepId: "worker", role: "worker", status: "completed" }),
          createStepResult({ stepId: "reviewer", role: "reviewer", status: "completed" }),
          createStepResult({ stepId: "synth", role: "synthesizer", status: "completed" }),
        ],
        finalSummary: "## Synthesis Incomplete The required fields need continuation.",
        integritySignals: ["orchestration_partial_needs_continuation"],
        finalized: true,
      }).status,
    ).toBe("partial");
    const partial = buildChatOrchestrationSummary({
      runId: "run-partial",
      objective: "Do work",
      modePolicy: "cowork",
      routeDecision,
      stepResults: [
        createStepResult({ stepId: "completed", status: "completed", summary: "done" }),
        createStepResult({ stepId: "failed", status: "failed", error: "timeout" }),
      ],
      finalSummary: "partial result",
      integritySignals: ["Synthesis Incomplete"],
      finalized: true,
    });

    expect(partial).toEqual(
      expect.objectContaining({
        status: "partial",
        finalSummary: "partial result",
        integritySignals: ["Synthesis Incomplete"],
      }),
    );
    expect(partial.steps).toEqual([
      expect.objectContaining({ stepId: "completed", status: "completed", summary: "done" }),
      expect.objectContaining({ stepId: "failed", status: "failed", error: "timeout" }),
    ]);
  });

  it("injects eligible parent-thread context for side chats without writing to the parent transcript", async () => {
    const harness = createHost("chat");
    const parentUser = {
      messageId: "parent-user-1",
      sessionId: "parent-1",
      role: "user",
      actorType: "user",
      actorId: "operator",
      content: "The parent thread says .env.local may not exist.",
      timestamp: "2026-05-04T00:00:00.000Z",
    } as ChatMessageRecord;
    const parentAssistant = {
      messageId: "parent-assistant-1",
      sessionId: "parent-1",
      role: "assistant",
      actorType: "assistant",
      actorId: "assistant",
      content: "I will check the repo root and avoid mutating the parent transcript.",
      timestamp: "2026-05-04T00:00:01.000Z",
    } as ChatMessageRecord;
    vi.mocked(harness.host.storage.chatSideChats.getByChildSession).mockReturnValue({
      sideChatId: "btw-1",
      parentSessionId: "parent-1",
      childSessionId: "side-1",
      workspaceId: "default",
      createdFromSurface: "code",
      createdAt: "2026-05-04T00:00:00.000Z",
      updatedAt: "2026-05-04T00:00:00.000Z",
    });
    vi.mocked(harness.host.loadChatTurnSessionState).mockImplementation(async (sessionId) => {
      if (sessionId !== "parent-1") {
        return {
          traces: [],
          tracesById: new Map(),
          messages: [],
          messagesById: new Map(),
          childrenByTurnId: new Map(),
          turnLineageById: new Map(),
        };
      }
      return {
        traces: [
          {
            turnId: "parent-turn-1",
            userMessageId: parentUser.messageId,
            assistantMessageId: parentAssistant.messageId,
          } as never,
        ],
        tracesById: new Map([
          [
            "parent-turn-1",
            {
              turnId: "parent-turn-1",
              userMessageId: parentUser.messageId,
              assistantMessageId: parentAssistant.messageId,
            } as never,
          ],
        ]),
        messages: [parentUser, parentAssistant],
        messagesById: new Map([
          [parentUser.messageId, parentUser],
          [parentAssistant.messageId, parentAssistant],
        ]),
        childrenByTurnId: new Map(),
        turnLineageById: new Map([["parent-turn-1", { turnId: "parent-turn-1" }]]),
        activeLeafTurnId: "parent-turn-1",
      };
    });

    await prepareAgentChatTurn(harness.host, "side-1", {
      content: "aside question",
      sideChatContext: {
        parentSessionId: "parent-1",
        originSurface: "code",
        selectedTurnId: "parent-turn-1",
      },
    });

    expect(harness.readGuidance()).toContain("GoatCitadel /btw side chat");
    expect(harness.readGuidance()).toContain("Parent session: parent-1");
    expect(harness.readGuidance()).toContain("The parent thread says .env.local may not exist.");
    expect(harness.host.ingestEvent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(harness.host.ingestEvent).mock.calls[0]?.[1])).not.toContain("parent-1");
  });
});

function createPreparedTurnForOrchestration(overrides: { planningMode: ChatSessionPrefsRecord["planningMode"] }) {
  return {
    session: { sessionId: "session-1" },
    workspaceId: "default",
    content: "Draft a launch note",
    conversationMessages: [],
    history: [],
    normalized: { mode: "chat" },
    prefs: createPrefs("chat", { planningMode: overrides.planningMode }),
  };
}

function createPlan(overrides: { steps: ReturnType<typeof createStep>[] }) {
  return {
    workflowTemplate: "cowork.plan.work.synthesize",
    summary: "Plan summary",
    routeDecision: {
      modePolicy: "cowork",
      workflowTemplate: "cowork.plan.work.synthesize",
      hidden: false,
      visibility: "explicit",
      intensity: "balanced",
      providerPreference: "balanced",
      reviewDepth: "standard",
      parallelism: "sequential",
      selectedRoles: ["Researcher"],
      selectedProviders: [],
      triggerReason: "test",
    },
    steps: overrides.steps,
  };
}

function createStep(overrides: { stepId: string; role: string; objective: string }) {
  return {
    stepId: overrides.stepId,
    index: 0,
    role: overrides.role,
    label: overrides.role,
    stage: 1,
    objective: overrides.objective,
    successCriteria: "Return a useful handoff.",
    suggestedTools: ["browser.search"],
    expectedOutput: "handoff",
    parallelizable: false,
    dependsOnStepIds: [],
    delegatedRole: overrides.role,
  };
}

function createStepResult(overrides: {
  stepId: string;
  status: "completed" | "failed";
  summary?: string;
  output?: string;
  error?: string;
}) {
  return {
    stepId: overrides.stepId,
    role: "researcher",
    label: "Researcher",
    index: 0,
    status: overrides.status,
    providerId: "openai",
    model: "gpt-5.4-mini",
    startedAt: "2026-05-04T00:00:00.000Z",
    finishedAt: "2026-05-04T00:00:01.000Z",
    durationMs: 1000,
    summary: overrides.summary,
    output: overrides.output,
    error: overrides.error,
  };
}
