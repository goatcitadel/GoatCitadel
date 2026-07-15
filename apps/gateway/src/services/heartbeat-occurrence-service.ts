import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  ConflictError,
  type ChatSendMessageRequest,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import {
  HEARTBEAT_SYSTEM_ACTOR_ID,
  type HeartbeatOccurrenceBoundIdentity,
  type HeartbeatOccurrenceRecord,
  type HeartbeatPriorCadence,
  type Storage,
} from "@goatcitadel/storage";
import type { ActiveTurnAdmission } from "./chat-turn-types.js";
import { buildAutonomousTurnContext, HEARTBEAT_PERMISSION_PROFILE_ID } from "./gateway/autonomous-turn-policy.js";
import { HEARTBEAT_SYSTEM_PROMPT, type HeartbeatDatabaseAdmissionOutcome } from "./gateway/heartbeat-service.js";
import type { SessionControlRuntimeOwner } from "./session-control-runtime-owner.js";
import {
  computeFrozenChatTurnAdmissionMaterialSha256,
  freezeChatTurnExecutionRequest,
  type DecisionCommittedHeartbeatRecoveryIdentity,
} from "./session-control-service.js";

const HEARTBEAT_GATEWAY_MATERIAL_VERSION = 1 as const;
const OPERATOR_PREEMPTION_RECOVERY_TIMEOUT_MS = 2_000;
const OPERATOR_PREEMPTION_RECOVERY_POLL_MS = 25;
const HEARTBEAT_RECOVERY_SWEEP_ITEM_BUDGET = 2_000;
const HEARTBEAT_RECOVERY_SWEEP_PAGE_BUDGET = 100;

type HeartbeatOccurrenceRecoveryOutcome = "parked" | "busy" | "reclaimed" | "resumed" | "terminal" | "closed";

export interface HeartbeatOccurrencePlan {
  sourceRunId: string;
  request: HeartbeatChatRequest;
  frozenRequestSha256: string;
  frozenObjectiveSha256: string;
  evaluatedPolicySha256: string;
  reason: string;
}

export interface EnqueuePreclaimedHeartbeatInput {
  occurrence: HeartbeatOccurrenceRecord;
  turnAdmission: ActiveTurnAdmission;
  request: HeartbeatChatRequest;
  sourceRunId: string;
  prompt: string;
  reason: string;
}

export type HeartbeatChatRequest = ChatSendMessageRequest & {
  policyContext: ReturnType<typeof buildAutonomousTurnContext>["policyContext"];
};

export interface ClaimAndEnqueueHeartbeatInput {
  workspaceId: string;
  sessionId: string;
  expectedPriorCadence: HeartbeatPriorCadence;
  idleFloorSeconds: number;
}

export interface HeartbeatOccurrenceRecoveryResult {
  scanned: number;
  parked: number;
  busy: number;
  reclaimed: number;
  resumed: number;
  terminal: number;
  closed: number;
  /** Resume point for the next bounded sweep when more rows were observed. */
  continuation?: { updatedAt: string; occurrenceId: string };
}

export interface HeartbeatOccurrenceServiceDeps {
  storage: Pick<Storage, "heartbeatOccurrences" | "sessionMutationAdmissions">;
  sessionControlRuntimeOwner: Pick<
    SessionControlRuntimeOwner,
    "admitSystemHeartbeatOccurrence" | "recoverSystemHeartbeatOccurrence"
  >;
  canEnqueueHeartbeat(): boolean;
  enqueuePreclaimedHeartbeat(input: EnqueuePreclaimedHeartbeatInput): Promise<boolean>;
  getDurableRun(runId: string): DurableRunRecord;
  recoverDurableRun(runId: string): Promise<void>;
}

/**
 * Gateway owner for durable heartbeat replay. Occurrence rows remain content
 * free; every recovery recomputes the fixed objective, actor, profile, request,
 * and policy materials and refuses to continue when any digest drifts.
 */
