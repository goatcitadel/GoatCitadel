import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@goatcitadel/contracts";
import { Storage, createSqliteAsyncStorage } from "@goatcitadel/storage";
import {
  SkillStateService,
  type SkillStateMutationPendingOutcome,
  type SkillStateServiceHost,
} from "./skill-state-service.js";
import { SkillLifecycleApplyError } from "./skill-governance-journey-producer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

interface Harness {
  storage: Storage;
  service: SkillStateService;
  publishRealtime: ReturnType<typeof vi.fn>;
  host: SkillStateServiceHost;
  requesterId: string;
  resolverId: string;
}

function createHarness(options?: { skills?: string[]; withoutAuthority?: boolean }): Harness {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  const asyncStorage = createSqliteAsyncStorage(storage);
  cleanups.push(() => storage.close());
  const publishRealtime = vi.fn();
  const host: SkillStateServiceHost = {
    listSkills: () => (options?.skills ?? ["skill-alpha", "skill-beta"]).map((skillId) => ({ skillId })),
    recordAutonomousMutation: vi.fn(),
    recordDevDiagnostic: vi.fn(),
    publishRealtime,
  };
  const service = new SkillStateService(
    {
      storage: asyncStorage,
      systemSettings: asyncStorage.systemSettings,
      skillAggregateRevisions: asyncStorage.skillAggregateRevisions,
      ...(options?.withoutAuthority
        ? {}
        : {
            approvalAuthority: {
              approvals: asyncStorage.approvals,
              approvalEvents: asyncStorage.approvalEvents,
              governanceJourneyEvents: asyncStorage.governanceJourneyEvents,
            },
          }),
    },
    host,
  );
  return {
    storage,
    service,
    publishRealtime,
    host,
    requesterId: "operator-requester",
    resolverId: "operator-resolver",
  };
}

function countRows(harness: Harness, table: string): number {
  const row = harness.storage.gatewaySql.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function readSkillRow(harness: Harness, skillId: string): { state: string; note: string | null } | undefined {
  return harness.storage.gatewaySql
    .prepare(`SELECT state, note FROM skill_state WHERE skill_id = @skillId`)
    .get({ skillId }) as { state: string; note: string | null } | undefined;
}

function readGovernedEvent(
  harness: Harness,
  eventId: string,
): { operation: string; actorType: string; approvalId: string | null; actorId: string } | undefined {
  return harness.storage.gatewaySql
    .prepare(
      `SELECT operation, actor_type AS actorType, approval_id AS approvalId, actor_id AS actorId
       FROM governed_lifecycle_events WHERE event_id = @eventId`,
    )
    .get({ eventId }) as
    | { operation: string; actorType: string; approvalId: string | null; actorId: string }
    | undefined;
}

async function requestPending(
  harness: Harness,
  skillId: string,
  state: "enabled" | "sleep" | "disabled",
  note?: string,
): Promise<SkillStateMutationPendingOutcome> {
  const revision = harness.storage.skillAggregateRevisions.ensure("runtime_skill", skillId).revision;
  const outcome = await harness.service.requestSkillStateApproval(skillId, state, note, {
    expectedRevision: revision,
    requesterId: harness.requesterId,
  });
  if (!outcome.pendingApproval) throw new Error("expected a pending approval");
  return outcome as SkillStateMutationPendingOutcome;
}

describe("skill state substrate (reads, defaults, usage metadata)", () => {
  it("ensures default rows, reads decorated states, and records usage", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha", "skill-alpha", "skill-beta"]);
    const states = await harness.service.readSkillStates();
    expect(states.get("skill-alpha")).toMatchObject({ state: "enabled", revision: 1 });
    expect(states.get("skill-beta")).toMatchObject({ state: "enabled" });
    await harness.service.recordSkillUsage(["skill-alpha", " ", "skill-alpha"]);
    expect((await harness.service.readSkillStates()).get("skill-alpha")).toMatchObject({ usageCount: 1 });
  });

  it("returns the default activation policy with a canonical revision", async () => {
    const harness = createHarness();
    expect(await harness.service.getActivationPolicy()).toMatchObject({
      revision: 1,
      guardedAutoThreshold: 0.72,
      requireFirstUseConfirmation: true,
    });
  });
});

