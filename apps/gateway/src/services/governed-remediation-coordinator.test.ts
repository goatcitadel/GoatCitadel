import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  GOVERNED_REMEDIATION_RECIPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  type GovernedRemediationRecipe,
  type GovernedRemediationScope,
} from "@goatcitadel/contracts";
import { GovernedRemediationRepository, createDatabase, type DatabaseClient } from "@goatcitadel/storage";
import {
  GovernedRemediationCoordinator,
  type GovernedRemediationAuthorityPort,
  type GovernedRemediationAuthorityRequest,
  type GovernedRemediationCompletionNotice,
  type GovernedRemediationCompletionRegistration,
  type GovernedRemediationDurableParentPort,
  type GovernedRemediationDurableResumeObservation,
  type GovernedRemediationDurableResumeRequest,
  type GovernedRemediationParentReservationRequest,
  type StartGovernedRemediationInput,
} from "./governed-remediation-coordinator.js";
import {
  GovernedRemediationRecipeRegistry,
  normalizeGovernedRemediationApplyResult,
  normalizeGovernedRemediationReconcileResult,
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
    activationMode: "not_applicable",
    activationApproval: "not_applicable",
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
    activationMode: "not_applicable",
    activationApproval: "not_applicable",
    verificationProbeId: null,
    rollbackStrategy: "manual_required",
    maxApplyAttempts: 0,
  });
}

interface Barrier {
  readonly entered: Promise<void>;
  release(): void;
  wait(): Promise<void>;
}

function barrier(): Barrier {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return Object.freeze({
    entered,
    release,
    async wait() {
      enter();
      await blocked;
    },
  });
}

class FakeConfigurationOwner implements GovernedRemediationOwnerPort {
  public readonly ownerId = "configuration-owner";
  public readonly targetId = "configuration.target";
  public readonly requestedCapabilityId = "configuration.write-governed";
  public activationMode: "not_applicable" | "owner_step" = "not_applicable";
  public readonly events: string[];
  public verifyFails = false;
  public failProbeOnCall: number | null = null;
  public probeCalls = 0;
  public rollbackFails = false;
  public applyThrowsAfterCommit = false;
  public applyRejectsRemaining = 0;
  public malformedApplySecret: string | null = null;
  public rawApplyCalls = 0;
  public committedApplyCount = 0;
  public activateCalls = 0;
  public rollbackCalls = 0;
  public revision = "owner-revision-1";
  public effectPresent = false;
  public effectVerified = false;
  public rolledBack = false;
  public applyBarrier: Barrier | null = null;
  public reconcileOverride: GovernedRemediationReconcileResult | null = null;
  private readonly applyByOperation = new Map<string, GovernedRemediationApplyResult>();
  private readonly activationByOperation = new Map<
    string,
    { status: "activated"; ownerRevisionBefore: string; ownerRevisionAfter: string }
  >();
  private readonly rollbackByOperation = new Map<
    string,
    { status: "rolled_back"; ownerRevisionBefore: string; ownerRevisionAfter: string }
  >();

  public constructor(events: string[] = []) {
    this.events = events;
  }

  public async preflight() {
    return { status: "ready" as const, ownerRevision: this.revision };
  }

