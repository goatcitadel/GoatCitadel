import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatMessageRecord, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import { buildChatCompactionAttemptId, ChatConversationSummaryRepository, createDatabase } from "@goatcitadel/storage";
import {
  buildLlmMessagesFromBranchPath,
  type ChatCompactionDimension,
  type ChatMessageHistoryDependencies,
} from "./chat-message-history-service.js";

const DIMENSION_A: ChatCompactionDimension = {
  dimensionHash: "breaker-dimension-a",
  providerId: "openai",
  model: "gpt-4.1",
  profileFingerprint: "profile-a",
  persistState: true,
};
const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // Ignore cleanup noise.
      }
    }
  }
});

describe("chat branch persistent compaction breaker", () => {
  it("commits pending truth and closes it only from exact newer provider evidence", async () => {
    const fixture = createFixture();
    try {
      await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toMatchObject({
        status: "awaiting_evidence",
        pendingBranchHeadTurnId: "turn-14",
        pendingObservedTurnCount: 14,
        lastOutcome: "unverified",
      });

      await build(fixture.repo, createState(turnIds(15), usage("turn-15", 1_200)), turnIds(15));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toMatchObject({
        status: "closed",
        fallbackStreak: 0,
        ineffectiveStreak: 0,
        lastEvidenceTurnId: "turn-15",
        lastEvidenceInputTokens: 1_200,
        lastOutcome: "healthy",
      });
      expect(fixture.repo.listCompactionStates("session-1", DIMENSION_A.dimensionHash)[0]).toMatchObject({
        armed: true,
        baselineInputTokens: 1_200,
        observedTurnCount: 15,
      });
    } finally {
      fixture.db.close();
    }
  });

  it("ignores deterministic, mismatched, stale, and failed-turn evidence", async () => {
    const fixture = createFixture();
    try {
      await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14));
      const initial = fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)!;

      const estimated = createState(turnIds(15), usage("turn-15", 1_000, { exact: false }));
      await build(fixture.repo, estimated, turnIds(15));
      const switched = createState(turnIds(16), usage("turn-16", 1_000, { providerId: "anthropic" }));
      await build(fixture.repo, switched, turnIds(16));
      const failed = createState(turnIds(17), usage("turn-17", 1_000));
      failed.tracesById.get("turn-17")!.status = "failed";
      await build(fixture.repo, failed, turnIds(17));

      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toEqual(initial);
    } finally {
      fixture.db.close();
    }
  });

  it("trips after two ineffective structured boundaries and preserves the aggregate across a rearm turn", async () => {
    const fixture = createFixture();
    try {
      await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14));
      await build(fixture.repo, createState(turnIds(15), usage("turn-15", 2_300)), turnIds(15));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toMatchObject({
        status: "closed",
        ineffectiveStreak: 1,
      });

      await build(fixture.repo, createState(turnIds(16), usage("turn-16", 1_200)), turnIds(16));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)?.ineffectiveStreak).toBe(1);
      await build(fixture.repo, createState(turnIds(22), usage("turn-22", 2_400)), turnIds(22));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)?.status).toBe(
        "awaiting_evidence",
      );
      await build(fixture.repo, createState(turnIds(23), usage("turn-23", 2_500)), turnIds(23));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toMatchObject({
        status: "tripped",
        ineffectiveStreak: 2,
        lastOutcome: "ineffective",
      });
    } finally {
      fixture.db.close();
    }
  });

  it("does not let a fork or dimension switch erase pending breaker truth", async () => {
    const fixture = createFixture();
    try {
      await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14));
      const pending = fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)!;
      const forkPath = [...turnIds(8), ...Array.from({ length: 7 }, (_, index) => `fork-${index + 9}`)];
      const forkMessages = await build(fixture.repo, createState(forkPath, usage(forkPath.at(-1)!, 1_000)), forkPath);
      expect(forkMessages[0]).toMatchObject({ role: "system" });
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toEqual(pending);

      const dimensionB = {
        ...DIMENSION_A,
        dimensionHash: "breaker-dimension-b",
        model: "gpt-5",
        profileFingerprint: "profile-b",
      };
      await build(
        fixture.repo,
        createState(turnIds(14), usage("turn-14", 2_400, { model: "gpt-5", dimensionHash: dimensionB.dimensionHash })),
        turnIds(14),
        dimensionB,
      );
      expect(fixture.repo.getCompactionBreaker("session-1", dimensionB.dimensionHash)?.status).toBe(
        "awaiting_evidence",
      );
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toEqual(pending);
    } finally {
      fixture.db.close();
    }
  });

  it("records a genuinely eligible no-progress attempt once, while rich and provisional skips remain clean", async () => {
    const fixture = createFixture();
    try {
      const blank = createState(turnIds(14), usage("turn-14", 2_400), " ".repeat(800));
      for (const [messageId, record] of blank.messagesById) {
        blank.messagesById.set(messageId, { ...record, content: " ".repeat(800) });
      }
      await build(fixture.repo, blank, turnIds(14));
      const first = fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)!;
      expect(first).toMatchObject({ status: "closed", ineffectiveStreak: 1, lastOutcome: "no_progress" });
      await build(fixture.repo, blank, turnIds(14));
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toEqual(first);

      const richDimension = { ...DIMENSION_A, dimensionHash: "rich-dimension", profileFingerprint: "rich-profile" };
      const rich = createState(turnIds(14), usage("turn-14", 2_400, { dimensionHash: richDimension.dimensionHash }));
      rich.messagesById.set("user-turn-3", {
        ...rich.messagesById.get("user-turn-3")!,
        attachments: [{ attachmentId: "a", fileName: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
      });
      await build(fixture.repo, rich, turnIds(14), richDimension);
      expect(fixture.repo.getCompactionBreaker("session-1", richDimension.dimensionHash)).toBeUndefined();

      const provisional = { ...DIMENSION_A, dimensionHash: "provisional", persistState: false };
      await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14), provisional);
      expect(fixture.repo.getCompactionBreaker("session-1", provisional.dimensionHash)).toBeUndefined();
    } finally {
      fixture.db.close();
    }
  });

  it("records one no-progress strike when an eligible boundary cannot commit", async () => {
    const fixture = createFixture();
    try {
      vi.spyOn(fixture.repo, "commitCompactionBoundary").mockImplementationOnce(() => {
        throw new Error("simulated boundary commit failure");
      });

      const messages = await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14));

      expect(messages).toHaveLength(28);
      expect(messages.some((message) => message.role === "system")).toBe(false);
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)).toMatchObject({
        status: "closed",
        ineffectiveStreak: 1,
        lastOutcome: "no_progress",
      });
    } finally {
      fixture.db.close();
    }
  });

  it("uses an actor-bound action once after dimension seal and consumes only a structured boundary", async () => {
    const fixture = createFixture();
    try {
      const tripped = tripBreaker(fixture.repo, "session-1", DIMENSION_A);
      const forceAction = createForceAction(fixture.repo, tripped.revision);
      const dimension = {
        ...DIMENSION_A,
        forceAction: { actionId: forceAction.actionId, actorHash: forceAction.actorHash },
      };

      const messages = await build(
        fixture.repo,
        createState(turnIds(14), usage("turn-14", 500)),
        turnIds(14),
        dimension,
      );

      expect(messages[0]).toMatchObject({ role: "system" });
      expect(fixture.repo.getCompactionBreakerAction(forceAction.actionId)).toMatchObject({
        status: "consumed",
        resultingBreakerRevision: tripped.revision + 1,
      });
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)?.status).toBe(
        "awaiting_evidence",
      );
    } finally {
      fixture.db.close();
    }
  });

  it("fails closed on a mismatched action actor and leaves the one-shot action pending", async () => {
    const fixture = createFixture();
    try {
      const tripped = tripBreaker(fixture.repo, "session-1", DIMENSION_A);
      const forceAction = createForceAction(fixture.repo, tripped.revision);
      const messages = await build(fixture.repo, createState(turnIds(14), usage("turn-14", 500)), turnIds(14), {
        ...DIMENSION_A,
        forceAction: { actionId: forceAction.actionId, actorHash: "sha256:wrong-actor" },
      });
      expect(messages).toHaveLength(28);
      expect(messages.some((message) => message.role === "system")).toBe(false);
      expect(fixture.repo.getCompactionBreakerAction(forceAction.actionId).status).toBe("pending");
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)?.status).toBe("tripped");
    } finally {
      fixture.db.close();
    }
  });

  it("fails closed and returns the full prompt when a pending boundary becomes corrupt", async () => {
    const fixture = createFixture();
    try {
      await build(fixture.repo, createState(turnIds(14), usage("turn-14", 2_400)), turnIds(14));
      const pending = fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)!;
      fixture.db
        .prepare("UPDATE chat_compaction_states SET boundary_turn_ids_json = '{bad' WHERE state_key = ?")
        .run(pending.pendingStateKey);
      const path15 = turnIds(15);
      const messages = await build(fixture.repo, createState(path15, usage("turn-15", 1_000)), path15);
      expect(messages).toHaveLength(30);
      expect(messages.some((message) => message.role === "system")).toBe(false);
      expect(fixture.repo.getCompactionBreaker("session-1", DIMENSION_A.dimensionHash)?.status).toBe("blocked_corrupt");
    } finally {
      fixture.db.close();
    }
  });
});