// HX-402 P2: every operator skill-state mutation is approval-first. These
// tests model the NEW contract (coverage-preserving rewrite of the retired
// direct setSkillState/bulkSetSkillState/updateActivationPolicy flows):
// request -> approve -> recovered effect -> governed evidence, with the P0
// governed lifecycle owner as the immutable backstop.
describe("approval-first skill state mutations", () => {
  it("requests approval with zero pre-approval mutation and deterministic replayed identity", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);

    const envelope = await requestPending(harness, "skill-alpha", "disabled", "Pause for review");
    expect(envelope.pendingApproval).toMatchObject({
      kind: "skill.lifecycle",
      action: "skill_state_set",
      subjectKind: "skill",
      subjectId: "skill-alpha",
      status: "pending",
      replayed: false,
      skillIds: ["skill-alpha"],
    });
    expect(envelope.pendingApproval.approvalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Byte-exact replay converges on the original approval identity.
    const replay = await requestPending(harness, "skill-alpha", "disabled", "Pause for review");
    expect(replay.pendingApproval.approvalId).toBe(envelope.pendingApproval.approvalId);
    expect(replay.pendingApproval.replayed).toBe(true);

    // No durable mutation before approval.
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "enabled" });
    expect(countRows(harness, "governed_lifecycle_events")).toBe(0);
    // Requester Journey evidence commits atomically with the approval.
    const evidence = harness.storage.governanceJourneyEvents.findByIdempotencyKey(
      `skill:lifecycle:request:${envelope.pendingApproval.approvalId}`,
    );
    expect(evidence).toMatchObject({
      actorId: harness.requesterId,
      approvalId: envelope.pendingApproval.approvalId,
      action: "mutation_requested",
    });
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "skill_mutation_approval_requested",
      "skills",
      expect.objectContaining({ approvalId: envelope.pendingApproval.approvalId }),
    );
  });

  it("treats a byte-identical current state as a pure no-op with no approval row", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    const revision = harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision;
    const outcome = await harness.service.requestSkillStateApproval("skill-alpha", "enabled", undefined, {
      expectedRevision: revision,
      requesterId: harness.requesterId,
    });
    expect(outcome.pendingApproval).toBeNull();
    expect(outcome).toMatchObject({ noMutationRequired: true });
    expect(countRows(harness, "approvals")).toBe(0);
    expect(countRows(harness, "governed_lifecycle_events")).toBe(0);
  });

  it("rejects unknown skills, stale revisions, and pinned skills at request time", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    await expect(
      harness.service.requestSkillStateApproval("skill-missing", "disabled", undefined, {
        expectedRevision: 1,
      }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      harness.service.requestSkillStateApproval("skill-alpha", "disabled", undefined, {
        expectedRevision: 99,
      }),
    ).rejects.toThrow(/changed since revision/);
    harness.storage.systemSettings.set("skill_state_metadata_v1", { "skill-alpha": { pinned: true } });
    await expect(
      harness.service.requestSkillStateApproval("skill-alpha", "disabled", undefined, {
        expectedRevision: harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision,
      }),
    ).rejects.toThrow(/Pinned skill/);
  });

  it("fails closed without the canonical approval authority host", async () => {
    const harness = createHarness({ withoutAuthority: true });
    await harness.service.ensureSkillStates(["skill-alpha"]);
    await expect(
      harness.service.requestSkillStateApproval("skill-alpha", "disabled", undefined, { expectedRevision: 1 }),
    ).rejects.toThrow(/approval authority host/);
    await expect(harness.service.executeApprovedSkillLifecycleMutation({ approvalId: "missing" })).rejects.toThrow(
      /approval authority host/,
    );
  });

  it("executes an approved transition through the recovered effect and writes coupled governed evidence", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    const envelope = await requestPending(harness, "skill-alpha", "sleep", "Quiet hours");

    // The executor refuses to run before the approval resolves.
    await expect(
      harness.service.executeApprovedSkillLifecycleMutation({ approvalId: envelope.pendingApproval.approvalId }),
    ).rejects.toThrow(SkillLifecycleApplyError);
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "enabled" });

    harness.storage.approvals.resolve(envelope.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: harness.resolverId,
    });
    const applied = await harness.service.executeApprovedSkillLifecycleMutation({
      approvalId: envelope.pendingApproval.approvalId,
    });
    expect(applied).toMatchObject({
      disposition: "applied",
      action: "skill_state_set",
      subjectId: "skill-alpha",
      skillIds: ["skill-alpha"],
      changedCount: 1,
    });
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "sleep", note: "Quiet hours" });

    // Canonical mutation, immutable source, governed event, and Journey share the transaction.
    const governed = readGovernedEvent(harness, `skill-lifecycle:${envelope.pendingApproval.approvalId}:skill-alpha`);
    expect(governed).toMatchObject({
      operation: "slept",
      actorType: "operator",
      approvalId: envelope.pendingApproval.approvalId,
      actorId: harness.resolverId,
    });
    const activationEvents = harness.storage.gatewaySql
      .prepare(
        `SELECT event_id AS eventId, payload_json AS payloadJson FROM skill_activation_events WHERE skill_id = @skillId`,
      )
      .all({ skillId: "skill-alpha" }) as Array<{ eventId: string; payloadJson: string }>;
    expect(activationEvents.length).toBe(1);
    expect(JSON.parse(activationEvents[0]!.payloadJson)).toMatchObject({
      state: "sleep",
      approvalId: envelope.pendingApproval.approvalId,
    });
    // Revision advanced past the reviewed value.
    expect(harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision).toBe(2);

    // Exact effect replay converges on the committed evidence without double-mutating.
    const replay = await harness.service.executeApprovedSkillLifecycleMutation({
      approvalId: envelope.pendingApproval.approvalId,
    });
    expect(replay).toMatchObject({ disposition: "applied", changedCount: 1 });
    expect(harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision).toBe(2);
    expect(countRows(harness, "governed_lifecycle_events")).toBe(1);
  });

  it("denial and expiry are zero-delta and terminal", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    const denied = await requestPending(harness, "skill-alpha", "disabled");
    harness.storage.approvals.resolve(denied.pendingApproval.approvalId, {
      decision: "reject",
      resolvedBy: harness.resolverId,
    });
    await expect(
      harness.service.executeApprovedSkillLifecycleMutation({ approvalId: denied.pendingApproval.approvalId }),
    ).rejects.toThrow(/missing, foreign, malformed, or not approved/);
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "enabled" });
    expect(countRows(harness, "governed_lifecycle_events")).toBe(0);

    // Unknown approvals are equally terminal.
    await expect(harness.service.executeApprovedSkillLifecycleMutation({ approvalId: "missing" })).rejects.toThrow(
      SkillLifecycleApplyError,
    );
  });

  it("conflicts terminally when canonical state drifts from the exact reviewed material", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    const envelope = await requestPending(harness, "skill-alpha", "disabled", "Reviewed against enabled");
    harness.storage.approvals.resolve(envelope.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: harness.resolverId,
    });
    // Drift the canonical state through the branded system path.
    await harness.service.systemDisableSkill("skill-alpha", "failsafe drift");
    await expect(
      harness.service.executeApprovedSkillLifecycleMutation({ approvalId: envelope.pendingApproval.approvalId }),
    ).rejects.toThrow(/drifted from the exact reviewed material/);
  });

  it("applies an approved bulk transition atomically with per-skill governed evidence", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha", "skill-beta"]);
    const revisions = {
      "skill-alpha": harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision,
      "skill-beta": harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-beta").revision,
    };
    const outcome = await harness.service.requestSkillStateBulkApproval(
      ["skill-beta", "skill-alpha"],
      "disabled",
      "Bulk pause",
      { expectedRevisionsBySkillId: revisions, requesterId: harness.requesterId },
    );
    if (!outcome.pendingApproval) throw new Error("expected pending bulk approval");
    expect(outcome.pendingApproval.subjectKind).toBe("skill_batch");
    expect(outcome.pendingApproval.skillIds).toEqual(["skill-alpha", "skill-beta"]);

    harness.storage.approvals.resolve(outcome.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: harness.resolverId,
    });
    const applied = await harness.service.executeApprovedSkillLifecycleMutation({
      approvalId: outcome.pendingApproval.approvalId,
    });
    expect(applied).toMatchObject({ disposition: "applied", changedCount: 2 });
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "disabled" });
    expect(readSkillRow(harness, "skill-beta")).toMatchObject({ state: "disabled" });
    expect(
      readGovernedEvent(harness, `skill-lifecycle:${outcome.pendingApproval.approvalId}:skill-beta`),
    ).toMatchObject({ operation: "disabled" });
  });

  it("converges effect replays of a mixed bulk whose no-op members never mint governed events", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha", "skill-beta"]);
    // skill-beta is ALREADY at the exact target state+note, so the bulk
    // approval binds it as a no-op member that will never mint a governed
    // event; skill-alpha is the only changing member.
    await harness.service.systemDisableSkill("skill-beta", "Bulk pause");
    const revisions = {
      "skill-alpha": harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision,
      "skill-beta": harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-beta").revision,
    };
    const outcome = await harness.service.requestSkillStateBulkApproval(
      ["skill-alpha", "skill-beta"],
      "disabled",
      "Bulk pause",
      { expectedRevisionsBySkillId: revisions, requesterId: harness.requesterId },
    );
    if (!outcome.pendingApproval) throw new Error("expected pending mixed bulk approval");
    expect(outcome.pendingApproval.skillIds).toEqual(["skill-alpha", "skill-beta"]);

    harness.storage.approvals.resolve(outcome.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: harness.resolverId,
    });
    const applied = await harness.service.executeApprovedSkillLifecycleMutation({
      approvalId: outcome.pendingApproval.approvalId,
    });
    expect(applied).toMatchObject({ disposition: "applied", changedCount: 1 });
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "disabled", note: "Bulk pause" });
    // Only the changed member minted a governed event under this approval.
    expect(
      readGovernedEvent(harness, `skill-lifecycle:${outcome.pendingApproval.approvalId}:skill-alpha`),
    ).toMatchObject({ operation: "disabled" });
    expect(
      readGovernedEvent(harness, `skill-lifecycle:${outcome.pendingApproval.approvalId}:skill-beta`),
    ).toBeUndefined();

    // Crash-recovery replay (lost completion lease, deferral after commit):
    // the effect re-executes and MUST converge on the committed evidence —
    // never terminally fail as false state drift — with an honest count.
    const replay = await harness.service.executeApprovedSkillLifecycleMutation({
      approvalId: outcome.pendingApproval.approvalId,
    });
    expect(replay).toMatchObject({ disposition: "applied", changedCount: 1 });
    // Zero re-mutation: revisions and the governed-event set are unchanged.
    expect(harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-alpha").revision).toBe(
      revisions["skill-alpha"] + 1,
    );
    expect(harness.storage.skillAggregateRevisions.ensure("runtime_skill", "skill-beta").revision).toBe(
      revisions["skill-beta"],
    );
    const approvalScoped = harness.storage.gatewaySql
      .prepare(`SELECT COUNT(*) AS count FROM governed_lifecycle_events WHERE approval_id = @approvalId`)
      .get({ approvalId: outcome.pendingApproval.approvalId }) as { count: number };
    expect(Number(approvalScoped.count)).toBe(1);
  });

  it("validates bulk revision maps exactly", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha", "skill-beta"]);
    await expect(
      harness.service.requestSkillStateBulkApproval(["skill-alpha"], "disabled", undefined, {
        expectedRevisionsBySkillId: {},
      }),
    ).rejects.toThrow(/expectedRevisionsBySkillId.skill-alpha/);
    await expect(
      harness.service.requestSkillStateBulkApproval(["skill-alpha"], "disabled", undefined, {
        expectedRevisionsBySkillId: { "skill-alpha": 1, "skill-ghost": 1 },
      }),
    ).rejects.toThrow(/Unexpected skill revision entries/);
  });
});

