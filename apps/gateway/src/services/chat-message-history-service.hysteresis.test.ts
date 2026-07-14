import { describe, expect, it, vi } from "vitest";
import type {
  ChatCompactionStateRecord,
  ChatConversationSummaryRecord,
  ChatMessageRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import {
  buildLlmMessagesFromBranchPath,
  type ChatCompactionDimension,
  type ChatMessageHistoryDependencies,
} from "./chat-message-history-service.js";

const DIMENSION_A: ChatCompactionDimension = {
  dimensionHash: "dimension-a",
  providerId: "openai",
  model: "gpt-4.1",
  profileFingerprint: "profile-a",
  persistState: true,
};

describe("chat branch compaction hysteresis", () => {
  it("defers initial compaction when matching first-request usage is below the trigger", async () => {
    const repo = createInMemorySummaryRepo();
    const belowTrigger = createBranchState(14, {
      usageByTurn: new Map([["turn-14", 1200]]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });

    const unchanged = await build(repo, belowTrigger, pathIds(14), DIMENSION_A);

    expect(unchanged).toHaveLength(28);
    expect(repo.summaries).toHaveLength(0);
    expect(repo.states).toHaveLength(0);

    const atTrigger = createBranchState(14, {
      usageByTurn: new Map([["turn-14", 2200]]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });
    const compacted = await build(repo, atTrigger, pathIds(14), DIMENSION_A);

    expect(compacted[0]).toMatchObject({ role: "system", content: expect.stringContaining("Compacted") });
    expect(repo.states[0]).toMatchObject({ baselineInputTokens: 2200, armed: false });
  });

  it("uses local sizing only for initial eligibility when exact provider usage is unavailable", async () => {
    for (const unavailableReason of ["provider_usage_missing", "request_failed_before_usage"] as const) {
      const repo = createInMemorySummaryRepo();
      const state = createBranchState(14, {
        usageByTurn: new Map([["turn-14", 2200]]),
        dimensionHash: DIMENSION_A.dimensionHash,
      });
      const usage = state.tracesById.get("turn-14")?.completion?.firstProviderRequestUsage;
      if (!usage) {
        throw new Error("Expected first-request usage for the unavailable-usage fixture");
      }
      delete usage.reportedInputTokens;
      usage.source = "deterministic_estimate";
      usage.availability = "unavailable";
      usage.unavailableReason = unavailableReason;

      await build(repo, state, pathIds(14), DIMENSION_A);

      expect(repo.states[0]?.baselineInputTokens).toBeGreaterThan(2200);
      expect(repo.states[0]?.armed).toBe(false);
    }
  });

  it("persists an exact 8-turn boundary, survives restart, and waits for low/high growth plus a new window", async () => {
    const repo = createInMemorySummaryRepo();
    const state14 = createBranchState(14);

    const initial = await build(repo, state14, pathIds(14), DIMENSION_A);

    expect(initial[0]).toMatchObject({ role: "system", content: expect.stringContaining("Compacted") });
    expect(repo.summaries).toHaveLength(1);
    expect(repo.states).toHaveLength(1);
    expect(repo.states[0]?.boundaryTurnIds).toEqual(pathIds(8));
    expect(repo.states[0]?.armed).toBe(false);

    // A fresh dependency object over the same durable rows models restart.
    const afterRestart = await build(repo, createBranchState(14), pathIds(14), DIMENSION_A);
    expect(afterRestart).toEqual(initial);
    expect(repo.summaries).toHaveLength(1);
    expect(repo.states).toHaveLength(1);

    const delayedSameCountUsage = createBranchState(14, {
      usageByTurn: new Map([["turn-14", 1200]]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });
    await build(repo, delayedSameCountUsage, pathIds(14), DIMENSION_A);
    expect(repo.states[0]?.armed).toBe(false);
    expect(repo.states[0]?.observedTurnCount).toBe(14);

    const state15 = createBranchState(15, {
      usageByTurn: new Map([["turn-15", 1200]]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });
    await build(repo, state15, pathIds(15), DIMENSION_A);
    expect(repo.states[0]?.armed).toBe(true);
    expect(repo.states[0]?.baselineInputTokens).toBe(1200);
    expect(repo.summaries).toHaveLength(1);

    const state22 = createBranchState(22, {
      usageByTurn: new Map([["turn-22", 2400]]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });
    const extended = await build(repo, state22, pathIds(22), DIMENSION_A);
    expect(repo.summaries).toHaveLength(2);
    expect(repo.states).toHaveLength(2);
    expect(repo.states.find((state) => state.boundaryTurnIds.length === 16)?.armed).toBe(false);
    expect(extended.filter((message) => message.role === "system")).toHaveLength(2);

    await build(repo, state22, pathIds(22), DIMENSION_A);
    expect(repo.summaries).toHaveLength(2);
    expect(repo.states).toHaveLength(2);
  });

  it("keeps provisional capability-selection history read-only before the sealed dimension persists once", async () => {
    const repo = createInMemorySummaryRepo();
    const state = createBranchState(14);

    const provisional = await build(repo, state, pathIds(14), {
      ...DIMENSION_A,
      persistState: false,
    });

    expect(provisional).toHaveLength(28);
    expect(repo.summaries).toHaveLength(0);
    expect(repo.states).toHaveLength(0);
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(repo.upsertCompactionState).not.toHaveBeenCalled();

    const sealed = await build(repo, state, pathIds(14), DIMENSION_A);
    expect(sealed[0]).toMatchObject({ role: "system", content: expect.stringContaining("Compacted") });
    expect(repo.summaries).toHaveLength(1);
    expect(repo.states).toHaveLength(1);
  });

  it("retains an incomplete older window and all recent/current records verbatim without duplicates", async () => {
    const repo = createInMemorySummaryRepo();
    const state18 = createBranchState(18);
    const current = message("current-user", "user", "current question");

    const messages = await build(repo, state18, pathIds(18), DIMENSION_A, current);

    expect(repo.summaries[0]?.turnIds).toEqual(pathIds(8));
    for (let turn = 9; turn <= 18; turn += 1) {
      expect(messages.filter((entry) => String(entry.content).includes(`user ${turn} `))).toHaveLength(1);
      expect(messages.filter((entry) => String(entry.content).includes(`assistant ${turn} `))).toHaveLength(1);
    }
    expect(messages.at(-1)).toEqual({ role: "user", content: "current question" });
    expect(messages).toHaveLength(22);
  });

  it("reuses a prefix boundary after a fork and resets safely when the fork precedes it", async () => {
    const repo = createInMemorySummaryRepo();
    await build(repo, createBranchState(14), pathIds(14), DIMENSION_A);

    const afterBoundaryPath = [...pathIds(8), ...Array.from({ length: 6 }, (_, index) => `fork-${index + 9}`)];
    const afterBoundaryState = createBranchStateForPath(afterBoundaryPath);
    const compatible = await build(repo, afterBoundaryState, afterBoundaryPath, DIMENSION_A);
    expect(compatible[0]?.role).toBe("system");
    expect(repo.summaries).toHaveLength(1);
    expect(repo.states).toHaveLength(1);

    const beforeBoundaryPath = [...pathIds(3), ...Array.from({ length: 11 }, (_, index) => `early-fork-${index + 4}`)];
    const beforeBoundaryState = createBranchStateForPath(beforeBoundaryPath);
    await build(repo, beforeBoundaryState, beforeBoundaryPath, DIMENSION_A);
    expect(repo.summaries).toHaveLength(2);
    expect(repo.states).toHaveLength(2);
  });

  it("resets state on provider/model/profile dimension changes while reusing exact summary windows", async () => {
    const repo = createInMemorySummaryRepo();
    const state = createBranchState(14);
    await build(repo, state, pathIds(14), DIMENSION_A);

    const dimensionB = {
      ...DIMENSION_A,
      dimensionHash: "dimension-b",
      model: "gpt-5",
      profileFingerprint: "profile-b",
    };
    await build(repo, state, pathIds(14), dimensionB);

    expect(repo.summaries).toHaveLength(1);
    expect(repo.states.map((item) => item.dimensionHash).sort()).toEqual(["dimension-a", "dimension-b"]);
  });

  it("rejects matching dimension hashes when first-request provider/model truth belongs to another route", async () => {
    const repo = createInMemorySummaryRepo();
    await build(repo, createBranchState(14), pathIds(14), DIMENSION_A);
    const switchedRouteState = createBranchState(15, {
      usageByTurn: new Map([
        ["turn-14", 1200],
        ["turn-15", 1200],
      ]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });
    const switchedUsage = switchedRouteState.tracesById.get("turn-15")?.completion?.firstProviderRequestUsage;
    if (!switchedUsage) {
      throw new Error("Expected first-request usage for the switched-route fixture");
    }
    switchedUsage.providerId = "anthropic";
    switchedUsage.model = "claude-sonnet";

    await build(repo, switchedRouteState, pathIds(15), DIMENSION_A);

    expect(repo.states).toHaveLength(1);
    expect(repo.states[0]).toMatchObject({ armed: false, observedTurnCount: 14 });
  });

  it("does not reuse an older usage sample across a newer failed turn", async () => {
    const repo = createInMemorySummaryRepo();
    await build(repo, createBranchState(14), pathIds(14), DIMENSION_A);
    const failedLatestState = createBranchState(15, {
      usageByTurn: new Map([["turn-14", 1200]]),
      dimensionHash: DIMENSION_A.dimensionHash,
    });
    const failedTrace = failedLatestState.tracesById.get("turn-15");
    if (!failedTrace) {
      throw new Error("Expected failed-turn trace fixture");
    }
    failedTrace.status = "failed";

    await build(repo, failedLatestState, pathIds(15), DIMENSION_A);

    expect(repo.states[0]).toMatchObject({ armed: false, observedTurnCount: 14 });
  });

  it("never summarizes or drops turns containing attachments or vision parts", async () => {
    const repo = createInMemorySummaryRepo();
    const state = createBranchState(14);
    const richUser = state.messagesById.get("user-3")!;
    state.messagesById.set("user-3", {
      ...richUser,
      parts: [{ type: "image_ref", attachmentId: "image-1", mimeType: "image/png", detail: "high" }],
      attachments: [{ attachmentId: "image-1", fileName: "diagram.png", mimeType: "image/png", sizeBytes: 42 }],
    });

    const messages = await build(repo, state, pathIds(14), DIMENSION_A);

    expect(repo.summaries).toHaveLength(0);
    expect(repo.states).toHaveLength(0);
    expect(messages).toHaveLength(28);
    expect(messages.find((entry) => Array.isArray(entry.content))).toBeTruthy();
  });

  it("bounds durable boundaries at the storage contract without dropping the remaining long-session turns", async () => {
    const repo = createInMemorySummaryRepo();
    const turnCount = 526;

    const messages = await build(repo, createBranchState(turnCount), pathIds(turnCount), DIMENSION_A);

    expect(repo.states).toHaveLength(1);
    expect(repo.states[0]?.boundaryTurnIds).toHaveLength(512);
    for (let turn = 513; turn <= turnCount; turn += 1) {
      expect(messages.filter((entry) => String(entry.content).includes(`user ${turn} `))).toHaveLength(1);
      expect(messages.filter((entry) => String(entry.content).includes(`assistant ${turn} `))).toHaveLength(1);
    }
  });
});

function createInMemorySummaryRepo() {
  const summaries: ChatConversationSummaryRecord[] = [];
  const states: ChatCompactionStateRecord[] = [];
  return {
    summaries,
    states,
    listByBranch: vi.fn((sessionId: string, branchHeadTurnId: string) =>
      summaries.filter((summary) => summary.sessionId === sessionId && summary.branchHeadTurnId === branchHeadTurnId),
    ),
    listBySession: vi.fn((sessionId: string) => summaries.filter((summary) => summary.sessionId === sessionId)),
    findReusableWindow: vi.fn((input: { sessionId: string; turnIds: string[]; sourceHash: string }) =>
      summaries.find(
        (summary) =>
          summary.sessionId === input.sessionId &&
          summary.sourceHash === input.sourceHash &&
          arraysEqual(summary.turnIds, input.turnIds),
      ),
    ),
    upsert: vi.fn((input: Omit<ChatConversationSummaryRecord, "summaryId" | "createdAt" | "updatedAt">) => {
      const existing = summaries.find(
        (summary) => summary.sourceHash === input.sourceHash && arraysEqual(summary.turnIds, input.turnIds),
      );
      if (existing) {
        return existing;
      }
      const created = {
        ...input,
        summaryId: `summary-${summaries.length + 1}`,
        createdAt: "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      } satisfies ChatConversationSummaryRecord;
      summaries.push(created);
      return created;
    }),
    listCompactionStates: vi.fn((sessionId: string, dimensionHash: string) =>
      states.filter((state) => state.sessionId === sessionId && state.dimensionHash === dimensionHash),
    ),
    upsertCompactionState: vi.fn((input: Omit<ChatCompactionStateRecord, "createdAt" | "updatedAt">) => {
      if (input.boundaryTurnIds.length > 512) {
        throw new RangeError("turnIds must contain between 1 and 512 entries");
      }
      const index = states.findIndex((state) => state.stateKey === input.stateKey);
      const prior = states[index];
      if (prior && prior.observedTurnCount > input.observedTurnCount) {
        return prior;
      }
      const next = {
        ...input,
        createdAt: prior?.createdAt ?? "2026-07-13T00:00:00.000Z",
        updatedAt: "2026-07-13T00:00:00.000Z",
      } satisfies ChatCompactionStateRecord;
      if (index >= 0) {
        states[index] = next;
      } else {
        states.push(next);
      }
      return next;
    }),
  };
}

async function build(
  repo: ReturnType<typeof createInMemorySummaryRepo>,
  state: ReturnType<typeof createBranchState>,
  pathTurnIds: string[],
  dimension: ChatCompactionDimension,
  currentUserMessage?: ChatMessageRecord,
) {
  const deps = {
    storage: { chatConversationSummaries: repo },
    llmService: {
      getRuntimeConfig: () => ({
        activeProviderId: dimension.providerId,
        activeModel: dimension.model,
        providers: [
          {
            providerId: dimension.providerId,
            defaultModel: dimension.model,
            capabilities: { vision: true },
          },
        ],
      }),
    },
    readTranscriptOrEmpty: vi.fn(async () => []),
    loadChatTurnSessionState: vi.fn(async () => state),
    buildUserMessageContent: vi.fn(async (record: ChatMessageRecord) =>
      record.parts?.length
        ? [{ type: "text", text: record.content }, ...record.parts.map((part) => ({ ...part }))]
        : record.content,
    ),
  } as unknown as ChatMessageHistoryDependencies;
  return buildLlmMessagesFromBranchPath(
    deps,
    "session-1",
    pathTurnIds,
    currentUserMessage,
    { providerId: dimension.providerId, model: dimension.model, compactionDimension: dimension },
    state,
  );
}

function createBranchState(
  count: number,
  options: {
    usageByTurn?: Map<string, number>;
    dimensionHash?: string;
    usageProviderId?: string;
    usageModel?: string;
  } = {},
) {
  return createBranchStateForPath(pathIds(count), options);
}

function createBranchStateForPath(
  turnIds: string[],
  options: {
    usageByTurn?: Map<string, number>;
    dimensionHash?: string;
    usageProviderId?: string;
    usageModel?: string;
  } = {},
) {
  const tracesById = new Map<string, ChatTurnTraceRecord>();
  const messagesById = new Map<string, ChatMessageRecord>();
  const turnLineageById = new Map<string, { turnId: string; parentTurnId?: string }>();
  turnIds.forEach((turnId, index) => {
    const turnSuffix = turnId.replace(/^turn-/, "");
    const userMessageId = `user-${turnSuffix}`;
    const assistantMessageId = `assistant-${turnSuffix}`;
    const inputTokens = options.usageByTurn?.get(turnId);
    tracesById.set(turnId, {
      turnId,
      sessionId: "session-1",
      userMessageId,
      assistantMessageId,
      status: "completed",
      mode: "chat",
      webMode: "off",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      retrieval: { query: "", sources: [], used: false },
      startedAt: "2026-07-13T00:00:00.000Z",
      branchKind: "append",
      completion:
        inputTokens === undefined
          ? { status: "complete", repaired: false }
          : {
              status: "complete",
              repaired: false,
              firstProviderRequestUsage: {
                reportedInputTokens: inputTokens,
                effectiveInputTokens: inputTokens,
                source: "provider_reported",
                availability: "reported",
                providerId: options.usageProviderId ?? DIMENSION_A.providerId,
                model: options.usageModel ?? DIMENSION_A.model,
                compactionDimensionHash: options.dimensionHash,
              },
            },
    } as ChatTurnTraceRecord);
    messagesById.set(userMessageId, message(userMessageId, "user", `user ${index + 1} ${"detail ".repeat(180)}`));
    messagesById.set(
      assistantMessageId,
      message(assistantMessageId, "assistant", `assistant ${index + 1} ${"detail ".repeat(180)}`),
    );
    turnLineageById.set(turnId, {
      turnId,
      ...(index > 0 ? { parentTurnId: turnIds[index - 1] } : {}),
    });
  });
  return {
    traces: [...tracesById.values()],
    tracesById,
    turnLineageById,
    messages: [...messagesById.values()],
    messagesById,
    childrenByTurnId: new Map<string, string[]>(),
    activeLeafTurnId: turnIds.at(-1),
  };
}

function message(messageId: string, role: ChatMessageRecord["role"], content: string): ChatMessageRecord {
  return {
    messageId,
    sessionId: "session-1",
    role,
    actorType: role === "assistant" ? "agent" : "user",
    actorId: role === "assistant" ? "assistant" : "operator",
    content,
    timestamp: "2026-07-13T00:00:00.000Z",
  };
}

function pathIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `turn-${index + 1}`);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
