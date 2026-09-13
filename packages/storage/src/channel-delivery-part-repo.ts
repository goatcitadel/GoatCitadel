import { createHash } from "node:crypto";
import { canonicalJsonString, ConflictError, type ToolInvokeRequest } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export type ChannelDeliveryPartStatus =
  | "prepared"
  | "waiting_approval"
  | "dispatching"
  | "sent"
  | "failed"
  | "manual_reconciliation_required";
export interface ChannelDeliveryPartRecord {
  partId: string;
  deliveryId: string;
  attempt: number;
  partIndex: number;
  payloadHash: string;
  requestHash: string;
  claimExpiresAt: string;
  status: ChannelDeliveryPartStatus;
  approvalId?: string;
  providerDeliveryId?: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

type PartRow = {
  part_id: string;
  delivery_id: string;
  attempt: number;
  part_index: number;
  payload_hash: string;
  request_hash: string;
  claim_expires_at: string;
  status: ChannelDeliveryPartStatus;
  approval_id: string | null;
  provider_delivery_id: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export function channelDeliveryPartId(deliveryId: string, attempt: number, partIndex: number): string {
  return `channel-part-${digest({ deliveryId, attempt, partIndex })}`;
}

export function isChannelDeliveryPartId(value: string | undefined): value is string {
  return value?.startsWith("channel-part-") === true;
}

/** Bind executable arguments and canonical scope; policy/grant evaluation remains
 * the policy engine's independent authority and can still refuse this request. */
export function channelDeliveryPartRequestHash(request: ToolInvokeRequest): string {
  return digest({
    toolName: request.toolName,
    args: request.args,
    workspaceId: request.workspaceId ?? request.policyContext?.workspaceId ?? "default",
    sessionId: request.sessionId,
    agentId: request.agentId,
    taskId: request.taskId ?? request.policyContext?.taskId ?? null,
    runId: request.runId ?? request.policyContext?.runId ?? null,
  });
}

export class ChannelDeliveryPartRepository {
  private readonly findStmt;
  private readonly listStmt;
  private readonly insertStmt;
  private readonly waitStmt;
  private readonly waitParentStmt;
  private readonly providerStmt;
  private readonly finishStmt;
  private readonly rejectStmt;
  private readonly parentStmt;

  constructor(private readonly db: DatabaseClient) {
    this.findStmt = db.prepare("SELECT * FROM channel_delivery_parts WHERE part_id = @partId");
    this.listStmt = db.prepare(
      "SELECT * FROM channel_delivery_parts WHERE delivery_id = @deliveryId AND attempt = @attempt ORDER BY part_index LIMIT 2048",
    );
    this.parentStmt = db.prepare(`SELECT status, delivery_status, attempts, payload_hash, next_attempt_at,
      connection_id, channel_key, target FROM comms_deliveries WHERE delivery_id = @deliveryId${db.dialect === "postgres" ? " FOR UPDATE" : ""}`);
    this.insertStmt = db.prepare(`
      INSERT INTO channel_delivery_parts (part_id, delivery_id, attempt, part_index, payload_hash, request_hash,
        claim_expires_at, status, revision, created_at, updated_at)
      VALUES (@partId, @deliveryId, @attempt, @partIndex, @payloadHash, @requestHash, @claimExpiresAt, 'prepared', 1, @now, @now)
    `);
    this.waitStmt = db.prepare(`
      UPDATE channel_delivery_parts SET status = 'waiting_approval', approval_id = @approvalId,
        revision = revision + 1, updated_at = @now
      WHERE part_id = @partId AND revision = @revision AND status = 'prepared' AND request_hash = @requestHash
    `);
    this.waitParentStmt = db.prepare(`
      UPDATE comms_deliveries SET delivery_status = 'waiting_approval', next_attempt_at = @now, updated_at = @now,
        error = NULL, stale_reason = NULL
      WHERE delivery_id = @deliveryId AND status = 'queued' AND attempts = @attempt
        AND payload_hash = @payloadHash AND next_attempt_at = @claimExpiresAt
    `);
    this.providerStmt = db.prepare(`
      UPDATE channel_delivery_parts SET status = 'dispatching', provider_delivery_id = @providerDeliveryId,
        revision = revision + 1, updated_at = @now
      WHERE part_id = @partId AND revision = @revision AND status IN ('prepared', 'waiting_approval')
        AND request_hash = @requestHash
    `);
    this.finishStmt = db.prepare(`
      UPDATE channel_delivery_parts SET status = @status, revision = revision + 1, updated_at = @now
      WHERE part_id = @partId AND revision = @revision AND status = 'dispatching' AND provider_delivery_id = @providerDeliveryId
    `);
    this.rejectStmt = db.prepare(`
      UPDATE channel_delivery_parts SET status = 'failed', revision = revision + 1, updated_at = @now
      WHERE part_id = @partId AND revision = @revision AND status IN ('prepared', 'waiting_approval')
    `);
  }

  find(partId: string): ChannelDeliveryPartRecord | undefined {
    const row = this.findStmt.get({ partId }) as PartRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(deliveryId: string, attempt: number): ChannelDeliveryPartRecord[] {
    return (this.listStmt.all({ deliveryId, attempt }) as PartRow[]).map(mapRow);
  }

  prepare(
    input: Pick<
      ChannelDeliveryPartRecord,
      "deliveryId" | "attempt" | "partIndex" | "payloadHash" | "requestHash" | "claimExpiresAt"
    >,
    now = new Date().toISOString(),
  ): ChannelDeliveryPartRecord {
    if (
      !Number.isSafeInteger(input.attempt) ||
      input.attempt < 1 ||
      !Number.isSafeInteger(input.partIndex) ||
      input.partIndex < 0 ||
      input.partIndex >= 2048 ||
      !/^[a-f0-9]{64}$/.test(input.payloadHash) ||
      !/^[a-f0-9]{64}$/.test(input.requestHash)
    )
      throw new Error("Invalid channel delivery part binding.");
    const partId = channelDeliveryPartId(input.deliveryId, input.attempt, input.partIndex);
    return this.db.transaction("immediate", () => {
      const existing = this.find(partId);
      if (existing) {
        if (existing.requestHash !== input.requestHash || existing.payloadHash !== input.payloadHash)
          throw conflict("Channel delivery part material changed.");
        return existing;
      }
      this.assertActiveParent(input, now, true);
      this.insertStmt.run({ ...input, partId, now });
      return this.find(partId)!;
    });
  }

  /** Called inside the approval creation transaction; failure rolls back the
   * approval and pending action instead of leaving an unlinked executable send. */
  bindApproval(
    partId: string,
    requestHash: string,
    approvalId: string,
    now = new Date().toISOString(),
  ): ChannelDeliveryPartRecord {
    return this.db.transaction("immediate", () => {
      const part = this.require(partId, requestHash);
      if (part.status === "waiting_approval" && part.approvalId === approvalId) return part;
      this.assertActiveParent(part, now, true);
      this.assertApproval(part, approvalId, "pending", now);
      if (
        this.waitStmt.run({ partId, requestHash, approvalId, revision: part.revision, now }).changes !== 1 ||
        this.waitParentStmt.run({
          deliveryId: part.deliveryId,
          attempt: part.attempt,
          payloadHash: part.payloadHash,
          claimExpiresAt: part.claimExpiresAt,
          now,
        }).changes !== 1
      )
        throw conflict("Channel delivery lost its approval handoff claim.");
      return this.find(partId)!;
    });
  }

  /** Provider-row insertion and this transition must share the caller's storage
   * transaction. A provider request is allowed only after it commits. */
  attachProvider(
    partId: string,
    requestHash: string,
    providerDeliveryId: string,
    now = new Date().toISOString(),
  ): ChannelDeliveryPartRecord {
    return this.db.transaction("immediate", () => {
      const part = this.require(partId, requestHash);
      this.assertActiveParent(part, now, part.status === "prepared");
      if (part.status === "waiting_approval") {
        this.assertApproval(part, part.approvalId!, "approved", now);
      }
      const provider = this.db
        .prepare(
          `SELECT provider.delivery_id FROM comms_deliveries provider
        JOIN comms_deliveries parent ON parent.delivery_id = @deliveryId
        WHERE provider.delivery_id = @providerDeliveryId AND provider.delivery_id <> parent.delivery_id
          AND provider.status = 'queued' AND provider.attempts = 0
          AND provider.connection_id = parent.connection_id AND provider.channel_key = parent.channel_key
          AND provider.target = parent.target`,
        )
        .get({ deliveryId: part.deliveryId, providerDeliveryId });
      if (!provider) throw conflict("Channel provider receipt does not belong to this delivery.");
      if (
        this.providerStmt.run({ partId, requestHash, providerDeliveryId, revision: part.revision, now }).changes !== 1
      )
        throw conflict("Channel delivery part already dispatched or lost its claim.");
      return this.find(partId)!;
    });
  }

  finish(
    partId: string,
    providerDeliveryId: string,
    revision: number,
    status: "sent" | "failed" | "manual_reconciliation_required",
    now = new Date().toISOString(),
  ): boolean {
    return this.db.transaction("immediate", () => {
      const provider = this.db
        .prepare("SELECT status, delivery_status FROM comms_deliveries WHERE delivery_id = @providerDeliveryId")
        .get({ providerDeliveryId }) as { status: string; delivery_status: string } | undefined;
      if (
        !provider ||
        (status === "sent"
          ? provider.status !== "sent" || provider.delivery_status !== "sent"
          : provider.status !== "failed" ||
            (status === "manual_reconciliation_required") !==
              (provider.delivery_status === "manual_reconciliation_required"))
      )
        throw conflict("Channel delivery part has no matching terminal provider receipt.");
      return this.finishStmt.run({ partId, providerDeliveryId, revision, status, now }).changes === 1;
    });
  }

  /** Return the current queue claim to approval polling without reviving a
   * finalized delivery or taking another runtime's renewed claim. */
  park(partId: string, claimExpiresAt: string, nextAttemptAt: string, now = new Date().toISOString()): boolean {
    return this.db.transaction("immediate", () => {
      const part = this.find(partId);
      if (!part?.approvalId || part.status === "prepared") return false;
      return (
        this.db
          .prepare(
            `UPDATE comms_deliveries SET delivery_status = 'waiting_approval',
        next_attempt_at = @nextAttemptAt, updated_at = @now, error = NULL, stale_reason = NULL
        WHERE delivery_id = @deliveryId AND status = 'queued' AND attempts = @attempt AND payload_hash = @payloadHash
          AND (next_attempt_at = @claimExpiresAt OR delivery_status = 'waiting_approval')`,
          )
          .run({
            deliveryId: part.deliveryId,
            attempt: part.attempt,
            payloadHash: part.payloadHash,
            claimExpiresAt,
            nextAttemptAt,
            now,
          }).changes === 1
      );
    });
  }

  reject(partId: string, revision: number, now = new Date().toISOString()): boolean {
    return this.rejectStmt.run({ partId, revision, now }).changes === 1;
  }

  private require(partId: string, requestHash: string): ChannelDeliveryPartRecord {
    const part = this.find(partId);
    if (!part || part.requestHash !== requestHash)
      throw conflict("Channel delivery part request identity is missing or changed.");
    return part;
  }

  private assertApproval(
    part: ChannelDeliveryPartRecord,
    approvalId: string,
    status: "pending" | "approved",
    now: string,
  ): void {
    const approval = this.db
      .prepare(
        `SELECT a.status, a.expires_at, a.kind, a.payload_json, p.action_type, p.request_json
      FROM approvals a JOIN pending_approval_actions p ON p.approval_id = a.approval_id
      WHERE a.approval_id = @approvalId`,
      )
      .get({ approvalId }) as
      | {
          status: string;
          expires_at: string;
          kind: string;
          payload_json: string;
          action_type: string;
          request_json: string;
        }
      | undefined;
    if (
      !approval ||
      approval.status !== status ||
      !isFuture(approval.expires_at, now) ||
      approval.kind !== "channel.send" ||
      approval.action_type !== "tool.invoke"
    )
      throw conflict("Channel delivery has no matching current approval action.");
    const request = JSON.parse(approval.request_json) as ToolInvokeRequest;
    const approvedPayload = JSON.parse(approval.payload_json) as Record<string, unknown>;
    delete approvedPayload.__gcApprovalLinkage;
    if (
      request.toolRunId !== part.partId ||
      request.toolName !== "channel.send" ||
      channelDeliveryPartRequestHash(request) !== part.requestHash ||
      digest(approvedPayload) !== digest(request.args)
    )
      throw conflict("Channel delivery approval request identity changed.");
  }

  private assertActiveParent(
    part: Pick<ChannelDeliveryPartRecord, "deliveryId" | "attempt" | "payloadHash" | "claimExpiresAt">,
    now: string,
    requireLease: boolean,
  ): void {
    const parent = this.parentStmt.get({ deliveryId: part.deliveryId }) as
      | {
          status: string;
          attempts: number;
          payload_hash: string;
          next_attempt_at: string | null;
        }
      | undefined;
    if (
      !parent ||
      parent.status !== "queued" ||
      Number(parent.attempts) !== part.attempt ||
      parent.payload_hash !== part.payloadHash ||
      (requireLease && (parent.next_attempt_at !== part.claimExpiresAt || !isFuture(part.claimExpiresAt, now)))
    )
      throw conflict("Channel delivery part does not own the current queue attempt.");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value)).digest("hex");
}
function conflict(message: string): ConflictError {
  return new ConflictError({ message });
}
function isFuture(value: string, now: string): boolean {
  return Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.parse(now);
}
function mapRow(row: PartRow): ChannelDeliveryPartRecord {
  return {
    partId: row.part_id,
    deliveryId: row.delivery_id,
    attempt: Number(row.attempt),
    partIndex: Number(row.part_index),
    payloadHash: row.payload_hash,
    requestHash: row.request_hash,
    claimExpiresAt: row.claim_expires_at,
    status: row.status,
    approvalId: row.approval_id ?? undefined,
    providerDeliveryId: row.provider_delivery_id ?? undefined,
    revision: Number(row.revision),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