describe("approval-first activation policy", () => {
  it("requests, approves, and applies a policy update with governed evidence; unchanged patches are no-ops", async () => {
    const harness = createHarness();
    const noOp = await harness.service.requestActivationPolicyApproval(
      { guardedAutoThreshold: 0.72 },
      { expectedRevision: 1, requesterId: harness.requesterId },
    );
    expect(noOp.pendingApproval).toBeNull();
    expect(countRows(harness, "approvals")).toBe(0);

    const outcome = await harness.service.requestActivationPolicyApproval(
      { guardedAutoThreshold: 0.9 },
      { expectedRevision: 1, requesterId: harness.requesterId },
    );
    if (!outcome.pendingApproval) throw new Error("expected pending policy approval");
    expect(outcome.pendingApproval).toMatchObject({
      action: "activation_policy_updated",
      subjectKind: "skill_activation_policy",
    });
    // Policy unchanged before approval.
    expect(await harness.service.getActivationPolicy()).toMatchObject({ guardedAutoThreshold: 0.72 });

    harness.storage.approvals.resolve(outcome.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: harness.resolverId,
    });
    const applied = await harness.service.executeApprovedSkillLifecycleMutation({
      approvalId: outcome.pendingApproval.approvalId,
    });
    expect(applied).toMatchObject({ disposition: "applied", action: "activation_policy_updated" });
    expect(await harness.service.getActivationPolicy()).toMatchObject({ guardedAutoThreshold: 0.9, revision: 2 });
    expect(
      readGovernedEvent(harness, `skill-lifecycle:${outcome.pendingApproval.approvalId}:activation-policy`),
    ).toMatchObject({ operation: "activation_policy_updated" });

    // Replay converges.
    expect(
      await harness.service.executeApprovedSkillLifecycleMutation({ approvalId: outcome.pendingApproval.approvalId }),
    ).toMatchObject({ disposition: "applied" });
  });

  it("conflicts on stale policy revisions at request time", async () => {
    const harness = createHarness();
    await expect(
      harness.service.requestActivationPolicyApproval({ guardedAutoThreshold: 0.5 }, { expectedRevision: 7 }),
    ).rejects.toThrow(/changed since revision/);
  });
});

