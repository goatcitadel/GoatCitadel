import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
vi.mock("node:sqlite", () => ({ DatabaseSync: class DatabaseSync {}, StatementSync: class StatementSync {} }));
import type { PromptPackAutoScoreRecord, PromptPackRunRecord } from "@goatcitadel/contracts";
import { DEFAULT_PROMPT_PACK_POLICY_V3 } from "@goatcitadel/contracts";
import { hashPromptPackPolicyV3 } from "@goatcitadel/storage";
import { PromptPackService } from "./prompt-pack-service.js";
import { PromptPacksRouteService } from "./prompt-packs-route-service.js";
import { promptPackRoutes } from "../routes/prompt-packs.js";
import { createPack, createRun, createScore, createTest } from "./prompt-pack-service-test-fixtures.js";
import { PROMPT_PACK_V3_JUDGE_RUBRIC_VERSION, PROMPT_PACK_V3_SCORER_VERSION } from "./prompt-pack-policy.js";
function fixture() {
  const pack = createPack("pack-1"),
    test = createTest("test-1", "TEST-1"),
    older = createRun("older", "completed", "2026-01-01T00:00:00Z"),
    newer = createRun("newer", "completed", "2026-02-01T00:00:00Z");
  const score: PromptPackAutoScoreRecord = {
    autoScoreId: "score-older",
    packId: pack.packId,
    testId: test.testId,
    runId: older.runId,
    scoringSchemaVersion: "v3",
    scorerVersion: PROMPT_PACK_V3_SCORER_VERSION,
    judgeRubricVersion: PROMPT_PACK_V3_JUDGE_RUBRIC_VERSION,
    policyHash: hashPromptPackPolicyV3(DEFAULT_PROMPT_PACK_POLICY_V3),
    policySource: "repo_default",
    scoreState: "auto_valid",
    protocol: { protocolPass: true, reasonCodes: [] },
    hardFailReasons: [],
    applicability: {},
    outcomeScores: {},
    executionScores: {},
    ruleScores: {},
    finalScores: {},
    disagreement: {},
    weightedScore: 80,
    autoVerdict: "pass",
    reviewReasons: [],
    degradedReasons: [],
    mergeProvenance: {},
    attribution: { primary: "not_applicable", confidence: "high", evidence: [] },
    judgeStatus: "valid",
    createdAt: "2026-01-02T00:00:00Z",
  };
  const review = {
    reviewId: "review-older",
    packId: pack.packId,
    testId: test.testId,
    runId: older.runId,
    reviewerId: "operator:test",
    scores: {},
    applicability: {},
    overrideVerdict: "pass" as const,
    createdAt: "2026-01-03T00:00:00Z",
  };
  const storage = {
    promptPacks: {
      getPack: vi.fn(async () => pack),
      getTest: vi.fn(async () => test),
      listTests: vi.fn(async () => [test]),
    },
    promptPackRuns: {
      get: vi.fn(async (): Promise<PromptPackRunRecord> => older),
      listByPack: vi.fn(async () => [newer]),
    },
    promptPackScores: {
      listByPack: vi.fn(async () => []),
      listByRun: vi.fn(async () => [createScore("legacy-older", older.runId, "2026-01-02T00:00:00Z", 1)]),
    },
    promptPackAutoScoresV2: { listByPack: vi.fn(async () => []), listByRun: vi.fn(async () => [score]) },
    promptPackHumanReviewsV2: { listByPack: vi.fn(async () => []), listByRun: vi.fn(async () => [review]) },
  };
  const providers = {
    createChatSession: vi.fn(),
    agentSendChatMessage: vi.fn(),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: vi.fn(),
    getPromptJudgeModelDefaults: vi.fn(),
    backgroundTasks: new Set<Promise<unknown>>(),
  };
  const service = new PromptPackService(
    {
      storage,
      config: {
        rootDir: process.cwd(),
        assistant: {
          workspaceDir: ".",
          durable: { enabled: true, executionEnabled: true, chatAutoPromoteEnabled: true },
        },
      },
    } as never,
    providers as never,
  );
  return { service, storage, providers, older, newer, test, score, review };
}
describe("canonical focused prompt-pack report", () => {
  it("preserves default report reads/body and selects an older exact record outside the bounded run list", async () => {
    const f = fixture(),
      normal = await f.service.getPromptPackReport("pack-1");
    expect(normal).not.toHaveProperty("focusedRun");
    expect(normal.runs).toEqual([f.newer]);
    expect(f.storage.promptPacks.getPack).toHaveBeenCalledExactlyOnceWith("pack-1");
    expect(f.storage.promptPacks.listTests).toHaveBeenCalledExactlyOnceWith("pack-1", 5000);
    for (const owner of [
      f.storage.promptPackRuns,
      f.storage.promptPackScores,
      f.storage.promptPackAutoScoresV2,
      f.storage.promptPackHumanReviewsV2,
    ])
      expect(owner.listByPack).toHaveBeenCalledExactlyOnceWith("pack-1", 10000);
    expect(f.storage.promptPackRuns.get).not.toHaveBeenCalled();
    expect(f.storage.promptPacks.getTest).not.toHaveBeenCalled();
    for (const owner of [
      f.storage.promptPackAutoScoresV2,
      f.storage.promptPackHumanReviewsV2,
      f.storage.promptPackScores,
    ])
      expect(owner.listByRun).not.toHaveBeenCalled();
    const focused = await f.service.getPromptPackReport("pack-1", {
      runId: f.older.runId,
      sessionId: f.older.sessionId,
    });
    const { focusedRun, ...retained } = focused;
    expect(retained).toEqual(normal);
    expect(focusedRun).toMatchObject({
      run: f.older,
      test: f.test,
      assessment: {
        runId: "older",
        testId: "test-1",
        autoScore: f.score,
        humanReview: f.review,
        currentGeneration: true,
        effectiveVerdict: "pass",
      },
    });
    for (const owner of [
      f.storage.promptPackAutoScoresV2,
      f.storage.promptPackHumanReviewsV2,
      f.storage.promptPackScores,
    ])
      expect(owner.listByRun).toHaveBeenCalledExactlyOnceWith("older", 1);
    expect(f.providers.createChatCompletion).not.toHaveBeenCalled();
    expect(f.providers.agentSendChatMessage).not.toHaveBeenCalled();
    expect(f.providers.createChatSession).not.toHaveBeenCalled();
  });
  it("retains unchanged generation policy for historical scoring evidence", async () => {
    const f = fixture();
    f.storage.promptPackAutoScoresV2.listByRun.mockResolvedValue([{ ...f.score, policyHash: "stale-policy" }]);
    expect((await f.service.getPromptPackReport("pack-1", { runId: "older" })).focusedRun?.assessment).toMatchObject({
      currentGeneration: false,
      effectiveVerdict: undefined,
      humanReview: f.review,
    });
  });
  it.each(["missing", "foreign-pack", "foreign-session", "foreign-test", "absent-run", "absent-test"])(
    "never substitutes latest for %s",
    async (mode) => {
      const f = fixture();
      if (mode === "missing") f.storage.promptPackRuns.get.mockRejectedValue(new Error("Requested run missing"));
      if (mode === "absent-run") f.storage.promptPackRuns.get.mockResolvedValue(undefined as never);
      if (mode === "absent-test") f.storage.promptPacks.getTest.mockResolvedValue(undefined as never);
      if (mode === "foreign-pack") f.storage.promptPackRuns.get.mockResolvedValue({ ...f.older, packId: "foreign" });
      if (mode === "foreign-test") f.storage.promptPacks.getTest.mockResolvedValue({ ...f.test, packId: "foreign" });
      await expect(
        f.service.getPromptPackReport("pack-1", {
          runId: "older",
          ...(mode === "foreign-session" ? { sessionId: "different" } : {}),
        }),
      ).rejects.toThrow(/Requested run/);
      for (const owner of [
        f.storage.promptPackAutoScoresV2,
        f.storage.promptPackHumanReviewsV2,
        f.storage.promptPackScores,
      ])
        expect(owner.listByRun).not.toHaveBeenCalled();
      expect(f.providers.createChatCompletion).not.toHaveBeenCalled();
    },
  );
});

