import {
  ConflictError,
  NotFoundError,
  type A2AOutboundPreviewRequest,
  type A2AOutboundSendResponse,
  type A2ATaskPushDeliveryResult,
  type ApprovalEffectRecord,
  type ApprovalRequest,
  type IntegrationActionInvokeResult,
} from "@goatcitadel/contracts";
import { buildApprovalEffectIdempotencyKey, type AsyncStorage } from "@goatcitadel/storage";
import type { A2ARouteService } from "./a2a-route-service.js";
import {
  CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND,
  CITADEL_WARD_A2A_PUSH_APPROVAL_KIND,
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
  citadelWardReplayIdempotencyKey,
  computeCitadelWardIntegrationTargetFingerprint,
  computeCitadelWardPayloadHash,
  isCitadelWardApprovalKind,
  isCitadelWardApprovedPushConfig,
  readCitadelWardApprovalPayload,
  type CitadelWardApprovalPayload,
  type CitadelWardApprovalRef,
  type CitadelWardRequestVault,
} from "./citadel-ward-approval.js";
import { buildIntegrationWardAction, resolveWardEffectForExternalAction } from "./citadel-ward-gate.js";
import type { CommunicationsApprovalEffectSettlement } from "./communications-approval-effect-service.js";
import { getIntegrationOperatorActions } from "./integration-action-registry.js";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";

/**
 * Executes approved Citadel Ward `require_approval` actions (integration operator actions,
 * A2A outbound sends, A2A push deliveries) exactly once. The approval payload is re-read, its
 * sealed request opened (integration and outbound requests are never stored in plaintext) and
 * hash-verified, the action is replayed with the approval reference under the original request's
 * idempotency key (else `citadel-ward:<approvalId>`, so two approvals of one keyed request still
 * execute once), and the owner re-checks the live ward (deny still wins). Every refusal is a terminal `CitadelWardApprovalEffectError`; any other error is
 * infrastructure and may retry, because the owners' side-effect ledgers keep a retry
 * exactly-once. A rejected or expired approval executes nothing; a deferred push is recorded as
 * blocked so later events resume.
 */
export const CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND = "citadel_ward_integration_action_apply" as const;
export const CITADEL_WARD_A2A_OUTBOUND_EFFECT_KIND = "citadel_ward_a2a_outbound_apply" as const;
export const CITADEL_WARD_A2A_PUSH_EFFECT_KIND = "citadel_ward_a2a_push_apply" as const;
export const CITADEL_WARD_EFFECT_TARGET_KIND = "citadel_ward_action" as const;

type CitadelWardEffectKind =
  | typeof CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND
  | typeof CITADEL_WARD_A2A_OUTBOUND_EFFECT_KIND
  | typeof CITADEL_WARD_A2A_PUSH_EFFECT_KIND;

const EFFECT_KIND_BY_APPROVAL_KIND: Readonly<Record<string, CitadelWardEffectKind>> = {
  [CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND]: CITADEL_WARD_INTEGRATION_ACTION_EFFECT_KIND,
  [CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND]: CITADEL_WARD_A2A_OUTBOUND_EFFECT_KIND,
  [CITADEL_WARD_A2A_PUSH_APPROVAL_KIND]: CITADEL_WARD_A2A_PUSH_EFFECT_KIND,
};
const WARD_EFFECT_KINDS: readonly string[] = Object.values(EFFECT_KIND_BY_APPROVAL_KIND);

export function isCitadelWardEffectKind(kind: string): boolean {
  return WARD_EFFECT_KINDS.includes(kind);
}

export type CitadelWardEffectErrorCode =
  | "approval_not_approved"
  | "invalid_payload"
  | "payload_hash_mismatch"
  | "ward_denied"
  | "blocked";

export class CitadelWardApprovalEffectError extends Error {
  public constructor(
    public readonly code: CitadelWardEffectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CitadelWardApprovalEffectError";
  }
}

/** The Citadel Ward executors the approval effects worker is composed with (all optional). */
export interface CitadelWardApprovalEffectExecutors {
  executeApprovedCitadelWardAction?(input: { approvalId: string }): Promise<Record<string, unknown>>;
  recordCitadelWardApprovalRefused?(input: { approvalId: string; expired: boolean }): Promise<Record<string, unknown>>;
}

export type CitadelWardApprovalEffectA2APort = Pick<
  A2ARouteService,
  "sendOutbound" | "deliverApprovedPush" | "recordRefusedPushApproval"
>;

