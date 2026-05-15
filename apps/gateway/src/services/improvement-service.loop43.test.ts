import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import {
  ImprovementService,
  type ImprovementServiceCallbacks,
  type ImprovementServiceContext,
} from "./improvement-service.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  published: Array<{ channel: string; topic: string; payload: Record<string, unknown> }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService loop43 weekly scheduler behavior", () => {
  it("does not run replay work without an enabled weekly cron job or outside the scheduled window", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-15T17:00:00.000Z") });
    const harness = createHarness();

    await harness.service.runWeeklyImprovementSchedulerIfDue({ force: true });
    expect(harness.service.listDecisionReplayRuns(5)).toEqual([]);

    harness.service.ensureWeeklyImprovementCronJob();
    const enabledJob = harness.storage.cronJobs.get("improvement_weekly");
    expect(enabledJob).toBeDefined();
    harness.storage.cronJobs.upsert(
      {
        ...enabledJob!,
        enabled: false,
      },
      new Date().toISOString(),
    );

    await harness.service.runWeeklyImprovementSchedulerIfDue({ force: true });
    expect(harness.service.listDecisionReplayRuns(5)).toEqual([]);

    harness.storage.cronJobs.upsert(
      {
        ...enabledJob!,
        enabled: true,
      },
      new Date().toISOString(),
    );
    await harness.service.runWeeklyImprovementSchedulerIfDue();

    expect(harness.service.listDecisionReplayRuns(5)).toEqual([]);
    expect(harness.published).toEqual([]);
  });

  it("runs a forced weekly replay audit, persists the report, and advances the cron watermark", async () => {
    vi.useFakeTimers({ now: new Date("2026-05-17T09:30:00.000Z") });
    const harness = createHarness();
    harness.service.ensureWeeklyImprovementCronJob();

    await harness.service.runWeeklyImprovementSchedulerIfDue({ force: true });

    const [run] = harness.service.listDecisionReplayRuns(5);
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

    const [report] = harness.service.listImprovementReports(5);
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

    const cronJob = harness.storage.cronJobs.get("improvement_weekly");
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

function createHarness(): Harness {
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
    storage,
    gatewaySql: storage.gatewaySql,
    publishRealtime: (channel, topic, payload) => {
      published.push({ channel, topic, payload });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
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
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;
  const harness = {
    rootDir,
    storage,
    service: new ImprovementService(ctx, callbacks),
    published,
  };
  harnesses.push(harness);
  return harness;
}
