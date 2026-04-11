import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { Storage } from "@goatcitadel/storage";
import type { ApprovalResolveInput, ImprovementRef } from "@goatcitadel/contracts";
import { ImprovementService, type ImprovementServiceCallbacks } from "./improvement-service.js";
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
});

function createHarness(): Harness {
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
    readTranscriptOrEmpty: async () => [],
    retryChatTurn: async () => ({ sessionId: "retry-session", turnId: "retry-turn" }) as never,
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
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

function createRoutingCandidate(service: ImprovementService) {
  service.recordPromptLabRegressionCompletionSignal({
    regressionRunId: "regression-seed-1",
    packId: "pack-routing",
    capability: "provider-balance",
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
