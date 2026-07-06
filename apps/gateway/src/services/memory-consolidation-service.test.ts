import { describe, expect, it, vi } from "vitest";
import type { ChatTurnTraceRecord, TranscriptEvent } from "@goatcitadel/contracts";
import {
  jaccardSimilarity,
  MemoryConsolidationService,
  parseDraftedCandidates,
  tokenizeInsight,
  type MemoryConsolidationDeps,
} from "./memory-consolidation-service.js";

function buildTrace(
  input: Partial<ChatTurnTraceRecord> & Pick<ChatTurnTraceRecord, "turnId" | "sessionId">,
): ChatTurnTraceRecord {
  return {
    userMessageId: `${input.turnId}-user`,
    assistantMessageId: `${input.turnId}-assistant`,
    status: "completed",
    startedAt: "2026-07-01T00:00:00.000Z",
    ...input,
  } as ChatTurnTraceRecord;
}

function buildEvents(sessionId: string): TranscriptEvent[] {
  const text =
    "The deployment failed because the staging bucket region moved to eu-west-1 and the sync script still assumed us-east-1. " +
    "We fixed it by reading the region from terraform outputs instead of hardcoding it.";
  return [
    {
      eventId: "e1",
      actionId: "a1",
      idempotencyKey: "k1",
      sessionId,
      sessionKey: sessionId,
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: { text },
    },
    {
      eventId: "e2",
      actionId: "a2",
      idempotencyKey: "k2",
      sessionId,
      sessionKey: sessionId,
      timestamp: "2026-07-01T00:01:00.000Z",
      type: "message.assistant",
      actorType: "agent",
      actorId: "assistant",
      payload: { text },
    },
  ];
}

const DRAFT_JSON = JSON.stringify([
  {
    type: "repo_fact",
    insight: "The staging bucket region is eu-west-1; sync scripts must read it from terraform outputs.",
    confidence: 0.8,
  },
]);

function createHarness(overrides: Partial<MemoryConsolidationDeps> = {}) {
  const proposed: Array<{ insight: string; actorId: string }> = [];
  const watermarks: string[] = [];
  const deps: MemoryConsolidationDeps = {
    isFeatureEnabled: (flag) => flag === "memoryConsolidationV1Enabled" || flag === "memoryLifecycleAdminV1Enabled",
    listCompletedTurnTracesSince: () => [buildTrace({ turnId: "t1", sessionId: "s1" })],
    readTranscriptOrEmpty: async (sessionId) => buildEvents(sessionId),
    createChatCompletion: vi.fn(async () => ({
      choices: [{ message: { content: DRAFT_JSON } }],
    })) as unknown as MemoryConsolidationDeps["createChatCompletion"],
    resolveModelDefaults: () => ({ providerId: "glm", model: "glm-4-flash" }),
    proposeTraceMemoryCandidate: vi.fn(async (input, actorId) => {
      proposed.push({ insight: input.proposedInsight, actorId });
      return { candidateId: "c1" } as never;
    }),
    listExistingInsightsForDedup: () => [],
    getWatermark: () => "2026-06-24T00:00:00.000Z",
    setWatermark: (iso) => {
      watermarks.push(iso);
    },
    publishRealtime: vi.fn(),
    now: () => new Date("2026-07-05T10:00:00.000Z"),
    ...overrides,
  };
  return { service: new MemoryConsolidationService(deps), deps, proposed, watermarks };
}

describe("MemoryConsolidationService", () => {
  it("mines qualifying traces, drafts, and proposes approval-gated candidates", async () => {
    const { service, proposed, watermarks } = createHarness();
    const summary = await service.runConsolidation();
    expect(summary.status).toBe("completed");
    expect(summary.proposed).toBe(1);
    expect(proposed[0].actorId).toBe("memory-consolidation-job");
    expect(proposed[0].insight).toContain("eu-west-1");
    expect(watermarks).toEqual(["2026-07-01T00:00:00.000Z"]);
  });

  it("is inert when the consolidation flag is off", async () => {
    const { service, deps, proposed } = createHarness({
      isFeatureEnabled: (flag) => flag === "memoryLifecycleAdminV1Enabled",
    });
    const summary = await service.runConsolidation();
    expect(summary.status).toBe("disabled");
    expect(proposed).toHaveLength(0);
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
  });

  it("halts on the autonomy kill switch", async () => {
    const { service, deps, proposed } = createHarness({
      isFeatureEnabled: () => true, // autonomyV1Disabled=true wins
    });
    const summary = await service.runConsolidation();
    expect(summary.status).toBe("skipped_kill_switch");
    expect(proposed).toHaveLength(0);
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
  });

  it("skips still_failed reflection turns and filters low-confidence drafts", async () => {
    const { service, proposed } = createHarness({
      listCompletedTurnTracesSince: () => [
        buildTrace({
          turnId: "t1",
          sessionId: "s1",
          reflection: { attempted: true, attemptCount: 1, outcome: "still_failed" },
        }),
      ],
    });
    const summary = await service.runConsolidation();
    expect(summary.qualifyingTurns).toBe(0);
    expect(proposed).toHaveLength(0);
  });

  it("deduplicates near-identical insights against existing memory", async () => {
    const { service, proposed } = createHarness({
      listExistingInsightsForDedup: () => [
        "Staging bucket region is eu-west-1 and sync scripts must read it from terraform outputs.",
      ],
    });
    const summary = await service.runConsolidation();
    expect(summary.deduplicated).toBe(1);
    expect(proposed).toHaveLength(0);
  });

  it("does not advance the watermark when every sampled session fails", async () => {
    const { service, watermarks } = createHarness({
      createChatCompletion: vi.fn(async () => Promise.reject(new Error("provider down"))),
    });
    const summary = await service.runConsolidation();
    expect(summary.sessionsFailed).toBe(1);
    expect(summary.proposed).toBe(0);
    expect(watermarks).toHaveLength(0);
  });
});

describe("parseDraftedCandidates", () => {
  it("parses fenced or noisy JSON and enforces bounds", () => {
    const noisy = "Here you go:\n```json\n" + DRAFT_JSON + "\n```";
    const drafted = parseDraftedCandidates(noisy, "s1", "t1");
    expect(drafted).toHaveLength(1);
    expect(drafted[0].candidateType).toBe("repo_fact");
  });

  it("drops short, unconfident, and malformed items", () => {
    const content = JSON.stringify([
      { insight: "too short", confidence: 0.9 },
      { insight: "confident enough but the confidence value is below the floor for proposing", confidence: 0.2 },
      {
        type: "nonsense-type",
        insight: "an insight long enough to pass the minimum length check for candidates",
        confidence: 0.7,
      },
      "not-an-object",
    ]);
    const drafted = parseDraftedCandidates(content, "s1");
    expect(drafted).toHaveLength(1);
    expect(drafted[0].candidateType).toBe("fact");
  });

  it("returns empty on non-JSON content", () => {
    expect(parseDraftedCandidates("no structured data here", "s1")).toEqual([]);
  });
});

describe("lexical dedup helpers", () => {
  it("scores near-duplicates above the skip threshold and unrelated text below it", () => {
    const a = tokenizeInsight("The staging bucket region is eu-west-1 for sync scripts");
    const b = tokenizeInsight("Staging bucket region eu-west-1 sync scripts must use terraform");
    const c = tokenizeInsight("Operators prefer weekly cost reports delivered on Telegram");
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(0.5);
    expect(jaccardSimilarity(a, c)).toBeLessThan(0.2);
    expect(jaccardSimilarity(new Set(), a)).toBe(0);
  });
});