function createFixture() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-gateway-compaction-breaker-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatConversationSummaryRepository(db) };
}

function tripBreaker(repo: ChatConversationSummaryRepository, sessionId: string, dimension: ChatCompactionDimension) {
  const identity = {
    sessionId,
    dimensionHash: dimension.dimensionHash,
    providerId: dimension.providerId,
    model: dimension.model,
    profileFingerprint: dimension.profileFingerprint,
  };
  const firstSource = "runtime-trip-source-1";
  const first = repo.recordCompactionNoProgress({
    ...identity,
    attemptId: buildChatCompactionAttemptId({
      ...identity,
      branchHeadTurnId: "turn-14",
      observedTurnCount: 14,
      boundarySourceHash: firstSource,
      disposition: "no_progress",
    }),
    branchHeadTurnId: "turn-14",
    observedTurnCount: 14,
    attemptedBoundarySourceHash: firstSource,
  });
  const secondSource = "runtime-trip-source-2";
  return repo.recordCompactionNoProgress({
    ...identity,
    attemptId: buildChatCompactionAttemptId({
      ...identity,
      branchHeadTurnId: "turn-22",
      observedTurnCount: 22,
      boundarySourceHash: secondSource,
      disposition: "no_progress",
    }),
    branchHeadTurnId: "turn-22",
    observedTurnCount: 22,
    attemptedBoundarySourceHash: secondSource,
    expectedBreakerRevision: first.revision,
  });
}

