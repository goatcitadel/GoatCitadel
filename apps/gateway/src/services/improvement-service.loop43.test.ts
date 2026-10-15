import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalAsyncStorage, Storage } from "@goatcitadel/storage";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
} from "./improvement-service.js";
import {
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
} from "./improvement-tune-reads.js";
import { IMPROVEMENT_WEEKLY_JOB_ID } from "./gateway/cron-job-ids.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  published: Array<{ channel: string; topic: string; payload: Record<string, unknown> }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService loop43 weekly scheduler behavior", () => {
  it("keeps scheduled model evaluation opt-in while local signal collection can run independently", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-17T09:30:00.000Z") });
    const harness = await createHarness((flag) => flag === "improvementLocalObservationV1Enabled");
    await harness.service.ensureWeeklyImprovementCronJob();
    const created = harness.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    harness.storage.cronJobs.upsert({ ...created!, enabled: true }, new Date().toISOString());

    await harness.service.recordFocusedToolFailureSignal({
      workspaceId: "workspace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      toolName: "fs.read",
      failureClass: "tool_error",
      operationPhase: "execute",
    });
    await expect(harness.service.runWeeklyImprovementSchedulerIfDue()).resolves.toEqual({
      status: "skipped",
      reason: "improvement_model_evaluation_disabled",
    });

    expect(await harness.service.listImprovementSignals(5, "workspace-1")).toHaveLength(1);
    expect(await harness.service.listDecisionReplayRuns(5)).toEqual([]);
  });

  it("does not run replay work without an enabled weekly cron job or outside the scheduled window", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-15T17:00:00.000Z") });
    const harness = await createHarness();

    await expect(harness.service.runWeeklyImprovementSchedulerIfDue({ force: true })).resolves.toEqual({
      status: "skipped",
      reason: "job_disabled",
    });
    expect(await harness.service.listDecisionReplayRuns(5)).toEqual([]);

    await harness.service.ensureWeeklyImprovementCronJob();
    const enabledJob = harness.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    expect(enabledJob).toBeDefined();
    harness.storage.cronJobs.upsert(
      {
        ...enabledJob!,
        enabled: false,
      },
      new Date().toISOString(),
    );

    await expect(harness.service.runWeeklyImprovementSchedulerIfDue({ force: true })).resolves.toEqual({
      status: "skipped",
      reason: "job_disabled",
    });
    expect(await harness.service.listDecisionReplayRuns(5)).toEqual([]);

    harness.storage.cronJobs.upsert(
      {
        ...enabledJob!,
        enabled: true,
      },
      new Date().toISOString(),
    );
    await expect(harness.service.runWeeklyImprovementSchedulerIfDue()).resolves.toEqual({
      status: "skipped",
      reason: "not_due",
    });

    expect(await harness.service.listDecisionReplayRuns(5)).toEqual([]);
    expect(harness.published).toEqual([]);
  });

  it("seeds the weekly job in the host timezone and opens its Sunday 02:00 window there", async () => {
    // Spy before faking timers: fake timers swap Intl.DateTimeFormat for a wrapper around the native one.
    const actualResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (this: Intl.DateTimeFormat) {
      return { ...actualResolvedOptions.call(this), timeZone: "UTC" };
    });
    vi.useFakeTimers({ now: new Date("2026-05-17T02:30:00.000Z") }); // Sunday in UTC, Saturday in Pacific time
    const harness = await createHarness();
    await harness.service.ensureWeeklyImprovementCronJob();
    const created = harness.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    expect(created?.schedule).toBe("0 2 * * 0 UTC");
    harness.storage.cronJobs.upsert({ ...created!, enabled: true }, new Date().toISOString());

    await harness.service.runWeeklyImprovementSchedulerIfDue();

    const runs = await harness.service.listDecisionReplayRuns(5);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ triggerMode: "scheduled", status: "completed" });
  });

  it("runs a forced weekly replay audit, persists the report, and advances the cron watermark", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-17T09:30:00.000Z") });
    const harness = await createHarness();
    await harness.service.ensureWeeklyImprovementCronJob();
    // First-run default is disabled (codex finding #27). Opt the operator in
    // before forcing the run, since the scheduler skips disabled jobs even
    // when force=true (matches the first loop43 test in this file).
    const created = harness.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    harness.storage.cronJobs.upsert({ ...created!, enabled: true }, new Date().toISOString());

    await expect(harness.service.runWeeklyImprovementSchedulerIfDue({ force: true })).resolves.toMatchObject({
      status: "completed",
      summary: { replayStatus: "completed", totalCandidates: 0, reportId: expect.any(String) },
    });

    const [run] = await harness.service.listDecisionReplayRuns(5);
    expect(run).toMatchObject({
      triggerMode: "manual",
      sampleSize: 500,
      status: "completed",
      totalCandidates: 0,
      totalScored: 0,
      likelyWrongCount: 0,
      modelJudgedCount: 0,
    });
    expect(run?.reportId).toBeDefined();

    const [report] = await harness.service.listImprovementReports(5);
    expect(report).toMatchObject({
      reportId: run?.reportId,
      runId: run?.runId,
      summary: expect.objectContaining({
        sampledDecisions: 0,
        likelyWrongCount: 0,
        wrongnessRate: 0,
      }),
      topFindings: [],
      appliedAutoTunes: [],
      queuedRecommendations: [],
    });

    const cronJob = harness.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    expect(cronJob).toMatchObject({
      lastRunAt: "2026-05-17T09:30:00.000Z",
      nextRunAt: "2026-05-24T09:30:00.000Z",
    });
    expect(harness.storage.systemSettings.get<string>("improvement_weekly_last_week_key_v1")?.value).toBeDefined();
    expect(harness.published.map((event) => event.channel)).toEqual([
      "improvement_replay_started",
      "improvement_replay_completed",
    ]);
    expect(harness.published[1]?.payload).toMatchObject({
      runId: run?.runId,
      reportId: report?.reportId,
      sampledDecisions: 0,
      likelyWrongCount: 0,
      appliedAutoTunes: 0,
      queuedRecommendations: 0,
    });
  });
});

async function createHarness(
  featureEnabled: (flag: keyof import("./gateway/runtime-settings.js").RuntimeSettings["features"]) => boolean = () =>
    true,
): Promise<Harness> {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-loop43-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(rootDir, "gateway.sqlite"),
    transcriptsDir,
    auditDir,
  });
  const published: Harness["published"] = [];
  const ctx: ImprovementServiceContext = {
    storage: createLocalAsyncStorage(storage),
    cronSpecOwner: {
      reconcileSpec: async (cronSpec) => storage.cronJobs.reconcileSpec(cronSpec),
    },
    gatewaySql: storage.gatewaySql,
    publishRealtime: async (channel, topic, payload) => {
      published.push({ channel, topic, payload });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: async (flag) => featureEnabled(flag),
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readEffectiveBlockerTemplateStrictness: () => readBlockerTemplateStrictness(storage.systemSettings),
    readEffectiveRetryRepairThreshold: () => readRetryRepairThreshold(storage.systemSettings),
    readEffectiveLiveIntentThreshold: () => readLiveIntentThreshold(storage.systemSettings),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;
  const service = new ImprovementService(ctx, callbacks);
  await service.initialize();
  const harness = {
    rootDir,
    storage,
    service,
    published,
  };
  harnesses.push(harness);
  return harness;
}
