import {
  ConflictError,
  type ApprovalEffectRecord,
  type ApprovalRequest,
  type CalendarCreateEventInput,
  type GmailSendInput,
  type IntegrationConnection,
  type MailDraftRecord,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import { buildApprovalEffectIdempotencyKey, type AsyncStorage } from "@goatcitadel/storage";
import {
  buildCommsPreApproval,
  commsCalendarCreate,
  commsGmailSend,
  commsSmtpSend,
  type CommsHost,
  type CommsPreApproval,
} from "./comms-service.js";
import {
  communicationsIdempotencyKey,
  computeCommunicationsPayloadHash,
  readCalendarCreateApprovalInput,
  readMailSendApprovalInput,
} from "./communications-approval-payload.js";
import { resolveCalendarProvider, resolveMailProvider } from "./communications-dashboard-service.js";

/**
 * Executes approved `communications.mail.send` / `communications.calendar.create`
 * approvals exactly once. The approval's stored payload is re-read and hash-verified,
 * the provider call runs through the comms external side-effect ledger keyed by
 * `communications:<approvalId>`, and a replay of a completed ledger run is reported as
 * already done instead of sending twice. Every refusal is a terminal
 * `CommunicationsApprovalEffectError`; any other error is infrastructure and may retry,
 * because the ledger turns a retry after the external boundary into `outcome_unknown`.
 */
export const COMMUNICATIONS_MAIL_SEND_EFFECT_KIND = "communications_mail_send_apply" as const;
export const COMMUNICATIONS_CALENDAR_CREATE_EFFECT_KIND = "communications_calendar_create_apply" as const;
export const COMMUNICATIONS_MAIL_SEND_EFFECT_TARGET_KIND = "mail_draft" as const;
export const COMMUNICATIONS_CALENDAR_CREATE_EFFECT_TARGET_KIND = "calendar_event" as const;
export const COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND = "communications.mail.send";
export const COMMUNICATIONS_CALENDAR_CREATE_APPROVAL_KIND = "communications.calendar.create";

/** True for the approval kinds whose execution must stay on the communications ledger. */
export function isCommunicationsApprovalKind(kind: string): boolean {
  return kind === COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND || kind === COMMUNICATIONS_CALENDAR_CREATE_APPROVAL_KIND;
}

export type CommunicationsEffectErrorCode =
  | "approval_not_approved"
  | "invalid_payload"
  | "payload_hash_mismatch"
  | "provider_unavailable"
  | "send_unavailable"
  | "delivery_failed"
  | "outcome_unknown";

export class CommunicationsApprovalEffectError extends Error {
  public constructor(
    public readonly code: CommunicationsEffectErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommunicationsApprovalEffectError";
  }
}

type CommsResult = ToolInvokeResult | Record<string, unknown>;

export interface CommunicationsApprovalEffectDeps {
  storage: Pick<AsyncStorage, "approvals" | "mailDrafts" | "pendingApprovalActions" | "externalSideEffectRuns">;
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
  commsGmailSend(input: GmailSendInput, preApproval: CommsPreApproval): Promise<CommsResult>;
  commsSmtpSend(input: GmailSendInput, preApproval: CommsPreApproval): Promise<CommsResult>;
  commsCalendarCreate(
    input: CalendarCreateEventInput & { idempotencyKey: string },
    preApproval: CommsPreApproval,
  ): Promise<CommsResult>;
  now?: () => Date;
}

export const MAIL_SEND_REJECTED_REASON = "Send approval was rejected; nothing was sent.";
export const MAIL_SEND_EXPIRED_REASON = "Send approval expired; nothing was sent.";
const MAIL_OUTCOME_UNKNOWN_REASON = "Delivery outcome is unknown; check the mailbox before retrying.";
const CALENDAR_OUTCOME_UNKNOWN_REASON = "Calendar create outcome is unknown; check the calendar before retrying.";
const PAYLOAD_HASH_MISMATCH_REASON = "The approved message no longer matches its approval; nothing was sent.";
/** Thrown by `buildCommsPreApproval` when the approval's pending action is already settled. */
const PRE_APPROVAL_SETTLED_MESSAGE = "Approved communications action already settled; refusing to invoke again.";
const SENT_PROVIDER_STATUSES = new Set(["sent", "created"]);

type ProviderOutcome = { providerId?: string; replayed: boolean };

export class CommunicationsApprovalEffectService {
  public constructor(private readonly deps: CommunicationsApprovalEffectDeps) {}

  public async executeApprovedMailSend(input: {
    approvalId: string;
  }): Promise<{ disposition: "sent"; providerMessageId?: string; replayed: boolean }> {
    const { approvalId } = input;
    const approval = await this.readApproval(approvalId, COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND, "approved");
    const mail = readMailSendApprovalInput(approval.payload);
    if (!mail) {
      throw new CommunicationsApprovalEffectError("invalid_payload", "The mail send approval payload is malformed.");
    }
    const failDraft = (error: CommunicationsApprovalEffectError, reason = error.message) =>
      this.failDraft(mail.draftId, reason).then(() => Promise.reject(error));
    if (computeCommunicationsPayloadHash(mail) !== approval.payload.payloadHash) {
      return failDraft(new CommunicationsApprovalEffectError("payload_hash_mismatch", PAYLOAD_HASH_MISMATCH_REASON));
    }
    try {
      const connection = await this.readConnection(mail.accountId);
      const send = this.selectMailSender(connection);
      const result = await this.invokeApproved(approval, (preApproval) =>
        send(
          {
            connectionId: mail.accountId,
            to: mail.to,
            cc: mail.cc,
            bcc: mail.bcc,
            subject: mail.subject,
            bodyText: mail.bodyText,
            idempotencyKey: communicationsIdempotencyKey(approvalId),
          },
          preApproval,
        ),
      );
      const outcome = await this.classify(result, "Mail send", MAIL_OUTCOME_UNKNOWN_REASON);
      await this.deps.storage.mailDrafts.transition(mail.draftId, ["approval_required", "failed"], {
        status: "sent",
        clearFailureReason: true,
        sentAt: this.nowIso(),
        updatedAt: this.nowIso(),
      });
      return {
        disposition: "sent",
        ...(outcome.providerId ? { providerMessageId: outcome.providerId } : {}),
        replayed: outcome.replayed,
      };
    } catch (error) {
      if (error instanceof CommunicationsApprovalEffectError) {
        return failDraft(error);
      }
      throw error;
    }
  }

  public async executeApprovedCalendarCreate(input: {
    approvalId: string;
  }): Promise<{ disposition: "created"; providerEventId?: string; replayed: boolean }> {
    const { approvalId } = input;
    const approval = await this.readApproval(approvalId, COMMUNICATIONS_CALENDAR_CREATE_APPROVAL_KIND, "approved");
    const event = readCalendarCreateApprovalInput(approval.payload);
    if (!event) {
      throw new CommunicationsApprovalEffectError(
        "invalid_payload",
        "The calendar create approval payload is malformed.",
      );
    }
    if (computeCommunicationsPayloadHash(event) !== approval.payload.payloadHash) {
      throw new CommunicationsApprovalEffectError(
        "payload_hash_mismatch",
        "The approved event no longer matches its approval; nothing was created.",
      );
    }
    this.assertCalendarCanCreate(await this.readConnection(event.accountId));
    const result = await this.invokeApproved(approval, (preApproval) =>
      this.deps.commsCalendarCreate(
        {
          connectionId: event.accountId,
          ...(event.calendarId === undefined ? {} : { calendarId: event.calendarId }),
          title: event.title,
          ...(event.description === undefined ? {} : { description: event.description }),
          startIso: event.startIso,
          endIso: event.endIso,
          attendees: event.attendees,
          ...(event.location === undefined ? {} : { location: event.location }),
          idempotencyKey: communicationsIdempotencyKey(approvalId),
        },
        preApproval,
      ),
    );
    const outcome = await this.classify(result, "Calendar create", CALENDAR_OUTCOME_UNKNOWN_REASON);
    return {
      disposition: "created",
      ...(outcome.providerId ? { providerEventId: outcome.providerId } : {}),
      replayed: outcome.replayed,
    };
  }

  /** Makes a denied (or expired) send visible on its draft. Never calls a provider. */
  public async recordMailSendRejected(input: {
    approvalId: string;
    expired?: boolean;
  }): Promise<{ disposition: "rejected" }> {
    const approval = await this.readApproval(input.approvalId, COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND, "rejected");
    const draftId = approval.payload.draftId;
    if (typeof draftId !== "string" || !draftId) {
      throw new CommunicationsApprovalEffectError("invalid_payload", "The rejected mail approval names no draft.");
    }
    await this.failDraft(draftId, input.expired ? MAIL_SEND_EXPIRED_REASON : MAIL_SEND_REJECTED_REASON);
    return { disposition: "rejected" };
  }

  private async readApproval(
    approvalId: string,
    kind: string,
    status: ApprovalRequest["status"],
  ): Promise<ApprovalRequest> {
    let approval: ApprovalRequest | undefined;
    try {
      approval = await this.deps.storage.approvals.get(approvalId);
    } catch {
      approval = undefined;
    }
    if (approval?.kind !== kind || approval.status !== status) {
      throw new CommunicationsApprovalEffectError(
        "approval_not_approved",
        `Approval ${approvalId} is not a ${status} ${kind} approval.`,
      );
    }
    return approval;
  }

  private async readConnection(accountId: string): Promise<IntegrationConnection> {
    try {
      return await this.deps.getIntegrationConnection(accountId);
    } catch {
      throw new CommunicationsApprovalEffectError(
        "provider_unavailable",
        "The approved account is no longer connected; nothing was sent.",
      );
    }
  }

  private selectMailSender(connection: IntegrationConnection): CommunicationsApprovalEffectDeps["commsGmailSend"] {
    const provider = resolveMailProvider(connection);
    if (provider === "gmail") {
      return (input, preApproval) => this.deps.commsGmailSend(input, preApproval);
    }
    if (provider === "imap" || provider === "smtp") {
      return (input, preApproval) => this.deps.commsSmtpSend(input, preApproval);
    }
    throw new CommunicationsApprovalEffectError(
      "provider_unavailable",
      `This mail account (${provider ?? connection.key}) cannot send; connect Gmail or an SMTP account.`,
    );
  }

  private assertCalendarCanCreate(connection: IntegrationConnection): void {
    const provider = resolveCalendarProvider(connection);
    if (provider !== "google") {
      throw new CommunicationsApprovalEffectError(
        "provider_unavailable",
        `This calendar account (${provider ?? connection.key}) cannot create events; connect Google Calendar.`,
      );
    }
  }

  /**
   * Runs one approved invoke in the approval's workspace; a settled pending action fails
   * closed instead of retrying.
   */
  private async invokeApproved(
    approval: ApprovalRequest,
    invoke: (preApproval: CommsPreApproval) => Promise<CommsResult>,
  ): Promise<CommsResult> {
    try {
      const workspaceId = approval.linkage?.workspaceId;
      return await invoke(buildCommsPreApproval(this.deps.storage, approval.approvalId, () => this.now(), workspaceId));
    } catch (error) {
      if (error instanceof Error && error.message === PRE_APPROVAL_SETTLED_MESSAGE) {
        throw new CommunicationsApprovalEffectError(
          "approval_not_approved",
          "This approval was already used; nothing was sent again.",
        );
      }
      throw error;
    }
  }

  /**
   * Classifies a ledgered comms result. A ledger replay (`replayOutcome !== "claimed"`)
   * is only "already done" when the recorded side-effect run completed; an in-progress,
   * mismatched or unreadable run is an unknown external outcome.
   */
  private async classify(result: CommsResult, label: string, unknownReason: string): Promise<ProviderOutcome> {
    if (typeof result === "object" && result !== null && "outcome" in result && result.outcome !== "executed") {
      const reason = (result as ToolInvokeResult).policyReason;
      throw new CommunicationsApprovalEffectError("delivery_failed", `${label} was not executed: ${reason}`);
    }
    const record = result as Record<string, unknown>;
    const replayOutcome = record.replayOutcome;
    if (
      replayOutcome === "duplicate" ||
      replayOutcome === "in_progress" ||
      replayOutcome === "payload_mismatch" ||
      // A fenced claim that crossed the dispatch boundary is never redispatched.
      replayOutcome === "unknown_after_send"
    ) {
      if (replayOutcome === "duplicate" && (await this.isLedgerRunCompleted(record.sideEffectRunId))) {
        return { replayed: true };
      }
      throw new CommunicationsApprovalEffectError("outcome_unknown", unknownReason);
    }
    if (SENT_PROVIDER_STATUSES.has(String(record.status))) {
      return { providerId: readProviderId(record), replayed: false };
    }
    if (
      record.status === "failed" &&
      (record.deliveryStatus === "blocked" || record.deliveryStatus === "not_available")
    ) {
      const reason = typeof record.error === "string" && record.error ? record.error : "the provider refused it";
      throw new CommunicationsApprovalEffectError("delivery_failed", `${label} failed: ${reason}`);
    }
    throw new CommunicationsApprovalEffectError("outcome_unknown", unknownReason);
  }

  private async isLedgerRunCompleted(runId: unknown): Promise<boolean> {
    if (typeof runId !== "string" || !runId) {
      return false;
    }
    try {
      return (await this.deps.storage.externalSideEffectRuns.get(runId)).status === "completed";
    } catch {
      return false;
    }
  }

  private async failDraft(draftId: string, reason: string): Promise<MailDraftRecord | undefined> {
    return this.deps.storage.mailDrafts.transition(draftId, ["approval_required"], {
      status: "failed",
      failureReason: reason,
      updatedAt: this.nowIso(),
    });
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function readProviderId(record: Record<string, unknown>): string | undefined {
  for (const key of ["providerMessageId", "providerEventId", "eventId", "messageId"]) {
    const value = record[key];
    if (typeof value === "string" && value) {
      return value;
    }
  }
  return undefined;
}

/** The communications executors the approval effects worker is composed with (all optional). */
export interface CommunicationsApprovalEffectExecutors {
  executeApprovedCommunicationsMailSend?(input: {
    approvalId: string;
  }): Promise<{ disposition: "sent"; providerMessageId?: string; replayed: boolean }>;
  executeApprovedCommunicationsCalendarCreate?(input: {
    approvalId: string;
  }): Promise<{ disposition: "created"; providerEventId?: string; replayed: boolean }>;
  recordCommunicationsMailSendRejected?(input: {
    approvalId: string;
    expired?: boolean;
  }): Promise<{ disposition: "rejected" }>;
}

export type CommunicationsApprovalEffectUpsert = Pick<
  ApprovalEffectRecord,
  "approvalId" | "effectKind" | "targetKind" | "targetId" | "idempotencyKey" | "payload"
>;

/**
 * Returns the effect row an approval resolution enqueues for a communications approval,
 * or undefined when none applies: an approved mail send or calendar create executes,
 * a rejected mail send marks its draft failed, a rejected calendar create needs nothing.
 * The target is the draft or event id from the server-built payload; a payload without
 * its binding fails the resolution closed.
 */
export function buildCommunicationsApprovalEffectUpsert(
  approval: ApprovalRequest,
  decision: "approve" | "reject" | "edit",
  expired = false,
): CommunicationsApprovalEffectUpsert | undefined {
  const payload = approval.payload as Record<string, unknown>;
  if (approval.kind === COMMUNICATIONS_MAIL_SEND_APPROVAL_KIND && (decision === "approve" || decision === "reject")) {
    const draftId = readBindingString(payload.draftId);
    if (decision === "reject") {
      return draftId
        ? buildEffectUpsert(
            approval,
            COMMUNICATIONS_MAIL_SEND_EFFECT_KIND,
            COMMUNICATIONS_MAIL_SEND_EFFECT_TARGET_KIND,
            draftId,
            { draftId, decision: "reject", ...(expired ? { expired: true } : {}) },
          )
        : throwMissingBinding(approval);
    }
    const accountId = readBindingString(payload.accountId);
    const payloadHash = readBindingString(payload.payloadHash);
    return draftId && accountId && payloadHash
      ? buildEffectUpsert(
          approval,
          COMMUNICATIONS_MAIL_SEND_EFFECT_KIND,
          COMMUNICATIONS_MAIL_SEND_EFFECT_TARGET_KIND,
          draftId,
          {
            draftId,
            accountId,
            payloadHash,
          },
        )
      : throwMissingBinding(approval);
  }
  if (approval.kind === COMMUNICATIONS_CALENDAR_CREATE_APPROVAL_KIND && decision === "approve") {
    const eventId = readBindingString(payload.eventId);
    const accountId = readBindingString(payload.accountId);
    const payloadHash = readBindingString(payload.payloadHash);
    return eventId && accountId && payloadHash
      ? buildEffectUpsert(
          approval,
          COMMUNICATIONS_CALENDAR_CREATE_EFFECT_KIND,
          COMMUNICATIONS_CALENDAR_CREATE_EFFECT_TARGET_KIND,
          eventId,
          { eventId, accountId, payloadHash },
        )
      : throwMissingBinding(approval);
  }
  return undefined;
}

function buildEffectUpsert(
  approval: ApprovalRequest,
  effectKind: CommunicationsApprovalEffectUpsert["effectKind"],
  targetKind: CommunicationsApprovalEffectUpsert["targetKind"],
  targetId: string,
  payload: Record<string, unknown>,
): CommunicationsApprovalEffectUpsert {
  const identity = { approvalId: approval.approvalId, effectKind, targetKind, targetId };
  return { ...identity, idempotencyKey: buildApprovalEffectIdempotencyKey(identity), payload };
}

function readBindingString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function throwMissingBinding(approval: ApprovalRequest): never {
  throw new ConflictError({
    code: "STATE_CONFLICT",
    message: `Approval ${approval.approvalId} does not carry a canonical ${approval.kind} binding.`,
  });
}

/** The effect-row operations one claimed communications effect settles through. */
export interface CommunicationsApprovalEffectSettlement {
  workerId: string;
  approvalEffects: Pick<AsyncStorage["approvalEffects"], "completeEffect" | "failEffect">;
  isEffectStillClaimed(effectId: string): Promise<boolean>;
  deferForRetry(error: unknown): Promise<unknown>;
}

/**
 * Runs one claimed communications effect (modeled on the mesh activation handler): the
 * executor result completes the effect, a `CommunicationsApprovalEffectError` fails it
 * terminally with its code, and only an unexpected infrastructure error defers for
 * retry. A retry after the provider boundary converges on `outcome_unknown` through the
 * side-effect ledger, so it can never send twice.
 */
export async function runCommunicationsApprovalEffect(
  effect: ApprovalEffectRecord,
  executors: CommunicationsApprovalEffectExecutors,
  settlement: CommunicationsApprovalEffectSettlement,
): Promise<void> {
  const { workerId, approvalEffects } = settlement;
  const execute = selectCommunicationsExecutor(effect, executors);
  if (!execute) {
    await approvalEffects.failEffect(effect.effectId, workerId, effect.version, {
      lastError: "Communications effect is missing its executor.",
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
      throw new Error(`Communications effect ${effect.effectId} lost its completion lease.`);
    }
  } catch (error) {
    if (!(await settlement.isEffectStillClaimed(effect.effectId))) return;
    if (error instanceof CommunicationsApprovalEffectError) {
      await approvalEffects.failEffect(effect.effectId, workerId, effect.version, {
        lastError: error.message,
        result: { errorCode: error.code },
      });
      return;
    }
    await settlement.deferForRetry(error);
  }
}

function selectCommunicationsExecutor(
  effect: ApprovalEffectRecord,
  executors: CommunicationsApprovalEffectExecutors,
): ((input: { approvalId: string }) => Promise<Record<string, unknown>>) | undefined {
  if (effect.effectKind === COMMUNICATIONS_CALENDAR_CREATE_EFFECT_KIND) {
    const create = executors.executeApprovedCommunicationsCalendarCreate;
    return create && ((input) => create.call(executors, input));
  }
  if (effect.payload.decision === "reject") {
    const reject = executors.recordCommunicationsMailSendRejected;
    const expired = effect.payload.expired === true;
    return reject && ((input) => reject.call(executors, { ...input, expired }));
  }
  const send = executors.executeApprovedCommunicationsMailSend;
  return send && ((input) => send.call(executors, input));
}

/** Composes the executor over the same comms host the communications routes use. */
export function createCommunicationsApprovalEffectService(
  storage: CommunicationsApprovalEffectDeps["storage"],
  host: CommsHost,
): CommunicationsApprovalEffectService {
  return new CommunicationsApprovalEffectService({
    storage,
    getIntegrationConnection: (connectionId) => host.getIntegrationConnection(connectionId),
    commsGmailSend: (input, preApproval) => commsGmailSend(host, input, preApproval),
    commsSmtpSend: (input, preApproval) => commsSmtpSend(host, input, preApproval),
    commsCalendarCreate: (input, preApproval) => commsCalendarCreate(host, input, preApproval),
  });
}

/**
 * The approval-effects deps for the communications executors. The comms host is built
 * lazily per effect, the same way the communications routes build theirs.
 */
export function buildCommunicationsApprovalEffectDeps(
  storage: CommunicationsApprovalEffectDeps["storage"],
  buildHost: () => CommsHost,
): Required<CommunicationsApprovalEffectExecutors> {
  const executor = () => createCommunicationsApprovalEffectService(storage, buildHost());
  return {
    executeApprovedCommunicationsMailSend: (input) => executor().executeApprovedMailSend(input),
    executeApprovedCommunicationsCalendarCreate: (input) => executor().executeApprovedCalendarCreate(input),
    recordCommunicationsMailSendRejected: (input) => executor().recordMailSendRejected(input),
  };
}