export interface CitadelWardApprovalEffectDeps {
  storage: Pick<AsyncStorage, "approvals" | "a2aTaskPushConfigs">;
  integrationHost: () => IntegrationActionHost;
  a2a: () => CitadelWardApprovalEffectA2APort;
  /** Opens the sealed integration and outbound requests; without it those approvals cannot execute. */
  requestVault: () => CitadelWardRequestVault | undefined;
}

/**
 * The A2A owners return no structured deny field, so a deny is read from their message text:
 * `sendOutboundRaw` in a2a-route-service.ts warns "A Citadel Ward denies <action> (citadel …)."
 * and `deliverPushEvent` in a2a-push-notification-service.ts records "A Citadel Ward denies
 * a2a.outbound.push (citadel …)." as the blocked delivery error. Keep this in step with both.
 */
const DENY_WARNING = /\bA Citadel Ward denies\b/;
/** The runner reports a completed run for the same idempotency key as a duplicate. */
const INTEGRATION_DUPLICATE_REASON = "external_side_effect_duplicate";
/** A concurrent claim of the same key is transient; the retry converges on duplicate or unknown. */
const INTEGRATION_IN_PROGRESS_REASON = "external_side_effect_in_progress";

export class CitadelWardApprovalEffectService {
  public constructor(private readonly deps: CitadelWardApprovalEffectDeps) {}

  /**
   * Executes the approved action. Any refusal of a push approval also records the event as a
   * failed (blocked) delivery, so its config never stays deferred; a settled push is not a
   * refusal. The refusal still fails the effect terminally with its code.
   */
  public async executeApprovedAction(input: { approvalId: string }): Promise<Record<string, unknown>> {
    try {
      return await this.executeApproved(input.approvalId);
    } catch (error) {
      if (error instanceof CitadelWardApprovalEffectError) {
        await this.recordFailedPush(input.approvalId, error);
      }
      throw error;
    }
  }

  private async executeApproved(approvalId: string): Promise<Record<string, unknown>> {
    const approval = await this.readApproval(approvalId, ["approved"]);
    const payload = readWardPayload(approval);
    const request = await this.openRequest(approval, payload);
    if (computeCitadelWardPayloadHash(request) !== payload.payloadHash) {
      throw new CitadelWardApprovalEffectError(
        "payload_hash_mismatch",
        `The approved ${payload.wardAction} request no longer matches approval ${approvalId}; nothing was executed.`,
      );
    }
    const wardApproval: CitadelWardApprovalRef = { approvalId, wardAction: payload.wardAction };
    if (approval.kind === CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND) {
      return this.executeIntegrationAction(payload, request, wardApproval);
    }
    if (approval.kind === CITADEL_WARD_A2A_OUTBOUND_APPROVAL_KIND) {
      return this.executeA2AOutbound(request, wardApproval);
    }
    return this.executeA2APush(payload, request, wardApproval);
  }

  /**
   * The plaintext push request, or the opened sealed request. An envelope that does not open
   * (no vault, a missing or rotated key, a tampered envelope) is terminal: nothing is executed.
   * A key store that throws raises `CitadelWardRequestVaultUnavailableError`, which is not a
   * refusal, so the effect defers and retries.
   */
  private async openRequest(
    approval: ApprovalRequest,
    payload: CitadelWardApprovalPayload,
  ): Promise<Record<string, unknown>> {
    if ("request" in payload) {
      return payload.request;
    }
    const opened = await this.deps.requestVault()?.open(approval.kind, payload);
    if (!opened) {
      throw new CitadelWardApprovalEffectError(
        "invalid_payload",
        `The sealed request of Citadel Ward approval ${approval.approvalId} could not be opened; nothing was executed.`,
      );
    }
    return opened;
  }

  /**
   * Records a rejected or expired approval. Never executes; a deferred push resumes later events.
   * The push is recorded only from a request that still matches its approved hash, so a changed
   * request can never move the config past events it did not name.
   */
  public async recordRefused(input: { approvalId: string; expired: boolean }): Promise<Record<string, unknown>> {
    const approval = await this.readApproval(input.approvalId, ["rejected", "edited"]);
    const disposition = input.expired ? "expired" : "rejected";
    if (approval.kind === CITADEL_WARD_A2A_PUSH_APPROVAL_KIND) {
      const payload = readWardPayload(approval);
      const request = readPlainRequest(approval);
      if (computeCitadelWardPayloadHash(request) !== payload.payloadHash) {
        throw new CitadelWardApprovalEffectError(
          "payload_hash_mismatch",
          `The refused push request no longer matches approval ${input.approvalId}; the push config was not advanced.`,
        );
      }
      await this.recordPushRefusal(input.approvalId, readPushRequest(request), disposition);
    }
    return { disposition, kind: approval.kind };
  }