export class HeartbeatOccurrenceService {
  private recoveryContinuation: { updatedAt: string; occurrenceId: string } | undefined;

  public constructor(private readonly deps: HeartbeatOccurrenceServiceDeps) {}

  public async claimAndEnqueue(input: ClaimAndEnqueueHeartbeatInput): Promise<HeartbeatDatabaseAdmissionOutcome> {
    if (!this.deps.canEnqueueHeartbeat()) {
      return { disposition: "database_parked", reason: "execution_disabled" };
    }
    const plan = buildHeartbeatOccurrencePlan(input);
    let turnAdmission: ActiveTurnAdmission | undefined;
    const outcome = this.deps.storage.heartbeatOccurrences.claim(
      {
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        expectedPriorCadence: input.expectedPriorCadence,
        evaluatedPolicySha256: plan.evaluatedPolicySha256,
        frozenRequestSha256: plan.frozenRequestSha256,
        frozenObjectiveSha256: plan.frozenObjectiveSha256,
        idleFloorSeconds: input.idleFloorSeconds,
      },
      (occurrenceRequest) => {
        const admitted = this.deps.sessionControlRuntimeOwner.admitSystemHeartbeatOccurrence({
          occurrenceRequest,
          request: plan.request,
        });
        turnAdmission = admitted.admission;
        return { admission: admitted.record, child: occurrenceRequest.child };
      },
    );
    if (outcome.disposition === "not_due") {
      return { disposition: "database_not_due", reason: outcome.reason };
    }
    if (outcome.disposition === "created") {
      if (!turnAdmission) throw new Error("Heartbeat occurrence committed without its synchronous admission result.");
      const enqueue = await this.enqueueWithAuthorityDriftFence(outcome.occurrence, turnAdmission, plan);
      if (enqueue.closed) return { disposition: "database_recovered", outcome: "closed" };
      return enqueue.enqueued ? { disposition: "enqueued" } : { disposition: "failed" };
    }
    // A replay or pre-existing unresolved row is recovered through the same
    // exact lease path. A live lease is busy and is never stolen.
    const recovered = await this.recoverOccurrence(outcome.occurrence);
    if (recovered.enqueued) return { disposition: "enqueued" };
    if (recovered.outcome === "busy") return { disposition: "database_busy" };
    if (recovered.outcome === "resumed" || recovered.outcome === "terminal" || recovered.outcome === "closed") {
      return { disposition: "database_recovered", outcome: recovered.outcome };
    }
    return { disposition: "failed" };
  }

  /** Run once before generic admission cleanup/schedulers and before each sweep. */
  public async recoverAll(
    limit = 500,
    itemBudget = HEARTBEAT_RECOVERY_SWEEP_ITEM_BUDGET,
  ): Promise<HeartbeatOccurrenceRecoveryResult> {
    const result: HeartbeatOccurrenceRecoveryResult = {
      scanned: 0,
      parked: 0,
      busy: 0,
      reclaimed: 0,
      resumed: 0,
      terminal: 0,
      closed: 0,
    };
    const boundedPageSize = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 500;
    const boundedItemBudget = Number.isFinite(itemBudget)
      ? Math.max(1, Math.trunc(itemBudget))
      : HEARTBEAT_RECOVERY_SWEEP_ITEM_BUDGET;
    let observed = 0;
    let pagesObserved = 0;
    let after = this.recoveryContinuation;
    const recoveredOccurrenceIds = new Set<string>();
    for (;;) {
      const page = this.deps.storage.heartbeatOccurrences.listRecoverablePage({
        limit: Math.min(boundedPageSize, boundedItemBudget - observed),
        ...(after ? { after } : {}),
      });
      pagesObserved += 1;
      if (page.nextCursor && after && compareRecoveryCursor(page.nextCursor, after) <= 0) {
        throw new Error("Heartbeat occurrence recovery cursor did not advance.");
      }
      observed += page.items.length;
      for (const occurrence of page.items) {
        if (recoveredOccurrenceIds.has(occurrence.occurrenceId)) {
          continue;
        }
        recoveredOccurrenceIds.add(occurrence.occurrenceId);
        result.scanned += 1;
        const recovered = await this.recoverOccurrence(occurrence);
        result[recovered.outcome] += 1;
      }
      if (!page.nextCursor) {
        this.recoveryContinuation = undefined;
        return result;
      }
      if (observed >= boundedItemBudget || pagesObserved >= HEARTBEAT_RECOVERY_SWEEP_PAGE_BUDGET) {
        this.recoveryContinuation = page.nextCursor;
        return { ...result, continuation: { ...page.nextCursor } };
      }
      after = page.nextCursor;
    }
  }