describe("branded fail-safe system disable", () => {
  it("disables with canonical row, activation event, governed system event, and Journey in one transaction", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    const record = await harness.service.systemDisableSkill("skill-alpha", "curator:idle-archive");
    expect(record).toMatchObject({ skillId: "skill-alpha", state: "disabled", note: "curator:idle-archive" });
    const governedRows = harness.storage.gatewaySql
      .prepare(`SELECT operation, actor_type AS actorType FROM governed_lifecycle_events WHERE domain = 'skill_state'`)
      .all() as Array<{ operation: string; actorType: string }>;
    expect(governedRows).toHaveLength(1);
    expect(governedRows[0]).toMatchObject({ operation: "system_disabled", actorType: "system" });
    const journeyRows = harness.storage.gatewaySql
      .prepare(`SELECT COUNT(*) AS count FROM governance_journey_events WHERE action = 'system_disabled'`)
      .get() as { count: number };
    expect(Number(journeyRows.count)).toBe(1);

    // Idempotent repeat: no second governed claim.
    await harness.service.systemDisableSkill("skill-alpha", "curator:idle-archive");
    expect(countRows(harness, "governed_lifecycle_events")).toBe(1);
  });

  it("rejects unknown skills", async () => {
    const harness = createHarness();
    await expect(harness.service.systemDisableSkill("skill-ghost", "reason")).rejects.toThrow(NotFoundError);
  });
});