function createForceAction(repo: ChatConversationSummaryRepository, expectedBreakerRevision: number) {
  const createdAt = new Date().toISOString();
  return repo.createCompactionBreakerAction({
    actionId: randomUUID(),
    sessionId: "session-1",
    dimensionHash: DIMENSION_A.dimensionHash,
    actionKind: "force",
    expectedBreakerRevision,
    actorHash: "sha256:operator-a",
    requestEvidenceHash: "sha256:request-a",
    policyDecisionHash: "sha256:policy-a",
    auditEvidenceHash: "sha256:audit-a",
    approvalId: "approval-a",
    reason: "Reviewed exact compaction evidence",
    status: "pending",
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 5 * 60_000).toISOString(),
  });
}

async function build(
  repo: ChatConversationSummaryRepository,
  state: ReturnType<typeof createState>,
  pathTurnIds: string[],
  dimension: ChatCompactionDimension = DIMENSION_A,
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
    buildUserMessageContent: vi.fn(async (record: ChatMessageRecord) => record.content),
  } as unknown as ChatMessageHistoryDependencies;
  return buildLlmMessagesFromBranchPath(
    deps,
    "session-1",
    pathTurnIds,
    undefined,
    { providerId: dimension.providerId, model: dimension.model, compactionDimension: dimension },
    state,
  );
}

function usage(
  turnId: string,
  inputTokens: number,
  options: {
    exact?: boolean;
    providerId?: string;
    model?: string;
    dimensionHash?: string;
  } = {},
) {
  return new Map([
    [
      turnId,
      {
        inputTokens,
        exact: options.exact ?? true,
        providerId: options.providerId ?? DIMENSION_A.providerId!,
        model: options.model ?? DIMENSION_A.model!,
        dimensionHash: options.dimensionHash ?? DIMENSION_A.dimensionHash,
      },
    ],
  ]);
}

function createState(
  pathTurnIds: string[],
  usageByTurn = new Map<
    string,
    { inputTokens: number; exact: boolean; providerId: string; model: string; dimensionHash: string }
  >(),
  content = "detail ".repeat(180),
) {
  const tracesById = new Map<string, ChatTurnTraceRecord>();
  const messagesById = new Map<string, ChatMessageRecord>();
  pathTurnIds.forEach((turnId, index) => {
    const userMessageId = `user-${turnId}`;
    const assistantMessageId = `assistant-${turnId}`;
    const observed = usageByTurn.get(turnId);
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
      startedAt: "2026-07-14T03:00:00.000Z",
      branchKind: "append",
      completion: observed
        ? {
            status: "complete",
            repaired: false,
            firstProviderRequestUsage: {
              ...(observed.exact ? { reportedInputTokens: observed.inputTokens } : {}),
              effectiveInputTokens: observed.inputTokens,
              source: observed.exact ? "provider_reported" : "deterministic_estimate",
              availability: observed.exact ? "reported" : "unavailable",
              ...(!observed.exact ? { unavailableReason: "provider_usage_missing" as const } : {}),
              providerId: observed.providerId,
              model: observed.model,
              compactionDimensionHash: observed.dimensionHash,
            },
          }
        : { status: "complete", repaired: false },
    } as ChatTurnTraceRecord);
    messagesById.set(userMessageId, message(userMessageId, "user", `user ${index + 1} ${content}`));
    messagesById.set(assistantMessageId, message(assistantMessageId, "assistant", `assistant ${index + 1} ${content}`));
  });
  return {
    traces: [...tracesById.values()],
    tracesById,
    turnLineageById: new Map(),
    messages: [...messagesById.values()],
    messagesById,
    childrenByTurnId: new Map(),
    activeLeafTurnId: pathTurnIds.at(-1),
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
    timestamp: "2026-07-14T03:00:00.000Z",
  };
}

function turnIds(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `turn-${index + 1}`);
}
