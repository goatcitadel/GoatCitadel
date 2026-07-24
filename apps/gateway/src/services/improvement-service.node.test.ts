import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "@goatcitadel/storage";
import type { ApprovalResolveInput, ImprovementRef } from "@goatcitadel/contracts";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
import {
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
} from "./improvement-tune-reads.js";
import { IMPROVEMENT_WEEKLY_JOB_ID } from "./gateway/cron-job-ids.js";
import type { ServiceContext } from "./service-context.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  routingPolicies: Record<string, unknown>;
  repairPolicies: Record<string, unknown>;
  published: Array<{ eventType: string; source: string; payload: Record<string, unknown> }>;
  state: {
    failRoutingRestore: boolean;
    failRepairRestore: boolean;
  };
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    try {
      harness.storage.close();
    } catch {
      // ignore cleanup failures in tests
    }
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService ledger lifecycle", () => {
  it("applies a pending activation immediately when approval resolves approved", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");

    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    const applied = harness.service.handleActivationApprovalResolution(approval);

    assert.equal(applied?.status, "active");
    assert.equal(applied?.watchStatus, "watching");
    assert.ok(harness.routingPolicies[candidate.targetKey]);
  });

  it("rejects pending activations through approval resolution and suppresses the fingerprint", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");

    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "reject",
      resolvedBy: "operator-1",
    });
    const failed = harness.service.handleActivationApprovalResolution(approval);
    const detail = harness.service.getImprovementCandidateDetail(candidate.candidateId);

    assert.equal(failed?.status, "failed");
    assert.equal(detail.candidate.status, "rejected");
    assert.ok(detail.candidate.suppressionUntil);
  });

  it("fails a drifted activation instead of applying the stale revision", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");
    const detail = harness.service.getImprovementCandidateDetail(candidate.candidateId);
    const currentRevision = detail.currentRevision;
    assert.ok(currentRevision);

    const driftRevisionId = randomUUID();
    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO improvement_candidate_revisions (
          revision_id, candidate_id, candidate_ref_json, change_hash, created_at,
          created_by_actor_id, created_by_actor_type
        ) VALUES (
          @revisionId, @candidateId, @candidateRefJson, @changeHash, @createdAt,
          'system', 'system'
        )
      `,
      )
      .run({
        revisionId: driftRevisionId,
        candidateId: candidate.candidateId,
        candidateRefJson: JSON.stringify({
          refType: "artifact_manifest",
          refId: `routing_policy:${candidate.targetKey}`,
          metadata: {
            proposedChange: {
              strategy: "route_rebalance",
              targetKey: candidate.targetKey,
              causeClass: "different-capability",
            },
          },
        } satisfies ImprovementRef),
        changeHash: `drift-${driftRevisionId}`,
        createdAt: new Date().toISOString(),
      });
    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE improvement_candidates
        SET current_revision_id = @revisionId,
            updated_at = @updatedAt
        WHERE candidate_id = @candidateId
      `,
      )
      .run({
        revisionId: driftRevisionId,
        updatedAt: new Date().toISOString(),
        candidateId: candidate.candidateId,
      });

    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    const failed = harness.service.handleActivationApprovalResolution(approval);
    const updated = harness.service.getImprovementCandidateDetail(candidate.candidateId);

    assert.equal(failed?.status, "failed");
    assert.equal(updated.candidate.status, "evaluating");
    assert.equal(harness.routingPolicies[candidate.targetKey], undefined);
  });

  it("marks an activation stable after 20 qualifying watch-window signals", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");
    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    harness.service.handleActivationApprovalResolution(approval);

    for (let index = 0; index < 20; index += 1) {
      harness.service.recordPromptLabRegressionCompletionSignal({
        regressionRunId: `regression-neutral-${index}`,
        packId: "pack-routing",
        capability: "provider-balance",
        scoreDelta: 0,
        passDelta: 0,
        latencyDeltaMs: 0,
      });
    }

    const stable = harness.service.getImprovementActivation(activation.activationId);
    assert.equal(stable.watchStatus, "stable");
    assert.equal(stable.watchSignalCount, 20);
  });

  it("reconciles active watch windows to stable after the watch deadline expires", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");
    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    harness.service.handleActivationApprovalResolution(approval);
    harness.storage.gatewaySql
      .prepare(
        `
        UPDATE improvement_activations
        SET watch_ends_at = @watchEndsAt
        WHERE activation_id = @activationId
      `,
      )
      .run({
        activationId: activation.activationId,
        watchEndsAt: "2000-01-01T00:00:00.000Z",
      });

    (harness.service as unknown as { reconcileActiveWatchWindows: () => void }).reconcileActiveWatchWindows();

    const stable = harness.service.getImprovementActivation(activation.activationId);
    assert.equal(stable.watchStatus, "stable");
  });

  it("fails the activation when the first watch-window regression cannot restore the snapshot", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");
    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    harness.service.handleActivationApprovalResolution(approval);
    harness.state.failRoutingRestore = true;

    harness.service.recordPromptLabRegressionCompletionSignal({
      regressionRunId: "regression-negative-1",
      packId: "pack-routing",
      capability: "provider-balance",
      scoreDelta: -0.4,
      passDelta: -0.2,
      latencyDeltaMs: 42,
    });

    const failed = harness.service.getImprovementActivation(activation.activationId);
    assert.equal(failed.status, "failed");
    assert.equal(
      harness.published.some((event) => event.eventType === "improvement_activation_pause_failed"),
      true,
    );
  });

  it("never synthesizes candidates from improvement_internal audit signals", () => {
    const harness = createHarness();
    (
      harness.service as unknown as {
        recordImprovementSignal: (input: Record<string, unknown>) => unknown;
      }
    ).recordImprovementSignal({
      sourceService: "improvement-service",
      sourceType: "lifecycle",
      sourceId: "internal-1",
      sourceEventId: "internal-1",
      idempotencyKey: "internal-1",
      workspaceId: "default",
      origin: "improvement_internal",
      signalClass: "runtime",
      signalKind: "activation_failed",
      outcome: "negative",
      fingerprint: "internal-only",
      evidenceRefs: [],
    });

    assert.equal(harness.service.listImprovementCandidates(20).length, 0);
  });

  it("records skill revision candidates as proposal-gated ledger evidence", async () => {
    const harness = createHarness();
    const result = harness.service.recordSkillEvaluationSignal({
      skillId: "planning",
      skillName: "Planning",
      runId: "skill-eval-1",
      accepted: true,
      passRate: 1,
      improvementDelta: 0.4,
      summary: "Improved instruction criteria coverage.",
    });

    assert.ok(result?.signal);
    assert.ok(result.candidate);
    assert.equal(result.candidate.kind, "skill_revision");
    const detail = harness.service.getImprovementCandidateDetail(result.candidate.candidateId);
    assert.equal(detail.candidate.status, "ready_for_approval");
    assert.equal(detail.latestEvaluation?.evaluatorKind, "skill_eval_scorecard");
    assert.equal(detail.currentRevision?.candidateRef.refType, "skill_evaluation_run");
    await assert.rejects(
      () => harness.service.requestImprovementActivation(result.candidate!.candidateId, "operator-1"),
      /capability proposals/,
    );
  });

  it("records agentic diagnostics as idempotent review-first improvement signals", () => {
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

    assert.ok(signal);
    assert.ok(replay);
    assert.equal(replay.signalId, signal.signalId);
    assert.equal(signal.sourceService, "task-lifecycle-service");
    assert.equal(signal.sourceType, "agentic_diagnostic");
    assert.equal(signal.sourceId, diagnostic.signalId);
    assert.equal(signal.sourceEventId, `${task.taskId}:${diagnostic.signalId}`);
    assert.equal(signal.signalKind, "agentic_child_timeout");
    assert.equal(signal.outcome, "negative");
    assert.equal(signal.severity, "high");
    assert.equal(signal.taskId, task.taskId);
    assert.equal(signal.sessionId, "sess-agentic-1");
    assert.equal(signal.durableRunId, "durable-agentic-1");
    assert.equal(signal.evidenceRefs[0]?.refType, "agentic_diagnostic");
    assert.equal(signal.evidenceRefs[0]?.refId, diagnostic.signalId);
    assert.equal(signal.metadata?.diagnosticCode, "child_timeout");
    assert.equal(signal.metadata?.runId, "run-agentic-timeout");
  });

  it("persists agentic bridge proposals as governed candidates with mutationApplied=false", async () => {
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

    assert.ok(result);
    assert.ok(result.signal);
    assert.ok(result.candidate);
    assert.equal(result.candidate.kind, "routing_policy");
    assert.equal(result.candidate.status, "ready_for_approval");
    assert.equal(result.signal.signalKind, "agentic_improvement_proposal");
    assert.equal(result.signal.metadata?.mutationApplied, false);

    const detail = harness.service.getImprovementCandidateDetail(result.candidate.candidateId);
    assert.equal(detail.currentRevision?.candidateRef.metadata?.mutationApplied, false);
    assert.equal(
      (detail.currentRevision?.candidateRef.metadata?.proposedChange as { mutationApplied?: boolean } | undefined)
        ?.mutationApplied,
      false,
    );
    assert.equal(detail.latestEvaluation?.status, "passed");

    const activation = await harness.service.requestImprovementActivation(result.candidate.candidateId, "operator-1");
    assert.equal(activation.status, "pending");
    assert.deepEqual(harness.routingPolicies, {});
  });

  it("keeps review-first skill drift proposals from mutating through direct activation", async () => {
    const harness = createHarness();

    const [result] = harness.service.recordAgenticImprovementProposals({
      skillDrifts: [
        {
          skillId: "safe-self-improvement",
          skillName: "Safe Self Improvement",
          observedIssue: "The skill does not mention review-first proposal ingestion.",
          proposedChange: "Add approval-gated proposal language after evaluation.",
          driftRef: "skills/safe-self-improvement/SKILL.md",
          severity: "high",
        },
      ],
    });

    assert.ok(result?.candidate);
    assert.equal(result.candidate.kind, "skill_revision");
    const detail = harness.service.getImprovementCandidateDetail(result.candidate.candidateId);
    assert.equal(detail.currentRevision?.candidateRef.metadata?.mutationApplied, false);
    await assert.rejects(
      () => harness.service.requestImprovementActivation(result.candidate!.candidateId, "operator-1"),
      /capability proposals/,
    );
  });

  it("deduplicates capability gaps and promotes repeated gaps into repair candidates", () => {
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

    assert.equal(first.repeatCount, 1);
    assert.deepEqual(first.recoveryOptions, ["switch_tool_profile", "retry_once"]);
    assert.equal(second.repeatCount, 2);
    assert.equal(second.confidence, 0.8);
    assert.equal(second.repairCandidateId !== undefined, true);

    const [candidate] = harness.service.listRepairCandidates(10);
    assert.ok(candidate);
    assert.equal(candidate.causeClass, "tool_exists_but_not_in_profile");
    assert.equal(candidate.eventCount, 2);
    assert.equal(candidate.validationStatus, "not_started");
    assert.equal(candidate.suggestedPatch?.includes("web.search"), true);

    const invalidStatus = harness.service.updateRepairCandidateValidation(candidate.candidateId, {
      status: "unexpected" as never,
      summary: "invalid statuses normalize",
    });
    assert.equal(invalidStatus.validationStatus, "not_started");
    assert.equal(invalidStatus.validationSummary, "invalid statuses normalize");

    const passed = harness.service.updateRepairCandidateValidation(candidate.candidateId, {
      status: "passed",
      summary: "validated by replay",
    });
    assert.equal(passed.validationStatus, "passed");
    assert.equal(passed.validationSummary, "validated by replay");
  });

  it("exposes scheduler, replay-run, and signal read paths without mutating disabled jobs", async () => {
    const harness = createHarness();

    harness.service.startScheduler();
    harness.service.startScheduler();
    harness.service.stopScheduler();
    harness.service.stopScheduler();

    await harness.service.ensureWeeklyImprovementCronJob();
    const cronJob = harness.storage.cronJobs.get(IMPROVEMENT_WEEKLY_JOB_ID);
    // First-run default is disabled (codex finding #27): the weekly job ships
    // sampled chat/tool traces to the LLM judge and must not start running
    // until an operator explicitly opts in from Mission Control settings.
    assert.equal(cronJob?.enabled, false);
    assert.equal(cronJob?.schedule, "0 2 * * 0 America/Los_Angeles");

    const startedAt = "2026-05-10T02:00:00.000Z";
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
          NULL, @startedAt, NULL
        )
      `,
      )
      .run({ startedAt });

    harness.service.markInterruptedDecisionReplayRuns();
    const [run] = harness.service.listDecisionReplayRuns(5);

    assert.equal(run.runId, "run-interrupted");
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /Replay interrupted/);
    assert.equal(
      harness.published.some((event) => event.eventType === "system" && event.payload.recoveredCount === 1),
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
    assert.ok(signal);

    assert.equal(harness.service.getImprovementSignal(signal.signalId).signalId, signal.signalId);
    assert.equal(
      harness.service.listImprovementSignals(10, "prompt-lab").some((item) => item.signalId === signal.signalId),
      true,
    );
    assert.equal(harness.service.listImprovementCandidates(10, "prompt-lab").length >= 1, true);
    assert.throws(() => harness.service.getImprovementSignal("missing-signal"), /Improvement signal not found/);
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

    assert.equal(report.routingGapSummary?.totalEvents, 1);
    assert.deepEqual(report.routingGapSummary?.topRequestedTools, ["browser.search"]);
    assert.equal(
      report.specialistCandidateSuggestions?.some((item) => item.title === "Routing Harness Specialist"),
      true,
    );
    assert.equal(
      report.specialistCandidateSuggestions?.some((item) => item.title === "Context Recovery Specialist"),
      true,
    );
    assert.equal(
      report.proposalDrafts?.some((item) => item.kind === "routing_rule"),
      true,
    );
    assert.equal(
      report.proposalDrafts?.some((item) => item.kind === "playbook"),
      true,
    );
    assert.equal(
      report.strategyTags?.some((item) => item.tag === "repair"),
      true,
    );
    assert.equal(harness.service.listImprovementReports(10)[0]?.reportId, reportId);
    assert.equal(harness.service.getDecisionReplayRun(runId).report?.reportId, reportId);
    assert.throws(() => harness.service.getImprovementReport("missing-report"), /not found/);
  });

  it("routes curator lifecycle actions through review-first state transitions", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);

    const validated = harness.service.validateImprovementCandidate(candidate.candidateId, {
      actorId: "qa-operator",
      reason: "ready for approval",
    });
    assert.equal(validated.status, "validated");
    assert.equal(validated.mutationApplied, false);

    const approved = harness.service.approveImprovementCandidate(candidate.candidateId, {
      actorId: "qa-operator",
      reason: "evaluation passed",
    });
    assert.equal(approved.status, "approved");

    assert.throws(() => harness.service.promoteImprovementCandidate(candidate.candidateId), /Promotion is review-only/);

    const activated = await harness.service.activateImprovementCandidate(candidate.candidateId, {
      actorId: "qa-operator",
    });
    assert.equal(activated.status, "approval_pending");
    assert.ok(activated.approvalId);

    const rejectCandidate = createRoutingCandidate(harness.service, "reject");
    const rejected = harness.service.rejectImprovementCandidate(rejectCandidate.candidateId, {
      actorId: "qa-operator",
      reason: "not useful",
    });
    assert.equal(rejected.status, "rejected");

    const snoozeCandidate = createRoutingCandidate(harness.service, "snooze");
    const snoozed = harness.service.snoozeImprovementCandidate(snoozeCandidate.candidateId, {
      actorId: "qa-operator",
      reason: "wait for more evidence",
    });
    assert.equal(snoozed.status, "snoozed");
    assert.ok(snoozed.review.candidate.suppressionUntil);
    assert.equal(
      harness.service.getCuratorReviewItem(snoozeCandidate.candidateId).candidate.candidateId,
      snoozeCandidate.candidateId,
    );
  });

  it("runs manual replay against persisted traces with model judge scores and report events", async () => {
    const chatCompletionRequests: unknown[] = [];
    const harness = createHarness({
      createChatCompletion: async (request) => {
        chatCompletionRequests.push(request);
        return {
          id: "judge-replay",
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  correctnessLikelihood: 0.22,
                  missedToolProbability: 0.81,
                  betterResponsePotential: 0.76,
                  rationale: "The trace failed with live-data intent and no completed recovery.",
                }),
              },
            },
          ],
        } as never;
      },
      readTranscriptOrEmpty: async () =>
        [
          {
            type: "message.user",
            eventId: "user-replay",
            payload: { message: { content: "Find the current provider release notes and cite them." } },
          },
          {
            type: "message.assistant",
            eventId: "assistant-replay",
            payload: { message: { content: "I could not complete the lookup." } },
          },
        ] as never,
    });
    const occurredAt = new Date().toISOString();
    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO chat_turn_traces (
          turn_id, session_id, user_message_id, assistant_message_id, status, mode, model,
          web_mode, memory_mode, thinking_level, routing_json, retrieval_json, reflection_json,
          started_at, finished_at
        ) VALUES (
          'turn-replay', 'sess-replay', 'user-replay', 'assistant-replay', 'failed', 'chat', 'gpt-5.4',
          'quick', 'off', 'standard', @routingJson, @retrievalJson, @reflectionJson,
          @occurredAt, @occurredAt
        )
      `,
      )
      .run({
        routingJson: JSON.stringify({ liveDataIntent: true, selectedProviderId: "openai" }),
        retrievalJson: JSON.stringify({ l2Used: false }),
        reflectionJson: JSON.stringify({ attemptCount: 0 }),
        occurredAt,
      });
    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO chat_tool_runs (
          tool_run_id, turn_id, session_id, tool_name, status, args_json, result_json, error, started_at, finished_at
        ) VALUES (
          'tool-replay', 'turn-replay', 'sess-replay', 'browser.search', 'failed',
          @argsJson, NULL, 'provider timeout', @occurredAt, @occurredAt
        )
      `,
      )
      .run({
        argsJson: JSON.stringify({ query: "provider release notes" }),
        occurredAt,
      });

    const result = await harness.service.runImprovementReplayManually({ sampleSize: 5 });
    const detail = harness.service.getDecisionReplayRun(result.run.runId);

    assert.equal(detail.run.status, "completed");
    assert.equal(detail.run.totalCandidates, 2);
    assert.equal(detail.run.totalScored, 2);
    assert.equal(detail.run.modelJudgedCount, 2);
    assert.equal(detail.items.length, 2);
    assert.equal(
      detail.items.every((item) => item.modelScores),
      true,
    );
    assert.equal(
      detail.items.some((item) => item.evidence.includes("model_judged")),
      true,
    );
    assert.ok(detail.findings.length >= 1);
    assert.equal(detail.report?.reportId, result.report?.reportId);
    assert.equal(result.report?.summary.sampledDecisions, 2);
    assert.equal(chatCompletionRequests.length, 2);
    assert.equal(
      harness.published.some((event) => event.eventType === "improvement_replay_started"),
      true,
    );
    assert.equal(
      harness.published.some((event) => event.eventType === "improvement_replay_progress"),
      true,
    );
    assert.equal(
      harness.published.some(
        (event) =>
          event.eventType === "improvement_replay_completed" &&
          event.payload.runId === result.run.runId &&
          event.payload.reportId === result.report?.reportId,
      ),
      true,
    );
  });

  it("persists failed replay status and emits failure events when replay scoring crashes", async () => {
    const harness = createHarness({
      readTranscriptOrEmpty: async () => {
        throw new Error("transcript store offline");
      },
    });
    const occurredAt = new Date().toISOString();
    harness.storage.gatewaySql
      .prepare(
        `
        INSERT INTO chat_turn_traces (
          turn_id, session_id, user_message_id, assistant_message_id, status, mode, model,
          web_mode, memory_mode, thinking_level, routing_json, retrieval_json, reflection_json,
          started_at, finished_at
        ) VALUES (
          'turn-replay-fail', 'sess-replay-fail', 'user-replay-fail', 'assistant-replay-fail',
          'failed', 'chat', 'gpt-5.4', 'off', 'off', 'standard',
          '{}', '{}', '{}', @occurredAt, @occurredAt
        )
      `,
      )
      .run({ occurredAt });

    await assert.rejects(
      () => harness.service.runImprovementReplayManually({ sampleSize: 1 }),
      /transcript store offline/,
    );
    const [failedRun] = harness.service.listDecisionReplayRuns(1);

    assert.ok(failedRun);
    assert.equal(failedRun.status, "failed");
    assert.match(failedRun.error ?? "", /transcript store offline/);
    assert.equal(
      harness.published.some(
        (event) =>
          event.eventType === "improvement_replay_failed" &&
          event.payload.runId === failedRun.runId &&
          /transcript store offline/.test(String(event.payload.message)),
      ),
      true,
    );
  });
});

function createHarness(callbackOverrides: Partial<ImprovementServiceCallbacks> = {}): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-ledger-"));
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
  const state = {
    failRoutingRestore: false,
    failRepairRestore: false,
  };

  const ctx: ServiceContext = {
    storage,
    cronSpecOwner: {
      reconcileSpec: async (cronSpec) => storage.cronJobs.reconcileSpec(cronSpec),
    },
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: (eventType, source, payload) => {
      published.push({ eventType, source, payload });
    },
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: (flag) => flag === "improvementLedgerV1Enabled" || flag === "improvementActivationV1Enabled",
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };

  const callbacks: ImprovementServiceCallbacks = {
    createApproval: async (input) => storage.approvals.create(input),
    captureRepairPolicySnapshot: (targetKey) =>
      createPolicySnapshot("repair_policy_snapshot", targetKey, repairPolicies),
    applyRepairPolicyCandidate: (targetKey, revisionRef) =>
      applyPolicyCandidate("repair_policy_config", targetKey, revisionRef, repairPolicies),
    restoreRepairPolicySnapshot: (snapshotRef) => {
      if (state.failRepairRestore) {
        throw new Error("repair restore failed");
      }
      restorePolicySnapshot(snapshotRef, repairPolicies);
    },
    captureRoutingPolicySnapshot: (targetKey) =>
      createPolicySnapshot("routing_policy_snapshot", targetKey, routingPolicies),
    applyRoutingPolicyCandidate: (targetKey, revisionRef) =>
      applyPolicyCandidate("routing_policy_config", targetKey, revisionRef, routingPolicies),
    restoreRoutingPolicySnapshot: (snapshotRef) => {
      if (state.failRoutingRestore) {
        throw new Error("routing restore failed");
      }
      restorePolicySnapshot(snapshotRef, routingPolicies);
    },
    createChatCompletion: async () => ({ id: "mock", choices: [] }) as never,
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readEffectiveBlockerTemplateStrictness: () => readBlockerTemplateStrictness(storage.systemSettings),
    readEffectiveRetryRepairThreshold: () => readRetryRepairThreshold(storage.systemSettings),
    readEffectiveLiveIntentThreshold: () => readLiveIntentThreshold(storage.systemSettings),
    readTranscriptOrEmpty: async () => [],
    retryChatTurn: async () => ({ sessionId: "retry-session", turnId: "retry-turn" }) as never,
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
    ...callbackOverrides,
  };

  const service = new ImprovementService(ctx, callbacks);
  const harness: Harness = {
    rootDir,
    storage,
    service,
    routingPolicies,
    repairPolicies,
    published,
    state,
  };
  harnesses.push(harness);
  return harness;
}

function createRoutingCandidate(service: ImprovementService, suffix = "1") {
  service.recordPromptLabRegressionCompletionSignal({
    regressionRunId: `regression-seed-${suffix}`,
    packId: "pack-routing",
    capability: suffix === "1" ? "provider-balance" : `provider-balance-${suffix}`,
    scoreDelta: -0.6,
    passDelta: -0.2,
    latencyDeltaMs: 35,
  });
  const [candidate] = service.listImprovementCandidates(10);
  assert.ok(candidate);
  return candidate;
}

function resolveApproval(
  harness: Harness,
  approvalId: string,
  input: Pick<ApprovalResolveInput, "decision" | "resolvedBy">,
) {
  return harness.storage.approvals.resolve(approvalId, {
    ...input,
    resolutionNote: "test",
  });
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