describe("canonical focused report through the Gateway route facade", () => {
  it("keeps default reads and returns the exact older run through real route, facade and report owners", async () => {
    const f = fixture(),
      app = Fastify();
    app.decorate("services", { promptPacks: new PromptPacksRouteService(f.service) } as never);
    await app.register(promptPackRoutes);
    try {
      const normal = await app.inject({ method: "GET", url: "/api/v1/prompt-packs/pack-1/report" });
      expect(normal.statusCode).toBe(200);
      expect(normal.json()).not.toHaveProperty("focusedRun");
      expect(normal.json().runs).toEqual([f.newer]);
      expect(f.storage.promptPackRuns.get).not.toHaveBeenCalled();
      expect(f.older.sessionId).toBe("sess-older");
      const selected = await app.inject({
        method: "GET",
        url: "/api/v1/prompt-packs/pack-1/report?runId=older&sessionId=" + encodeURIComponent("sess-older"),
      });
      expect(selected.statusCode).toBe(200);
      const { focusedRun, ...retained } = selected.json();
      expect(retained).toEqual(normal.json());
      expect(focusedRun).toMatchObject({
        run: f.older,
        test: f.test,
        assessment: { runId: "older", testId: "test-1", currentGeneration: true, effectiveVerdict: "pass" },
      });
      expect(f.storage.promptPackRuns.get).toHaveBeenCalledExactlyOnceWith("older");
      for (const owner of [
        f.storage.promptPackAutoScoresV2,
        f.storage.promptPackHumanReviewsV2,
        f.storage.promptPackScores,
      ])
        expect(owner.listByRun).toHaveBeenCalledExactlyOnceWith("older", 1);
      expect(f.providers.createChatCompletion).not.toHaveBeenCalled();
      expect(f.providers.agentSendChatMessage).not.toHaveBeenCalled();
      expect(f.providers.createChatSession).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("returns existing 404 through the real facade for a missing focused run without latest substitution", async () => {
    const f = fixture(),
      app = Fastify();
    f.storage.promptPackRuns.get.mockResolvedValue(undefined as never);
    app.decorate("services", { promptPacks: new PromptPacksRouteService(f.service) } as never);
    await app.register(promptPackRoutes);
    try {
      const result = await app.inject({ method: "GET", url: "/api/v1/prompt-packs/pack-1/report?runId=missing" });
      expect(result.statusCode).toBe(404);
      expect(result.json()).not.toHaveProperty("focusedRun");
      expect(f.storage.promptPackRuns.get).toHaveBeenCalledExactlyOnceWith("missing");
      for (const owner of [
        f.storage.promptPackAutoScoresV2,
        f.storage.promptPackHumanReviewsV2,
        f.storage.promptPackScores,
      ])
        expect(owner.listByRun).not.toHaveBeenCalled();
      expect(f.providers.createChatCompletion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
