import { afterEach, describe, expect, it } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import {
  buildCapabilityLifecycleApprovalBinding,
  buildCapabilityLifecycleApprovalPayload,
  buildSkillLifecycleApprovalBinding,
  buildSkillLifecycleApprovalPayload,
  CapabilityLifecycleApplyError,
  createSkillGovernedLifecycleRepository,
  deriveCapabilityLifecycleApprovalId,
  deriveSkillLifecycleApprovalId,
  isSkillGovernanceSystemAuthority,
  mintSkillGovernanceSystemAuthority,
  parseCapabilityLifecycleApprovalBinding,
  parseSkillLifecycleApprovalBinding,
  parseSkillLifecycleRequestEnvelope,
  persistApprovedCapabilityCandidateEvidence,
  persistApprovedSkillStateEvidence,
  persistCapabilityProposalCreatedEvidence,
  persistCapabilitySystemRevokeEvidence,
  persistSkillSystemDisableEvidence,
  SKILL_GOVERNANCE_SYSTEM_ACTOR_ID,
  SkillLifecycleApplyError,
} from "./skill-governance-journey-producer.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function createStorage(): Storage {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  cleanups.push(() => storage.close());
  return storage;
}

function skillBinding(overrides?: { mutation?: unknown; expectedState?: unknown }) {
  return buildSkillLifecycleApprovalBinding({
    subjectKind: "skill",
    subjectId: "skill-alpha",
    action: "skill_state_set",
    mutation: overrides?.mutation ?? { state: "enabled", note: null },
    expectedState: overrides?.expectedState ?? { state: "disabled", revision: 3 },
  });
}

