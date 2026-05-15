import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { ImprovementRef } from "@goatcitadel/contracts";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
import type { ServiceContext } from "./service-context.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  routingPolicies: Record<string, unknown>;
  repairPolicies: Record<string, unknown>;
  published: Array<{ eventType: string; source: string; payload: Record<string, unknown> }>;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService runtime coverage", () => {
  it("applies and reverts low-risk decision auto-tunes while rejecting unsafe states", () => {
    const harness = createHarness();
    insertDecisionReplayRun(harness, "run-autotune");
    insertDecisionAutoTune(harness, {
      tuneId: "tune-low-risk",
      riskLevel: "low",
      status: "queued",
      patch: { settingKey: "routing.weight.provider_balance", nextValue: 0.72 },
      snapshot: { settingKey: "routing.weight.provider_balance", previousValue: 0.5 },
    });
    insertDecisionAutoTune(harness, {
      tuneId: "tune-medium-risk",
      riskLevel: "medium",
      status: "queued",
      patch: { settingKey: "routing.weight.context", nextValue: 0.4 },
      snapshot: { settingKey: "routing.weight.context", previousValue: 0.2 },
    });
    insertDecisionAutoTune(harness, {
      tuneId: "tune-failed",
      riskLevel: "low",
      status: "failed",
      patch: { settingKey: "routing.weight.failed", nextValue: 0.1 },
      snapshot: { settingKey: "routing.weight.failed", previousValue: 0 },
    });

    expect(harness.service.approveDecisionAutoTune("tune-low-risk").status).toBe("applied");
    expect(harness.storage.systemSettings.get<number>("routing.weight.provider_balance")?.value).toBe(0.72);
    expect(harness.service.approveDecisionAutoTune("tune-low-risk").status).toBe("applied");
    expect(harness.service.revertDecisionAutoTune("tune-low-risk").status).toBe("reverted");
    expect(harness.storage.systemSettings.get<number>("routing.weight.provider_balance")?.value).toBe(0.5);

    expect(harness.published.some((event) => event.eventType === "improvement_autotune_applied")).toBe(true);
    expect(harness.published.some((event) => event.eventType === "improvement_autotune_reverted")).toBe(true);
    expect(() => harness.service.approveDecisionAutoTune("tune-medium-risk")).toThrow(/manual code review/);
    expect(() => harness.service.approveDecisionAutoTune("tune-failed")).toThrow(/cannot be approved/);
    expect(() => harness.service.revertDecisionAutoTune("tune-medium-risk")).toThrow(/cannot be reverted/);
  });

  it("creates replay override drafts and exposes completed diff summaries against the storage schema", () => {
    const harness = createHarness();

    const draft = harness.service.createReplayOverrideDraft("source-run-1", [
      {
        stepKey: "  route-step  ",
        overrideKind: "policy_decision",
        override: { nextRoute: "researcher" },
      },
      {
        stepKey: "",
        overrideKind: "prompt_patch",
        override: { prompt: "ignored" },
      },
    ]);
    const completed = harness.service.executeReplayOverride("source-run-1", [
      {
        stepKey: "tool-step",
        overrideKind: "tool_output",
        override: { stdout: "deterministic fake output" },
      },
    ]);
    const summary = harness.service.getReplayDiffSummary(completed.replayRunId);

    expect(draft.status).toBe("draft");
    expect(draft.overrides.map((override) => override.stepKey)).toEqual(["route-step"]);
    expect(completed.status).toBe("completed");
    expect(summary.status).toBe("completed");
    expect(summary.summary).toMatchObject({ errorChanged: false, costUsdDelta: 0 });
    expect(
      harness.published.some(
        (event) => event.eventType === "system" && event.payload.type === "replay_override_completed",
      ),
    ).toBe(true);
    expect(() => harness.service.getReplayDiffSummary("missing-replay")).toThrow(/not found/);
  });

  it("deduplicates capability gaps and validates repair candidates through runtime storage", () => {
    const harness = createHarness();

    const first = harness.service.recordCapabilityGapEvent({
      sessionId: "sess-gap",
      causeClass: "tool_exists_but_not_in_profile",
      requestedTool: "web.search",
      toolProfile: "chat",
      providerId: "openai",
      configArea: "toolPolicy",
      recoveryOptions: ["switch_tool_profile", "retry_once", "invalid-option" as never],
      confidence: 0.4,
    });
    const second = harness.service.recordCapabilityGapEvent({
      sessionId: "sess-gap",
      causeClass: "tool_exists_but_not_in_profile",
      requestedTool: "web.search",
      toolProfile: "chat",
      providerId: "openai",
      configArea: "toolPolicy",
      recoveryOptions: ["request_approval"],
      confidence: 0.8,
    });

    expect(first.repeatCount).toBe(1);
    expect(first.recoveryOptions).toEqual(["switch_tool_profile", "retry_once"]);
    expect(second.repeatCount).toBe(2);
    expect(second.confidence).toBe(0.8);
    expect(second.repairCandidateId).toBeDefined();
    expect(harness.service.listCapabilityGapEvents(10).map((event) => event.eventId)).toContain(second.eventId);

    const [candidate] = harness.service.listRepairCandidates(10);
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      causeClass: "tool_exists_but_not_in_profile",
      eventCount: 2,
      validationStatus: "not_started",
    });
    expect(candidate?.suggestedPatch).toContain("web.search");

    expect(
      harness.service.updateRepairCandidateValidation(candidate!.candidateId, {
        status: "unexpected" as never,
        summary: "invalid statuses normalize",
      }),
    ).toMatchObject({
      validationStatus: "not_started",
      validationSummary: "invalid statuses normalize",
    });
    expect(
      harness.service.updateRepairCandidateValidation(candidate!.candidateId, {
        status: "passed",
        summary: "validated by replay",
      }),
    ).toMatchObject({
      validationStatus: "passed",
      validationSummary: "validated by replay",
    });
    expect(() =>
      harness.service.updateRepairCandidateValidation("missing-candidate", {
        status: "passed",
      }),
    ).toThrow(/Repair candidate not found/);
  });

  it("recovers interrupted replay runs and reads prompt-lab improvement signals", () => {
    const harness = createHarness();

    harness.service.startScheduler();
    harness.service.startScheduler();
    harness.service.stopScheduler();
    harness.service.stopScheduler();
    harness.service.ensureWeeklyImprovementCronJob();
    expect(harness.storage.cronJobs.get("improvement_weekly")).toMatchObject({
      enabled: true,
      schedule: "0 2 * * 0 America/Los_Angeles",
    });

    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO decision_replay_runs (
          run_id, trigger_mode, sample_size, window_start, window_end, status,
          report_id, total_candidates, total_scored, likely_wrong_count, model_judged_count,
          error_text, started_at, finished_at
        ) VALUES (
          'run-interrupted', 'scheduled', 500, '2026-05-03T00:00:00.000Z',
          '2026-05-10T00:00:00.000Z', 'running', NULL, 3, 1, 1, 0,
          NULL, '2026-05-10T02:00:00.000Z', NULL
        )
      `,
      )
      .run();

    harness.service.markInterruptedDecisionReplayRuns();
    const [run] = harness.service.listDecisionReplayRuns(5);
    expect(run).toMatchObject({
      runId: "run-interrupted",
      status: "failed",
    });
    expect(run?.error).toMatch(/Replay interrupted/);
    expect(harness.published.some((event) => event.eventType === "system" && event.payload.recoveredCount === 1)).toBe(
      true,
    );

    const signal = harness.service.recordPromptLabRegressionCompletionSignal({
      regressionRunId: "regression-signal-read",
      packId: "pack-routing",
      capability: "provider-balance",
      scoreDelta: -0.6,
      passDelta: -0.2,
      latencyDeltaMs: 35,
    });

    expect(signal).toBeDefined();
    expect(harness.service.getImprovementSignal(signal!.signalId).signalId).toBe(signal!.signalId);
    expect(
      harness.service.listImprovementSignals(10, "prompt-lab").some((item) => item.signalId === signal!.signalId),
    ).toBe(true);
    expect(harness.service.listImprovementCandidates(10, "prompt-lab").length).toBeGreaterThanOrEqual(1);
    expect(() => harness.service.getImprovementSignal("missing-signal")).toThrow(/Improvement signal not found/);
  });

  it("enriches weekly reports with routing gaps, strategy tags, proposals, and specialists", () => {
    const harness = createHarness();
    const runId = "run-report-enrichment";
    const reportId = "report-enrichment";
    const createdAt = "2026-05-10T03:00:00.000Z";
    const finding = {
      findingId: "finding-context",
      runId,
      fingerprint: "retrieval:miss",
      causeClass: "retrieval_miss",
      clusterKey: "retrieval",
      severity: "high",
      recurrenceCount: 3,
      impactedSessions: 2,
      impactedTurns: 2,
      avgWrongness: 0.82,
      title: "Context evidence missing",
      summary: "Runs missed required context evidence.",
      recommendation: "Add a context recovery checklist.",
      isDuplicate: false,
      createdAt,
    };

    harness.service.recordCapabilityGapEvent({
      sessionId: "sess-gap-report",
      causeClass: "tool_exists_but_not_in_profile",
      requestedTool: "browser.search",
      toolProfile: "chat",
      providerId: "openai",
      configArea: "toolPolicy",
      recoveryOptions: ["switch_tool_profile"],
      confidence: 0.9,
    });
    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO decision_replay_runs (
          run_id, trigger_mode, sample_size, window_start, window_end, status,
          report_id, total_candidates, total_scored, likely_wrong_count, model_judged_count,
          error_text, started_at, finished_at
        ) VALUES (
          @runId, 'manual', 50, '2026-05-01T00:00:00.000Z', '2026-05-10T00:00:00.000Z',
          'completed', @reportId, 10, 8, 3, 1, NULL, @createdAt, @createdAt
        )
      `,
      )
      .run({ runId, reportId, createdAt });
    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_reports (
          report_id, run_id, week_start, week_end, summary_json, top_findings_json,
          applied_tunes_json, queued_tunes_json, week_over_week_json, previous_report_id, created_at
        ) VALUES (
          @reportId, @runId, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z',
          @summaryJson, @topFindingsJson, '[]', '[]', @weekOverWeekJson, NULL, @createdAt
        )
      `,
      )
      .run({
        reportId,
        runId,
        summaryJson: JSON.stringify({
          sampledDecisions: 10,
          likelyWrongCount: 3,
          wrongnessRate: 0.3,
          topCauseClasses: [{ causeClass: "retrieval_miss", count: 3 }],
          duplicateSuppressedCount: 0,
          improvedCount: 1,
          regressedCount: 2,
        }),
        topFindingsJson: JSON.stringify([finding]),
        weekOverWeekJson: JSON.stringify({ improved: ["routing"], regressed: ["context"], unchanged: [] }),
        createdAt,
      });

    const report = harness.service.getImprovementReport(reportId);

    expect(report.routingGapSummary?.totalEvents).toBe(1);
    expect(report.routingGapSummary?.topRequestedTools).toEqual(["browser.search"]);
    expect(report.specialistCandidateSuggestions?.some((item) => item.title === "Routing Harness Specialist")).toBe(
      true,
    );
    expect(report.specialistCandidateSuggestions?.some((item) => item.title === "Context Recovery Specialist")).toBe(
      true,
    );
    expect(report.proposalDrafts?.some((item) => item.kind === "routing_rule")).toBe(true);
    expect(report.proposalDrafts?.some((item) => item.kind === "playbook")).toBe(true);
    expect(report.strategyTags?.some((item) => item.tag === "repair")).toBe(true);
    expect(harness.service.listImprovementReports(10)[0]?.reportId).toBe(reportId);
    expect(harness.service.getDecisionReplayRun(runId).report?.reportId).toBe(reportId);
    expect(() => harness.service.getImprovementReport("missing-report")).toThrow(/not found/);
  });

  it("records agentic diagnostics as idempotent governed improvement evidence", () => {
    const harness = createHarness();
    const task = harness.storage.tasks.create({
      workspaceId: "default",
      title: "Agentic run with timeout",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "run-agentic-timeout",
        durableRunId: "durable-agentic-1",
        parentSessionId: "sess-agentic-1",
        surface: "cowork",
        status: "running",
        failureClass: "timeout",
        profileId: "researcher",
      },
    });
    const diagnostic = {
      signalId: "diag-agentic-timeout",
      code: "child_timeout",
      severity: "critical",
      title: "Child agent exceeded timeout",
      summary: "A child agent is still active after timeout.",
      evidenceRef: "child-session-1",
      createdAt: "2026-05-05T12:00:00.000Z",
    } as const;

    const signal = harness.service.recordAgenticDiagnosticSignal({ task, diagnostic });
    const replay = harness.service.recordAgenticDiagnosticSignal({ task, diagnostic });

    expect(signal).toBeDefined();
    expect(replay?.signalId).toBe(signal?.signalId);
    expect(signal).toMatchObject({
      sourceService: "task-lifecycle-service",
      sourceType: "agentic_diagnostic",
      sourceId: diagnostic.signalId,
      sourceEventId: `${task.taskId}:${diagnostic.signalId}`,
      signalKind: "agentic_child_timeout",
      outcome: "negative",
      severity: "high",
      taskId: task.taskId,
      sessionId: "sess-agentic-1",
      durableRunId: "durable-agentic-1",
    });
    expect(signal?.evidenceRefs[0]).toMatchObject({
      refType: "agentic_diagnostic",
      refId: diagnostic.signalId,
    });
    expect(signal?.metadata).toMatchObject({
      diagnosticCode: "child_timeout",
      runId: "run-agentic-timeout",
    });
  });

  it("persists agentic bridge proposals as review-first candidates without applying mutations", async () => {
    const harness = createHarness();

    const [result] = harness.service.recordAgenticImprovementProposals(
      {
        missingCapabilities: [
          {
            capability: {
              capabilityId: "provider:anthropic",
              label: "Anthropic",
              family: "provider",
              status: "blocked",
              callable: false,
              reasons: ["API key missing"],
              checkedAt: "2026-05-05T12:00:00.000Z",
            },
            requestedBy: "cowork route preflight",
          },
        ],
      },
      { workspaceId: "default" },
    );

    expect(result?.signal).toBeDefined();
    expect(result?.candidate).toMatchObject({
      kind: "routing_policy",
      status: "ready_for_approval",
    });
    expect(result?.signal).toMatchObject({
      signalKind: "agentic_improvement_proposal",
      outcome: "negative",
    });
    expect(result?.signal.metadata?.mutationApplied).toBe(false);

    const detail = harness.service.getImprovementCandidateDetail(result!.candidate!.candidateId);
    expect(detail.currentRevision?.candidateRef.metadata?.mutationApplied).toBe(false);
    expect(
      (detail.currentRevision?.candidateRef.metadata?.proposedChange as { mutationApplied?: boolean } | undefined)
        ?.mutationApplied,
    ).toBe(false);
    expect(detail.latestEvaluation?.status).toBe("passed");

    const activation = await harness.service.requestImprovementActivation(result!.candidate!.candidateId, "operator-1");
    expect(activation.status).toBe("pending");
    expect(harness.routingPolicies).toEqual({});
  });
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-runtime-"));
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
  const repairPolicies: Record<string, unknown> = {};
  const routingPolicies: Record<string, unknown> = {};
  const ctx: ServiceContext = {
    storage,
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: (eventType, source, payload) => {
      published.push({ eventType, source, payload });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks: ImprovementServiceCallbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn((targetKey) =>
      createPolicySnapshot("repair_policy_snapshot", targetKey, repairPolicies),
    ),
    applyRepairPolicyCandidate: vi.fn((targetKey, revisionRef) =>
      applyPolicyCandidate("repair_policy_config", targetKey, revisionRef, repairPolicies),
    ),
    restoreRepairPolicySnapshot: vi.fn((snapshotRef) => {
      restorePolicySnapshot(snapshotRef, repairPolicies);
    }),
    captureRoutingPolicySnapshot: vi.fn((targetKey) =>
      createPolicySnapshot("routing_policy_snapshot", targetKey, routingPolicies),
    ),
    applyRoutingPolicyCandidate: vi.fn((targetKey, revisionRef) =>
      applyPolicyCandidate("routing_policy_config", targetKey, revisionRef, routingPolicies),
    ),
    restoreRoutingPolicySnapshot: vi.fn((snapshotRef) => {
      restorePolicySnapshot(snapshotRef, routingPolicies);
    }),
    createChatCompletion: vi.fn(),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;

  const service = new ImprovementService(ctx, callbacks);
  const harness = { rootDir, storage, service, routingPolicies, repairPolicies, published };
  harnesses.push(harness);
  return harness;
}

function createPolicySnapshot(
  refType: ImprovementRef["refType"],
  targetKey: string,
  policies: Record<string, unknown>,
): ImprovementRef {
  const hadValue = Object.prototype.hasOwnProperty.call(policies, targetKey);
  return {
    refType,
    refId: targetKey,
    metadata: {
      targetKey,
      hadValue,
      previousValue: hadValue ? policies[targetKey] : null,
    },
  };
}

function applyPolicyCandidate(
  refType: ImprovementRef["refType"],
  targetKey: string,
  revisionRef: ImprovementRef,
  policies: Record<string, unknown>,
): ImprovementRef {
  const proposedChange =
    revisionRef.metadata && typeof revisionRef.metadata === "object" && "proposedChange" in revisionRef.metadata
      ? (revisionRef.metadata as { proposedChange?: unknown }).proposedChange
      : revisionRef.metadata;
  policies[targetKey] = proposedChange ?? {};
  return {
    refType,
    refId: targetKey,
    metadata: {
      targetKey,
      appliedValue: policies[targetKey],
    },
  };
}

function restorePolicySnapshot(snapshotRef: ImprovementRef, policies: Record<string, unknown>): void {
  const metadata = snapshotRef.metadata as
    | { targetKey?: string; hadValue?: boolean; previousValue?: unknown }
    | undefined;
  const targetKey = metadata?.targetKey ?? snapshotRef.refId;
  if (metadata?.hadValue) {
    policies[targetKey] = metadata.previousValue;
    return;
  }
  delete policies[targetKey];
}

function insertDecisionReplayRun(harness: Harness, runId: string): void {
  harness.storage.gatewaySql
    .prepare(
      `
        INSERT INTO decision_replay_runs (
          run_id, trigger_mode, sample_size, window_start, window_end, status,
          report_id, total_candidates, total_scored, likely_wrong_count, model_judged_count,
          error_text, started_at, finished_at
        ) VALUES (
          @runId, 'manual', 50, '2026-05-01T00:00:00.000Z', '2026-05-10T00:00:00.000Z',
          'completed', NULL, 0, 0, 0, 0, NULL, '2026-05-10T03:00:00.000Z',
          '2026-05-10T03:00:00.000Z'
        )
      `,
    )
    .run({ runId });
}

function insertDecisionAutoTune(
  harness: Harness,
  input: {
    tuneId: string;
    riskLevel: "low" | "medium" | "high";
    status: "queued" | "applied" | "failed" | "reverted";
    patch: Record<string, unknown>;
    snapshot?: Record<string, unknown>;
  },
): void {
  harness.storage.gatewaySql
    .prepare(
      `
        INSERT INTO decision_autotunes (
          tune_id, run_id, finding_id, tune_class, risk_level, status, description,
          patch_json, snapshot_json, result_json, created_at, applied_at, reverted_at
        ) VALUES (
          @tuneId, 'run-autotune', NULL, 'ranking_weight', @riskLevel, @status,
          'operator coverage auto tune', @patchJson, @snapshotJson, NULL,
          '2026-05-10T03:00:00.000Z', NULL, NULL
        )
      `,
    )
    .run({
      tuneId: input.tuneId,
      riskLevel: input.riskLevel,
      status: input.status,
      patchJson: JSON.stringify(input.patch),
      snapshotJson: input.snapshot ? JSON.stringify(input.snapshot) : null,
    });
}
