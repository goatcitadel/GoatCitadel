import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "@goatcitadel/storage";
import type { ApprovalResolveInput, ImprovementRef } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
import {
  readBlockerTemplateStrictness,
  readLiveIntentThreshold,
  readRetryRepairThreshold,
} from "./improvement-tune-reads.js";
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
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

describe("ImprovementService activation ledger coverage", () => {
  it("applies pending routing activations only after approval resolution", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");

    expect(harness.routingPolicies[candidate.targetKey]).toBeUndefined();

    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    const applied = harness.service.handleActivationApprovalResolution(approval);

    expect(applied).toMatchObject({ status: "active", watchStatus: "watching" });
    expect(harness.routingPolicies[candidate.targetKey]).toMatchObject({
      strategy: "route_rebalance",
      targetKey: candidate.targetKey,
    });
    expect(harness.published.some((event) => event.eventType === "improvement_activation_applied")).toBe(true);
  });

  it("rejects approvals by failing the activation and suppressing the candidate", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");

    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "reject",
      resolvedBy: "operator-1",
    });
    const failed = harness.service.handleActivationApprovalResolution(approval);
    const detail = harness.service.getImprovementCandidateDetail(candidate.candidateId);

    expect(failed).toMatchObject({ status: "failed" });
    expect(detail.candidate.status).toBe("rejected");
    expect(detail.candidate.suppressionUntil).toBeTruthy();
    expect(harness.routingPolicies[candidate.targetKey]).toBeUndefined();
  });

  it("blocks stale approval activation when the candidate revision has drifted", async () => {
    const harness = createHarness();
    const candidate = createRoutingCandidate(harness.service);
    const activation = await harness.service.requestImprovementActivation(candidate.candidateId, "operator-1");
    const detail = harness.service.getImprovementCandidateDetail(candidate.candidateId);

    expect(detail.currentRevision).toBeDefined();

    const revisionId = randomUUID();
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
        revisionId,
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
        changeHash: `drift-${revisionId}`,
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
        revisionId,
        updatedAt: new Date().toISOString(),
        candidateId: candidate.candidateId,
      });

    const approval = resolveApproval(harness, activation.approvalId, {
      decision: "approve",
      resolvedBy: "operator-1",
    });
    const failed = harness.service.handleActivationApprovalResolution(approval);
    const updated = harness.service.getImprovementCandidateDetail(candidate.candidateId);

    expect(failed).toMatchObject({ status: "failed" });
    expect(updated.candidate.status).toBe("evaluating");
    expect(harness.routingPolicies[candidate.targetKey]).toBeUndefined();
  });

  it("stabilizes watch windows and emits rollback failure events for negative regressions", async () => {
    const stableHarness = createHarness();
    const stableCandidate = createRoutingCandidate(stableHarness.service);
    const stableActivation = await stableHarness.service.requestImprovementActivation(
      stableCandidate.candidateId,
      "operator-1",
    );
    stableHarness.service.handleActivationApprovalResolution(
      resolveApproval(stableHarness, stableActivation.approvalId, {
        decision: "approve",
        resolvedBy: "operator-1",
      }),
    );

    for (let index = 0; index < 20; index += 1) {
      stableHarness.service.recordPromptLabRegressionCompletionSignal({
        regressionRunId: `regression-neutral-${index}`,
        packId: "pack-routing",
        capability: "provider-balance",
        scoreDelta: 0,
        passDelta: 0,
        latencyDeltaMs: 0,
      });
    }

    expect(stableHarness.service.getImprovementActivation(stableActivation.activationId)).toMatchObject({
      watchStatus: "stable",
      watchSignalCount: 20,
    });

    const failingHarness = createHarness();
    const failingCandidate = createRoutingCandidate(failingHarness.service, "rollback");
    const failingActivation = await failingHarness.service.requestImprovementActivation(
      failingCandidate.candidateId,
      "operator-1",
    );
    failingHarness.service.handleActivationApprovalResolution(
      resolveApproval(failingHarness, failingActivation.approvalId, {
        decision: "approve",
        resolvedBy: "operator-1",
      }),
    );
    failingHarness.state.failRoutingRestore = true;

    failingHarness.service.recordPromptLabRegressionCompletionSignal({
      regressionRunId: "regression-negative-rollback",
      packId: "pack-routing",
      capability: "provider-balance-rollback",
      scoreDelta: -0.4,
      passDelta: -0.2,
      latencyDeltaMs: 42,
    });

    expect(failingHarness.service.getImprovementActivation(failingActivation.activationId).status).toBe("failed");
    expect(failingHarness.published.some((event) => event.eventType === "improvement_activation_pause_failed")).toBe(
      true,
    );
  }, 15_000);

  it("keeps proposal and curator lifecycle actions review-first", async () => {
    const harness = createHarness();
    const skillResult = harness.service.recordSkillEvaluationSignal({
      skillId: "planning",
      skillName: "Planning",
      runId: "skill-eval-1",
      accepted: true,
      passRate: 1,
      improvementDelta: 0.4,
      summary: "Improved instruction criteria coverage.",
    });

    expect(skillResult?.candidate).toMatchObject({ kind: "skill_revision", status: "ready_for_approval" });
    expect(
      harness.service.getImprovementCandidateDetail(skillResult!.candidate!.candidateId).latestEvaluation,
    ).toMatchObject({ evaluatorKind: "skill_eval_scorecard" });
    await expect(
      harness.service.requestImprovementActivation(skillResult!.candidate!.candidateId, "operator-1"),
    ).rejects.toThrow(/capability proposals/);

    const routingCandidate = createRoutingCandidate(harness.service, "curator");
    expect(
      harness.service.validateImprovementCandidate(routingCandidate.candidateId, {
        actorId: "qa-operator",
        reason: "ready for approval",
      }),
    ).toMatchObject({ status: "validated", mutationApplied: false });
    expect(
      harness.service.approveImprovementCandidate(routingCandidate.candidateId, {
        actorId: "qa-operator",
        reason: "evaluation passed",
      }),
    ).toMatchObject({ status: "approved" });
    expect(() => harness.service.promoteImprovementCandidate(routingCandidate.candidateId)).toThrow(
      /Promotion is review-only/,
    );

    const activated = await harness.service.activateImprovementCandidate(routingCandidate.candidateId, {
      actorId: "qa-operator",
    });
    expect(activated).toMatchObject({ status: "approval_pending" });
    expect(activated.approvalId).toBeTruthy();
  });

  it("runs manual replay against persisted traces with model judge scores and report events", async () => {
    const chatCompletionRequests: unknown[] = [];
    const harness = createHarness({
      createChatCompletion: vi.fn(async (request) => {
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
      }),
      readTranscriptOrEmpty: vi.fn(
        async () =>
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
      ),
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

    expect(detail.run).toMatchObject({
      status: "completed",
      totalCandidates: 2,
      totalScored: 2,
      modelJudgedCount: 2,
    });
    expect(detail.items).toHaveLength(2);
    expect(detail.items.every((item) => item.modelScores)).toBe(true);
    expect(detail.items.some((item) => item.evidence.includes("model_judged"))).toBe(true);
    expect(detail.findings.length).toBeGreaterThanOrEqual(1);
    expect(detail.report?.reportId).toBe(result.report?.reportId);
    expect(result.report?.summary.sampledDecisions).toBe(2);
    expect(chatCompletionRequests).toHaveLength(2);
    expect(harness.published.some((event) => event.eventType === "improvement_replay_started")).toBe(true);
    expect(harness.published.some((event) => event.eventType === "improvement_replay_progress")).toBe(true);
    expect(
      harness.published.some(
        (event) =>
          event.eventType === "improvement_replay_completed" &&
          event.payload.runId === result.run.runId &&
          event.payload.reportId === result.report?.reportId,
      ),
    ).toBe(true);
  }, 15_000);

  it("persists failed replay status and emits failure events when replay scoring crashes", async () => {
    const harness = createHarness({
      readTranscriptOrEmpty: vi.fn(async () => {
        throw new Error("transcript store offline");
      }),
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

    await expect(harness.service.runImprovementReplayManually({ sampleSize: 1 })).rejects.toThrow(
      /transcript store offline/,
    );
    const [failedRun] = harness.service.listDecisionReplayRuns(1);

    expect(failedRun).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/transcript store offline/),
    });
    expect(
      harness.published.some(
        (event) =>
          event.eventType === "improvement_replay_failed" &&
          event.payload.runId === failedRun?.runId &&
          /transcript store offline/.test(String(event.payload.message)),
      ),
    ).toBe(true);
  });

  it("does not synthesize candidates from internal lifecycle audit signals", () => {
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

    expect(harness.service.listImprovementCandidates(20)).toHaveLength(0);
  });
});

