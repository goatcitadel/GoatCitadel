import { describe, expect, it, vi } from "vitest";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import type { ProductSourceUpdateEventRecord, ProductSourceUpdateManifestRecord } from "@goatcitadel/storage";
import {
  ProductSourceUpdateChangePlanAdapter,
  type ProductSourceApplyObservation,
} from "./product-source-update-change-plan-adapter.js";

const manifest: ProductSourceUpdateManifestRecord = {
  manifestId: "source-update-1",
  planId: "plan-1",
  installId: "install-1",
  installRevision: 2,
  baseSha: "a".repeat(40),
  baseTree: "b".repeat(40),
  patchSha256: "c".repeat(64),
  patchArtifactRelPath: "artifacts/evolution/source-updates/plan-1/approved.patch",
  rollbackSha256: "d".repeat(64),
  rollbackArtifactRelPath: "artifacts/evolution/source-updates/plan-1/rollback.patch",
  changedFiles: [
    {
      path: "apps/gateway/src/example.ts",
      changeKind: "modified",
      beforeSha256: "e".repeat(64),
      afterSha256: "f".repeat(64),
    },
  ],
  validations: [{ proofId: "workspace_typecheck", status: "passed", evidenceRef: "workbench-command:1" }],
  riskClass: "protected_core",
  protectedAreas: ["evolution_control_plane"],
  codeModeRunId: "code-run-1",
  manifestSha256: "1".repeat(64),
  createdAt: new Date().toISOString(),
};

const actions = {
  confirmation: vi.fn((input) => ({
    kind: "confirmation" as const,
    actionId: "confirm-1",
    actionNonce: "nonce-1",
    title: input.title,
    confirmationText: input.confirmationText,
    purpose: input.purpose ?? ("apply" as const),
  })),
  publicForm: vi.fn(),
  secureInput: vi.fn(),
  oauth: vi.fn(),
  nativePathPicker: vi.fn(),
  approval: vi.fn((input) => ({
    kind: "approval" as const,
    actionId: "approval-action-1",
    actionNonce: "nonce-2",
    title: input.title,
    risk: input.risk,
    approvalId: input.approvalId,
  })),
  artifactReview: vi.fn((input) => ({
    kind: "artifact_review" as const,
    actionId: "review-1",
    actionNonce: "nonce-review",
    title: input.title,
    artifactRefs: input.artifactRefs,
  })),
};