describe("curator idle snapshot capture/restore", () => {
  it("captures a snapshot and restores the prior state under system authority with Journey evidence", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    await harness.service.captureCuratorIdleSnapshot("skill-alpha");
    expect(harness.host.recordAutonomousMutation).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "curator_archive", targetKey: "skill-alpha" }),
    );
    await harness.service.systemDisableSkill("skill-alpha", "curator:idle-archive");
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "disabled" });

    expect(await harness.service.restoreCuratorIdleSnapshot("skill-alpha")).toBe(true);
    expect(readSkillRow(harness, "skill-alpha")).toMatchObject({ state: "enabled" });
    const restoreJourney = harness.storage.gatewaySql
      .prepare(`SELECT COUNT(*) AS count FROM governance_journey_events WHERE action = 'system_restored'`)
      .get() as { count: number };
    expect(Number(restoreJourney.count)).toBe(1);
    expect(await harness.service.restoreCuratorIdleSnapshot("skill-ghost")).toBe(false);
  });

  it("swallows snapshot capture failures with a diagnostic", async () => {
    const harness = createHarness();
    const asyncStorage = createSqliteAsyncStorage(harness.storage);
    const failing = new SkillStateService(
      {
        storage: {
          ...asyncStorage,
          db: {
            prepare: () => {
              throw new Error("db down");
            },
          } as never,
        },
        systemSettings: asyncStorage.systemSettings,
        skillAggregateRevisions: asyncStorage.skillAggregateRevisions,
      },
      harness.host,
    );
    await failing.captureCuratorIdleSnapshot("skill-alpha");
    expect(harness.host.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "curator_idle_snapshot_failed" }),
    );
  });
});

