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
    completion:{status:"complete",repaired:false,providerCallCount:1},
    startedAt: "2026-07-01T00:00:00.000Z",
    ...input,
  } as ChatTurnTraceRecord;
}

it("never mines a completed turn whose memory mode was explicitly off",async()=>{
  const harness=createHarness({listCompletedTracePage:async()=>[buildTrace({turnId:"t1",sessionId:"s1",memoryMode:"off"})]});
  expect((await harness.service.runConsolidation()).proposed).toBe(0);
  expect(harness.deps.createChatCompletion).not.toHaveBeenCalled();
});

it.each([undefined,{status:"truncated",repaired:false,providerCallCount:1},{status:"complete",repaired:false,providerCallCount:0}])("skips sparse or incomplete traces without canonical completion evidence: %s",async completion=>{
  const harness=createHarness({listCompletedTracePage:async()=>[buildTrace({turnId:"t1",sessionId:"s1",completion:completion as ChatTurnTraceRecord["completion"]})]});
  expect((await harness.service.runConsolidation()).proposed).toBe(0);expect(harness.deps.createChatCompletion).not.toHaveBeenCalled();
});

function buildEvents(
  sessionId: string,
  turnId = "t1",
  text = "The deployment failed because the staging bucket region moved to eu-west-1 and the sync script still assumed us-east-1. " +
    "We fixed it by reading the region from terraform outputs instead of hardcoding it.",
): TranscriptEvent[] {
  return [
    {
      eventId: `${turnId}-user`,
      actionId: "a1",
      idempotencyKey: "k1",
      sessionId,
      sessionKey: sessionId,
      timestamp: "2026-07-01T00:00:00.000Z",
      type: "message.user",
      actorType: "user",
      actorId: "operator",
      payload: { message: { role: "user", content: text } },
    },
    {
      eventId: `${turnId}-assistant`,
      actionId: "a2",
      idempotencyKey: "k2",
      sessionId,
      sessionKey: sessionId,
      timestamp: "2026-07-01T00:01:00.000Z",
      type: "message.assistant",
      actorType: "agent",
      actorId: "assistant",
      payload: { message: { role: "assistant", content: text } },
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
    isFeatureEnabled: async (flag) =>
      flag === "memoryConsolidationV1Enabled" || flag === "memoryLifecycleAdminV1Enabled",
    listCompletedTracePage: async () => [buildTrace({ turnId: "t1", sessionId: "s1" })],
    readTranscriptOrEmpty: async (sessionId) => buildEvents(sessionId),
    createChatCompletion: vi.fn(async () => ({
      choices: [{ message: { content: DRAFT_JSON } }],
    })) as unknown as MemoryConsolidationDeps["createChatCompletion"],
    resolveModelDefaults: async () => ({ providerId: "glm", model: "glm-4-flash" }),
    proposeTraceMemoryCandidate: vi.fn(async (input, actorId) => {
      proposed.push({ insight: input.proposedInsight, actorId });
      return { candidateId: "c1" } as never;
    }),
    listExistingInsightsForDedup: vi.fn(async () => []),
    publishRealtime: vi.fn(async () => undefined),
    now: () => new Date("2026-07-05T10:00:00.000Z"),
    listWorkspaceIds: async () => ["workspace-a"],
    resolveEligibleSourceSession: async () => ({ workspaceId: "workspace-a" }),
    readProgress: async () => ({ revision: 0, cursor: { finishedAt: "2026-06-24T00:00:00.000Z", turnId: "" } }),
    claimProgress: async (_workspaceId: string, revision: number, leaseOwner: string) => ({
      revision: revision + 1,
      leaseOwner,
    }),
    commitProgress: async (
      _workspaceId: string,
      _revision: number,
      _leaseOwner: string,
      cursor?: { finishedAt: string },
    ) => {
      if (cursor && cursor.finishedAt > "2026-06-24T00:00:00.000Z") watermarks.push(cursor.finishedAt);
    },
    ...overrides,
  };
  return { service: new MemoryConsolidationService(deps), deps, proposed, watermarks };
}

describe("MemoryConsolidationService", () => {
  it("binds canonical source hashes and withholds a proposal if source bytes change during drafting",async()=>{
    let hash="a".repeat(64);
    const h=createHarness({readCanonicalSource:async input=>({sourceHash:hash,events:buildEvents(input.sessionId)})});
    await h.service.runConsolidation();
    expect(vi.mocked(h.deps.proposeTraceMemoryCandidate).mock.calls[0]![0].metadata).toMatchObject({consolidationSource:{workspaceId:"workspace-a",sessionId:"s1",turnIds:["t1"],sourceHash:hash}});
    const changed=createHarness({readCanonicalSource:async input=>({sourceHash:hash,events:buildEvents(input.sessionId)}),createChatCompletion:async()=>{hash="b".repeat(64);return {choices:[{message:{role:"assistant",content:DRAFT_JSON}}]} as never;}});
    expect((await changed.service.runConsolidation()).proposed).toBe(0);
    expect(changed.watermarks).toEqual([]);
  });
  it("does not send actual credential-bearing transcript messages to a review provider", async () => {
    const { service, deps } = createHarness({ readTranscriptOrEmpty: async sessionId => buildEvents(sessionId, "t1",
      "A completed synthetic project status note. ".repeat(6) + "Authorization: Bearer synthetic-test-only-abcdefghijklmnopqrstuvwxyz123456789") });
    await service.runConsolidation();
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
    expect(deps.proposeTraceMemoryCandidate).not.toHaveBeenCalled();
  });

  it("allows identical lessons in different canonical workspaces", async () => {
    const { service, deps } = createHarness({
      listWorkspaceIds: async () => ["A", "B"],
      listCompletedTracePage: async ({ workspaceId }) => [buildTrace({ turnId: "t1", sessionId: workspaceId })],
      resolveEligibleSourceSession: async (sessionId) => ({ workspaceId: sessionId }),
    });
    const result = await service.runConsolidation();
    expect(result.proposed).toBe(2);
    expect(vi.mocked(deps.proposeTraceMemoryCandidate).mock.calls.map(([input]) => input.workspaceId)).toEqual(["A", "B"]);
  });

  it("keeps a failed prefix retryable while a different workspace makes progress", async () => {
    const progress: Array<{ workspaceId: string; cursor?: { turnId: string } }> = [];
    const { service } = createHarness({
      listWorkspaceIds: async () => ["A", "B"],
      listCompletedTracePage: async ({ workspaceId }) => [buildTrace({ turnId: "t1", sessionId: workspaceId })],
      resolveEligibleSourceSession: async (sessionId) => ({ workspaceId: sessionId }),
      readTranscriptOrEmpty: async (sessionId) => {
        if (sessionId === "A") throw new Error("transient unavailable");
        return buildEvents(sessionId);
      },
      commitProgress: async (workspaceId, _revision, _owner, cursor) => { progress.push({ workspaceId, cursor }); },
    });
    const result = await service.runConsolidation();
    expect(result.sessionsFailed).toBe(1);
    expect(result.proposed).toBe(1);
    expect(progress).toEqual([
      { workspaceId: "A", cursor: { finishedAt: "2026-06-24T00:00:00.000Z", turnId: "" } },
      { workspaceId: "B", cursor: { finishedAt: "2026-07-01T00:00:00.000Z", turnId: "t1" } },
    ]);
  });

  it("binds proposals and dedupe to the canonical non-default workspace", async () => {
    const { service, deps } = createHarness();
    await service.runConsolidation();
    expect(deps.proposeTraceMemoryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-a", sourceSessionId: "s1" }),
      "memory-consolidation-job",
    );
    expect(deps.listExistingInsightsForDedup).toHaveBeenCalledWith("workspace-a");
  });

  it("does not read transcripts or call a provider when canonical ownership is missing", async () => {
    const readTranscriptOrEmpty = vi.fn(async (sessionId: string) => buildEvents(sessionId));
    const { service, deps, proposed } = createHarness({
      readTranscriptOrEmpty,
      ...{ resolveEligibleSourceSession: async () => undefined },
    });
    await service.runConsolidation();
    expect(readTranscriptOrEmpty).not.toHaveBeenCalled();
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
    expect(proposed).toEqual([]);
  });

  it("does not propose if source ownership changes while drafting", async () => {
    let reads = 0;
    const { service, deps } = createHarness({
      ...{ resolveEligibleSourceSession: async () => ({ workspaceId: ++reads === 1 ? "workspace-a" : "foreign" }) },
    });
    await service.runConsolidation();
    expect(deps.proposeTraceMemoryCandidate).not.toHaveBeenCalled();
  });

  it("mines qualifying traces, drafts, and proposes approval-gated candidates", async () => {
    const { service, deps, proposed, watermarks } = createHarness();
    const summary = await service.runConsolidation();
    expect(summary.status).toBe("completed");
    expect(summary.proposed).toBe(1);
    expect(proposed[0].actorId).toBe("memory-consolidation-job");
    expect(proposed[0].insight).toContain("eu-west-1");
    expect(deps.proposeTraceMemoryCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ sourceSessionId: "s1", sourceTurnId: "t1" }),
      "memory-consolidation-job",
    );
    expect(watermarks).toEqual(["2026-07-01T00:00:00.000Z"]);
  });

  it("uses only messages from qualifying turns and cites their session when the digest spans turns", async () => {
    const { service, deps } = createHarness({
      listCompletedTracePage: async () => [
        buildTrace({ turnId: "t1", sessionId: "s1" }),
        buildTrace({ turnId: "t2", sessionId: "s1" }),
        buildTrace({
          turnId: "failed",
          sessionId: "s1",
          reflection: { attempted: true, attemptCount: 1, outcome: "still_failed" },
        }),
      ],
      readTranscriptOrEmpty: async () => [
        ...buildEvents("s1", "old", "Before the consolidation window"),
        ...buildEvents("s1", "t1"),
        ...buildEvents("s1", "t2", "The release checklist now includes the bucket-region check."),
        ...buildEvents("s1", "failed", "Failed reflection content"),
        ...buildEvents("other-session", "t2", "Foreign session content"),
        ...buildEvents("s1", "unselected", "Unselected recent content"),
      ],
    });

    expect((await service.runConsolidation()).proposed).toBe(1);

    const [request, attribution] = vi.mocked(deps.createChatCompletion).mock.calls[0]!;
    const digest = request.messages[1]?.content;
    expect(digest).toContain("eu-west-1");
    expect(digest).toContain("The release checklist");
    expect(digest).not.toMatch(/Before the consolidation window|Failed reflection|Foreign session|Unselected recent/u);
    expect(attribution.sessionId).toBe("s1");
    expect(attribution).not.toHaveProperty("turnId");
    const [proposal] = vi.mocked(deps.proposeTraceMemoryCandidate).mock.calls[0]!;
    expect(proposal.sourceSessionId).toBe("s1");
    expect(proposal).not.toHaveProperty("sourceTurnId");
  });

  it("does not advance the watermark past unsampled qualifying sessions", async () => {
    const { service, watermarks } = createHarness({
      listCompletedTracePage: async () => [
        buildTrace({ turnId: "t1", sessionId: "s1", startedAt: "2026-07-01T00:00:01.000Z" }),
        buildTrace({ turnId: "t2", sessionId: "s2", startedAt: "2026-07-01T00:00:02.000Z" }),
        buildTrace({ turnId: "t3", sessionId: "s3", startedAt: "2026-07-01T00:00:03.000Z" }),
        buildTrace({ turnId: "t4", sessionId: "s4", startedAt: "2026-07-01T00:00:04.000Z" }),
      ],
    });

    const summary = await service.runConsolidation();

    expect(summary.sessionsSampled).toBe(3);
    expect(summary.qualifyingTurns).toBe(4);
    expect(summary.nextWatermark).toBe("2026-07-01T00:00:03.000Z");
    expect(watermarks).toEqual(["2026-07-01T00:00:03.000Z"]);
  });

  it("is inert when the consolidation flag is off", async () => {
    const { service, deps, proposed } = createHarness({
      isFeatureEnabled: async (flag) => flag === "memoryLifecycleAdminV1Enabled",
    });
    const summary = await service.runConsolidation();
    expect(summary.status).toBe("disabled");
    expect(proposed).toHaveLength(0);
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
  });

  it("halts on the autonomy kill switch", async () => {
    const { service, deps, proposed } = createHarness({
      isFeatureEnabled: async () => true, // autonomyV1Disabled=true wins
    });
    const summary = await service.runConsolidation();
    expect(summary.status).toBe("skipped_kill_switch");
    expect(proposed).toHaveLength(0);
    expect(deps.createChatCompletion).not.toHaveBeenCalled();
  });

  it("skips still_failed reflection turns and filters low-confidence drafts", async () => {
    const { service, proposed } = createHarness({
      listCompletedTracePage: async () => [
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
      listExistingInsightsForDedup: async () => [
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