  /** Best-effort read of the push the approval names; nothing is recorded when it is unreadable. */
  private async recordFailedPush(approvalId: string, error: CitadelWardApprovalEffectError): Promise<void> {
    const approval = await this.findApproval(approvalId);
    const request = approval?.kind === CITADEL_WARD_A2A_PUSH_APPROVAL_KIND ? readWardRequest(approval) : undefined;
    const push = request ? readPushRequestOrUndefined(request) : undefined;
    if (push) {
      await this.recordPushRefusal(approvalId, push, "failed", `${error.code}: ${error.message}`);
    }
  }

  private async recordPushRefusal(
    approvalId: string,
    push: PushEventIdentity,
    disposition: "rejected" | "expired" | "failed",
    reason?: string,
  ): Promise<void> {
    await this.deps.a2a().recordRefusedPushApproval({
      approvalId,
      taskId: push.taskId,
      peerId: push.peerId,
      eventSequence: push.eventSequence,
      disposition,
      ...(reason ? { reason } : {}),
      ...(push.configCreatedAt !== undefined ? { configCreatedAt: push.configCreatedAt } : {}),
    });
  }

  private async executeIntegrationAction(
    payload: CitadelWardApprovalPayload,
    approvedRequest: Record<string, unknown>,
    wardApproval: CitadelWardApprovalRef,
  ): Promise<Record<string, unknown>> {
    const request = readIntegrationRequest(approvedRequest);
    const host = this.deps.integrationHost();
    const connection = await host.storage.integrationConnections.get(request.connectionId);
    const actionKnown =
      connection &&
      getIntegrationOperatorActions(connection.catalogId).some((action) => action.actionId === request.actionId);
    if (!connection || !actionKnown) {
      throw new CitadelWardApprovalEffectError(
        "blocked",
        `The integration action approved by ${wardApproval.approvalId} no longer exists; nothing was executed.`,
      );
    }
    if (normalizeWorkspaceId(connection.workspaceId) !== normalizeWorkspaceId(payload.workspaceId)) {
      throw new CitadelWardApprovalEffectError(
        "blocked",
        `The connection moved to another workspace after approval ${wardApproval.approvalId}; nothing was run. Request approval again.`,
      );
    }
    if (computeCitadelWardIntegrationTargetFingerprint(connection, request.actionId) !== request.targetFingerprint) {
      throw new CitadelWardApprovalEffectError(
        "blocked",
        `The connection's target changed after approval; nothing was sent. Approval ${wardApproval.approvalId} must be requested again.`,
      );
    }
    const wardAction = buildIntegrationWardAction(connection.catalogId, request.actionId);
    const live = await resolveWardEffectForExternalAction({
      storage: host.storage,
      workspaceId: connection.workspaceId,
      action: wardAction,
    });
    if (wardAction !== payload.wardAction || live.citadelId !== payload.citadelId) {
      throw new CitadelWardApprovalEffectError(
        "blocked",
        `The connection's citadel changed after approval ${wardApproval.approvalId}; nothing was executed. Request approval again.`,
      );
    }
    const result = await invokeIntegrationConnectionAction(
      host,
      request.connectionId,
      request.actionId,
      {
        input: request.input,
        idempotencyKey: citadelWardReplayIdempotencyKey(wardApproval.approvalId, request.idempotencyKey),
      },
      { wardApproval },
    );
    return mapIntegrationResult(result);
  }

  private async executeA2AOutbound(
    approvedRequest: Record<string, unknown>,
    wardApproval: CitadelWardApprovalRef,
  ): Promise<Record<string, unknown>> {
    const { outbound, actorId } = readOutboundRequest(approvedRequest);
    const result = await this.deps.a2a().sendOutbound(
      {
        ...outbound,
        idempotencyKey: citadelWardReplayIdempotencyKey(wardApproval.approvalId, outbound.idempotencyKey),
      },
      actorId,
      undefined,
      { wardApproval },
    );
    return mapOutboundResult(result);
  }