describe("import events", () => {
  it("records validated and redirected import lifecycle events", async () => {
    const harness = createHarness();
    const validation = {
      candidate: {
        sourceProvider: "github",
        sourceRef: "https://github.com/example/skill",
        sourceType: "git_url",
        canonicalKey: "github:git_url:example/skill",
      },
      valid: true,
      riskLevel: "medium",
      inferredSkillName: "Example",
      inferredSkillId: "example",
      warnings: [],
      errors: [],
    } as never;
    await harness.service.recordSkillImportEvent(validation, "import_validated");
    await harness.service.recordSkillImportEvent(validation, "import_redirected");
    const rows = harness.storage.gatewaySql
      .prepare(`SELECT event_type AS eventType FROM skill_activation_events ORDER BY event_type`)
      .all() as Array<{ eventType: string }>;
    expect(rows.map((row) => row.eventType)).toEqual(["import_redirected", "import_validated"]);
  });
});

describe("retired direct mutation surface", () => {
  it("no longer exposes unapproved setSkillState/bulkSetSkillState/updateActivationPolicy branches", () => {
    const harness = createHarness();
    const surface = harness.service as unknown as Record<string, unknown>;
    expect(surface.setSkillState).toBeUndefined();
    expect(surface.bulkSetSkillState).toBeUndefined();
    expect(surface.updateActivationPolicy).toBeUndefined();
  });

  it("rejects a forged approval whose payload identity does not re-derive", async () => {
    const harness = createHarness();
    await harness.service.ensureSkillStates(["skill-alpha"]);
    const foreign = harness.storage.approvals.createDeterministicDetachedWithTtlDuration(
      {
        approvalId: "11111111-2222-3333-4444-555555555555",
        kind: "skill.lifecycle",
        riskLevel: "danger",
        payload: { skillLifecycle: { forged: true }, request: { forged: true } },
        preview: {},
      },
      60_000,
    );
    harness.storage.approvals.resolve(foreign.approval.approvalId, {
      decision: "approve",
      resolvedBy: harness.resolverId,
    });
    await expect(
      harness.service.executeApprovedSkillLifecycleMutation({ approvalId: foreign.approval.approvalId }),
    ).rejects.toThrow(/missing, foreign, malformed, or not approved/);
    expect(countRows(harness, "governed_lifecycle_events")).toBe(0);
  });
});