describe("skill governance producer approval identity", () => {
  it("derives one deterministic payload-hash UUID per exact request AND exact reviewed state", () => {
    const binding = skillBinding();
    const approvalId = deriveSkillLifecycleApprovalId(binding);
    expect(approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(deriveSkillLifecycleApprovalId(binding)).toBe(approvalId);
    // A different reviewed state is a DIFFERENT approval identity.
    expect(deriveSkillLifecycleApprovalId(skillBinding({ expectedState: { state: "sleep", revision: 3 } }))).not.toBe(
      approvalId,
    );
    // A different mutation is a DIFFERENT approval identity.
    expect(deriveSkillLifecycleApprovalId(skillBinding({ mutation: { state: "sleep", note: null } }))).not.toBe(
      approvalId,
    );
  });

  it("derives distinct deterministic capability approval identities per action and state", () => {
    const promote = buildCapabilityLifecycleApprovalBinding({
      subjectId: "candidate-1",
      action: "candidate_promoted",
      mutation: { versionId: "v1" },
      expectedState: { versionsSha256: "a".repeat(64), revision: 2 },
    });
    const approvalId = deriveCapabilityLifecycleApprovalId(promote);
    expect(approvalId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const revoke = buildCapabilityLifecycleApprovalBinding({
      subjectId: "candidate-1",
      action: "candidate_revoked",
      mutation: { versionId: "v1" },
      expectedState: { versionsSha256: "a".repeat(64), revision: 2 },
    });
    expect(deriveCapabilityLifecycleApprovalId(revoke)).not.toBe(approvalId);
  });

  it("same approval identity with different payload material conflicts in the approvals owner", () => {
    const storage = createStorage();
    const binding = skillBinding();
    const approvalId = deriveSkillLifecycleApprovalId(binding);
    const create = (requesterId: string) =>
      storage.approvals.createDeterministicDetachedWithTtlDuration(
        {
          approvalId,
          kind: "skill.lifecycle",
          riskLevel: "danger",
          payload: buildSkillLifecycleApprovalPayload({
            binding,
            requesterId,
            mutation: { state: "enabled", note: null },
          }),
          preview: { title: "Skill approval" },
        },
        60_000,
      );
    const first = create("operator-one");
    expect(first.created).toBe(true);
    const replay = create("operator-one");
    expect(replay.created).toBe(false);
    expect(replay.approval.approvalId).toBe(approvalId);
    expect(() => create("operator-two")).toThrow();
  });

  it("round-trips the immutable request envelope and rejects malformed payload shapes", () => {
    const binding = skillBinding();
    const payload = buildSkillLifecycleApprovalPayload({
      binding,
      requesterId: "operator-one",
      mutation: { state: "enabled", note: null },
    });
    expect(parseSkillLifecycleRequestEnvelope(payload)).toMatchObject({
      requesterId: "operator-one",
      mutation: { state: "enabled", note: null },
    });
    expect(parseSkillLifecycleApprovalBinding(payload.skillLifecycle)).toEqual(binding);
    expect(parseSkillLifecycleRequestEnvelope({})).toBeUndefined();
    expect(parseSkillLifecycleRequestEnvelope({ request: { requesterId: "x" } })).toBeUndefined();
    expect(
      parseSkillLifecycleRequestEnvelope({
        request: { schemaVersion: "wrong", requesterId: "x", mutation: {} },
      }),
    ).toBeUndefined();
    expect(
      parseSkillLifecycleRequestEnvelope({
        request: {
          schemaVersion: "goatcitadel.skill-lifecycle-request-envelope.v1",
          requesterId: "x",
          mutation: {},
          extra: 1,
        },
      }),
    ).toBeUndefined();
    expect(parseSkillLifecycleApprovalBinding({ ...binding, scopeKind: "workspace" })).toBeUndefined();
    expect(parseSkillLifecycleApprovalBinding({ ...binding, extra: true })).toBeUndefined();
  });

  it("fail-closed parses the capability binding", () => {
    const binding = buildCapabilityLifecycleApprovalBinding({
      subjectId: "candidate-1",
      action: "candidate_rolled_back",
      mutation: { targetVersionId: "v0" },
      expectedState: { versionsSha256: "b".repeat(64), revision: 5 },
    });
    const payload = buildCapabilityLifecycleApprovalPayload({
      binding,
      requesterId: "operator-one",
      mutation: { targetVersionId: "v0" },
    });
    expect(parseCapabilityLifecycleApprovalBinding(payload.capabilityLifecycle)).toEqual(binding);
    expect(parseCapabilityLifecycleApprovalBinding({ ...binding, action: "candidate_activated" })).toBeUndefined();
    expect(parseCapabilityLifecycleApprovalBinding({ ...binding, subjectId: 42 })).toBeUndefined();
  });
});

describe("governed skill/capability evidence writes", () => {
  const authority = {
    approvalId: "0adf1111-2222-3333-4444-555566667777",
    actorId: "operator-resolver",
    requesterId: "operator-requester",
    occurredAt: "2026-07-23T00:00:00.000Z",
    requestSha256: "c".repeat(64),
    expectedStateSha256: "d".repeat(64),
  };

  it("writes approved skill-state evidence transactionally and converges exact replays", () => {
    const storage = createStorage();
    const repository = createSkillGovernedLifecycleRepository(storage.gatewaySql);
    const input = {
      authority,
      skillId: "skill-alpha",
      state: "enabled" as const,
      activationEventId: "activation-1",
    };
    const first = persistApprovedSkillStateEvidence(repository, input);
    expect(first.event.operation).toBe("enabled");
    expect(first.event.approvalId).toBe(authority.approvalId);
    expect(first.event.scopeKind).toBe("global");
    expect(first.journeyEvent.approvalId).toBe(authority.approvalId);
    expect(first.journeyEvent.summary.callable).toBe(false);
    // Exact replay converges on the original stored pair.
    const replay = persistApprovedSkillStateEvidence(repository, input);
    expect(replay.event.eventId).toBe(first.event.eventId);
    expect(replay.event.materialSha256).toBe(first.event.materialSha256);
    // The same identity with different material conflicts inside the owner.
    expect(() => persistApprovedSkillStateEvidence(repository, { ...input, state: "sleep" as const })).toThrow(
      ConflictError,
    );
  });

  it("writes approved capability-candidate evidence with approval linkage", () => {
    const storage = createStorage();
    const repository = createSkillGovernedLifecycleRepository(storage.gatewaySql);
    const stored = persistApprovedCapabilityCandidateEvidence(repository, {
      authority,
      candidateId: "candidate-1",
      action: "candidate_promoted",
      selectedVersionId: "version-1",
      changedVersionIds: ["version-1", "version-0"],
    });
    expect(stored.event.operation).toBe("candidate_promoted");
    expect(stored.event.targetKind).toBe("capability_candidate");
    expect(stored.event.approvalId).toBe(authority.approvalId);
    expect(stored.journeyEvent.subjectId).toBe("candidate-1");
  });

  it("writes review-only proposal evidence as approval-free source-required governance", () => {
    const storage = createStorage();
    const repository = createSkillGovernedLifecycleRepository(storage.gatewaySql);
    const stored = persistCapabilityProposalCreatedEvidence(repository, {
      proposalId: "proposal-1",
      proposalKind: "skill",
      proposalEventId: "proposal-event-1",
      actorId: "operator",
      occurredAt: "2026-07-23T00:00:00.000Z",
    });
    expect(stored.event.operation).toBe("proposal_created");
    expect(stored.event.approvalRequired).toBe(false);
    expect(stored.event.sourceRequired).toBe(true);
    expect(stored.event.approvalId).toBeUndefined();
    expect(stored.journeyEvent.summary.callable).toBe(false);
    expect(stored.journeyEvent.summary.directPromotion).toBe(false);
  });
});

describe("module-private fail-safe authority (brand-forgery matrix)", () => {
  it("mints an unforgeable authority that JSON, spread, and prototype grafts cannot reproduce", () => {
    const authority = mintSkillGovernanceSystemAuthority();
    expect(authority.actorId).toBe(SKILL_GOVERNANCE_SYSTEM_ACTOR_ID);
    expect(isSkillGovernanceSystemAuthority(authority)).toBe(true);
    expect(() => JSON.stringify(authority)).toThrow(ConflictError);
    expect(isSkillGovernanceSystemAuthority({ actorId: SKILL_GOVERNANCE_SYSTEM_ACTOR_ID })).toBe(false);
    expect(isSkillGovernanceSystemAuthority({ ...authority })).toBe(false);
    expect(
      isSkillGovernanceSystemAuthority(
        Object.assign(Object.create(Object.getPrototypeOf(authority) as object), { actorId: authority.actorId }),
      ),
    ).toBe(false);
    expect(isSkillGovernanceSystemAuthority(undefined)).toBe(false);
    expect(isSkillGovernanceSystemAuthority(null)).toBe(false);
  });

  it("refuses fail-safe skill disable evidence for forged authorities and writes it for minted ones", () => {
    const storage = createStorage();
    const repository = createSkillGovernedLifecycleRepository(storage.gatewaySql);
    const forged = { actorId: SKILL_GOVERNANCE_SYSTEM_ACTOR_ID, toJSON: () => undefined } as never;
    expect(() =>
      persistSkillSystemDisableEvidence(repository, {
        authority: forged,
        skillId: "skill-alpha",
        reasonCode: "curator_idle_archive",
        activationEventId: "activation-2",
        occurredAt: "2026-07-23T00:00:00.000Z",
      }),
    ).toThrow(ConflictError);

    const stored = persistSkillSystemDisableEvidence(repository, {
      authority: mintSkillGovernanceSystemAuthority(),
      skillId: "skill-alpha",
      reasonCode: "curator_idle_archive",
      activationEventId: "activation-2",
      occurredAt: "2026-07-23T00:00:00.000Z",
    });
    expect(stored.event.operation).toBe("system_disabled");
    expect(stored.event.actorType).toBe("system");
    expect(stored.event.approvalRequired).toBe(false);
    expect(stored.journeyEvent.actorType).toBe("system");
  });

  it("refuses fail-safe capability revoke evidence for forged authorities and requires versions", () => {
    const storage = createStorage();
    const repository = createSkillGovernedLifecycleRepository(storage.gatewaySql);
    expect(() =>
      persistCapabilitySystemRevokeEvidence(repository, {
        authority: { ...mintSkillGovernanceSystemAuthority() } as never,
        candidateId: "candidate-1",
        revokedVersionIds: ["v1"],
        reasonCode: "integrity_failure",
        occurredAt: "2026-07-23T00:00:00.000Z",
      }),
    ).toThrow(ConflictError);
    expect(() =>
      persistCapabilitySystemRevokeEvidence(repository, {
        authority: mintSkillGovernanceSystemAuthority(),
        candidateId: "candidate-1",
        revokedVersionIds: [],
        reasonCode: "integrity_failure",
        occurredAt: "2026-07-23T00:00:00.000Z",
      }),
    ).toThrow(ConflictError);

    const stored = persistCapabilitySystemRevokeEvidence(repository, {
      authority: mintSkillGovernanceSystemAuthority(),
      candidateId: "candidate-1",
      revokedVersionIds: ["v1", "v0"],
      reasonCode: "integrity_failure",
      occurredAt: "2026-07-23T00:00:00.000Z",
    });
    expect(stored.event.operation).toBe("system_revoked");
    expect(stored.event.actorType).toBe("system");
  });
});

describe("apply error taxonomy", () => {
  it("exposes terminal content-free codes for both domains", () => {
    const skillError = new SkillLifecycleApplyError("skill_lifecycle_request_drift");
    expect(skillError.code).toBe("skill_lifecycle_request_drift");
    expect(skillError.name).toBe("SkillLifecycleApplyError");
    const capabilityError = new CapabilityLifecycleApplyError("capability_lifecycle_state_drift");
    expect(capabilityError.code).toBe("capability_lifecycle_state_drift");
    expect(capabilityError.name).toBe("CapabilityLifecycleApplyError");
  });
});
