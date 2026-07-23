import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLog, Storage, TranscriptLog } from "@goatcitadel/storage";
import {
  buildImprovementActivateReviewedStateMaterial,
  buildImprovementRestoreReviewedStateMaterial,
  ImprovementService,
  type ImprovementServiceCallbacks,
} from "./improvement-service.js";
import {
  buildImprovementLifecycleApprovalBinding,
  buildImprovementLifecycleApprovalPayload,
  buildImprovementLifecycleRequestJourneyEvent,
  deriveImprovementLifecycleApprovalId,
  type ImprovementLifecycleApprovalBindingV1,
} from "./improvement-lifecycle-journey-producer.js";
import type { ServiceContext } from "./service-context.js";
import { createPostgresDialectStrictDb } from "./testing/postgres-dialect-strict-db.js";

interface Harness {
  rootDir: string;
  storage: Storage;
  service: ImprovementService;
  callbacks: ImprovementServiceCallbacks;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.service.stopScheduler();
    harness.storage.close();
    fsSync.rmSync(harness.rootDir, { recursive: true, force: true });
  }
});

function createHarness(): Harness {
  const rootDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-pg-dialect-"));
  const transcriptsDir = path.join(rootDir, "transcripts");
  const auditDir = path.join(rootDir, "audit");
  fsSync.mkdirSync(transcriptsDir, { recursive: true });
  fsSync.mkdirSync(auditDir, { recursive: true });

  const storage = new Storage({
    db: createPostgresDialectStrictDb(rootDir),
    transcriptsDir,
    auditDir,
    // Keep the file-based logs so the sqlite-backed facade never has to serve
    // the postgres transcript/audit SQL variants.
    transcripts: new TranscriptLog(transcriptsDir),
    audit: new AuditLog(auditDir),
  });

  const ctx: ServiceContext = {
    storage,
    config: {} as never,
    llmService: {} as never,
    policyEngine: {} as never,
    gatewaySql: storage.gatewaySql,
    publishRealtime: () => undefined,
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: () => true,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId?.trim() || "default",
  };
  const callbacks = {
    createApproval: vi.fn((input) => storage.approvals.create(input)),
    captureRepairPolicySnapshot: vi.fn(),
    applyRepairPolicyCandidate: vi.fn(),
    restoreRepairPolicySnapshot: vi.fn(),
    captureRoutingPolicySnapshot: vi.fn(),
    applyRoutingPolicyCandidate: vi.fn(),
    restoreRoutingPolicySnapshot: vi.fn(),
    createChatCompletion: vi.fn(async () => ({
      id: "mock-chatcmpl-1",
      object: "chat.completion",
      created: 0,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    })),
    getPromptRunnerModelDefaults: () => ({ providerId: "mock", model: "mock-model" }),
    readEffectiveBlockerTemplateStrictness: () => 1,
    readEffectiveRetryRepairThreshold: () => 0.5,
    readEffectiveLiveIntentThreshold: () => 0.5,
    readTranscriptOrEmpty: vi.fn(async () => []),
    retryChatTurn: vi.fn(),
    backgroundTasks: new Set<Promise<void>>(),
    closing: false,
  } as unknown as ImprovementServiceCallbacks;

  const service = new ImprovementService(ctx, callbacks);
  const harness = { rootDir, storage, service, callbacks };
  harnesses.push(harness);
  return harness;
}

/**
 * HX-402 P3 (P1 precedent): seed one resolved `improvement.lifecycle`
 * approval plus its immutable requester Journey evidence directly. The
 * approvals repository's TTL-window SQL is genuinely postgres-flavored
 * (`AT TIME ZONE`), which the sqlite-backed strict facade cannot execute; the
 * executor under test still revalidates every binding field from the seeded
 * row inside its own ladder, which is exactly the surface this file proves.
 */