  private async executeA2APush(
    payload: CitadelWardApprovalPayload,
    approvedRequest: Record<string, unknown>,
    wardApproval: CitadelWardApprovalRef,
  ): Promise<Record<string, unknown>> {
    const push = readPushRequest(approvedRequest);
    const results = await this.deps.a2a().deliverApprovedPush({
      approvalId: wardApproval.approvalId,
      wardAction: wardApproval.wardAction,
      taskId: push.taskId,
      peerId: push.peerId,
      eventSequence: push.eventSequence,
      urlHash: push.urlHash,
      citadelId: payload.citadelId,
      ...(payload.workspaceId !== undefined ? { workspaceId: payload.workspaceId } : {}),
      ...(push.configCreatedAt !== undefined ? { configCreatedAt: push.configCreatedAt } : {}),
    });
    const [first] = results;
    return first ? mapPushResult(first) : this.readSettledPush(push, wardApproval.approvalId);
  }

  /**
   * The push owner returns no result both when the approved event already settled (a retry
   * after delivery or refusal) and when its config or binding is gone or the event is no longer
   * next. Only the approved config that already moved past the event is settled; anything else
   * delivered nothing and fails closed. A config re-created after approval is never settled by it,
   * and the refusal this raises does not advance that config.
   */
  private async readSettledPush(push: PushEventIdentity, approvalId: string): Promise<Record<string, unknown>> {
    const config = await this.deps.storage.a2aTaskPushConfigs.find(push.taskId, push.peerId);
    if (config && !isCitadelWardApprovedPushConfig(config, push.configCreatedAt)) {
      throw new CitadelWardApprovalEffectError(
        "blocked",
        `The push config approved by ${approvalId} was deleted and set again after approval; nothing was delivered.`,
      );
    }
    if (config && config.lastEventSequence >= push.eventSequence) {
      return { disposition: "already_settled", eventSequence: push.eventSequence };
    }
    throw new CitadelWardApprovalEffectError(
      "blocked",
      `The push config or task binding approved by ${approvalId} is gone, disabled or no longer at event ${push.eventSequence}; nothing was delivered.`,
    );
  }

  private async readApproval(
    approvalId: string,
    statuses: readonly ApprovalRequest["status"][],
  ): Promise<ApprovalRequest> {
    const approval = await this.findApproval(approvalId);
    if (!approval || !isCitadelWardApprovalKind(approval.kind) || !statuses.includes(approval.status)) {
      throw new CitadelWardApprovalEffectError(
        "approval_not_approved",
        `Approval ${approvalId} is not a ${statuses.join(" or ")} Citadel Ward approval.`,
      );
    }
    return approval;
  }

  private async findApproval(approvalId: string): Promise<ApprovalRequest | undefined> {
    try {
      return await this.deps.storage.approvals.get(approvalId);
    } catch (error) {
      // Only a missing approval is terminal; any other read failure is infrastructure,
      // so it propagates and the effect worker defers and retries.
      if (!(error instanceof NotFoundError)) throw error;
      return undefined;
    }
  }
}

function readWardPayload(approval: ApprovalRequest): CitadelWardApprovalPayload {
  const payload = readCitadelWardApprovalPayload(approval.kind, approval.payload);
  if (!payload) {
    throw invalidPayload(approval.approvalId);
  }
  return payload;
}

function invalidPayload(approvalId?: string): CitadelWardApprovalEffectError {
  return new CitadelWardApprovalEffectError(
    "invalid_payload",
    `The Citadel Ward approval${approvalId ? ` ${approvalId}` : ""} payload is malformed.`,
  );
}

/** The plaintext request of a push approval; a sealed payload here is malformed. */
function readPlainRequest(approval: ApprovalRequest): Record<string, unknown> {
  const payload = readWardPayload(approval);
  if (!("request" in payload)) throw invalidPayload(approval.approvalId);
  return payload.request;
}

/** A blank or missing workspace id means unbound. */
function normalizeWorkspaceId(workspaceId: string | undefined): string | undefined {
  return workspaceId?.trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw invalidPayload();
  return value;
}

function readIntegrationRequest(request: Record<string, unknown>): {
  connectionId: string;
  actionId: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  targetFingerprint: string;
} {
  const invokeRequest = request.invokeRequest;
  if (!isRecord(invokeRequest) || (invokeRequest.input !== undefined && !isRecord(invokeRequest.input))) {
    throw invalidPayload();
  }
  const { idempotencyKey } = invokeRequest;
  return {
    connectionId: readString(request.connectionId),
    actionId: readString(request.actionId),
    targetFingerprint: readString(request.targetFingerprint),
    input: (invokeRequest.input as Record<string, unknown> | undefined) ?? {},
    ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
  };
}

