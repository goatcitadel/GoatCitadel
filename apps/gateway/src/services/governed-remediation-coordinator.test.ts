import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  type GovernedRemediationApplicationReceipt,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import { GovernedRemediationRepository, createDatabase, type DatabaseClient } from "@goatcitadel/storage";
import {
  GovernedRemediationCoordinator,
  type GovernedRemediationAuthorityPort,
  type GovernedRemediationDurableResumePort,
  type GovernedRemediationDurableResumeRequest,
  type StartGovernedRemediationInput,
} from "./governed-remediation-coordinator.js";
import {
  GovernedRemediationRecipeRegistry,
  GovernedRemediationRegistryError,
  type GovernedRemediationApplyResult,
  type GovernedRemediationOwnerContext,
  type GovernedRemediationOwnerPort,
  type GovernedRemediationReconcileResult,
} from "./governed-remediation-registry.js";

const opened: DatabaseClient[] = [];
const files: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const file of files.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      try {
        fs.rmSync(candidate, { force: true });
      } catch {
        // Best-effort test cleanup.
      }
    }
  }
});

const scope: GovernedRemediationScope = {
  schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  deploymentId: "deployment-local",
  scopeKind: "workspace",
  scopeId: "workspace-1",
  targetId: "configuration.target",
};

function recipe(overrides: Partial<GovernedRemediationRecipe> = {}): GovernedRemediationRecipe {
  return {
    schemaVersion: GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
    recipeId: "recipe.declarative.configuration",
    recipeVersion: 1,
    repairClass: "declarative_configuration",
    ownerId: "configuration-owner",
    targetId: "configuration.target",
    requestedCapabilityId: "configuration.write-governed",
    executionMode: "governed",
    allowedScopeKinds: ["workspace"],
    allowedDeploymentProfiles: ["trusted_local"],
    inputKind: "none",
    preEffectApproval: "not_required",
    activationApproval: "not_required",
    verificationProbeId: "configuration.probe",
    rollbackStrategy: "restore_previous",
    maxApplyAttempts: 2,
    ...overrides,
  };
}

function manualRecipe(): GovernedRemediationRecipe {
  return recipe({
    recipeId: "recipe.product.manual",
    repairClass: "product_source_or_binary",
    ownerId: "manual-owner",
    executionMode: "manual_required",
    inputKind: "none",
    preEffectApproval: "not_applicable",
    activationApproval: "not_applicable",
    verificationProbeId: null,
    rollbackStrategy: "manual_required",
    maxApplyAttempts: 0,
  });
}

class FakeConfigurationOwner implements GovernedRemediationOwnerPort {
  public readonly ownerId = "configuration-owner";
  public readonly targetId = "configuration.target";
  public readonly requestedCapabilityId = "configuration.write-governed";
  public activationMode: "not_applicable" | "owner_step" = "not_applicable";
  public verifyFails = false;
  public rollbackFails = false;
  public applyThrows = false;
  public applyRejects = false;
  public rawApplyCalls = 0;
  public committedApplyCount = 0;
  public rollbackCalls = 0;
  public revision = "owner-revision-1";
  public effectPresent = false;
  public effectVerified = false;
  public rolledBack = false;
  public reconcileOverride: GovernedRemediationReconcileResult | null = null;
  private readonly applyByOperation = new Map<string, GovernedRemediationApplyResult>();

  public async preflight() {
    return { status: "ready" as const, ownerRevision: this.revision };
  }