function seedApprovedLifecycleApproval(
  harness: Harness,
  binding: ImprovementLifecycleApprovalBindingV1,
  mutation: Record<string, unknown>,
): string {
  const approvalId = deriveImprovementLifecycleApprovalId(binding);
  const createdAt = "2026-07-23T00:30:00.000Z";
  harness.storage.gatewaySql
    .prepare(
      `INSERT INTO approvals (
         approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
         explanation_status, created_at, expires_at, resolved_at, resolved_by
       ) VALUES (
         @approvalId, 'improvement.lifecycle', 'caution', 'approved', @linkageJson, @payloadJson, '{}',
         'not_requested', @createdAt, NULL, @resolvedAt, @resolvedBy
       )`,
    )
    .run({
      approvalId,
      linkageJson: JSON.stringify({ workspaceId: binding.workspaceId, actionType: "improvement_lifecycle" }),
      payloadJson: JSON.stringify(
        buildImprovementLifecycleApprovalPayload({ binding, requesterId: "operator-pg", mutation }),
      ),
      createdAt,
      resolvedAt: "2026-07-23T01:00:00.000Z",
      resolvedBy: "resolver-pg",
    });
  harness.storage.governanceJourneyEvents.create(
    buildImprovementLifecycleRequestJourneyEvent({
      approval: { approvalId, createdAt },
      binding,
      requesterId: "operator-pg",
    }),
  );
  return approvalId;
}