function readOutboundRequest(request: Record<string, unknown>): {
  outbound: A2AOutboundPreviewRequest;
  actorId: string;
} {
  const outbound = request.outbound;
  if (!isRecord(outbound) || !isRecord(outbound.params)) throw invalidPayload();
  readString(outbound.peerId);
  readString(outbound.method);
  return { outbound: outbound as unknown as A2AOutboundPreviewRequest, actorId: readString(request.actorId) };
}

/** The push event an approval names; `configCreatedAt` is absent on approvals opened before it was recorded. */
interface PushEventIdentity {
  taskId: string;
  peerId: string;
  eventSequence: number;
  configCreatedAt?: string;
}

function readPushRequest(request: Record<string, unknown>): PushEventIdentity & { urlHash: string } {
  const { eventSequence, configCreatedAt } = request;
  if (typeof eventSequence !== "number" || !Number.isInteger(eventSequence)) throw invalidPayload();
  return {
    taskId: readString(request.taskId),
    peerId: readString(request.peerId),
    eventSequence,
    urlHash: readString(request.urlHash),
    ...(configCreatedAt !== undefined ? { configCreatedAt: readString(configCreatedAt) } : {}),
  };
}

function readWardRequest(approval: ApprovalRequest): Record<string, unknown> | undefined {
  const payload = readCitadelWardApprovalPayload(approval.kind, approval.payload);
  return payload && "request" in payload ? payload.request : undefined;
}

/** The push event identity for recording a failure; undefined when the request does not name one. */
function readPushRequestOrUndefined(request: Record<string, unknown>): PushEventIdentity | undefined {
  const { taskId, peerId, eventSequence, configCreatedAt } = request;
  if (typeof taskId !== "string" || !taskId.trim() || typeof peerId !== "string" || !peerId.trim()) return undefined;
  // A malformed config binding cannot say which config it names, so nothing is recorded.
  if (configCreatedAt !== undefined && (typeof configCreatedAt !== "string" || !configCreatedAt.trim())) {
    return undefined;
  }
  return typeof eventSequence === "number" && Number.isInteger(eventSequence)
    ? { taskId, peerId, eventSequence, ...(configCreatedAt !== undefined ? { configCreatedAt } : {}) }
    : undefined;
}

function mapIntegrationResult(result: IntegrationActionInvokeResult): Record<string, unknown> {
  const auditRef = typeof result.output?.sideEffectRunId === "string" ? result.output.sideEffectRunId : undefined;
  const base = { connectionId: result.connectionId, actionId: result.actionId, ...(auditRef ? { auditRef } : {}) };
  if (result.status === "executed") {
    return { disposition: "executed", replayed: false, ...base };
  }
  if (result.blockedReason === INTEGRATION_DUPLICATE_REASON) {
    return { disposition: "replayed", replayed: true, ...base };
  }
  if (result.blockedReason === INTEGRATION_IN_PROGRESS_REASON) {
    // Not a refusal: the worker defers and the retry sees the settled run.
    throw new Error(`Integration action ${result.actionId} is still in progress under its approval replay key.`);
  }
  if (result.blockedReason === "citadel_ward_deny") {
    throw new CitadelWardApprovalEffectError("ward_denied", result.message);
  }
  throw new CitadelWardApprovalEffectError("blocked", result.message);
}

function mapOutboundResult(result: A2AOutboundSendResponse): Record<string, unknown> {
  const base = {
    peerId: result.peerId,
    method: result.method,
    ...(result.auditRef ? { auditRef: result.auditRef } : {}),
  };
  if (result.status === "sent" || result.status === "replayed") {
    return { disposition: result.status, replayed: result.status === "replayed", ...base };
  }
  const message = result.warnings.join(" ") || `A2A ${result.method} to ${result.peerId} was ${result.status}.`;
  throw new CitadelWardApprovalEffectError(
    result.warnings.some((warning) => DENY_WARNING.test(warning)) ? "ward_denied" : "blocked",
    message,
  );
}

function mapPushResult(first: A2ATaskPushDeliveryResult): Record<string, unknown> {
  if (first.status === "delivered") {
    return {
      disposition: "delivered",
      eventSequence: first.eventSequence,
      attemptCount: first.attemptCount,
      ...(first.auditRef ? { auditRef: first.auditRef } : {}),
    };
  }
  const message = first.error ?? `A2A push of event ${first.eventSequence} was ${first.status}.`;
  throw new CitadelWardApprovalEffectError(DENY_WARNING.test(message) ? "ward_denied" : "blocked", message);
}