  public async apply(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationApplyResult> {
    this.rawApplyCalls += 1;
    const replay = this.applyByOperation.get(context.operationId);
    if (replay) return replay;
    if (this.applyThrows) throw new Error("RAW_OWNER_SECRET_apply_should_never_persist");
    if (this.applyRejects) {
      return { status: "rejected", reason: "owner_unavailable", ownerRevisionObserved: this.revision };
    }
    const result: GovernedRemediationApplyResult = {
      status: "applied",
      effectId: context.effectId,
      ownerRevisionBefore: this.revision,
      ownerRevisionAfter: "owner-revision-2",
    };
    this.revision = result.ownerRevisionAfter;
    this.effectPresent = true;
    this.committedApplyCount += 1;
    this.applyByOperation.set(context.operationId, result);
    return result;
  }

  public async probe() {
    if (this.verifyFails) {
      return {
        status: "rejected" as const,
        reason: "verification_failed" as const,
        ownerRevisionObserved: this.revision,
      };
    }
    this.effectVerified = true;
    return {
      status: "accepted" as const,
      probeId: "configuration.probe",
      ownerRevisionObserved: this.revision,
    };
  }

  public async activate() {
    this.revision = "owner-revision-3";
    return { status: "activated" as const, ownerRevisionAfter: this.revision };
  }

  public async rollback() {
    this.rollbackCalls += 1;
    if (this.rollbackFails) {
      return { status: "failed" as const, ownerRevisionObserved: this.revision, effectState: "unknown" as const };
    }
    this.effectPresent = false;
    this.effectVerified = false;
    this.rolledBack = true;
    this.revision = "owner-revision-rollback";
    return { status: "rolled_back" as const, ownerRevisionAfter: this.revision };
  }

  public async reconcile(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationReconcileResult> {
    if (this.reconcileOverride) return this.reconcileOverride;
    const application = {
      effectId: context.effectId,
      ownerRevisionBefore: "owner-revision-1",
      ownerRevisionAfter: "owner-revision-2",
    };
    if (this.rolledBack) {
      return { observation: "rolled_back", application, ownerRevisionAfter: this.revision };
    }
    if (this.effectPresent) {
      return { observation: this.effectVerified ? "effect_verified" : "effect_present_unverified", application };
    }
    return { observation: "effect_absent", ownerRevisionObserved: this.revision };
  }
}

class FakeDurableResume implements GovernedRemediationDurableResumePort {
  public reject = false;
  public rawCalls = 0;
  public readonly requests: GovernedRemediationDurableResumeRequest[] = [];
  private readonly versions = new Map<string, number>();

  public async resume(request: GovernedRemediationDurableResumeRequest) {
    this.rawCalls += 1;
    this.requests.push(request);
    if (this.reject) return { status: "rejected" as const, reason: "resume_failed" as const };
    const replay = this.versions.get(request.idempotencyKey);
    if (replay !== undefined) return { status: "resumed" as const, resumedRunVersion: replay, replayed: true };
    const resumedRunVersion = request.expectedWaitingRunVersion + 1;
    this.versions.set(request.idempotencyKey, resumedRunVersion);
    return { status: "resumed" as const, resumedRunVersion, replayed: false };
  }
}

function authority(requireApproval = false): GovernedRemediationAuthorityPort {
  return {
    async authorize(request) {
      if (requireApproval && (request.phase === "preflight" || request.phase === "apply")) {
        return request.approvalId === "approval-1"
          ? { status: "authorized" as const }
          : { status: "denied" as const, reason: "approval_missing_or_expired" as const };
      }
      return { status: "authorized" as const };
    },
  };
}

function createHarness(
  input: {
    recipe?: GovernedRemediationRecipe;
    owner?: FakeConfigurationOwner;
    durableResume?: FakeDurableResume;
    requireApproval?: boolean;
    authority?: GovernedRemediationAuthorityPort;
    extraRegistrations?: ConstructorParameters<typeof GovernedRemediationRecipeRegistry>[0];
  } = {},
) {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-remediation-coordinator-${randomUUID()}.db`);
  files.push(dbPath);
  const db = createDatabase({ dbPath });
  opened.push(db);
  const repository = new GovernedRemediationRepository(db);
  const owner = input.owner ?? new FakeConfigurationOwner();
  const durableResume = input.durableResume ?? new FakeDurableResume();
  const configuredRecipe = input.recipe ?? recipe();
  const registry = new GovernedRemediationRecipeRegistry([
    { recipe: configuredRecipe, owner: configuredRecipe.executionMode === "manual_required" ? null : owner },
    ...(input.extraRegistrations ?? []),
  ]);
  const coordinator = new GovernedRemediationCoordinator({
    repository,
    registry,
    authority: input.authority ?? authority(input.requireApproval),
    durableResume,
    deploymentProfile: "trusted_local",
  });
  return { db, dbPath, repository, owner, durableResume, registry, coordinator, recipe: configuredRecipe };
}

function startInput(overrides: Partial<StartGovernedRemediationInput> = {}): StartGovernedRemediationInput {
  return {
    remediationId: "remediation-1",
    workspaceId: "workspace-1",
    sessionId: "session-1",
    sourceTurnId: "turn-1",
    durableRunId: "durable-run-1",
    blockedCheckpointId: "checkpoint-1",
    expectedWaitingRunVersion: 7,
    expectedOwnerRevision: "owner-revision-1",
    recipeId: "recipe.declarative.configuration",
    recipeVersion: 1,
    targetId: "configuration.target",
    requestedCapabilityId: "configuration.write-governed",
    scope,
    requestedAt: "2026-08-08T20:00:00.000Z",
    ...overrides,
  };
}

class SimulatedCoordinatorCrash extends Error {}

function crashOnReceiptOccurrence(
  repository: GovernedRemediationRepository,
  kind: Parameters<GovernedRemediationRepository["appendReceipt"]>[0]["receipt"]["kind"],
  occurrence = 1,
): () => void {
  const original = repository.appendReceipt.bind(repository);
  let seen = 0;
  repository.appendReceipt = (input) => {
    if (input.receipt.kind === kind) {
      seen += 1;
      if (seen === occurrence) throw new SimulatedCoordinatorCrash(`crash-after-${kind}`);
    }
    return original(input);
  };
  return () => {
    repository.appendReceipt = original;
  };
}

describe("GovernedRemediationRecipeRegistry", () => {
  it("rejects duplicate, conflicting, owner-mismatched, profile, scope, and manual callable bindings", () => {
    const owner = new FakeConfigurationOwner();
    expect(
      () =>
        new GovernedRemediationRecipeRegistry([
          { recipe: recipe(), owner },
          { recipe: recipe(), owner },
        ]),
    ).toThrowError(/Duplicate governed remediation binding/u);

    const conflictingRecipe = recipe({ targetId: "configuration.other" });
    const conflictingOwner = new FakeConfigurationOwner();
    Object.defineProperty(conflictingOwner, "targetId", { value: "configuration.other" });
    expect(
      () =>
        new GovernedRemediationRecipeRegistry([
          { recipe: recipe(), owner },
          { recipe: conflictingRecipe, owner: conflictingOwner },
        ]),
    ).toThrowError(/conflicting target or capability/u);

    const wrongOwner = new FakeConfigurationOwner();
    Object.defineProperty(wrongOwner, "ownerId", { value: "wrong-owner" });
    expect(() => new GovernedRemediationRecipeRegistry([{ recipe: recipe(), owner: wrongOwner }])).toThrowError(
      /owner binding does not match/u,
    );
    expect(() => new GovernedRemediationRecipeRegistry([{ recipe: manualRecipe(), owner }])).toThrowError(
      /Manual remediation recipes cannot have callable owners/u,
    );

    const registry = new GovernedRemediationRecipeRegistry([{ recipe: recipe(), owner }]);
    expect(() =>
      registry.resolve({
        recipeId: recipe().recipeId,
        recipeVersion: 1,
        targetId: recipe().targetId,
        requestedCapabilityId: recipe().requestedCapabilityId,
        deploymentProfile: "remote_hardened",
        scope,
      }),
    ).toThrowError(GovernedRemediationRegistryError);
    expect(() =>
      registry.resolve({
        recipeId: recipe().recipeId,
        recipeVersion: 1,
        targetId: recipe().targetId,
        requestedCapabilityId: recipe().requestedCapabilityId,
        deploymentProfile: "trusted_local",
        scope: { ...scope, scopeKind: "installation" },
      }),
    ).toThrowError(/scope kind is not allowlisted/u);
  });
});

describe("GovernedRemediationCoordinator", () => {
  it("completes a declarative recipe with durable receipts and idempotent CAS/resume replay", async () => {
    const harness = createHarness();
    const [left, right] = await Promise.all([
      harness.coordinator.start(startInput()),
      harness.coordinator.start(startInput()),
    ]);
    expect(left.record.state).toBe("completed");
    expect(right.record.state).toBe("completed");
    expect(harness.owner.committedApplyCount).toBe(1);
    expect(harness.repository.listReceipts("remediation-1").map((receipt) => receipt.kind)).toEqual([
      "application",
      "verification",
      "resume",
    ]);
    expect(harness.durableResume.requests[0]).toMatchObject({
      durableRunId: "durable-run-1",
      blockedCheckpointId: "checkpoint-1",
      expectedWaitingRunVersion: 7,
    });
    expect(new Set(harness.durableResume.requests.map((request) => request.idempotencyKey)).size).toBe(1);

    const replay = await harness.coordinator.start(startInput());
    expect(replay.record.state).toBe("completed");
    expect(harness.owner.committedApplyCount).toBe(1);
    expect(harness.repository.listReceipts("remediation-1")).toHaveLength(3);
  });

  it("waits durably for an approval reference before any owner effect", async () => {
    const configuredRecipe = recipe({ preEffectApproval: "required_before_apply" });
    const harness = createHarness({ recipe: configuredRecipe, requireApproval: true });
    const waiting = await harness.coordinator.start(startInput());
    expect(waiting.record.state).toBe("awaiting_preapproval");
    expect(waiting.record.approvalId).toBeNull();
    expect(harness.owner.rawApplyCalls).toBe(0);

    const completed = await harness.coordinator.continue({ remediationId: "remediation-1", approvalId: "approval-1" });
    expect(completed.record.state).toBe("completed");
    expect(completed.record.approvalId).toBe("approval-1");
    expect(harness.owner.committedApplyCount).toBe(1);
  });

  it("enforces manual recipes, fail-closed policy results, and fresh authority for bounded retries", async () => {
    const manual = createHarness({ recipe: manualRecipe() });
    const manualState = await manual.coordinator.start(startInput({ recipeId: "recipe.product.manual" }));
    expect(manualState.record.state).toBe("manual_required");
    expect(manual.owner.rawApplyCalls).toBe(0);

    const malformedPolicy = createHarness({
      authority: {
        async authorize() {
          return { status: "authorized", rawPolicyPayload: "RAW_POLICY_SECRET" } as never;
        },
      },
    });
    const denied = await malformedPolicy.coordinator.start(startInput({ remediationId: "remediation-policy-denied" }));
    expect(denied.record.state).toBe("failed");
    expect(malformedPolicy.owner.rawApplyCalls).toBe(0);
    expect(malformedPolicy.repository.listFailures("remediation-policy-denied")).toMatchObject([
      { phase: "preflight", reason: "policy_denied", effectBoundary: "not_crossed" },
    ]);

    const rejectingOwner = new FakeConfigurationOwner();
    rejectingOwner.applyRejects = true;
    let applyAuthorityChecks = 0;
    const bounded = createHarness({
      owner: rejectingOwner,
      authority: {
        async authorize(request) {
          if (request.phase === "apply") applyAuthorityChecks += 1;
          return { status: "authorized" };
        },
      },
    });
    const exhausted = await bounded.coordinator.start(startInput({ remediationId: "remediation-bounded-retry" }));
    expect(exhausted.record.state).toBe("failed");
    expect(rejectingOwner.rawApplyCalls).toBe(2);
    expect(applyAuthorityChecks).toBe(2);
    expect(bounded.repository.listFailures("remediation-bounded-retry").map((failure) => failure.disposition)).toEqual(
      expect.arrayContaining(["retry_with_fresh_authority", "terminal_no_effect"]),
    );
  });

  it("rolls back a verification failure and records typed application, failure, and rollback truth", async () => {
    const owner = new FakeConfigurationOwner();
    owner.verifyFails = true;
    const harness = createHarness({ owner });
    const result = await harness.coordinator.start(startInput());
    expect(result.record.state).toBe("rolled_back");
    expect(owner.rollbackCalls).toBe(1);
    expect(harness.repository.listReceipts("remediation-1").map((receipt) => receipt.kind)).toEqual([
      "application",
      "rollback",
    ]);
    expect(harness.repository.listFailures("remediation-1")).toMatchObject([
      { phase: "verify", reason: "verification_failed", effectBoundary: "crossed", disposition: "rollback_required" },
    ]);
  });

  it("quarantines rollback failure and records a later owner reconciliation receipt", async () => {
    const owner = new FakeConfigurationOwner();
    owner.verifyFails = true;
    owner.rollbackFails = true;
    const harness = createHarness({ owner });
    const failed = await harness.coordinator.start(startInput());
    expect(failed.record.state).toBe("rollback_failed");
    const [quarantined] = harness.repository.listReconciliationRecoveryCandidates();
    expect(quarantined).toMatchObject({ state: "quarantined", reason: "rollback_failed", observation: "unknown" });

    owner.reconcileOverride = {
      observation: "rolled_back",
      application: {
        effectId:
          harness.repository.listReceipts("remediation-1")[0]!.kind === "application"
            ? (harness.repository.listReceipts("remediation-1")[0] as GovernedRemediationApplicationReceipt).effectId
            : "unexpected",
        ownerRevisionBefore: "owner-revision-1",
        ownerRevisionAfter: "owner-revision-2",
      },
      ownerRevisionAfter: "owner-revision-rollback",
    };
    const [resolved] = await harness.coordinator.recoverReconciliations();
    expect(resolved).toMatchObject({ state: "resolved_rolled_back", observation: "rolled_back" });
    expect(harness.repository.listReceipts("remediation-1").map((receipt) => receipt.kind)).toContain("reconciliation");
  });

  it("fails a rejected durable resume without projecting parent completion", async () => {
    const durableResume = new FakeDurableResume();
    durableResume.reject = true;
    const harness = createHarness({ durableResume });
    const result = await harness.coordinator.start(startInput());
    expect(result.record.state).toBe("failed");
    expect(harness.repository.listFailures("remediation-1")).toMatchObject([
      { phase: "resume", reason: "resume_failed", effectBoundary: "crossed", disposition: "manual_required" },
    ]);
    expect(harness.repository.listReceipts("remediation-1").map((receipt) => receipt.kind)).not.toContain("resume");
    expect(harness.repository.listReconciliationRecoveryCandidates()).toHaveLength(1);
  });

  it("never persists raw owner errors or unsupported secure input fields", async () => {
    const owner = new FakeConfigurationOwner();
    owner.applyThrows = true;
    const harness = createHarness({ owner });
    const rawSecret = "RAW_CALLER_SECRET_should_never_persist";
    const result = await harness.coordinator.start({
      ...startInput(),
      rawSecureInput: rawSecret,
    } as StartGovernedRemediationInput);
    expect(result.record.state).toBe("failed");
    expect(harness.repository.listFailures("remediation-1")).toMatchObject([
      { phase: "apply", reason: "internal_error", effectBoundary: "unknown", disposition: "manual_required" },
    ]);
    harness.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    const durableBytes = fs.readFileSync(harness.dbPath).toString("utf8");
    expect(durableBytes).not.toContain(rawSecret);
    expect(durableBytes).not.toContain("RAW_OWNER_SECRET_apply_should_never_persist");
    expect(JSON.stringify(harness.repository.listFailures("remediation-1"))).not.toContain("SECRET");
  });

  it("recovers applying, verifying, activating, resuming, and rolling_back after crash boundaries", async () => {
    const applying = createHarness();
    let restore = crashOnReceiptOccurrence(applying.repository, "application");
    await expect(applying.coordinator.start(startInput())).rejects.toBeInstanceOf(SimulatedCoordinatorCrash);
    expect(applying.repository.getState("remediation-1").record.state).toBe("applying");
    restore();
    expect((await applying.coordinator.recover()).states[0]?.record.state).toBe("completed");

    const verifying = createHarness();
    restore = crashOnReceiptOccurrence(verifying.repository, "verification");
    await expect(
      verifying.coordinator.start(startInput({ remediationId: "remediation-verifying" })),
    ).rejects.toBeInstanceOf(SimulatedCoordinatorCrash);
    expect(verifying.repository.getState("remediation-verifying").record.state).toBe("verifying");
    restore();
    expect((await verifying.coordinator.recover()).states[0]?.record.state).toBe("completed");

    const activatingOwner = new FakeConfigurationOwner();
    activatingOwner.activationMode = "owner_step";
    const activating = createHarness({ owner: activatingOwner });
    restore = crashOnReceiptOccurrence(activating.repository, "verification", 2);
    await expect(
      activating.coordinator.start(startInput({ remediationId: "remediation-activating" })),
    ).rejects.toBeInstanceOf(SimulatedCoordinatorCrash);
    expect(activating.repository.getState("remediation-activating").record.state).toBe("activating");
    restore();
    expect((await activating.coordinator.recover()).states[0]?.record.state).toBe("completed");

    const resuming = createHarness();
    restore = crashOnReceiptOccurrence(resuming.repository, "resume");
    await expect(
      resuming.coordinator.start(startInput({ remediationId: "remediation-resuming" })),
    ).rejects.toBeInstanceOf(SimulatedCoordinatorCrash);
    expect(resuming.repository.getState("remediation-resuming").record.state).toBe("resuming");
    restore();
    expect((await resuming.coordinator.recover()).states[0]?.record.state).toBe("completed");
    expect(new Set(resuming.durableResume.requests.map((request) => request.idempotencyKey)).size).toBe(1);

    const rollingBackOwner = new FakeConfigurationOwner();
    rollingBackOwner.verifyFails = true;
    const rollingBack = createHarness({ owner: rollingBackOwner });
    restore = crashOnReceiptOccurrence(rollingBack.repository, "rollback");
    await expect(
      rollingBack.coordinator.start(startInput({ remediationId: "remediation-rolling-back" })),
    ).rejects.toBeInstanceOf(SimulatedCoordinatorCrash);
    expect(rollingBack.repository.getState("remediation-rolling-back").record.state).toBe("rolling_back");
    restore();
    expect((await rollingBack.coordinator.recover()).states[0]?.record.state).toBe("rolled_back");
  });
});