describe("ImprovementService on the postgres dialect", () => {
  it("completes the improvement ledger replay transaction path without sqlite-only exec", async () => {
    // Regression: the weekly improvement replay used raw `exec("BEGIN IMMEDIATE")`,
    // which is sqlite-only syntax and failed every run on Postgres deployments
    // with `syntax error at or near "IMMEDIATE"` (observed live 2026-07-06).
    const harness = createHarness();

    const result = await harness.service.runImprovementReplayManually({ sampleSize: 50 });

    expect(result.run.status).toBe("completed");
  });

  it("runs the governed improvement lifecycle (activate -> pause) without sqlite-only syntax", () => {
    // HX-402 P3: the approval-first request verbs, the recovered effect's
    // durable intent/claim/inspection/settlement machine, and the one-
    // transaction DB half must all execute under the postgres dialect facade.
    const harness = createHarness();
    const policies: Record<string, unknown> = {};
    (harness.callbacks.captureRoutingPolicySnapshot as ReturnType<typeof vi.fn>).mockImplementation(
      (targetKey: string) => ({
        refType: "routing_policy_snapshot",
        refId: targetKey,
        metadata: {
          targetKey,
          hadValue: Object.prototype.hasOwnProperty.call(policies, targetKey),
          previousValue: Object.prototype.hasOwnProperty.call(policies, targetKey) ? policies[targetKey] : null,
        },
      }),
    );
    (harness.callbacks.applyRoutingPolicyCandidate as ReturnType<typeof vi.fn>).mockImplementation(
      (targetKey: string, revisionRef: { metadata?: Record<string, unknown> }) => {
        const proposedChange =
          revisionRef.metadata && "proposedChange" in revisionRef.metadata
            ? revisionRef.metadata.proposedChange
            : revisionRef.metadata;
        policies[targetKey] = proposedChange ?? {};
        return { refType: "routing_policy_config", refId: targetKey, metadata: { targetKey } };
      },
    );
    (harness.callbacks.restoreRoutingPolicySnapshot as ReturnType<typeof vi.fn>).mockImplementation(
      (snapshotRef: { refId: string; metadata?: Record<string, unknown> }) => {
        const metadata = snapshotRef.metadata ?? {};
        const targetKey = typeof metadata.targetKey === "string" ? metadata.targetKey : snapshotRef.refId;
        if (metadata.hadValue === true) {
          policies[targetKey] = metadata.previousValue;
          return;
        }
        delete policies[targetKey];
      },
    );

    harness.service.recordPromptLabRegressionCompletionSignal({
      regressionRunId: "regression-pg-governed",
      packId: "pack-routing",
      capability: "provider-balance",
      scoreDelta: -0.6,
      passDelta: -0.2,
      latencyDeltaMs: 35,
    });
    const candidate = harness.service
      .listImprovementCandidates(50, "prompt-lab")
      .find((item) => item.kind === "routing_policy");
    expect(candidate).toBeDefined();
    const detail = harness.service.getImprovementCandidateDetail(candidate!.candidateId);
    const revision = detail.currentRevision!;
    const evaluation = detail.latestEvaluation!;
    const metadata = revision.candidateRef.metadata as Record<string, unknown> | undefined;
    const targetValue = (metadata && "proposedChange" in metadata ? metadata.proposedChange : metadata) ?? {};

    const activateBinding = buildImprovementLifecycleApprovalBinding({
      workspaceId: "prompt-lab",
      operationKind: "activate",
      targetKind: "improvement_candidate",
      targetId: candidate!.candidateId,
      mutation: {
        candidateId: candidate!.candidateId,
        revisionId: revision.revisionId,
        changeHash: revision.changeHash,
        kind: "routing_policy",
        targetKey: candidate!.targetKey,
        preState: { hadValue: false, value: null },
        targetState: { hadValue: true, value: targetValue },
      },
      expectedState: buildImprovementActivateReviewedStateMaterial(detail.candidate, revision, evaluation, undefined),
    });
    const activateApprovalId = seedApprovedLifecycleApproval(harness, activateBinding, {
      candidateId: candidate!.candidateId,
      revisionId: revision.revisionId,
      changeHash: revision.changeHash,
      kind: "routing_policy",
      targetKey: candidate!.targetKey,
      preState: { hadValue: false, value: null },
      targetState: { hadValue: true, value: targetValue },
    });
    expect(policies).toEqual({});

    const applied = harness.service.executeApprovedImprovementLifecycleMutation({
      workspaceId: "prompt-lab",
      approvalId: activateApprovalId,
    });
    expect(applied.disposition).toBe("applied");
    expect(policies[candidate!.targetKey]).toMatchObject({ strategy: "route_rebalance" });
    expect(harness.service.getImprovementActivation(applied.activationId!).status).toBe("active");
    // Exact replay converges on the immutable settlement.
    expect(
      harness.service.executeApprovedImprovementLifecycleMutation({
        workspaceId: "prompt-lab",
        approvalId: activateApprovalId,
      }),
    ).toMatchObject({ disposition: "applied", replayed: true, settlementId: applied.settlementId });

    const activation = harness.service.getImprovementActivation(applied.activationId!);
    const pauseBinding = buildImprovementLifecycleApprovalBinding({
      workspaceId: "prompt-lab",
      operationKind: "pause",
      targetKind: "improvement_activation",
      targetId: activation.activationId,
      mutation: {
        activationId: activation.activationId,
        preState: { hadValue: true, value: targetValue },
        targetState: { hadValue: false, value: null },
      },
      expectedState: buildImprovementRestoreReviewedStateMaterial(activation),
    });
    const pauseApprovalId = seedApprovedLifecycleApproval(harness, pauseBinding, {
      activationId: activation.activationId,
      preState: { hadValue: true, value: targetValue },
      targetState: { hadValue: false, value: null },
    });
    const paused = harness.service.executeApprovedImprovementLifecycleMutation({
      workspaceId: "prompt-lab",
      approvalId: pauseApprovalId,
    });
    expect(paused).toMatchObject({ disposition: "applied", operationKind: "pause" });
    expect(harness.service.getImprovementActivation(applied.activationId!).status).toBe("paused");
    expect(policies[candidate!.targetKey]).toBeUndefined();
  });

  it("types the optional expected-status predicate before binding a null on the postgres dialect", () => {
    const harness = createHarness();
    const prepare = vi.spyOn(harness.storage.gatewaySql, "prepare");
    const markActivationFailed = (
      harness.service as unknown as {
        markActivationFailed: (activationId: string, reason: string) => unknown;
      }
    ).markActivationFailed.bind(harness.service);

    expect(() => markActivationFailed("missing-activation", "probe")).toThrow(/not found/i);
    const transitionSql = prepare.mock.calls
      .map(([sql]) => sql)
      .find((sql) => sql.includes("UPDATE improvement_activations") && sql.includes("expectedStatus"));
    expect(transitionSql).toMatch(/CAST\(@expectedStatus AS TEXT\) IS NULL/);
    expect(transitionSql).toMatch(/status = CAST\(@expectedStatus AS TEXT\)/);
  });
});