function createHarness(callbackOverrides: Partial<ImprovementServiceCallbacks> = {}): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-loop19-"));
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
      if (state.failRepairRestore) {
        throw new Error("repair restore failed");
      }
      restorePolicySnapshot(snapshotRef, repairPolicies);
    }),
    captureRoutingPolicySnapshot: vi.fn((targetKey) =>
      createPolicySnapshot("routing_policy_snapshot", targetKey, routingPolicies),
    ),
    applyRoutingPolicyCandidate: vi.fn((targetKey, revisionRef) =>
      applyPolicyCandidate("routing_policy_config", targetKey, revisionRef, routingPolicies),
    ),
    restoreRoutingPolicySnapshot: vi.fn((snapshotRef) => {
      if (state.failRoutingRestore) {
        throw new Error("routing restore failed");
      }
      restorePolicySnapshot(snapshotRef, routingPolicies);
    }),
    createChatCompletion: vi.fn(async () => ({ id: "mock", choices: [] }) as never),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readEffectiveBlockerTemplateStrictness: () => readBlockerTemplateStrictness(storage.systemSettings),
    readEffectiveRetryRepairThreshold: () => readRetryRepairThreshold(storage.systemSettings),
    readEffectiveLiveIntentThreshold: () => readLiveIntentThreshold(storage.systemSettings),
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(async () => ({ sessionId: "retry-session", turnId: "retry-turn" }) as never),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
    ...callbackOverrides,
  };

  const service = new ImprovementService(ctx, callbacks);
  const harness: Harness = { rootDir, storage, service, routingPolicies, repairPolicies, published, state };
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
  const candidate = service.listImprovementCandidates(20).find((item) => item.kind === "routing_policy");
  expect(candidate).toBeDefined();
  return candidate!;
}

function resolveApproval(
  harness: Harness,
  approvalId: string,
  input: Pick<ApprovalResolveInput, "decision" | "resolvedBy">,
) {
  return harness.storage.approvals.resolve(approvalId, {
    ...input,
    resolutionNote: "loop19 coverage",
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