  public async apply(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationApplyResult> {
    this.rawApplyCalls += 1;
    this.events.push("apply");
    const replay = this.applyByOperation.get(context.operationId);
    if (replay) return replay;
    if (this.applyBarrier) await this.applyBarrier.wait();
    if (this.applyRejectsRemaining > 0) {
      this.applyRejectsRemaining -= 1;
      const rejected = {
        status: "rejected" as const,
        reason: "owner_unavailable" as const,
        ownerRevisionObserved: this.revision,
      };
      this.applyByOperation.set(context.operationId, rejected);
      return rejected;
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
    if (this.applyThrowsAfterCommit) {
      this.applyThrowsAfterCommit = false;
      throw new Error("RAW_OWNER_SECRET_apply_response_lost");
    }
    if (this.malformedApplySecret) {
      return { ...result, rawProviderToken: this.malformedApplySecret } as never;
    }
    return result;
  }

  public async probe() {
    this.probeCalls += 1;
    if (this.verifyFails || this.probeCalls === this.failProbeOnCall) {
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

  public async activate(context: GovernedRemediationOwnerContext) {
    this.activateCalls += 1;
    const replay = this.activationByOperation.get(context.operationId);
    if (replay) return replay;
    const result = {
      status: "activated" as const,
      ownerRevisionBefore: this.revision,
      ownerRevisionAfter: "owner-revision-3",
    };
    this.revision = result.ownerRevisionAfter;
    this.activationByOperation.set(context.operationId, result);
    return result;
  }

  public async rollback(context: GovernedRemediationOwnerContext) {
    this.rollbackCalls += 1;
    const replay = this.rollbackByOperation.get(context.operationId);
    if (replay) return replay;
    if (this.rollbackFails) {
      return { status: "failed" as const, ownerRevisionObserved: this.revision, effectState: "unknown" as const };
    }
    const result = {
      status: "rolled_back" as const,
      ownerRevisionBefore: this.revision,
      ownerRevisionAfter: "owner-revision-rollback",
    };
    this.effectPresent = false;
    this.effectVerified = false;
    this.rolledBack = true;
    this.revision = result.ownerRevisionAfter;
    this.rollbackByOperation.set(context.operationId, result);
    return result;
  }

  public async reconcile(context: GovernedRemediationOwnerContext): Promise<GovernedRemediationReconcileResult> {
    if (this.reconcileOverride) return this.reconcileOverride;
    const application = {
      effectId: context.effectId,
      ownerRevisionBefore: "owner-revision-1",
      ownerRevisionAfter: "owner-revision-2",
    };
    if (this.rolledBack) {
      return {
        observation: "rolled_back",
        application,
        ownerRevisionBefore: "owner-revision-2",
        ownerRevisionAfter: this.revision,
      };
    }
    if (this.effectPresent) {
      return {
        observation: this.effectVerified ? "effect_verified" : "effect_present_unverified",
        application,
        ownerRevisionObserved: this.revision,
      };
    }
    return { observation: "effect_absent", ownerRevisionObserved: this.revision };
  }
}

class FakeDurableParent implements GovernedRemediationDurableParentPort {
  public readonly events: string[];
  public reserveCalls = 0;
  public resumeCalls = 0;
  public throwAfterReserveCommit = false;
  public throwAfterResumeCommit = false;
  public rejectResume = false;
  public observationOverride: GovernedRemediationDurableResumeObservation | null = null;
  public readonly reserveRequests: GovernedRemediationParentReservationRequest[] = [];
  public readonly resumeRequests: GovernedRemediationDurableResumeRequest[] = [];
  private readonly reservations = new Map<string, string>();
  private readonly resumes = new Map<string, number>();

  public constructor(events: string[] = []) {
    this.events = events;
  }

  public async reserve(request: GovernedRemediationParentReservationRequest) {
    this.reserveCalls += 1;
    this.reserveRequests.push(request);
    this.events.push("reserve");
    const replay = this.reservations.get(request.idempotencyKey);
    if (replay) return { status: "reserved" as const, reservationId: replay, replayed: true };
    const reservationId = `reservation-${request.remediationId}`;
    this.reservations.set(request.idempotencyKey, reservationId);
    if (this.throwAfterReserveCommit) {
      this.throwAfterReserveCommit = false;
      throw new Error("reservation response lost");
    }
    return { status: "reserved" as const, reservationId, replayed: false };
  }

  public async resume(request: GovernedRemediationDurableResumeRequest) {
    this.resumeCalls += 1;
    this.resumeRequests.push(request);
    const replay = this.resumes.get(request.idempotencyKey);
    if (replay !== undefined) return { status: "resumed" as const, resumedRunVersion: replay, replayed: true };
    if (this.rejectResume) return { status: "rejected" as const, reason: "resume_failed" as const };
    const resumedRunVersion = request.expectedWaitingRunVersion + 1;
    this.resumes.set(request.idempotencyKey, resumedRunVersion);
    if (this.throwAfterResumeCommit) {
      this.throwAfterResumeCommit = false;
      throw new Error("resume response lost");
    }
    return { status: "resumed" as const, resumedRunVersion, replayed: false };
  }

  public async observeResume(request: GovernedRemediationDurableResumeRequest) {
    if (this.observationOverride) return this.observationOverride;
    const resumedRunVersion = this.resumes.get(request.idempotencyKey);
    return resumedRunVersion === undefined
      ? ({ observation: "resume_pending" } as const)
      : ({ observation: "resume_completed", resumedRunVersion } as const);
  }
}

class RecordingAuthority implements GovernedRemediationAuthorityPort {
  public readonly requests: GovernedRemediationAuthorityRequest[] = [];
  public requirePreEffectApproval = false;
  public requireActivationApproval = false;
  public malformed = false;
  public authorizePreflightCalls = Number.POSITIVE_INFINITY;

  public async authorize(request: GovernedRemediationAuthorityRequest) {
    this.requests.push(request);
    if (this.malformed) return { status: "authorized", rawPolicyToken: "RAW_POLICY_SECRET" } as never;
    if (
      request.phase === "preflight" &&
      this.requests.filter((candidate) => candidate.phase === "preflight").length > this.authorizePreflightCalls
    ) {
      return { status: "denied" as const, reason: "policy_denied" as const };
    }
    if (
      this.requirePreEffectApproval &&
      (request.phase === "preflight" || request.phase === "apply") &&
      (request.approvalPurpose !== "pre_effect" || request.approvalId !== "approval-pre")
    ) {
      return { status: "denied" as const, reason: "approval_missing_or_expired" as const };
    }
    if (
      this.requireActivationApproval &&
      request.phase === "activate" &&
      (request.approvalPurpose !== "activation" || request.approvalId !== "approval-activation")
    ) {
      return { status: "denied" as const, reason: "approval_missing_or_expired" as const };
    }
    return { status: "authorized" as const };
  }
}

function createHarness(
  input: {
    configuredRecipe?: GovernedRemediationRecipe;
    owner?: FakeConfigurationOwner;
    parent?: FakeDurableParent;
    authority?: RecordingAuthority;
    phaseLeaseDurationSeconds?: number;
    extraRegistrations?: ConstructorParameters<typeof GovernedRemediationRecipeRegistry>[0];
    completionPorts?: readonly GovernedRemediationCompletionRegistration[];
  } = {},
) {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-remediation-coordinator-${randomUUID()}.db`);
  files.push(dbPath);
  const db = createDatabase({ dbPath });
  opened.push(db);
  const repository = new GovernedRemediationRepository(db);
  const events: string[] = [];
  const owner = input.owner ?? new FakeConfigurationOwner(events);
  const parent = input.parent ?? new FakeDurableParent(events);
  const authority = input.authority ?? new RecordingAuthority();
  const configuredRecipe = input.configuredRecipe ?? recipe();
  const registry = new GovernedRemediationRecipeRegistry([
    {
      recipe: configuredRecipe,
      owner: configuredRecipe.executionMode === "manual_required" ? null : owner,
    },
    ...(input.extraRegistrations ?? []),
  ]);
  const makeCoordinator = (claimantId: string) =>
    new GovernedRemediationCoordinator({
      repository,
      registry,
      authority,
      durableParent: parent,
      deploymentProfile: "trusted_local",
      claimantId,
      phaseLeaseDurationSeconds: input.phaseLeaseDurationSeconds ?? 30,
      completionPorts: input.completionPorts,
      now: () => "2026-08-08T21:00:00.000Z",
    });
  const coordinator = makeCoordinator("gateway-worker-a");
  return {
    db,
    dbPath,
    repository,
    owner,
    parent,
    authority,
    registry,
    coordinator,
    makeCoordinator,
    configuredRecipe,
    events,
  };
}

function startInput(overrides: Partial<StartGovernedRemediationInput> = {}): StartGovernedRemediationInput {
  return {
    remediationId: "remediation-1",
    requesterActorId: "actor-1",
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
    creationIdempotencyKey: "create-remediation-1",
    requestedAt: "2026-08-08T20:00:00.000Z",
    ...overrides,
  };
}

async function proceed(harness: ReturnType<typeof createHarness>, remediationId = "remediation-1") {
  const current = harness.repository.getState(remediationId);
  return harness.coordinator.continue({
    remediationId,
    requesterActorId: current.record.requesterActorId,
    workspaceId: current.record.workspaceId,
    expectedStateRevision: current.record.revision,
    commandIdempotencyKey: `proceed-${remediationId}-${current.record.revision}`,
    action: { kind: "proceed" },
  });
}

describe("GovernedRemediationRecipeRegistry runtime boundary", () => {
  it("rejects recipe/owner drift and exact owner envelopes containing extra or secret-like fields", () => {
    const owner = new FakeConfigurationOwner();
    expect(() => new GovernedRemediationRecipeRegistry([{ recipe: recipe(), owner }])).not.toThrow();

    const activationOwner = new FakeConfigurationOwner();
    activationOwner.activationMode = "owner_step";
    expect(() => new GovernedRemediationRecipeRegistry([{ recipe: recipe(), owner: activationOwner }])).toThrow(
      /owner binding does not match/u,
    );

    expect(() =>
      normalizeGovernedRemediationApplyResult({
        status: "applied",
        effectId: "effect-a",
        ownerRevisionBefore: "revision-1",
        ownerRevisionAfter: "revision-2",
        rawProviderToken: "ghp_123456789012345678901234567890",
      }),
    ).toThrow(/invalid key set/u);
    expect(() =>
      normalizeGovernedRemediationApplyResult({
        status: "applied",
        effectId: "ghp_123456789012345678901234567890",
        ownerRevisionBefore: "revision-1",
        ownerRevisionAfter: "revision-2",
      }),
    ).toThrow(/secret-free identifier/u);
    expect(() =>
      normalizeGovernedRemediationReconcileResult({
        observation: "rolled_back",
        application: {
          effectId: "effect-a",
          ownerRevisionBefore: "revision-1",
          ownerRevisionAfter: "revision-2",
        },
        ownerRevisionAfter: "revision-3",
      }),
    ).toThrow(/invalid key set/u);
  });
});

describe("GovernedRemediationCoordinator v2 authority", () => {
  it("separates creation from continuation and binds requester, workspace, recipe digest, and revision", async () => {
    const harness = createHarness();
    const created = harness.coordinator.start(startInput());
    expect(created.record).toMatchObject({
      state: "blocked",
      revision: 1,
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
    });
    expect(created.record.recipeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(harness.owner.rawApplyCalls).toBe(0);
    expect(harness.parent.reserveCalls).toBe(0);

    await expect(
      harness.coordinator.continue({
        remediationId: "remediation-1",
        requesterActorId: "actor-other",
        workspaceId: "workspace-1",
        expectedStateRevision: 1,
        commandIdempotencyKey: "wrong-actor",
        action: { kind: "proceed" },
      }),
    ).rejects.toThrow(/not found/u);
    await expect(
      harness.coordinator.continue({
        remediationId: "remediation-1",
        requesterActorId: "actor-1",
        workspaceId: "workspace-other",
        expectedStateRevision: 1,
        commandIdempotencyKey: "wrong-workspace",
        action: { kind: "proceed" },
      }),
    ).rejects.toThrow(/not found/u);
    await expect(
      harness.coordinator.continue({
        remediationId: "remediation-1",
        requesterActorId: "actor-1",
        workspaceId: "workspace-1",
        expectedStateRevision: 2,
        commandIdempotencyKey: "stale",
        action: { kind: "proceed" },
      }),
    ).rejects.toThrow(/stale state revision/u);
    expect(() =>
      harness.coordinator.start(
        startInput({ requesterActorId: "actor-other", creationIdempotencyKey: "create-remediation-drift" }),
      ),
    ).toThrow(/conflicts with durable authority|conflict/u);
    expect(() =>
      createHarness().coordinator.start(
        startInput({
          remediationId: "remediation-wildcard",
          expectedOwnerRevision: null,
          creationIdempotencyKey: "create-remediation-wildcard",
        }),
      ),
    ).toThrow(/exact initial owner revision/u);
    expect(() =>
      createHarness().coordinator.start(
        startInput({
          remediationId: "remediation-future",
          requestedAt: "2099-01-01T00:00:00.000Z",
          creationIdempotencyKey: "create-remediation-future",
        }),
      ),
    ).toThrow(/too far in the future/u);
    expect(harness.owner.rawApplyCalls).toBe(0);
  });

  it("reserves the exact parent checkpoint before one claimed effect and completes with atomic receipts", async () => {
    const harness = createHarness();
    harness.parent.throwAfterReserveCommit = true;
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(result.record.state).toBe("completed");
    expect(harness.events.indexOf("reserve")).toBeLessThan(harness.events.indexOf("apply"));
    expect(harness.parent.reserveCalls).toBe(2);
    expect(new Set(harness.parent.reserveRequests.map((request) => request.idempotencyKey)).size).toBe(1);
    expect(harness.parent.reserveRequests[0]).toMatchObject({
      stateRevision: 2,
      expectedOwnerRevision: "owner-revision-1",
      preEffectApprovalId: null,
      promptId: null,
    });
    expect(harness.owner.committedApplyCount).toBe(1);
    expect(harness.repository.listReceipts("remediation-1").map((receipt) => receipt.kind)).toEqual([
      "application",
      "verification",
      "resume",
    ]);
    expect(harness.parent.resumeRequests[0]).toMatchObject({
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      durableRunId: "durable-run-1",
      blockedCheckpointId: "checkpoint-1",
      parentReservationId: "reservation-remediation-1",
    });
  });

  it("keeps pre-effect and activation approvals purpose-bound and refuses approval reuse", async () => {
    const configuredRecipe = recipe({
      preEffectApproval: "required_before_apply",
      activationMode: "owner_step",
      activationApproval: "required",
    });
    const owner = new FakeConfigurationOwner();
    owner.activationMode = "owner_step";
    const authority = new RecordingAuthority();
    authority.requirePreEffectApproval = true;
    authority.requireActivationApproval = true;
    const harness = createHarness({ configuredRecipe, owner, authority });
    harness.coordinator.start(startInput());

    const awaitingPre = await proceed(harness);
    expect(awaitingPre.record.state).toBe("awaiting_preapproval");
    expect(owner.rawApplyCalls).toBe(0);
    const awaitingActivation = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: awaitingPre.record.revision,
      commandIdempotencyKey: "approve-pre",
      action: { kind: "approve_pre_effect", approvalId: "approval-pre" },
    });
    expect(awaitingActivation.record.state).toBe("awaiting_activation_approval");
    expect(awaitingActivation.record.preEffectApprovalId).toBe("approval-pre");
    expect(awaitingActivation.record.activationApprovalId).toBeNull();

    await expect(
      harness.coordinator.continue({
        remediationId: "remediation-1",
        requesterActorId: "actor-1",
        workspaceId: "workspace-1",
        expectedStateRevision: awaitingActivation.record.revision,
        commandIdempotencyKey: "reuse-pre-for-activation",
        action: { kind: "approve_activation", approvalId: "approval-pre" },
      }),
    ).rejects.toThrow(/must be distinct/u);

    const completed = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: awaitingActivation.record.revision,
      commandIdempotencyKey: "approve-activation",
      action: { kind: "approve_activation", approvalId: "approval-activation" },
    });
    expect(completed.record.state).toBe("completed");
    expect(completed.record.activationApprovalId).toBe("approval-activation");
    expect(owner.activateCalls).toBe(1);
    expect(harness.repository.listReceipts("remediation-1").map((receipt) => receipt.kind)).toEqual([
      "application",
      "verification",
      "activation",
      "verification",
      "resume",
    ]);
    expect(
      authority.requests
        .filter((request) => request.phase === "apply" || request.phase === "activate")
        .map(({ phase, approvalPurpose, approvalId }) => ({ phase, approvalPurpose, approvalId })),
    ).toEqual([
      { phase: "apply", approvalPurpose: "pre_effect", approvalId: "approval-pre" },
      { phase: "activate", approvalPurpose: "activation", approvalId: "approval-activation" },
    ]);
  });

  it("distinguishes approval-before-input from approval-before-apply", async () => {
    const configuredRecipe = recipe({ inputKind: "operator_confirmation", preEffectApproval: "required_before_apply" });
    const authority = new RecordingAuthority();
    authority.requirePreEffectApproval = true;
    const harness = createHarness({ configuredRecipe, authority });
    harness.coordinator.start(startInput());

    const inputBound = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: 1,
      commandIdempotencyKey: "bind-confirmation",
      action: {
        kind: "proceed",
        prompt: { promptId: "confirmation-1", promptExpiresAt: "2026-08-08T22:00:00.000Z" },
      },
    });
    expect(inputBound.record).toMatchObject({ state: "awaiting_secure_input", preEffectApprovalId: null });
    expect(harness.parent.reserveCalls).toBe(0);
    expect(harness.owner.rawApplyCalls).toBe(0);

    const completed = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: inputBound.record.revision,
      commandIdempotencyKey: "approve-confirmation-apply",
      action: { kind: "approve_pre_effect", approvalId: "approval-pre" },
    });
    expect(completed.record.state).toBe("completed");
    expect(harness.parent.reserveRequests[0]).toMatchObject({
      preEffectApprovalId: "approval-pre",
      promptId: "confirmation-1",
    });
  });

  it("publishes the application receipt and state transition before a lost response and never reapplies", async () => {
    const harness = createHarness();
    const original = harness.repository.publishClaimedPhaseOutcome.bind(harness.repository);
    let injected = false;
    harness.repository.publishClaimedPhaseOutcome = (input) => {
      const result = original(input);
      if (!injected && input.outcome.kind === "state_receipt" && input.outcome.receipt.kind === "application") {
        injected = true;
        expect(harness.repository.getState("remediation-1").record.state).toBe("verifying");
        expect(harness.repository.listReceipts("remediation-1")).toContainEqual(input.outcome.receipt);
        throw new Error("simulated response loss after atomic commit");
      }
      return result;
    };
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(injected).toBe(true);
    expect(result.record.state).toBe("completed");
    expect(harness.owner.rawApplyCalls).toBe(1);
    expect(harness.owner.committedApplyCount).toBe(1);
    expect(
      harness.repository.listReceipts("remediation-1").filter((receipt) => receipt.kind === "application"),
    ).toHaveLength(1);
  });

  it("persists activation lineage before rolling back a rejected post-activation probe", async () => {
    const configuredRecipe = recipe({ activationMode: "owner_step", activationApproval: "not_required" });
    const owner = new FakeConfigurationOwner();
    owner.activationMode = "owner_step";
    owner.failProbeOnCall = 2;
    const harness = createHarness({ configuredRecipe, owner });
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(result.record.state).toBe("rolled_back");
    const receipts = harness.repository.listReceipts("remediation-1");
    expect(receipts.map((receipt) => receipt.kind)).toEqual(["application", "verification", "activation", "rollback"]);
    const activation = receipts.find((receipt) => receipt.kind === "activation");
    const rollback = receipts.find((receipt) => receipt.kind === "rollback");
    expect(activation).toMatchObject({
      ownerRevisionBefore: "owner-revision-2",
      ownerRevisionAfter: "owner-revision-3",
    });
    expect(rollback).toMatchObject({ ownerRevisionBefore: activation?.ownerRevisionAfter });
  });

  it("uses a new claim and fresh authority for each bounded no-effect apply retry", async () => {
    const owner = new FakeConfigurationOwner();
    owner.applyRejectsRemaining = 1;
    const harness = createHarness({ owner });
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(result.record.state).toBe("completed");
    expect(owner.rawApplyCalls).toBe(2);
    expect(owner.committedApplyCount).toBe(1);
    expect(harness.authority.requests.filter((request) => request.phase === "apply")).toHaveLength(2);
    expect(harness.repository.listFailures("remediation-1")).toMatchObject([
      {
        phase: "apply",
        effectBoundary: "not_crossed",
        disposition: "retry_with_fresh_authority",
      },
    ]);
  });

  it("fails closed on a malformed authority envelope before reserving or applying", async () => {
    const authority = new RecordingAuthority();
    authority.malformed = true;
    const harness = createHarness({ authority });
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(result.record.state).toBe("failed");
    expect(harness.parent.reserveCalls).toBe(0);
    expect(harness.owner.rawApplyCalls).toBe(0);
    expect(harness.repository.listFailures("remediation-1")).toMatchObject([
      { phase: "preflight", reason: "policy_denied", effectBoundary: "not_crossed" },
    ]);
  });

  it("rechecks authority after remote preflight immediately before parent reservation", async () => {
    const authority = new RecordingAuthority();
    authority.authorizePreflightCalls = 1;
    const harness = createHarness({ authority });
    harness.coordinator.start(startInput());

    const result = await proceed(harness);

    expect(result.record.state).toBe("failed");
    expect(authority.requests.filter((request) => request.phase === "preflight")).toHaveLength(2);
    expect(harness.parent.reserveCalls).toBe(0);
    expect(harness.owner.rawApplyCalls).toBe(0);
    expect(harness.repository.listFailures("remediation-1")).toMatchObject([
      { phase: "preflight", reason: "policy_denied", effectBoundary: "not_crossed" },
    ]);
  });

  it("allows only one competing phase worker to cross the effect boundary", async () => {
    const harness = createHarness();
    const gate = barrier();
    harness.owner.applyBarrier = gate;
    harness.coordinator.start(startInput());
    const workerA = proceed(harness);
    await gate.entered;
    expect(harness.repository.getState("remediation-1").record.state).toBe("applying");

    const workerB = harness.makeCoordinator("gateway-worker-b");
    const recovery = await workerB.recover({ limit: 10, pageSize: 1 });
    expect(recovery.failures).toEqual([]);
    expect(harness.owner.rawApplyCalls).toBe(1);
    expect(harness.owner.committedApplyCount).toBe(0);

    gate.release();
    const completed = await workerA;
    expect(completed.record.state).toBe("completed");
    expect(harness.owner.rawApplyCalls).toBe(1);
    expect(harness.owner.committedApplyCount).toBe(1);
  });

  it("quarantines an uncertain effect without persisting unbound owner output and resolves exact receipt lineage", async () => {
    const owner = new FakeConfigurationOwner();
    owner.applyThrowsAfterCommit = true;
    const harness = createHarness({ owner });
    harness.coordinator.start(startInput());
    const quarantined = await proceed(harness);
    expect(quarantined.record.state).toBe("failed");
    expect(harness.repository.listReceipts("remediation-1")).toEqual([]);
    const [reconciliation] = harness.repository.listReconciliationRecoveryCandidates({ domains: ["effect"] });
    expect(reconciliation).toMatchObject({ domain: "effect", state: "quarantined", observation: "unknown" });

    owner.effectVerified = true;
    const recovered = await harness.coordinator.recoverReconciliations({ limit: 10, pageSize: 1 });
    expect(recovered.failures).toEqual([]);
    expect(recovered.reconciliations[0]).toMatchObject({ state: "resolved_verified", domain: "effect" });
    expect(harness.authority.requests.find((request) => request.phase === "effect_reconcile")).toMatchObject({
      phaseAggregateKind: "reconciliation",
      phaseAggregateId: reconciliation?.reconciliationId,
      phaseAggregateRevision: reconciliation?.revision,
    });
    const receipts = harness.repository.listReceipts("remediation-1");
    const application = receipts.find((receipt) => receipt.kind === "application");
    const resolution = receipts.find((receipt) => receipt.kind === "reconciliation");
    expect(application).toBeDefined();
    expect(resolution).toMatchObject({
      resolution: "confirmed_verified",
      applicationReceiptId: application?.receiptId,
      resumeReceiptId: null,
    });
  });

  it("rejects reconciliation receipt lineage drift instead of blessing a different effect", async () => {
    const owner = new FakeConfigurationOwner();
    owner.applyThrowsAfterCommit = true;
    const harness = createHarness({ owner });
    harness.coordinator.start(startInput());
    await proceed(harness);
    owner.reconcileOverride = {
      observation: "effect_verified",
      application: {
        effectId: "different-effect",
        ownerRevisionBefore: "owner-revision-1",
        ownerRevisionAfter: "owner-revision-2",
      },
      ownerRevisionObserved: "owner-revision-2",
    };
    const recovered = await harness.coordinator.recoverReconciliations();
    expect(recovered.reconciliations[0]).toMatchObject({ state: "manual_required" });
    expect(harness.repository.listReceipts("remediation-1")).toEqual([]);
  });

  it("recovers a committed resume before recording completion with resume-domain receipts", async () => {
    const parent = new FakeDurableParent();
    parent.throwAfterResumeCommit = true;
    parent.observationOverride = { observation: "unknown" };
    const harness = createHarness({ parent, phaseLeaseDurationSeconds: 1 });
    harness.coordinator.start(startInput());
    const quarantined = await proceed(harness);
    expect(quarantined.record.state).toBe("reconciling_resume");
    expect(parent.resumeCalls).toBe(1);

    parent.observationOverride = null;
    await delay(1_100);
    const recovery = await harness.coordinator.recoverReconciliations({ limit: 10, pageSize: 1 });
    expect(recovery.failures).toEqual([]);
    expect(recovery.states.at(-1)?.record.state).toBe("completed");
    expect(
      harness.authority.requests
        .filter((request) => request.phase === "resume_reconcile")
        .map((request) => request.phaseAggregateRevision),
    ).toEqual([1, 1]);
    const receipts = harness.repository.listReceipts("remediation-1");
    const resumeReceipt = receipts.find((receipt) => receipt.kind === "resume");
    expect(resumeReceipt).toBeDefined();
    expect(receipts.find((receipt) => receipt.kind === "reconciliation")).toMatchObject({
      resolution: "confirmed_resumed",
      applicationReceiptId: null,
      resumeReceiptId: resumeReceipt?.receiptId,
    });
    expect(
      harness.repository
        .listReconciliationRecoveryCandidates({ domains: ["resume"] })
        .filter((candidate) => candidate.state === "open" || candidate.state === "quarantined"),
    ).toEqual([]);
  });

  it("rolls back before terminalizing a declined activation and supports no-effect expiry/manual paths", async () => {
    const configuredRecipe = recipe({ activationMode: "owner_step", activationApproval: "required" });
    const owner = new FakeConfigurationOwner();
    owner.activationMode = "owner_step";
    const harness = createHarness({ configuredRecipe, owner });
    harness.coordinator.start(startInput());
    const awaiting = await proceed(harness);
    expect(awaiting.record.state).toBe("awaiting_activation_approval");
    const declined = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: awaiting.record.revision,
      commandIdempotencyKey: "decline-activation",
      action: { kind: "decline" },
    });
    expect(declined.record.state).toBe("declined");
    expect(owner.rollbackCalls).toBe(1);
    expect(owner.effectPresent).toBe(false);
    expect(harness.repository.listReceipts("remediation-1").at(-1)?.kind).toBe("rollback");

    const manual = createHarness({ configuredRecipe: manualRecipe() });
    manual.coordinator.start(startInput({ recipeId: "recipe.product.manual" }));
    expect((await proceed(manual)).record.state).toBe("manual_required");

    const expiring = createHarness();
    expiring.coordinator.start(startInput());
    const expired = await expiring.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: 1,
      commandIdempotencyKey: "expire-offer",
      action: { kind: "expire" },
    });
    expect(expired.record.state).toBe("expired");
    expect(expiring.owner.rawApplyCalls).toBe(0);
  });

  it("screens malformed owner secrets before durability", async () => {
    const owner = new FakeConfigurationOwner();
    const rawSecret = "ghp_123456789012345678901234567890";
    owner.malformedApplySecret = rawSecret;
    const harness = createHarness({ owner });
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(result.record.state).toBe("failed");
    harness.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    expect(fs.readFileSync(harness.dbPath).toString("utf8")).not.toContain(rawSecret);
    expect(JSON.stringify(harness.repository.listFailures("remediation-1"))).not.toContain(rawSecret);
  });

  it("advances the recovery cursor after an isolated poisoned row", async () => {
    const harness = createHarness();
    const acquire = harness.repository.acquirePhaseClaim.bind(harness.repository);
    harness.repository.acquirePhaseClaim = (input) => {
      if (input.phase === "apply") throw new Error("simulated worker stop before apply claim");
      return acquire(input);
    };
    for (const [remediationId, requestedAt] of [
      ["remediation-a", "2026-08-08T20:00:00.000Z"],
      ["remediation-b", "2026-08-08T20:00:01.000Z"],
    ] as const) {
      harness.coordinator.start(
        startInput({
          remediationId,
          creationIdempotencyKey: `create-${remediationId}`,
          requestedAt,
        }),
      );
      await expect(proceed(harness, remediationId)).rejects.toThrow(/simulated worker stop/u);
      expect(harness.repository.getState(remediationId).record.state).toBe("applying");
    }
    harness.repository.acquirePhaseClaim = acquire;
    const original = harness.repository.acquirePhaseClaim.bind(harness.repository);
    harness.repository.acquirePhaseClaim = (input) => {
      if (input.remediationId === "remediation-a") throw new Error("poisoned row");
      return original(input);
    };
    const recovery = await harness.coordinator.recover({ limit: 10, pageSize: 1 });
    expect(recovery.failures).toContainEqual({
      aggregateKind: "state",
      aggregateId: "remediation-a",
      code: "recovery_failed",
    });
    expect(harness.repository.getState("remediation-b").record.state).toBe("completed");
    expect(harness.owner.committedApplyCount).toBe(1);
  });
});

describe("GovernedRemediationCoordinator completion callback seam", () => {
  function recordingCompletionPort(ownerId = "configuration-owner") {
    const notices: GovernedRemediationCompletionNotice[] = [];
    const registration: GovernedRemediationCompletionRegistration = {
      ownerId,
      port: {
        onRemediationSettled(notice) {
          notices.push(notice);
        },
      },
    };
    return { notices, registration };
  }

  it("rejects duplicate or malformed completion registrations", () => {
    const { registration } = recordingCompletionPort();
    expect(() => createHarness({ completionPorts: [registration, registration] })).toThrow(/already registered/u);
    expect(() =>
      createHarness({
        completionPorts: [{ ownerId: "configuration-owner", port: {} as never }],
      }),
    ).toThrow(/onRemediationSettled/u);
  });

  it("notifies the exact owner once after durable completion and stays queryable for boot replay", async () => {
    const { notices, registration } = recordingCompletionPort();
    const foreign = recordingCompletionPort("some-other-owner");
    const harness = createHarness({ completionPorts: [registration, foreign.registration] });
    harness.coordinator.start(startInput());
    expect(harness.coordinator.completionNoticeFor("remediation-1")).toBeNull();
    expect(harness.coordinator.completionNoticeFor("remediation-missing")).toBeNull();

    const result = await proceed(harness);
    expect(result.record.state).toBe("completed");
    expect(foreign.notices).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      remediationId: "remediation-1",
      ownerId: "configuration-owner",
      recipeId: "recipe.declarative.configuration",
      terminalState: "completed",
      effectDisposition: "effect_applied",
      effectId: result.record.effectId,
      latestReceiptId: result.record.latestReceiptId,
    });
    expect(harness.coordinator.completionNoticeFor("remediation-1")).toEqual(notices[0]);
  });

  it("keeps settlement durable when the completion callback itself fails", async () => {
    let calls = 0;
    const harness = createHarness({
      completionPorts: [
        {
          ownerId: "configuration-owner",
          port: {
            onRemediationSettled() {
              calls += 1;
              throw new Error("completion port crashed");
            },
          },
        },
      ],
    });
    harness.coordinator.start(startInput());
    const result = await proceed(harness);
    expect(result.record.state).toBe("completed");
    expect(calls).toBe(1);
    expect(harness.coordinator.completionNoticeFor("remediation-1")).toMatchObject({
      effectDisposition: "effect_applied",
    });
  });

  it("reports no_effect for pre-effect terminal outcomes", async () => {
    const { notices, registration } = recordingCompletionPort();
    const harness = createHarness({ completionPorts: [registration] });
    harness.coordinator.start(startInput());
    const declined = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: 1,
      commandIdempotencyKey: "decline-before-effect",
      action: { kind: "decline" },
    });
    expect(declined.record.state).toBe("declined");
    expect(harness.owner.rawApplyCalls).toBe(0);
    expect(notices.at(-1)).toMatchObject({ terminalState: "declined", effectDisposition: "no_effect" });
    expect(harness.coordinator.completionNoticeFor("remediation-1")).toMatchObject({
      effectDisposition: "no_effect",
    });
  });

  it("reports effect_rolled_back after a rollback-terminated remediation", async () => {
    const configuredRecipe = recipe({ activationMode: "owner_step", activationApproval: "required" });
    const owner = new FakeConfigurationOwner();
    owner.activationMode = "owner_step";
    const { notices, registration } = recordingCompletionPort();
    const harness = createHarness({ configuredRecipe, owner, completionPorts: [registration] });
    harness.coordinator.start(startInput());
    const awaiting = await proceed(harness);
    expect(awaiting.record.state).toBe("awaiting_activation_approval");
    expect(notices).toEqual([]);
    const declined = await harness.coordinator.continue({
      remediationId: "remediation-1",
      requesterActorId: "actor-1",
      workspaceId: "workspace-1",
      expectedStateRevision: awaiting.record.revision,
      commandIdempotencyKey: "decline-activation-completion",
      action: { kind: "decline" },
    });
    expect(declined.record.state).toBe("declined");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ terminalState: "declined", effectDisposition: "effect_rolled_back" });
  });

  it("holds effect_unknown while an effect reconciliation is open and settles it after recovery", async () => {
    const owner = new FakeConfigurationOwner();
    owner.applyThrowsAfterCommit = true;
    const { notices, registration } = recordingCompletionPort();
    const harness = createHarness({ owner, completionPorts: [registration] });
    harness.coordinator.start(startInput());
    const quarantined = await proceed(harness);
    expect(quarantined.record.state).toBe("failed");
    expect(notices.at(-1)).toMatchObject({ terminalState: "failed", effectDisposition: "effect_unknown" });
    expect(harness.coordinator.completionNoticeFor("remediation-1")).toMatchObject({
      effectDisposition: "effect_unknown",
    });

    owner.effectVerified = true;
    const recovered = await harness.coordinator.recoverReconciliations({ limit: 10, pageSize: 1 });
    expect(recovered.reconciliations[0]).toMatchObject({ state: "resolved_verified" });
    expect(harness.coordinator.completionNoticeFor("remediation-1")).toMatchObject({
      terminalState: "failed",
      effectDisposition: "effect_applied",
    });
  });
});