export type CitadelWardApprovalEffectUpsert = Pick<
  ApprovalEffectRecord,
  "approvalId" | "effectKind" | "targetKind" | "targetId" | "idempotencyKey" | "payload"
>;

/**
 * Returns the effect row an approval resolution enqueues for a Citadel Ward approval, or
 * undefined for any other kind. An approval executes; a rejection, an edit (never an execution
 * grant for a ward approval) or an expiry records the refusal. The target is the approval
 * itself; an approved payload without its hash fails the resolution closed.
 */
export function buildCitadelWardApprovalEffectUpsert(
  approval: ApprovalRequest,
  decision: "approve" | "reject" | "edit",
  expired = false,
): CitadelWardApprovalEffectUpsert | undefined {
  const effectKind = EFFECT_KIND_BY_APPROVAL_KIND[approval.kind];
  if (!effectKind) {
    return undefined;
  }
  const payloadHash = approval.payload.payloadHash;
  const hash = typeof payloadHash === "string" && payloadHash.trim() ? payloadHash : undefined;
  if (decision === "approve" && !hash) {
    throw new ConflictError({
      code: "STATE_CONFLICT",
      message: `Approval ${approval.approvalId} does not carry a canonical ${approval.kind} binding.`,
    });
  }
  const identity = {
    approvalId: approval.approvalId,
    effectKind,
    targetKind: CITADEL_WARD_EFFECT_TARGET_KIND,
    targetId: approval.approvalId,
  };
  return {
    ...identity,
    idempotencyKey: buildApprovalEffectIdempotencyKey(identity),
    payload: { decision, ...(expired ? { expired: true } : {}), ...(hash ? { payloadHash: hash } : {}) },
  };
}

/**
 * Runs one claimed Citadel Ward effect with the communications settlement semantics: the
 * executor result completes the effect, a `CitadelWardApprovalEffectError` fails it terminally
 * with its code, and only an unexpected infrastructure error defers for retry.
 */
export async function runCitadelWardApprovalEffect(
  effect: ApprovalEffectRecord,
  executors: CitadelWardApprovalEffectExecutors,
  settlement: CommunicationsApprovalEffectSettlement,
): Promise<void> {
  const { workerId, approvalEffects } = settlement;
  const execute = selectCitadelWardExecutor(effect, executors);
  if (!execute) {
    await approvalEffects.failEffect(effect.effectId, workerId, effect.version, {
      lastError: "Citadel Ward effect is missing its executor.",
      result: { configured: false },
    });
    return;
  }
  try {
    const result = await execute({ approvalId: effect.approvalId });
    if (!(await settlement.isEffectStillClaimed(effect.effectId))) return;
    const completed = await approvalEffects.completeEffect(effect.effectId, workerId, effect.version, {
      result: { ...result },
    });
    if (!completed) {
      throw new Error(`Citadel Ward effect ${effect.effectId} lost its completion lease.`);
    }
  } catch (error) {
    if (!(await settlement.isEffectStillClaimed(effect.effectId))) return;
    if (error instanceof CitadelWardApprovalEffectError) {
      await approvalEffects.failEffect(effect.effectId, workerId, effect.version, {
        lastError: error.message,
        result: { errorCode: error.code },
      });
      return;
    }
    await settlement.deferForRetry(error);
  }
}

function selectCitadelWardExecutor(
  effect: ApprovalEffectRecord,
  executors: CitadelWardApprovalEffectExecutors,
): ((input: { approvalId: string }) => Promise<Record<string, unknown>>) | undefined {
  if (effect.payload.decision === "approve") {
    const execute = executors.executeApprovedCitadelWardAction;
    return execute && ((input) => execute.call(executors, input));
  }
  const refuse = executors.recordCitadelWardApprovalRefused;
  const expired = effect.payload.expired === true;
  return refuse && ((input) => refuse.call(executors, { ...input, expired }));
}

/**
 * The approval-effects deps for the Citadel Ward executors. The integration host and the A2A
 * route service are resolved lazily per effect, because the gateway composes them later.
 */
export function buildCitadelWardApprovalEffectDeps(
  input: CitadelWardApprovalEffectDeps,
): Required<CitadelWardApprovalEffectExecutors> {
  const service = new CitadelWardApprovalEffectService(input);
  return {
    executeApprovedCitadelWardAction: (request) => service.executeApprovedAction(request),
    recordCitadelWardApprovalRefused: (request) => service.recordRefused(request),
  };
}