  /**
   * Finish the exact decision-committed heartbeat before an authenticated
   * operator admission retries. Recovery always re-enters the canonical
   * durable worker path; this method never synthesizes a terminal run,
   * occurrence, or mutation-admission state.
   */
  public async recoverDecisionCommittedForOperatorPreemption(
    identity: DecisionCommittedHeartbeatRecoveryIdentity,
  ): Promise<void> {
    const deadlineMs = Date.now() + OPERATOR_PREEMPTION_RECOVERY_TIMEOUT_MS;
    for (;;) {
      const current = this.readExactDecisionCommittedRecoveryState(identity);
      if (current.settled) return;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw decisionCommittedRecoveryTimeout(identity);
      }
      await this.recoverOccurrenceBeforeDeadline(current.occurrence, identity, deadlineMs);
      const recovered = this.readExactDecisionCommittedRecoveryState(identity);
      if (recovered.settled) return;
      const delayMs = Math.min(OPERATOR_PREEMPTION_RECOVERY_POLL_MS, deadlineMs - Date.now());
      if (delayMs <= 0) {
        throw decisionCommittedRecoveryTimeout(identity);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
      });
    }
  }

  private readExactDecisionCommittedRecoveryState(identity: DecisionCommittedHeartbeatRecoveryIdentity): {
    occurrence: HeartbeatOccurrenceRecord;
    settled: boolean;
  } {
    const occurrence = this.deps.storage.heartbeatOccurrences.find(identity.occurrenceId);
    const admission = this.deps.storage.sessionMutationAdmissions.get(identity.heartbeatAdmissionId);
    if (
      !occurrence ||
      !admission ||
      occurrence.workspaceId !== identity.workspaceId ||
      occurrence.sessionId !== identity.sessionId ||
      occurrence.sessionIncarnationId !== identity.sessionIncarnationId ||
      occurrence.turnId !== identity.turnId ||
      occurrence.admissionId !== identity.heartbeatAdmissionId ||
      occurrence.durableRunId !== identity.durableRunId ||
      occurrence.boundDurableRunId !== identity.durableRunId ||
      admission.admissionId !== identity.heartbeatAdmissionId ||
      admission.workspaceId !== identity.workspaceId ||
      admission.sessionId !== identity.sessionId ||
      admission.sessionIncarnationId !== identity.sessionIncarnationId ||
      admission.turnId !== identity.turnId ||
      admission.actorKind !== "system" ||
      admission.actorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
      admission.operation !== "chat_system_heartbeat"
    ) {
      throw decisionCommittedRecoveryDrift(identity);
    }
    if (occurrence.state === "terminal") {
      if (
        occurrence.terminalStatus !== "completed" ||
        admission.status !== "completed" ||
        admission.terminalAuthorityKind !== "durable_terminal" ||
        admission.terminalDurableRunId !== identity.durableRunId ||
        admission.terminalDurableRunStatus !== "completed"
      ) {
        throw decisionCommittedRecoveryDrift(identity);
      }
      return { occurrence, settled: true };
    }
    if (occurrence.state !== "durable_bound" || admission.status !== "active") {
      throw decisionCommittedRecoveryDrift(identity);
    }
    return { occurrence, settled: false };
  }

  private async recoverOccurrenceBeforeDeadline(
    occurrence: HeartbeatOccurrenceRecord,
    identity: DecisionCommittedHeartbeatRecoveryIdentity,
    deadlineMs: number,
  ): Promise<void> {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) throw decisionCommittedRecoveryTimeout(identity);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.recoverOccurrence(occurrence).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(decisionCommittedRecoveryTimeout(identity)), remainingMs);
          timeout.unref?.();
        }),
      ]);
    } catch (error) {
      if (error instanceof ConflictError) throw error;
      throw new ConflictError({
        code: "WRITE_CONFLICT",
        message: "The committed heartbeat could not complete canonical recovery; retry the operator turn.",
        details: {
          retryable: true,
          occurrenceId: identity.occurrenceId,
          durableRunId: identity.durableRunId,
        },
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async recoverOccurrence(
    occurrence: HeartbeatOccurrenceRecord,
  ): Promise<{ outcome: HeartbeatOccurrenceRecoveryOutcome; enqueued: boolean }> {
    const plan = buildHeartbeatOccurrencePlan({
      workspaceId: occurrence.workspaceId,
      sessionId: occurrence.sessionId,
      expectedPriorCadence: occurrence.priorCadence,
      idleFloorSeconds: occurrence.idleFloorSeconds,
    });
    assertHeartbeatOccurrencePlan(occurrence, plan);
    if (occurrence.state === "durable_bound" || occurrence.state === "terminal") {
      return this.recoverBoundOccurrence(occurrence);
    }
    if (occurrence.state !== "admitted") {
      return { outcome: "closed", enqueued: false };
    }
    // A disabled restart must not leave a pre-bind heartbeat holding the active
    // turn slot. Atomically close only this exact request-runtime admission and
    // retain the already-consumed cadence evidence on its abandoned occurrence.
    if (!this.deps.canEnqueueHeartbeat()) {
      const parked = this.deps.storage.sessionMutationAdmissions.abandonAdmittedHeartbeatForExecutionDisabled({
        workspaceId: occurrence.workspaceId,
        sessionId: occurrence.sessionId,
        occurrenceId: occurrence.occurrenceId,
        admissionId: occurrence.admissionId,
        claimSha256: occurrence.claimSha256,
        idempotencyKey: `heartbeat-execution-disabled:${occurrence.occurrenceId}`,
        correlationId: occurrence.occurrenceId,
      });
      if (parked.disposition === "drift") {
        const current = this.deps.storage.heartbeatOccurrences.find(occurrence.occurrenceId);
        if (current?.state === "durable_bound" || current?.state === "terminal") {
          return this.recoverBoundOccurrence(current);
        }
        if (current?.state === "abandoned") {
          assertExactHeartbeatAbandonment(occurrence, current);
          return { outcome: "closed", enqueued: false };
        }
        throw new Error("Execution-disabled heartbeat parking lost its exact pre-bind authority.");
      }
      const abandoned = this.deps.storage.heartbeatOccurrences.find(occurrence.occurrenceId);
      if (!abandoned || abandoned.abandonmentReason !== "admission_closed") {
        throw new Error("Execution-disabled heartbeat parking committed without cadence-retaining abandonment.");
      }
      assertExactHeartbeatAbandonment(occurrence, abandoned);
      return { outcome: "parked", enqueued: false };
    }
    let recovered: ReturnType<
      HeartbeatOccurrenceServiceDeps["sessionControlRuntimeOwner"]["recoverSystemHeartbeatOccurrence"]
    >;
    try {
      recovered = this.deps.sessionControlRuntimeOwner.recoverSystemHeartbeatOccurrence({
        occurrence,
        request: plan.request,
      });
    } catch (error) {
      if (this.isExactAuthorityDriftAbandonment(occurrence)) {
        return { outcome: "closed", enqueued: false };
      }
      throw error;
    }
    if (recovered.disposition === "live") {
      return this.isExactAuthorityDriftAbandonment(occurrence)
        ? { outcome: "closed", enqueued: false }
        : { outcome: "busy", enqueued: false };
    }
    if (recovered.disposition === "closed_or_authority_drift") {
      const expectedReason = recovered.reason === "closed" ? "admission_closed" : recovered.reason;
      const abandoned = this.deps.storage.heartbeatOccurrences.find(occurrence.occurrenceId);
      if (
        !abandoned ||
        abandoned.state !== "abandoned" ||
        abandoned.abandonmentReason !== expectedReason ||
        abandoned.claimSha256 !== occurrence.claimSha256
      ) {
        throw new Error("Heartbeat pre-bind recovery closed without exact durable abandonment evidence.");
      }
      assertExactHeartbeatAbandonment(occurrence, abandoned);
      return { outcome: "closed", enqueued: false };
    }
    if (recovered.disposition === "durable_bound") {
      const current = this.deps.storage.heartbeatOccurrences.findUnresolved(
        occurrence.workspaceId,
        occurrence.sessionId,
      );
      if (!current || current.occurrenceId !== occurrence.occurrenceId || current.state !== "durable_bound") {
        if (this.isExactAuthorityDriftAbandonment(occurrence)) {
          return { outcome: "closed", enqueued: false };
        }
        throw new Error("Heartbeat admission is durable-bound without the exact occurrence transition.");
      }
      return this.recoverBoundOccurrence(current);
    }
    const enqueue = await this.enqueueWithAuthorityDriftFence(occurrence, recovered.admission, plan);
    return enqueue.closed
      ? { outcome: "closed", enqueued: false }
      : { outcome: "reclaimed", enqueued: enqueue.enqueued };
  }

  private async recoverBoundOccurrence(
    occurrence: HeartbeatOccurrenceRecord,
  ): Promise<{ outcome: "resumed" | "terminal" | "closed"; enqueued: false }> {
    const identity = toBoundIdentity(occurrence);
    if (this.isExactAuthorityDriftAbandonment(occurrence)) {
      return { outcome: "closed", enqueued: false };
    }
    // Replay validation is intentional: storage checks the immutable profile,
    // v2 payload, actor, child, admission, trace, and all four heartbeat hashes.
    try {
      this.deps.storage.heartbeatOccurrences.markDurableBound(identity);
    } catch (error) {
      if (this.isExactAuthorityDriftAbandonment(occurrence)) {
        return { outcome: "closed", enqueued: false };
      }
      throw error;
    }
    if (this.isExactAuthorityDriftAbandonment(occurrence)) {
      return { outcome: "closed", enqueued: false };
    }
    let run: DurableRunRecord;
    try {
      run = this.deps.getDurableRun(occurrence.durableRunId);
    } catch (error) {
      if (this.isExactAuthorityDriftAbandonment(occurrence)) {
        return { outcome: "closed", enqueued: false };
      }
      throw error;
    }
    if (run.runId !== occurrence.durableRunId || run.workflowKey !== "chat.turn.execute") {
      throw new Error("Heartbeat occurrence durable owner drifted before recovery.");
    }
    try {
      await this.deps.recoverDurableRun(run.runId);
    } catch (error) {
      if (this.isExactAuthorityDriftAbandonment(occurrence)) {
        return { outcome: "closed", enqueued: false };
      }
      throw error;
    }
    if (this.isExactAuthorityDriftAbandonment(occurrence)) {
      return { outcome: "closed", enqueued: false };
    }
    let settlement: ReturnType<HeartbeatOccurrenceServiceDeps["storage"]["heartbeatOccurrences"]["markTerminal"]>;
    try {
      settlement = this.deps.storage.heartbeatOccurrences.markTerminal(identity);
    } catch (error) {
      if (this.isExactAuthorityDriftAbandonment(occurrence)) {
        return { outcome: "closed", enqueued: false };
      }
      throw error;
    }
    return {
      outcome: settlement.disposition === "still_bound" ? "resumed" : "terminal",
      enqueued: false,
    };
  }

  private async enqueueWithAuthorityDriftFence(
    occurrence: HeartbeatOccurrenceRecord,
    turnAdmission: ActiveTurnAdmission,
    plan: HeartbeatOccurrencePlan,
  ): Promise<{ enqueued: boolean; closed: boolean }> {
    if (this.isExactAuthorityDriftAbandonment(occurrence)) {
      return { enqueued: false, closed: true };
    }
    try {
      const enqueued = await this.enqueue(occurrence, turnAdmission, plan);
      return this.isExactAuthorityDriftAbandonment(occurrence)
        ? { enqueued: false, closed: true }
        : { enqueued, closed: false };
    } catch (error) {
      if (this.isExactAuthorityDriftAbandonment(occurrence)) {
        return { enqueued: false, closed: true };
      }
      throw error;
    }
  }

  private isExactAuthorityDriftAbandonment(expected: HeartbeatOccurrenceRecord): boolean {
    const current = this.deps.storage.heartbeatOccurrences.find(expected.occurrenceId);
    if (!current || current.state !== "abandoned") return false;
    assertExactHeartbeatAbandonment(expected, current);
    if (current.abandonmentReason !== "authority_drift") {
      throw new Error("Heartbeat recovery observed an unrelated abandonment reason.");
    }
    return true;
  }

  private enqueue(
    occurrence: HeartbeatOccurrenceRecord,
    turnAdmission: ActiveTurnAdmission,
    plan: HeartbeatOccurrencePlan,
  ): Promise<boolean> {
    return this.deps.enqueuePreclaimedHeartbeat({
      occurrence,
      turnAdmission,
      request: plan.request,
      sourceRunId: plan.sourceRunId,
      prompt: HEARTBEAT_SYSTEM_PROMPT,
      reason: plan.reason,
    });
  }
}

export function buildHeartbeatOccurrencePlan(input: ClaimAndEnqueueHeartbeatInput): HeartbeatOccurrencePlan {
  const workspaceId = requireIdentifier(input.workspaceId, "workspaceId");
  const sessionId = requireIdentifier(input.sessionId, "sessionId");
  const priorCadence = {
    lastProactiveAt: input.expectedPriorCadence.lastProactiveAt ?? null,
    lastProactiveRunId: input.expectedPriorCadence.lastProactiveRunId ?? null,
  };
  const sourceRunId = `heartbeat_source_${sha256(
    canonicalJsonString({
      version: HEARTBEAT_GATEWAY_MATERIAL_VERSION,
      kind: "heartbeat",
      workspaceId,
      sessionId,
      priorCadence,
    }),
  ).slice(0, 40)}`;
  const autonomousContext = buildAutonomousTurnContext({
    kind: "heartbeat",
    systemActorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    runId: sourceRunId,
    workspaceId,
    sessionId,
  });
  const request: HeartbeatChatRequest = {
    content: HEARTBEAT_SYSTEM_PROMPT,
    operatorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    authActorId: HEARTBEAT_SYSTEM_ACTOR_ID,
    authActorSource: "none",
    permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID,
    policyContext: autonomousContext.policyContext,
  };
  const frozenRequestSha256 = computeFrozenChatTurnAdmissionMaterialSha256(freezeChatTurnExecutionRequest(request));
  const frozenObjectiveSha256 = sha256(
    canonicalJsonString({
      version: HEARTBEAT_GATEWAY_MATERIAL_VERSION,
      kind: "heartbeat",
      objective: HEARTBEAT_SYSTEM_PROMPT,
    }),
  );
  const evaluatedPolicySha256 = sha256(
    canonicalJsonString({
      version: HEARTBEAT_GATEWAY_MATERIAL_VERSION,
      kind: "heartbeat",
      actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
      deliverMode: "on_notify",
      permissionProfileId: HEARTBEAT_PERMISSION_PROFILE_ID,
      policyContext: autonomousContext.policyContext,
    }),
  );
  return {
    sourceRunId,
    request,
    frozenRequestSha256,
    frozenObjectiveSha256,
    evaluatedPolicySha256,
    reason: `heartbeat self-wake:${sessionId}`,
  };
}

function assertHeartbeatOccurrencePlan(occurrence: HeartbeatOccurrenceRecord, plan: HeartbeatOccurrencePlan): void {
  if (
    occurrence.systemActorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
    occurrence.admissionMaterialSha256 !== plan.frozenRequestSha256 ||
    occurrence.frozenRequestSha256 !== plan.frozenRequestSha256 ||
    occurrence.frozenObjectiveSha256 !== plan.frozenObjectiveSha256 ||
    occurrence.evaluatedPolicySha256 !== plan.evaluatedPolicySha256
  ) {
    throw new Error("Heartbeat occurrence request, objective, actor, or policy material drifted.");
  }
}

function toBoundIdentity(occurrence: HeartbeatOccurrenceRecord): HeartbeatOccurrenceBoundIdentity {
  if (
    !occurrence.capabilityProfileId ||
    !occurrence.capabilityProfileHash ||
    occurrence.boundDurableRunId !== occurrence.durableRunId
  ) {
    throw new Error("Durable-bound heartbeat occurrence is missing its exact profile or run identity.");
  }
  return {
    occurrenceId: occurrence.occurrenceId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    admissionId: occurrence.admissionId,
    turnId: occurrence.turnId,
    durableRunId: occurrence.durableRunId,
    capabilityProfileId: occurrence.capabilityProfileId,
    capabilityProfileHash: occurrence.capabilityProfileHash,
  };
}

function toExactIdentity(occurrence: HeartbeatOccurrenceRecord) {
  return {
    occurrenceId: occurrence.occurrenceId,
    workspaceId: occurrence.workspaceId,
    sessionId: occurrence.sessionId,
    sessionIncarnationId: occurrence.sessionIncarnationId,
    admissionId: occurrence.admissionId,
    turnId: occurrence.turnId,
    durableRunId: occurrence.durableRunId,
  };
}

function assertExactHeartbeatAbandonment(
  expected: HeartbeatOccurrenceRecord,
  abandoned: HeartbeatOccurrenceRecord,
): void {
  if (
    abandoned.state !== "abandoned" ||
    abandoned.claimSha256 !== expected.claimSha256 ||
    canonicalJsonString(toExactIdentity(abandoned)) !== canonicalJsonString(toExactIdentity(expected))
  ) {
    throw new Error("Heartbeat occurrence abandonment does not preserve its exact cadence identity.");
  }
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Heartbeat occurrence requires ${label}.`);
  return normalized;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareRecoveryCursor(
  left: { updatedAt: string; occurrenceId: string },
  right: { updatedAt: string; occurrenceId: string },
): number {
  const timeOrder = left.updatedAt.localeCompare(right.updatedAt);
  return timeOrder !== 0 ? timeOrder : left.occurrenceId.localeCompare(right.occurrenceId);
}

function decisionCommittedRecoveryTimeout(identity: DecisionCommittedHeartbeatRecoveryIdentity): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The committed heartbeat is still completing canonical recovery; retry the operator turn.",
    details: {
      retryable: true,
      occurrenceId: identity.occurrenceId,
      durableRunId: identity.durableRunId,
    },
  });
}

function decisionCommittedRecoveryDrift(identity: DecisionCommittedHeartbeatRecoveryIdentity): ConflictError {
  return new ConflictError({
    code: "WRITE_CONFLICT",
    message: "The committed heartbeat recovery identity drifted; the operator turn was not admitted.",
    details: {
      retryable: false,
      occurrenceId: identity.occurrenceId,
      durableRunId: identity.durableRunId,
    },
  });
}
