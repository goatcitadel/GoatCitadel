/* eslint-disable max-lines -- SkillStateService owns the approval-first request verbs, the sole recovered executor, and the branded fail-safe disable for the skill_state domain (HX-402 P2); splitting would scatter the module-private authority. */
import { createHash, randomUUID } from "node:crypto";
import { isRecord } from "./companion-auth-helpers.js";
import type {
  ApprovalRequest,
  SkillActivationPolicy,
  SkillImportValidationResult,
  SkillRuntimeState,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import {
  canonicalJsonString,
  ConflictError,
  NotFoundError,
  SKILL_LIFECYCLE_APPROVAL_KIND,
  ValidationError,
  type GovernanceJourneyEventRecord,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import {
  buildSkillLifecycleApprovalBinding,
  buildSkillLifecycleApprovalPayload,
  buildSkillLifecycleRequestJourneyEvent,
  buildSkillLifecycleRequestSha256,
  buildSkillLifecycleStateSha256,
  createSkillGovernedLifecycleRepository,
  deriveSkillLifecycleApprovalId,
  mintSkillGovernanceSystemAuthority,
  parseSkillLifecycleApprovalBinding,
  parseSkillLifecycleRequestEnvelope,
  persistApprovedActivationPolicyEvidence,
  persistApprovedSkillStateEvidence,
  persistSkillSystemDisableEvidence,
  skillLifecycleRequestJourneyIdempotencyKey,
  SkillLifecycleApplyError,
  type AsyncGovernedLifecycleEventRepository,
  type SkillGovernanceSystemAuthority,
  type SkillLifecycleApprovalAction,
  type SkillLifecycleApprovalBindingV1,
  type SkillLifecycleSubjectKind,
} from "./skill-governance-journey-producer.js";

const SKILL_ACTIVATION_POLICY_SETTING_KEY = "skill_activation_policy_v1";
const SKILL_STATE_METADATA_SETTING_KEY = "skill_state_metadata_v1";
const SKILL_ACTIVATION_POLICY_AGGREGATE_ID = "global";
const SKILL_LIFECYCLE_APPROVAL_TTL_MS = 15 * 60_000;
const DEFAULT_SKILL_ACTIVATION_POLICY: Omit<SkillActivationPolicy, "revision"> = {
  guardedAutoThreshold: 0.72,
  requireFirstUseConfirmation: true,
};

type SkillActivationPolicyPatch = Partial<Omit<SkillActivationPolicy, "revision">>;
type PersistedSkillState = Omit<SkillStateRecord, "revision" | "pinned" | "usageCount" | "lastUsedAt">;

/**
 * Canonical approval-authority collaborators for the HX-402 P2 approval-first
 * skill mutation surface (P1's host shape). Optional so read-only harnesses can
 * omit them; every approval-request and executor entry point fails closed when
 * the host is absent.
 */
export interface SkillLifecycleApprovalAuthorityHost {
  approvals: {
    createDeterministicDetachedWithTtlDuration(
      input: {
        approvalId: string;
        kind: string;
        riskLevel: "safe" | "caution" | "danger";
        payload: Record<string, unknown>;
        preview: Record<string, unknown>;
        linkage?: Record<string, unknown>;
      },
      ttlMs: number,
    ): Promise<{ approval: ApprovalRequest; created: boolean }>;
    /** Throws NotFoundError when the approval does not exist. */
    get(approvalId: string): Promise<ApprovalRequest>;
  };
  approvalEvents: {
    append(input: {
      approvalId: string;
      eventType: "created";
      actorId: string;
      timestamp: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
  governanceJourneyEvents: {
    create(record: GovernanceJourneyEventRecord): Promise<GovernanceJourneyEventRecord>;
    findByIdempotencyKey(idempotencyKey: string): Promise<GovernanceJourneyEventRecord | undefined>;
  };
}

export interface SkillStateServiceCtx {
  storage: Pick<Storage, "db" | "governanceJourneyEvents" | "governedLifecycleEvents" | "runImmediateTransaction">;
  systemSettings: Pick<Storage["systemSettings"], "get" | "set">;
  skillAggregateRevisions: Storage["skillAggregateRevisions"];
  approvalAuthority?: SkillLifecycleApprovalAuthorityHost;
}

/**
 * Host callbacks are lazy closures over the gateway so construction order does not
 * matter; they are only invoked at call time.
 */
export interface SkillStateServiceHost {
  /** Known skills for the state-mutation existence check. */
  listSkills(): Promise<Array<{ skillId: string }>>;
  /** Unified autonomous-mutation audit (curator idle-archive snapshots). */
  recordAutonomousMutation(input: {
    kind: "curator_archive";
    targetKey: string;
    restoreRef: { kind: "curator_archive"; skillId: string };
  }): void;
  recordDevDiagnostic(input: {
    level: "warn";
    category: "cron";
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  /** Realtime fanout for approval-request and applied-mutation envelopes. */
  publishRealtime?(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** Route-facing authority input for one approval-first skill-state request. */
export interface SkillStateMutationAuthorityInput {
  expectedRevision: number;
  requesterId?: string;
}

export interface SkillStateBulkMutationAuthorityInput {
  expectedRevisionsBySkillId: Record<string, number>;
  requesterId?: string;
}

export interface ActivationPolicyMutationAuthorityInput {
  expectedRevision: number;
  requesterId?: string;
}

export interface SkillLifecyclePendingApproval {
  approvalId: string;
  status: ApprovalRequest["status"];
  kind: typeof SKILL_LIFECYCLE_APPROVAL_KIND;
  action: SkillLifecycleApprovalAction;
  subjectKind: SkillLifecycleSubjectKind;
  subjectId?: string;
  requestSha256: string;
  expectedStateSha256: string;
  expiresAt?: string;
  createdAt: string;
  replayed: boolean;
  skillIds: string[];
}

export interface SkillStateMutationPendingOutcome {
  pendingApproval: SkillLifecyclePendingApproval;
}

export interface SkillStateMutationNoOpOutcome {
  pendingApproval: null;
  noMutationRequired: true;
  skillState: SkillStateRecord;
}

export type SkillStateMutationOutcome = SkillStateMutationPendingOutcome | SkillStateMutationNoOpOutcome;

export interface SkillStateBulkMutationNoOpOutcome {
  pendingApproval: null;
  noMutationRequired: true;
  skillStates: SkillStateRecord[];
}

export type SkillStateBulkMutationOutcome = SkillStateMutationPendingOutcome | SkillStateBulkMutationNoOpOutcome;

export interface ActivationPolicyMutationNoOpOutcome {
  pendingApproval: null;
  noMutationRequired: true;
  policy: SkillActivationPolicy;
}

export type ActivationPolicyMutationOutcome = SkillStateMutationPendingOutcome | ActivationPolicyMutationNoOpOutcome;

export interface SkillLifecycleApplyResult {
  disposition: "applied" | "no_op";
  action: SkillLifecycleApprovalAction;
  subjectKind: SkillLifecycleSubjectKind;
  subjectId?: string;
  skillIds: string[];
  changedCount: number;
}

interface SkillStateSetMutationV1 {
  skillId: string;
  state: SkillRuntimeState;
  note: string | null;
}

interface SkillStateBulkSetMutationV1 {
  skillIds: string[];
  state: SkillRuntimeState;
  note: string | null;
}

interface ActivationPolicyMutationV1 {
  guardedAutoThreshold?: number;
  requireFirstUseConfirmation?: boolean;
}

/**
 * Owns the skill runtime-state substrate: the `skill_state` /
 * `skill_activation_events` tables, the system-settings-backed usage metadata and
 * activation policy, and the curator idle-archive snapshot/restore pair.
 *
 * HX-402 P2: the operator mutation surface is approval-first. The request verbs
 * commit one canonical `skill.lifecycle` approval (deterministic payload-hash
 * UUID identity over the exact request AND the exact reviewed state) plus
 * immutable requester Journey evidence — and never mutate. The recovered
 * `skill_lifecycle_apply` approval effect is the sole executor; fail-safe
 * internal disable runs only under the module-private branded system authority.
 */
export class SkillStateService {
  private governedLifecycleRepository?: AsyncGovernedLifecycleEventRepository;
  private systemAuthority?: SkillGovernanceSystemAuthority;

  constructor(
    private readonly ctx: SkillStateServiceCtx,
    private readonly host: SkillStateServiceHost,
  ) {}

  private getGovernedLifecycleRepository(): AsyncGovernedLifecycleEventRepository {
    this.governedLifecycleRepository ??= createSkillGovernedLifecycleRepository(this.ctx.storage);
    return this.governedLifecycleRepository;
  }

  private getSystemAuthority(): SkillGovernanceSystemAuthority {
    this.systemAuthority ??= mintSkillGovernanceSystemAuthority();
    return this.systemAuthority;
  }

  private requireApprovalAuthority(): SkillLifecycleApprovalAuthorityHost {
    const authority = this.ctx.approvalAuthority;
    if (!authority) {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Operator skill mutations require the canonical approval authority host.",
      });
    }
    return authority;
  }

  async readSkillStates(): Promise<Map<string, SkillStateRecord>> {
    const rows = await this.readPersistedSkillStates();
    const metadata = await this.readSkillStateMetadata();

    return new Map(
      await Promise.all(
        [...rows.values()].map(async (row) => {
          const revision = (await this.ctx.skillAggregateRevisions.ensure("runtime_skill", row.skillId)).revision;
          return [row.skillId, this.decorateSkillState(row, revision, metadata)] as const;
        }),
      ),
    );
  }

  private async readPersistedSkillStates(): Promise<Map<string, PersistedSkillState>> {
    const rows = toPersistedSkillStateRows(
      await this.ctx.storage.db
        .prepare(
          `
      SELECT skill_id AS skillId, state, note, updated_at AS updatedAt, first_auto_approved_at AS firstAutoApprovedAt
      FROM skill_state
    `,
        )
        .all(),
    );
    return new Map(rows.map((row) => [row.skillId, row]));
  }

  async ensureSkillStates(skillIds: string[]): Promise<void> {
    const unique = [...new Set(skillIds)];
    const now = new Date().toISOString();
    const insert = this.ctx.storage.db.prepare(`
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT (skill_id) DO NOTHING
    `);
    for (const skillId of unique) {
      await insert.run({
        skillId,
        state: "enabled",
        note: null,
        updatedAt: now,
      });
      await this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId, now);
    }
  }

  // ── HX-402 P2: approval-first operator mutation requests ─────────────

  /**
   * Request one approved skill-state transition. The route surface never
   * mutates: it commits a canonical `skill.lifecycle` approval plus immutable
   * requester Journey evidence, and only the recovered approval effect may
   * later execute the transition. A byte-identical current state is a pure
   * no-op: no approval row, no evidence, no mutation.
   */
  async requestSkillStateApproval(
    skillId: string,
    state: SkillRuntimeState,
    note: string | undefined,
    authority: SkillStateMutationAuthorityInput,
  ): Promise<SkillStateMutationOutcome> {
    const knownSkill = (await this.host.listSkills()).find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new NotFoundError({ entity: "skill", id: skillId });
    }
    const normalizedNote = normalizeSkillStateNote(note);
    const currentRevision = (await this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId)).revision;
    assertCurrentRevision("runtime_skill", skillId, authority.expectedRevision, currentRevision);
    const currentState = (await this.readPersistedSkillStates()).get(skillId);
    await this.assertSkillStateMutationAllowed(skillId, state, currentState);
    if (currentState && currentState.state === state && currentState.note === normalizedNote) {
      return {
        pendingApproval: null,
        noMutationRequired: true,
        skillState: this.decorateSkillState(currentState, currentRevision, await this.readSkillStateMetadata()),
      };
    }
    const mutation: SkillStateSetMutationV1 = { skillId, state, note: normalizedNote ?? null };
    const binding = buildSkillLifecycleApprovalBinding({
      subjectKind: "skill",
      subjectId: skillId,
      action: "skill_state_set",
      mutation,
      expectedState: buildSkillStateStateMaterial(currentState, currentRevision),
    });
    const pendingApproval = await this.commitSkillLifecycleApproval({
      binding,
      requesterId: normalizeRequesterId(authority.requesterId),
      mutation,
      skillIds: [skillId],
      preview: {
        title: "Approve skill state change",
        action: binding.action,
        skillId,
        state,
        ...(normalizedNote === undefined ? {} : { note: normalizedNote }),
        currentState: currentState?.state ?? "enabled",
      },
    });
    return { pendingApproval };
  }

  /**
   * Request one approved atomic bulk transition. One approval binds the exact
   * sorted skill set, the target state, and every reviewed per-skill state;
   * the recovered effect applies every transition in one transaction or none.
   */
  async requestSkillStateBulkApproval(
    skillIds: string[],
    state: SkillRuntimeState,
    note: string | undefined,
    authority: SkillStateBulkMutationAuthorityInput,
  ): Promise<SkillStateBulkMutationOutcome> {
    const uniqueIds = [...new Set(skillIds)].sort(compareCodeUnits);
    const knownSkillIds = new Set((await this.host.listSkills()).map((skill) => skill.skillId));
    for (const skillId of uniqueIds) {
      if (!knownSkillIds.has(skillId)) {
        throw new NotFoundError({ entity: "skill", id: skillId });
      }
      if (!Object.prototype.hasOwnProperty.call(authority.expectedRevisionsBySkillId, skillId)) {
        throw new ValidationError({
          code: "FIELD_REQUIRED",
          field: `expectedRevisionsBySkillId.${skillId}`,
        });
      }
    }
    const unexpectedIds = Object.keys(authority.expectedRevisionsBySkillId).filter(
      (skillId) => !uniqueIds.includes(skillId),
    );
    if (unexpectedIds.length > 0) {
      throw new ValidationError({
        code: "FIELD_INVALID",
        field: "expectedRevisionsBySkillId",
        message: `Unexpected skill revision entries: ${unexpectedIds.sort(compareCodeUnits).join(", ")}`,
      });
    }

    const normalizedNote = normalizeSkillStateNote(note);
    const currentStates = await this.readPersistedSkillStates();
    const revisions = new Map<string, number>();
    for (const skillId of uniqueIds) {
      const currentRevision = (await this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId)).revision;
      assertCurrentRevision("runtime_skill", skillId, authority.expectedRevisionsBySkillId[skillId]!, currentRevision);
      revisions.set(skillId, currentRevision);
      await this.assertSkillStateMutationAllowed(skillId, state, currentStates.get(skillId));
    }
    const changedIds = uniqueIds.filter((skillId) => {
      const current = currentStates.get(skillId);
      return !(current && current.state === state && current.note === normalizedNote);
    });
    if (changedIds.length === 0) {
      const metadata = await this.readSkillStateMetadata();
      return {
        pendingApproval: null,
        noMutationRequired: true,
        skillStates: uniqueIds.map((skillId) =>
          this.decorateSkillState(currentStates.get(skillId)!, revisions.get(skillId)!, metadata),
        ),
      };
    }
    const mutation: SkillStateBulkSetMutationV1 = { skillIds: uniqueIds, state, note: normalizedNote ?? null };
    const binding = buildSkillLifecycleApprovalBinding({
      subjectKind: "skill_batch",
      action: "skill_state_bulk_set",
      mutation,
      expectedState: buildSkillStatesStateMaterial(uniqueIds, currentStates, revisions),
    });
    const pendingApproval = await this.commitSkillLifecycleApproval({
      binding,
      requesterId: normalizeRequesterId(authority.requesterId),
      mutation,
      skillIds: uniqueIds,
      preview: {
        title: "Approve bulk skill state change",
        action: binding.action,
        state,
        skillCount: uniqueIds.length,
        changedCount: changedIds.length,
        ...(normalizedNote === undefined ? {} : { note: normalizedNote }),
      },
    });
    return { pendingApproval };
  }

  /** Request one approved activation-policy update; unchanged values are a pure no-op. */
  async requestActivationPolicyApproval(
    input: SkillActivationPolicyPatch,
    authority: ActivationPolicyMutationAuthorityInput,
  ): Promise<ActivationPolicyMutationOutcome> {
    const currentRevision = (
      await this.ctx.skillAggregateRevisions.ensure("activation_policy", SKILL_ACTIVATION_POLICY_AGGREGATE_ID)
    ).revision;
    assertCurrentRevision(
      "activation_policy",
      SKILL_ACTIVATION_POLICY_AGGREGATE_ID,
      authority.expectedRevision,
      currentRevision,
    );
    const current = await this.readActivationPolicyValue();
    const next: Omit<SkillActivationPolicy, "revision"> = {
      guardedAutoThreshold: clamp01(input.guardedAutoThreshold ?? current.guardedAutoThreshold),
      requireFirstUseConfirmation: input.requireFirstUseConfirmation ?? current.requireFirstUseConfirmation,
    };
    if (
      next.guardedAutoThreshold === current.guardedAutoThreshold &&
      next.requireFirstUseConfirmation === current.requireFirstUseConfirmation
    ) {
      return {
        pendingApproval: null,
        noMutationRequired: true,
        policy: { revision: currentRevision, ...current },
      };
    }
    const mutation: ActivationPolicyMutationV1 = {
      ...(input.guardedAutoThreshold === undefined
        ? {}
        : { guardedAutoThreshold: clamp01(input.guardedAutoThreshold) }),
      ...(input.requireFirstUseConfirmation === undefined
        ? {}
        : { requireFirstUseConfirmation: input.requireFirstUseConfirmation }),
    };
    const binding = buildSkillLifecycleApprovalBinding({
      subjectKind: "skill_activation_policy",
      subjectId: "skill-activation-policy:global",
      action: "activation_policy_updated",
      mutation,
      expectedState: buildActivationPolicyStateMaterial(current, currentRevision),
    });
    const pendingApproval = await this.commitSkillLifecycleApproval({
      binding,
      requesterId: normalizeRequesterId(authority.requesterId),
      mutation,
      skillIds: [],
      preview: {
        title: "Approve skill activation policy update",
        action: binding.action,
        guardedAutoThreshold: next.guardedAutoThreshold,
        requireFirstUseConfirmation: next.requireFirstUseConfirmation,
      },
    });
    return { pendingApproval };
  }

  private async commitSkillLifecycleApproval(input: {
    binding: SkillLifecycleApprovalBindingV1;
    requesterId: string;
    mutation: unknown;
    skillIds: string[];
    preview: Record<string, unknown>;
  }): Promise<SkillLifecyclePendingApproval> {
    const authority = this.requireApprovalAuthority();
    const approvalId = deriveSkillLifecycleApprovalId(input.binding);
    const payload = buildSkillLifecycleApprovalPayload({
      binding: input.binding,
      requesterId: input.requesterId,
      mutation: input.mutation,
    });
    const committed = await this.ctx.storage.runImmediateTransaction(async () => {
      const stored = await authority.approvals.createDeterministicDetachedWithTtlDuration(
        {
          approvalId,
          kind: SKILL_LIFECYCLE_APPROVAL_KIND,
          riskLevel: "danger",
          payload,
          preview: { ...input.preview },
        },
        SKILL_LIFECYCLE_APPROVAL_TTL_MS,
      );
      if (stored.created) {
        await authority.approvalEvents.append({
          approvalId,
          eventType: "created",
          actorId: "system",
          timestamp: stored.approval.createdAt,
          payload: {
            kind: stored.approval.kind,
            riskLevel: stored.approval.riskLevel,
            status: stored.approval.status,
          },
        });
        await authority.governanceJourneyEvents.create(
          buildSkillLifecycleRequestJourneyEvent({
            approval: stored.approval,
            binding: input.binding,
            requesterId: input.requesterId,
            targetCount: input.skillIds.length,
          }),
        );
      } else {
        // The original requester remains the immutable evidence. A byte-exact
        // replay from the SAME requester converges; a different requester's
        // identical mutation conflicts in the approvals owner because the
        // requester is payload material. A missing evidence row self-heals so
        // the recovered effect can never execute without requester evidence.
        const evidence = await authority.governanceJourneyEvents.findByIdempotencyKey(
          skillLifecycleRequestJourneyIdempotencyKey(approvalId),
        );
        if (!evidence) {
          await authority.governanceJourneyEvents.create(
            buildSkillLifecycleRequestJourneyEvent({
              approval: stored.approval,
              binding: input.binding,
              requesterId: input.requesterId,
              targetCount: input.skillIds.length,
            }),
          );
        }
      }
      return stored;
    });
    if (committed.created) {
      await this.host.publishRealtime?.("skill_mutation_approval_requested", "skills", {
        approvalId,
        action: input.binding.action,
        subjectKind: input.binding.subjectKind,
        ...(input.binding.subjectId === undefined ? {} : { subjectId: input.binding.subjectId }),
        skillCount: input.skillIds.length,
      });
    }
    return {
      approvalId,
      status: committed.approval.status,
      kind: SKILL_LIFECYCLE_APPROVAL_KIND,
      action: input.binding.action,
      subjectKind: input.binding.subjectKind,
      ...(input.binding.subjectId === undefined ? {} : { subjectId: input.binding.subjectId }),
      requestSha256: input.binding.requestSha256,
      expectedStateSha256: input.binding.expectedStateSha256,
      ...(committed.approval.expiresAt ? { expiresAt: committed.approval.expiresAt } : {}),
      createdAt: committed.approval.createdAt,
      replayed: !committed.created,
      skillIds: [...input.skillIds],
    };
  }

  // ── HX-402 P2: the recovered `skill.lifecycle` approval effect ───────

  /**
   * Execute one approved `skill.lifecycle` mutation as the recovered approval
   * effect. Revalidates the exact approval (kind, deterministic identity,
   * status, expiry), recovers the requester from the immutable request Journey
   * evidence, byte-verifies the request hash against the stored mutation,
   * re-verifies the exact reviewed state material against current state, and
   * re-checks the pinned policy — then mutates inside one immediate
   * transaction that also writes the governed lifecycle event and Journey
   * evidence through the P0 owner. Governance violations throw the terminal
   * {@link SkillLifecycleApplyError}; infrastructure errors propagate raw so
   * the approval-effect worker defers the effect for bounded retry.
   */
  async executeApprovedSkillLifecycleMutation(input: { approvalId: string }): Promise<SkillLifecycleApplyResult> {
    const authority = this.requireApprovalAuthority();
    let approval: ApprovalRequest;
    try {
      approval = await authority.approvals.get(input.approvalId);
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
      }
      throw error;
    }
    if (approval.kind !== SKILL_LIFECYCLE_APPROVAL_KIND) {
      throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
    }
    const payload = approval.payload as Record<string, unknown> | undefined;
    const binding = parseSkillLifecycleApprovalBinding(payload?.skillLifecycle);
    const envelope = parseSkillLifecycleRequestEnvelope(payload);
    if (!binding || !envelope || deriveSkillLifecycleApprovalId(binding) !== approval.approvalId) {
      throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
    }
    if (approval.status !== "approved" || !approval.resolvedBy) {
      throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
    }
    if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) {
      throw new SkillLifecycleApplyError("skill_lifecycle_approval_expired");
    }
    const evidence = await authority.governanceJourneyEvents.findByIdempotencyKey(
      skillLifecycleRequestJourneyIdempotencyKey(approval.approvalId),
    );
    if (!evidence || evidence.approvalId !== approval.approvalId || evidence.actorId !== envelope.requesterId) {
      throw new SkillLifecycleApplyError("skill_lifecycle_request_evidence_missing");
    }
    if (
      buildSkillLifecycleRequestSha256({
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
        action: binding.action,
        mutation: envelope.mutation,
      }) !== binding.requestSha256
    ) {
      throw new SkillLifecycleApplyError("skill_lifecycle_request_drift");
    }
    const applyAuthority = {
      approvalId: approval.approvalId,
      actorId: approval.resolvedBy,
      requesterId: envelope.requesterId,
      occurredAt: new Date().toISOString(),
      requestSha256: binding.requestSha256,
      expectedStateSha256: binding.expectedStateSha256,
    };
    try {
      if (binding.action === "skill_state_set") {
        const mutation = parseSkillStateSetMutation(envelope.mutation);
        if (!mutation || mutation.skillId !== binding.subjectId) {
          throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
        }
        return await this.applyApprovedSkillStates(
          binding,
          applyAuthority,
          [mutation.skillId],
          mutation.state,
          mutation.note,
        );
      }
      if (binding.action === "skill_state_bulk_set") {
        const mutation = parseSkillStateBulkSetMutation(envelope.mutation);
        if (!mutation) {
          throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
        }
        return await this.applyApprovedSkillStates(
          binding,
          applyAuthority,
          mutation.skillIds,
          mutation.state,
          mutation.note,
        );
      }
      const mutation = parseActivationPolicyMutation(envelope.mutation);
      if (!mutation) {
        throw new SkillLifecycleApplyError("skill_lifecycle_approval_not_executable");
      }
      return await this.applyApprovedActivationPolicy(binding, applyAuthority, mutation);
    } catch (error) {
      if (error instanceof SkillLifecycleApplyError) throw error;
      if (error instanceof ConflictError || error instanceof NotFoundError || error instanceof ValidationError) {
        throw new SkillLifecycleApplyError("skill_lifecycle_apply_conflict");
      }
      throw error;
    }
  }

  private async applyApprovedSkillStates(
    binding: SkillLifecycleApprovalBindingV1,
    applyAuthority: {
      approvalId: string;
      actorId: string;
      requesterId: string;
      occurredAt: string;
      requestSha256: string;
      expectedStateSha256: string;
    },
    skillIds: string[],
    state: SkillRuntimeState,
    note: string | null,
  ): Promise<SkillLifecycleApplyResult> {
    const repository = this.getGovernedLifecycleRepository();
    const normalizedNote = note ?? undefined;
    return await this.ctx.storage.runImmediateTransaction(async () => {
      // Exact-replay convergence: every governed event for one approval
      // commits in a single transaction, so ANY existing event proves the
      // mutation committed — partial existence is impossible. Bulk approvals
      // may bind no-op members that never mint events, so requiring `every`
      // would falsely read a committed mixed bulk as state drift on effect
      // re-execution; the honest changedCount is the committed event count.
      const governedEventIds = skillIds.map((skillId) => `skill-lifecycle:${applyAuthority.approvalId}:${skillId}`);
      const committedEventIds = (
        await Promise.all(
          governedEventIds.map(async (eventId) => ((await repository.find(eventId)) ? eventId : undefined)),
        )
      ).filter((eventId): eventId is string => eventId !== undefined);
      if (committedEventIds.length > 0) {
        return {
          disposition: "applied" as const,
          action: binding.action,
          subjectKind: binding.subjectKind,
          ...(binding.subjectId === undefined ? {} : { subjectId: binding.subjectId }),
          skillIds: [...skillIds],
          changedCount: committedEventIds.length,
        };
      }
      const currentStates = await this.readPersistedSkillStates();
      const revisions = new Map<string, number>();
      for (const skillId of skillIds) {
        revisions.set(skillId, (await this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId)).revision);
      }
      const currentMaterial =
        binding.subjectKind === "skill"
          ? buildSkillStateStateMaterial(currentStates.get(skillIds[0]!), revisions.get(skillIds[0]!)!)
          : buildSkillStatesStateMaterial(skillIds, currentStates, revisions);
      if (buildSkillLifecycleStateSha256(currentMaterial) !== binding.expectedStateSha256) {
        throw new SkillLifecycleApplyError("skill_lifecycle_state_drift");
      }
      for (const skillId of skillIds) {
        try {
          await this.assertSkillStateMutationAllowed(skillId, state, currentStates.get(skillId));
        } catch {
          throw new SkillLifecycleApplyError("skill_lifecycle_policy_blocked");
        }
      }
      let changedCount = 0;
      for (const [index, skillId] of skillIds.entries()) {
        const currentState = currentStates.get(skillId);
        if (currentState && currentState.state === state && currentState.note === normalizedNote) {
          continue;
        }
        await this.ctx.skillAggregateRevisions.fenceExpectedRevision(
          "runtime_skill",
          skillId,
          revisions.get(skillId)!,
          applyAuthority.occurredAt,
        );
        await this.persistSkillState(skillId, state, normalizedNote, currentState, applyAuthority.occurredAt);
        const activationEventId = await this.recordSkillStateEvent(
          skillId,
          state,
          normalizedNote,
          applyAuthority.occurredAt,
          {
            approvalId: applyAuthority.approvalId,
            eventId: `skill-activation:${applyAuthority.approvalId}:${skillId}`,
          },
        );
        await persistApprovedSkillStateEvidence(repository, {
          authority: applyAuthority,
          skillId,
          state,
          ...(normalizedNote === undefined ? {} : { noteSha256: sha256Text(normalizedNote) }),
          activationEventId,
          ...(binding.subjectKind === "skill_batch" ? { batchOperationIndex: index } : {}),
        });
        await this.ctx.skillAggregateRevisions.advanceExpectedRevision(
          "runtime_skill",
          skillId,
          revisions.get(skillId)!,
          applyAuthority.occurredAt,
        );
        changedCount += 1;
      }
      if (changedCount > 0) {
        await this.host.publishRealtime?.("skill_state_mutation_applied", "skills", {
          approvalId: applyAuthority.approvalId,
          state,
          skillIds: [...skillIds],
          changedCount,
        });
      }
      return {
        disposition: changedCount > 0 ? ("applied" as const) : ("no_op" as const),
        action: binding.action,
        subjectKind: binding.subjectKind,
        ...(binding.subjectId === undefined ? {} : { subjectId: binding.subjectId }),
        skillIds: [...skillIds],
        changedCount,
      };
    });
  }

  private async applyApprovedActivationPolicy(
    binding: SkillLifecycleApprovalBindingV1,
    applyAuthority: {
      approvalId: string;
      actorId: string;
      requesterId: string;
      occurredAt: string;
      requestSha256: string;
      expectedStateSha256: string;
    },
    mutation: ActivationPolicyMutationV1,
  ): Promise<SkillLifecycleApplyResult> {
    const repository = this.getGovernedLifecycleRepository();
    return await this.ctx.storage.runImmediateTransaction(async () => {
      const governedEventId = `skill-lifecycle:${applyAuthority.approvalId}:activation-policy`;
      if ((await repository.find(governedEventId)) !== undefined) {
        return {
          disposition: "applied" as const,
          action: binding.action,
          subjectKind: binding.subjectKind,
          subjectId: binding.subjectId,
          skillIds: [],
          changedCount: 1,
        };
      }
      const currentRevision = (
        await this.ctx.skillAggregateRevisions.ensure("activation_policy", SKILL_ACTIVATION_POLICY_AGGREGATE_ID)
      ).revision;
      const current = await this.readActivationPolicyValue();
      if (
        buildSkillLifecycleStateSha256(buildActivationPolicyStateMaterial(current, currentRevision)) !==
        binding.expectedStateSha256
      ) {
        throw new SkillLifecycleApplyError("skill_lifecycle_state_drift");
      }
      const next: Omit<SkillActivationPolicy, "revision"> = {
        guardedAutoThreshold: clamp01(mutation.guardedAutoThreshold ?? current.guardedAutoThreshold),
        requireFirstUseConfirmation: mutation.requireFirstUseConfirmation ?? current.requireFirstUseConfirmation,
      };
      const changed =
        next.guardedAutoThreshold !== current.guardedAutoThreshold ||
        next.requireFirstUseConfirmation !== current.requireFirstUseConfirmation;
      if (!changed) {
        return {
          disposition: "no_op" as const,
          action: binding.action,
          subjectKind: binding.subjectKind,
          subjectId: binding.subjectId,
          skillIds: [],
          changedCount: 0,
        };
      }
      await this.ctx.skillAggregateRevisions.fenceExpectedRevision(
        "activation_policy",
        SKILL_ACTIVATION_POLICY_AGGREGATE_ID,
        currentRevision,
        applyAuthority.occurredAt,
      );
      await this.ctx.systemSettings.set(SKILL_ACTIVATION_POLICY_SETTING_KEY, next);
      const activationEventId = await this.recordSkillStateEvent(
        "skill-activation-policy:global",
        undefined,
        undefined,
        applyAuthority.occurredAt,
        {
          approvalId: applyAuthority.approvalId,
          eventId: `skill-activation:${applyAuthority.approvalId}:activation-policy`,
          eventType: "activation_policy_updated",
          payload: next,
        },
      );
      await persistApprovedActivationPolicyEvidence(repository, {
        authority: applyAuthority,
        policy: next,
        activationEventId,
      });
      await this.ctx.skillAggregateRevisions.advanceExpectedRevision(
        "activation_policy",
        SKILL_ACTIVATION_POLICY_AGGREGATE_ID,
        currentRevision,
        applyAuthority.occurredAt,
      );
      await this.host.publishRealtime?.("skill_activation_policy_updated", "skills", {
        approvalId: applyAuthority.approvalId,
        guardedAutoThreshold: next.guardedAutoThreshold,
        requireFirstUseConfirmation: next.requireFirstUseConfirmation,
      });
      return {
        disposition: "applied" as const,
        action: binding.action,
        subjectKind: binding.subjectKind,
        subjectId: binding.subjectId,
        skillIds: [],
        changedCount: 1,
      };
    });
  }

  // ── HX-402 P2: branded fail-safe internal disable ────────────────────

  /**
   * Fail-safe internal disable under the module-private branded system
   * authority (curator idle-archive, confirmed curator archive/prune). Bypasses
   * approval by design, but still writes the canonical `skill_state` row, its
   * `skill_activation_events` source row, the system-actor-only governed
   * `system_disabled` event, and Journey — in one immediate transaction. Route
   * inputs can never mint the authority object this path verifies.
   */
  async systemDisableSkill(skillId: string, reason: string | undefined): Promise<SkillStateRecord> {
    const knownSkill = (await this.host.listSkills()).find((skill) => skill.skillId === skillId);
    if (!knownSkill) {
      throw new NotFoundError({ entity: "skill", id: skillId });
    }
    const authority = this.getSystemAuthority();
    const repository = this.getGovernedLifecycleRepository();
    const normalizedNote = normalizeSkillStateNote(reason);
    const now = new Date().toISOString();
    const applied = await this.ctx.storage.runImmediateTransaction(async () => {
      const currentRevision = (await this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId)).revision;
      const currentState = (await this.readPersistedSkillStates()).get(skillId);
      if (currentState && currentState.state === "disabled" && currentState.note === normalizedNote) {
        return { row: currentState, revision: currentRevision };
      }
      await this.ctx.skillAggregateRevisions.fenceExpectedRevision("runtime_skill", skillId, currentRevision, now);
      const next = await this.persistSkillState(skillId, "disabled", normalizedNote, currentState, now);
      const activationEventId = await this.recordSkillStateEvent(skillId, "disabled", normalizedNote, now, {
        systemAuthority: "skill_governance",
      });
      await persistSkillSystemDisableEvidence(repository, {
        authority,
        skillId,
        reasonCode: (normalizedNote ?? "system_disable").slice(0, 128),
        activationEventId,
        occurredAt: now,
      });
      const revision = await this.ctx.skillAggregateRevisions.advanceExpectedRevision(
        "runtime_skill",
        skillId,
        currentRevision,
        now,
      );
      return { row: next, revision: revision.revision };
    });
    return this.decorateSkillState(applied.row, applied.revision, await this.readSkillStateMetadata());
  }

  private async persistSkillState(
    skillId: string,
    state: SkillRuntimeState,
    note: string | undefined,
    current: PersistedSkillState | undefined,
    now: string,
  ): Promise<PersistedSkillState> {
    await this.ctx.storage.db
      .prepare(
        `
      INSERT INTO skill_state (skill_id, state, note, updated_at, first_auto_approved_at)
      VALUES (@skillId, @state, @note, @updatedAt, NULL)
      ON CONFLICT(skill_id) DO UPDATE SET
        state = excluded.state,
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
      )
      .run({
        skillId,
        state,
        note: note ?? null,
        updatedAt: now,
      });

    return {
      skillId,
      state,
      note,
      updatedAt: now,
      firstAutoApprovedAt: current?.firstAutoApprovedAt,
    };
  }

  private async recordSkillStateEvent(
    skillId: string,
    state: SkillRuntimeState | undefined,
    note: string | undefined,
    now: string,
    options?: {
      approvalId?: string;
      eventId?: string;
      eventType?: string;
      systemAuthority?: string;
      payload?: Record<string, unknown>;
    },
  ): Promise<string> {
    const eventId = options?.eventId ?? randomUUID();
    await this.ctx.storage.db
      .prepare(
        `
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `,
      )
      .run({
        eventId,
        skillId,
        eventType: options?.eventType ?? "state_updated",
        payloadJson: JSON.stringify(
          options?.payload ?? {
            state,
            note,
            ...(options?.approvalId === undefined ? {} : { approvalId: options.approvalId }),
            ...(options?.systemAuthority === undefined ? {} : { systemAuthority: options.systemAuthority }),
          },
        ),
        createdAt: now,
      });
    return eventId;
  }

  private async assertSkillStateMutationAllowed(
    skillId: string,
    state: SkillRuntimeState,
    currentState: PersistedSkillState | undefined,
  ): Promise<void> {
    const pinned = (await this.readSkillStateMetadata())[skillId]?.pinned === true;
    if (pinned && currentState?.state !== state) {
      throw new ConflictError({
        message: `Pinned skill ${skillId} cannot be changed directly; create a skill mutation proposal first.`,
      });
    }
  }

  private decorateSkillState(
    row: PersistedSkillState,
    revision: number,
    metadata: Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }>,
  ): SkillStateRecord {
    return {
      ...row,
      revision,
      pinned: metadata[row.skillId]?.pinned,
      usageCount: metadata[row.skillId]?.usageCount,
      lastUsedAt: metadata[row.skillId]?.lastUsedAt,
    };
  }

  async recordSkillUsage(skillIds: string[]): Promise<void> {
    const uniqueSkillIds = [...new Set(skillIds.filter((skillId) => skillId.trim().length > 0))];
    if (uniqueSkillIds.length === 0) {
      return;
    }
    const metadata = await this.readSkillStateMetadata();
    const now = new Date().toISOString();
    for (const skillId of uniqueSkillIds) {
      const current = metadata[skillId] ?? {};
      metadata[skillId] = {
        ...current,
        usageCount: (current.usageCount ?? 0) + 1,
        lastUsedAt: now,
      };
    }
    await this.ctx.systemSettings.set(SKILL_STATE_METADATA_SETTING_KEY, metadata);
  }

  async getActivationPolicy(): Promise<SkillActivationPolicy> {
    const revision = (
      await this.ctx.skillAggregateRevisions.ensure("activation_policy", SKILL_ACTIVATION_POLICY_AGGREGATE_ID)
    ).revision;
    return { revision, ...(await this.readActivationPolicyValue()) };
  }

  private async readActivationPolicyValue(): Promise<Omit<SkillActivationPolicy, "revision">> {
    const stored = (
      await this.ctx.systemSettings.get<Partial<SkillActivationPolicy>>(SKILL_ACTIVATION_POLICY_SETTING_KEY)
    )?.value;
    if (!stored) {
      return { ...DEFAULT_SKILL_ACTIVATION_POLICY };
    }
    return {
      guardedAutoThreshold: clamp01(
        stored.guardedAutoThreshold ?? DEFAULT_SKILL_ACTIVATION_POLICY.guardedAutoThreshold,
      ),
      requireFirstUseConfirmation:
        stored.requireFirstUseConfirmation ?? DEFAULT_SKILL_ACTIVATION_POLICY.requireFirstUseConfirmation,
    };
  }

  /**
   * Capture a reversible snapshot of a skill's prior runtime-state row before the
   * S3 idle janitor archives (disables) it. Persisted into `system_settings` so
   * the global "revert autonomous changes" path can restore the exact prior
   * state/note via {@link restoreCuratorIdleSnapshot}. Best-effort: a snapshot
   * failure must not abort the sweep (which is itself failure-isolated), so this
   * swallows errors. The archive is reversible regardless — a curator-archived
   * skill is a `disabled` row re-enableable from the snapshot.
   */
  async captureCuratorIdleSnapshot(skillId: string): Promise<void> {
    try {
      const prior = (await this.readSkillStates()).get(skillId);
      await this.ctx.systemSettings.set(curatorIdleSnapshotKey(skillId), {
        skillId,
        priorState: prior?.state ?? "enabled",
        priorNote: prior?.note,
        priorPinned: prior?.pinned ?? false,
        capturedAt: new Date().toISOString(),
      });
      // Unified audit: the snapshot self-persists in system_settings under the
      // deterministic key, so the restoreRef only needs the skillId (best-effort).
      this.host.recordAutonomousMutation({
        kind: "curator_archive",
        targetKey: skillId,
        restoreRef: { kind: "curator_archive", skillId },
      });
    } catch (error) {
      this.host.recordDevDiagnostic({
        level: "warn",
        category: "cron",
        event: "curator_idle_snapshot_failed",
        message: "failed to snapshot skill state before idle archive",
        context: { skillId, error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  /**
   * Restore a skill archived by the S3 idle janitor to its captured prior
   * state. Returns false when no snapshot exists for the skill. Used by the
   * global autonomous-rollback path: it un-does a branded system disable, so it
   * runs under the same module-private authority (never from route inputs) and
   * writes the canonical row, its activation-event source row, and Journey
   * restore evidence — without ever minting approval-requiring governed claims.
   */
  async restoreCuratorIdleSnapshot(skillId: string): Promise<boolean> {
    const snapshot = (
      await this.ctx.systemSettings.get<{
        skillId: string;
        priorState: SkillRuntimeState;
        priorNote?: string;
        priorPinned?: boolean;
      }>(curatorIdleSnapshotKey(skillId))
    )?.value;
    if (!snapshot || snapshot.skillId !== skillId) {
      return false;
    }
    const journeyHost = this.requireApprovalAuthority().governanceJourneyEvents;
    // Verify the module-private brand exactly like the governed system paths:
    // this restore is unreachable for forged authorities.
    const authority = this.getSystemAuthority();
    if (!authority || authority.actorId !== "system:skill-governance") {
      throw new ConflictError({
        code: "STATE_CONFLICT",
        message: "Curator snapshot restore requires the module-private system authority.",
      });
    }
    const normalizedNote = normalizeSkillStateNote(snapshot.priorNote);
    const now = new Date().toISOString();
    await this.ctx.storage.runImmediateTransaction(async () => {
      const currentRevision = (await this.ctx.skillAggregateRevisions.ensure("runtime_skill", skillId)).revision;
      const currentState = (await this.readPersistedSkillStates()).get(skillId);
      if (currentState && currentState.state === snapshot.priorState && currentState.note === normalizedNote) {
        return;
      }
      await this.ctx.skillAggregateRevisions.fenceExpectedRevision("runtime_skill", skillId, currentRevision, now);
      await this.persistSkillState(skillId, snapshot.priorState, normalizedNote, currentState, now);
      const activationEventId = await this.recordSkillStateEvent(skillId, snapshot.priorState, normalizedNote, now, {
        systemAuthority: "skill_governance",
      });
      const journeyEvent: GovernanceJourneyEventRecord = {
        schemaVersion: "goatcitadel.journey-event.v1",
        eventId: `skill:journey:system-restore:${activationEventId}`,
        idempotencyKey: `skill:lifecycle:system-restore:${activationEventId}`,
        scopeKind: "global",
        eventType: "skill_state_lifecycle",
        subjectKind: "skill",
        subjectId: skillId,
        action: "system_restored",
        actorId: authority.actorId,
        actorType: "system",
        sourceKind: "skill_activation_event",
        sourceId: activationEventId,
        trustDisposition: "system_skill_failsafe",
        poisoningStatus: "clean",
        evidenceRefs: [],
        provenance: {
          sourceRequired: true,
          approvalRequired: false,
          systemAuthority: "skill_governance",
          restoreOf: "curator_idle_archive",
        },
        summary: {
          state: snapshot.priorState,
          skillMutationObserved: true,
          journeyMutationAuthority: false,
          callable: false,
          directPromotion: false,
        },
        occurredAt: now,
        recordedAt: now,
      };
      await journeyHost.create(journeyEvent);
      await this.ctx.skillAggregateRevisions.advanceExpectedRevision("runtime_skill", skillId, currentRevision, now);
    });
    return true;
  }

  async recordSkillImportEvent(
    validation: SkillImportValidationResult,
    eventType: "import_validated" | "import_installed" | "import_redirected",
  ): Promise<void> {
    const now = new Date().toISOString();
    const skillId = validation.inferredSkillId
      ? `import:${validation.inferredSkillId}`
      : `import:${createHash("sha1").update(validation.candidate.canonicalKey).digest("hex").slice(0, 12)}`;
    await this.ctx.storage.db
      .prepare(
        `
      INSERT INTO skill_activation_events (
        event_id, skill_id, event_type, payload_json, created_at
      ) VALUES (
        @eventId, @skillId, @eventType, @payloadJson, @createdAt
      )
    `,
      )
      .run({
        eventId: randomUUID(),
        skillId,
        eventType,
        payloadJson: JSON.stringify({
          sourceProvider: validation.candidate.sourceProvider,
          sourceRef: validation.candidate.sourceRef,
          canonicalKey: validation.candidate.canonicalKey,
          valid: validation.valid,
          riskLevel: validation.riskLevel,
          skillName: validation.inferredSkillName,
          skillId: validation.inferredSkillId,
          warnings: validation.warnings,
          errors: validation.errors,
        }),
        createdAt: now,
      });
  }

  private async readSkillStateMetadata(): Promise<
    Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }>
  > {
    const value = (
      await this.ctx.systemSettings.get<Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }>>(
        SKILL_STATE_METADATA_SETTING_KEY,
      )
    )?.value;
    if (!value || typeof value !== "object") {
      return {};
    }
    const output: Record<string, { pinned?: boolean; usageCount?: number; lastUsedAt?: string }> = {};
    for (const [skillId, metadata] of Object.entries(value)) {
      if (!isRecord(metadata)) {
        continue;
      }
      output[skillId] = {
        pinned: metadata.pinned === true ? true : undefined,
        usageCount:
          typeof metadata.usageCount === "number" && metadata.usageCount >= 0 ? metadata.usageCount : undefined,
        lastUsedAt: typeof metadata.lastUsedAt === "string" ? metadata.lastUsedAt : undefined,
      };
    }
    return output;
  }
}

// ── canonical reviewed-state material builders ─────────────────────────

export function buildSkillStateStateMaterial(
  row: Pick<SkillStateRecord, "state" | "note" | "updatedAt" | "firstAutoApprovedAt"> | undefined,
  revision: number,
): Record<string, unknown> {
  return {
    exists: row !== undefined,
    state: row?.state ?? "enabled",
    noteSha256: row?.note === undefined ? null : sha256Text(row.note),
    updatedAt: row?.updatedAt ?? null,
    firstAutoApprovedAt: row?.firstAutoApprovedAt ?? null,
    revision,
  };
}

function buildSkillStatesStateMaterial(
  skillIds: readonly string[],
  currentStates: Map<string, PersistedSkillState>,
  revisions: Map<string, number>,
): Record<string, unknown> {
  const canonical = [...skillIds].sort(compareCodeUnits).map((skillId) => ({
    skillId,
    ...buildSkillStateStateMaterial(currentStates.get(skillId), revisions.get(skillId)!),
  }));
  return {
    skillCount: canonical.length,
    skillsSha256: sha256Text(canonicalJsonString(canonical)),
  };
}

export function buildActivationPolicyStateMaterial(
  policy: Omit<SkillActivationPolicy, "revision">,
  revision: number,
): Record<string, unknown> {
  return {
    guardedAutoThreshold: policy.guardedAutoThreshold,
    requireFirstUseConfirmation: policy.requireFirstUseConfirmation,
    revision,
  };
}

// ── local helpers ─────────────────────────────────────────────────────

function assertCurrentRevision(
  resourceKind: string,
  resourceId: string,
  expectedRevision: number,
  currentRevision: number,
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new ValidationError({ code: "FIELD_INVALID", field: "expectedRevision" });
  }
  if (expectedRevision !== currentRevision) {
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: `${resourceKind} ${resourceId} changed since revision ${expectedRevision}`,
      details: { resourceKind, resourceId, expectedRevision, currentRevision },
    });
  }
}

function parseSkillStateSetMutation(value: unknown): SkillStateSetMutationV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (
    canonicalJsonString(Object.keys(value).sort()) !== canonicalJsonString(["note", "skillId", "state"]) ||
    typeof value.skillId !== "string" ||
    !isSkillRuntimeState(value.state) ||
    (value.note !== null && typeof value.note !== "string")
  ) {
    return undefined;
  }
  return { skillId: value.skillId, state: value.state, note: value.note };
}

function parseSkillStateBulkSetMutation(value: unknown): SkillStateBulkSetMutationV1 | undefined {
  if (!isRecord(value)) return undefined;
  if (
    canonicalJsonString(Object.keys(value).sort()) !== canonicalJsonString(["note", "skillIds", "state"]) ||
    !Array.isArray(value.skillIds) ||
    value.skillIds.length === 0 ||
    value.skillIds.some((skillId) => typeof skillId !== "string" || !skillId.trim()) ||
    !isSkillRuntimeState(value.state) ||
    (value.note !== null && typeof value.note !== "string")
  ) {
    return undefined;
  }
  return { skillIds: value.skillIds as string[], state: value.state, note: value.note };
}

function parseActivationPolicyMutation(value: unknown): ActivationPolicyMutationV1 | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set(["guardedAutoThreshold", "requireFirstUseConfirmation"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  if (
    (value.guardedAutoThreshold !== undefined &&
      (typeof value.guardedAutoThreshold !== "number" ||
        value.guardedAutoThreshold < 0 ||
        value.guardedAutoThreshold > 1)) ||
    (value.requireFirstUseConfirmation !== undefined && typeof value.requireFirstUseConfirmation !== "boolean")
  ) {
    return undefined;
  }
  return {
    ...(value.guardedAutoThreshold === undefined ? {} : { guardedAutoThreshold: value.guardedAutoThreshold }),
    ...(value.requireFirstUseConfirmation === undefined
      ? {}
      : { requireFirstUseConfirmation: value.requireFirstUseConfirmation }),
  };
}

function isSkillRuntimeState(value: unknown): value is SkillRuntimeState {
  return value === "enabled" || value === "sleep" || value === "disabled";
}

function normalizeRequesterId(requesterId: string | undefined): string {
  const normalized = requesterId?.trim();
  return normalized && normalized.length <= 256 ? normalized : "operator";
}

function curatorIdleSnapshotKey(skillId: string): string {
  return `curator_idle_skill_snapshot_v1:${skillId}`;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toPersistedSkillStateRows(value: unknown): PersistedSkillState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((row) => {
    if (
      !isRecord(row) ||
      typeof row.skillId !== "string" ||
      (row.state !== "enabled" && row.state !== "sleep" && row.state !== "disabled") ||
      (typeof row.note !== "string" && row.note !== null) ||
      typeof row.updatedAt !== "string" ||
      (typeof row.firstAutoApprovedAt !== "string" && row.firstAutoApprovedAt !== null)
    ) {
      return [];
    }
    return [
      {
        skillId: row.skillId,
        state: row.state,
        note: typeof row.note === "string" ? row.note : undefined,
        updatedAt: row.updatedAt,
        firstAutoApprovedAt: typeof row.firstAutoApprovedAt === "string" ? row.firstAutoApprovedAt : undefined,
      },
    ];
  });
}

function normalizeSkillStateNote(note: string | undefined): string | undefined {
  return note?.trim() || undefined;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