function fixture(
  observation: ProductSourceApplyObservation = { status: "running", evidenceRefs: ["helper-request:1"] },
) {
  const events: ProductSourceUpdateEventRecord[] = [
    {
      eventId: "event-staged",
      manifestId: manifest.manifestId,
      sequence: 1,
      eventType: "staged",
      idempotencyKey: "staged:1",
      payload: {},
      createdAt: new Date().toISOString(),
    },
  ];
  const appendEvent = vi.fn((_manifestId, input) => {
    const event = {
      eventId: `event-${events.length + 1}`,
      manifestId: manifest.manifestId,
      sequence: events.length + 1,
      eventType: input.eventType,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      createdAt: new Date().toISOString(),
    } as ProductSourceUpdateEventRecord;
    events.push(event);
    return event;
  });
  const launchApply = vi.fn(async () => observation);
  const createProtectedApproval = vi.fn(async () => "approval-protected");
  const acceptAppliedBaseline = vi.fn(async (input) => ({
    installId: input.installId,
    label: "GoatCitadel",
    canonicalRoot: "C:\\private\\goatcitadel",
    repositoryIdentitySha256: "2".repeat(64),
    baselineSha: input.baselineSha,
    baselineTree: input.baselineTree,
    platform: "win32" as const,
    volumeId: "3".repeat(64),
    status: "active" as const,
    revision: input.expectedRevision + 1,
    registeredAt: new Date().toISOString(),
    lastVerifiedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  const adapter = new ProductSourceUpdateChangePlanAdapter({
    sourceUpdates: {
      inspectInstall: vi.fn(async () => ({
        record: {
          installId: "install-1",
          label: "GoatCitadel",
          baselineSha: manifest.baseSha,
          baselineTree: manifest.baseTree,
          revision: 2,
        },
        current: {},
      })) as never,
      stage: vi.fn(async () => manifest),
      getManifestForPlan: vi.fn(() => manifest),
      verifyManifest: vi.fn(async () => manifest),
      project: vi.fn(() => ({
        manifestId: manifest.manifestId,
        manifestSha256: manifest.manifestSha256,
        baseSha: manifest.baseSha,
        baseTree: manifest.baseTree,
        patchSha256: manifest.patchSha256,
        rollbackSha256: manifest.rollbackSha256,
        changedFiles: manifest.changedFiles,
        validations: manifest.validations,
        riskClass: manifest.riskClass,
        protectedAreas: manifest.protectedAreas,
        codeModeRunId: manifest.codeModeRunId,
        createdAt: manifest.createdAt,
        applyEligible: true,
        blockers: [],
      })),
      appendEvent,
      listEvents: vi.fn(() => events),
    },
    supervisor: {
      launchApply,
      inspect: vi.fn(async () => observation),
      launchRollback: vi.fn(async () => observation),
    },
    createProtectedApproval,
    acceptAppliedBaseline,
  });
  return { adapter, actions, launchApply, createProtectedApproval, acceptAppliedBaseline };
}

function plan(overrides: Partial<ChangePlanRecord> = {}): ChangePlanRecord {
  return {
    schemaVersion: 1,
    planId: "plan-1",
    origin: { surface: "chat", workspaceId: "default", sessionId: "session-1", actorId: "operator" },
    adapter: { adapterId: "product-source-update", version: 1 },
    kind: "product_source_update",
    scope: "product_source",
    status: "staging",
    phase: "staging",
    revision: 2,
    request: {
      kind: "product_source_update",
      sourceInstallId: "install-1",
      codeModeRunId: "code-run-1",
      changeSummary: "Apply reviewed update.",
    },
    intentHash: "4".repeat(64),
    target: {
      ownerId: "managed_source_install",
      resourceId: "install-1",
      expectedRevision: 2,
      expectedHash: manifest.manifestSha256,
    },
    title: "Update GoatCitadel",
    summary: "Apply reviewed update.",
    impact: "Restart",
    risk: "danger",
    approvalRefs: [],
    evidenceRefs: [`product-source-manifest:${manifest.manifestId}:sha256:${manifest.manifestSha256}`],
    rollbackRefs: [`product-source-rollback:${manifest.manifestId}:sha256:${manifest.rollbackSha256}`],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("ProductSourceUpdateChangePlanAdapter", () => {
  it("stages once, binds exact artifacts, and requests a final confirmation after review", async () => {
    const { adapter } = fixture();
    const staged = await adapter.stage(
      { origin: plan().origin, actions: actions as never },
      plan({
        target: {
          ownerId: "managed_source_install",
          resourceId: "install-1",
          expectedRevision: 2,
          expectedHash: manifest.baseSha,
        },
        evidenceRefs: [],
      }),
    );
    expect(staged.status).toBe("awaiting_input");
    expect(staged.requiredAction?.kind).toBe("artifact_review");
    expect(adapter.shouldStage(plan({ evidenceRefs: staged.evidenceRefs ?? [] }))).toBe(false);
    const reviewed = await adapter.reviewArtifacts!(
      { origin: plan().origin, actions: actions as never },
      plan({ evidenceRefs: staged.evidenceRefs ?? [], target: staged.target ?? plan().target }),
      (staged.requiredAction as Extract<NonNullable<typeof staged.requiredAction>, { kind: "artifact_review" }>)
        .artifactRefs,
    );
    expect(reviewed.status).toBe("awaiting_confirmation");
    expect(reviewed.requiredAction?.kind).toBe("confirmation");
  });

  it("requires a specialized second approval before protected-core launch", async () => {
    const { adapter, createProtectedApproval, launchApply } = fixture();
    const awaiting = await adapter.apply(
      { origin: plan().origin, actions: actions as never },
      plan({ status: "applying", approvalRefs: ["approval-base"] }),
    );
    expect(awaiting.status).toBe("awaiting_approval");
    expect(awaiting.requiredAction).toMatchObject({ kind: "approval", approvalId: "approval-protected" });
    expect(createProtectedApproval).toHaveBeenCalledOnce();
    expect(launchApply).not.toHaveBeenCalled();
  });

  it("launches only after both approvals and accepts only a proved helper result", async () => {
    const nextSha = "5".repeat(40);
    const nextTree = "6".repeat(40);
    const { adapter, launchApply, acceptAppliedBaseline } = fixture({
      status: "succeeded",
      baselineSha: nextSha,
      baselineTree: nextTree,
      evidenceRefs: ["source-update-result:result-1"],
    });
    const completed = await adapter.apply(
      { origin: plan().origin, actions: actions as never },
      plan({ status: "applying", approvalRefs: ["approval-base", "approval-protected"] }),
    );
    expect(launchApply).toHaveBeenCalledOnce();
    expect(acceptAppliedBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ baselineSha: nextSha, baselineTree: nextTree }),
    );
    expect(completed.status).toBe("completed");
    expect(JSON.stringify(completed)).not.toContain("C:\\private");
  });
});
