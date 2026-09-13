import { randomUUID } from "node:crypto";
import {
  claimOffer,
  newLeaseSecret,
  pollOffers,
  renewLease,
  syncAssignment,
  type LeaseBinding,
  type RouteContext,
} from "./connected-worker-routes.js";
import type { WorkerCredentialVault } from "./worker-credential-vault.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import type { WorkerWireResponse } from "./worker-wire-client.js";
import { WorkerSettlementGuard, type WorkerSettlementReceipt } from "./worker-settlement-guard.js";
import { canonicalJsonString } from "@goatcitadel/contracts";

const ACTIVE_KEY = "connected-run";
const CLAIM_KEY = "assignment-claim-pending";
const RENEWAL_KEY = "assignment-renewal-pending";
const VERSION = "goatcitadel.worker-lease-intent.v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u;
const SECRET = /^[A-Za-z0-9_-]{43}$/u;

interface PendingClaim {
  schemaVersion: typeof VERSION;
  registryWorkspaceId: string;
  assignmentId: string;
  leaseToken: string;
  idempotencyKey: string;
}

interface PendingRenewal {
  schemaVersion: typeof VERSION;
  lease: LeaseBinding;
  nextLeaseToken: string;
  workerSentThrough: number;
  idempotencyKey: string;
}

interface LeaseRoutes {
  claim: typeof claimOffer;
  poll: typeof pollOffers;
  renew: typeof renewLease;
  sync: typeof syncAssignment;
}

/** Worker-local custody only. Gateway storage remains the assignment authority.
 * Persist the proposed secret before its request; after a lost response, replay
 * that exact request instead of minting a secret the Gateway has never seen.
 * One process/assignment writer must own this instance and its state directory. */
export class WorkerAssignmentLeaseOwner {
  private readonly routes: LeaseRoutes;
  private renewalDeadline = 0;
  private sentThrough = 0;

  public constructor(
    private readonly context: RouteContext,
    private readonly state: WorkerDurableStatePort,
    private readonly vault: WorkerCredentialVault,
    private readonly registryWorkspaceId: string,
    routes: Partial<LeaseRoutes> = {},
  ) {
    assertIdentifier(registryWorkspaceId);
    this.routes = { claim: claimOffer, poll: pollOffers, renew: renewLease, sync: syncAssignment, ...routes };
  }

  public async resumeOrClaim(observed: Record<string, unknown>): Promise<LeaseBinding | undefined> {
    const pendingClaim = await this.state.read(CLAIM_KEY);
    if (pendingClaim !== undefined) return await this.commitClaim(parseClaim(pendingClaim), observed);
    const pendingRenewal = await this.state.read(RENEWAL_KEY);
    if (pendingRenewal !== undefined) await this.commitRenewal(parseRenewal(pendingRenewal), observed);
    const active = await this.state.read(ACTIVE_KEY);
    if (active !== undefined) {
      const assignmentId = parseIntent(active).assignmentId;
      assertIdentifier(assignmentId);
      const retained = this.vault.getLease(assignmentId);
      const lease: LeaseBinding = {
        registryWorkspaceId: this.registryWorkspaceId,
        assignmentId,
        assignmentGeneration: retained.assignmentGeneration,
        leaseRevision: retained.leaseRevision,
        leaseToken: retained.rawLeaseToken,
      };
      const synced = await this.routes.sync(this.context, lease, `sync:${randomUUID()}`);
      assertLeaseResponse(synced, lease, lease.leaseRevision,
        ["synchronized", "waiting_approval", "approval_resume_pending", "approval_resume_ready",
          "parent_recovery_pending", "parent_recovery_ready"]);
      this.sentThrough = leaseWatermark(synced);
      observed.reconnectSync = synced.body.disposition;
      if (synced.body.disposition === "parent_recovery_pending" || synced.body.disposition === "parent_recovery_ready") {
        const recovery = record(synced.body.recovery);
        if (typeof recovery.bindingSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(recovery.bindingSha256))
          throw invalid("Gateway parent recovery has no retained binding authority.");
        this.renewalDeadline = 0;
        if (synced.body.disposition === "parent_recovery_ready")
          return await this.renew(lease, this.sentThrough, observed);
        observed.awaiting = "parent_recovery";
        return undefined;
      }
      if (synced.body.disposition === "approval_resume_pending" || synced.body.disposition === "approval_resume_ready") {
        const resume = record(synced.body.resume);
        assertIdentifier(resume.approvalId);
        for (const hash of [resume.runtimeAuthoritySha256, resume.resumeSha256])
          if (typeof hash !== "string" || !/^[a-f0-9]{64}$/u.test(hash))
            throw invalid("Gateway approval resume has no retained handoff authority.");
        this.renewalDeadline = 0;
        if (synced.body.disposition === "approval_resume_ready")
          return await this.renew(lease, this.sentThrough, observed);
        observed.awaiting = "approval_resolution";
        return undefined;
      }
      if (synced.body.disposition === "waiting_approval") {
        const waiting = record(synced.body.waiting);
        assertIdentifier(waiting.approvalId);
        if (typeof waiting.runtimeAuthoritySha256 !== "string" || !/^[a-f0-9]{64}$/u.test(waiting.runtimeAuthoritySha256))
          throw invalid("Gateway approval wait has no retained runtime authority.");
        this.renewalDeadline = 0;
        observed.awaiting = "approval_resolution";
        return undefined;
      }
      return lease;
    }
    const polled = await this.routes.poll(this.context, {
      registryWorkspaceId: this.registryWorkspaceId,
      idempotencyKey: `poll:${randomUUID()}`,
      limit: 1,
    });
    const items = polled.body.items;
    if (!Array.isArray(items) || items.length > 1) throw invalid("Offer response is invalid.");
    observed.offerCount = items.length;
    if (!items.length) return undefined;
    const assignmentId = record(record(items[0]).assignment).assignmentId;
    assertIdentifier(assignmentId);
    const intent: PendingClaim = {
      schemaVersion: VERSION,
      registryWorkspaceId: this.registryWorkspaceId,
      assignmentId,
      leaseToken: newLeaseSecret(),
      idempotencyKey: `claim:${assignmentId}`,
    };
    await this.state.write(CLAIM_KEY, JSON.stringify(intent));
    return await this.commitClaim(intent, observed);
  }

  public async renew(
    lease: LeaseBinding,
    workerSentThrough: number,
    observed: Record<string, unknown>,
  ): Promise<LeaseBinding> {
    assertLease(lease);
    const pending = await this.state.read(RENEWAL_KEY);
    if (pending !== undefined) {
      const intent = parseRenewal(pending);
      if (
        intent.lease.assignmentId !== lease.assignmentId ||
        intent.lease.assignmentGeneration !== lease.assignmentGeneration
      )
        throw invalid("Pending renewal belongs to another assignment.");
      return await this.commitRenewal(intent, observed);
    }
    const retained = this.vault.getLease(lease.assignmentId);
    if (
      retained.leaseRevision !== lease.leaseRevision ||
      retained.rawLeaseToken !== lease.leaseToken ||
      retained.assignmentGeneration !== lease.assignmentGeneration
    )
      throw invalid("Cannot renew stale local authority.");
    if (!Number.isSafeInteger(workerSentThrough) || workerSentThrough < this.sentThrough)
      throw invalid("Invalid transcript watermark.");
    const intent: PendingRenewal = {
      schemaVersion: VERSION,
      lease,
      nextLeaseToken: newLeaseSecret(),
      workerSentThrough,
      idempotencyKey: `renew:${lease.assignmentId}:${lease.assignmentGeneration}:${lease.leaseRevision}`,
    };
    await this.state.write(RENEWAL_KEY, JSON.stringify(intent));
    return await this.commitRenewal(intent, observed);
  }

  /** Monotonic window derived from a fresh Gateway renewal, conservatively
   * subtracting the entire request/persistence duration. It is scheduling
   * guidance only; Gateway lease fencing remains authoritative. */
  public remainingLeaseMs(): number {
    return Math.max(0, this.renewalDeadline - performance.now());
  }

  public workerSentThrough(): number {
    return this.sentThrough;
  }

  /** Publish terminal receipt first, then clear active work, then forget its
   * secret. The terminal intent remains until all three durable steps finish. */
  public async complete(receipt: WorkerSettlementReceipt): Promise<void> {
    const guard = await WorkerSettlementGuard.open(this.state);
    if (canonicalJsonString(guard.getReceipt(receipt.assignmentId)) !== canonicalJsonString(receipt))
      throw invalid("Assignment cleanup requires its retained terminal receipt.");
    if ((await this.state.read(CLAIM_KEY)) !== undefined || (await this.state.read(RENEWAL_KEY)) !== undefined)
      throw invalid("Assignment cleanup cannot discard an unresolved lease operation.");
    const active = await this.state.read(ACTIVE_KEY);
    if (active !== undefined && parseIntent(active).assignmentId !== receipt.assignmentId)
      throw invalid("Assignment cleanup cannot clear different active work.");
    await this.state.delete(ACTIVE_KEY);
    await this.vault.forgetLease(receipt.assignmentId);
  }

  private async commitClaim(intent: PendingClaim, observed: Record<string, unknown>): Promise<LeaseBinding> {
    if (intent.registryWorkspaceId !== this.registryWorkspaceId) throw invalid("Pending claim workspace changed.");
    const active = await this.state.read(ACTIVE_KEY);
    if (active !== undefined && parseIntent(active).assignmentId !== intent.assignmentId)
      throw invalid("A different assignment already owns the worker.");
    const response = await this.routes.claim(this.context, intent);
    const generation = record(response.body.generation).assignmentGeneration;
    if (!positive(generation)) throw invalid("Claim generation is invalid.");
    const lease: LeaseBinding = {
      registryWorkspaceId: intent.registryWorkspaceId,
      assignmentId: intent.assignmentId,
      assignmentGeneration: generation,
      leaseRevision: 1,
      leaseToken: intent.leaseToken,
    };
    assertLeaseResponse(response, lease, 1, ["started", "replayed_without_lease_secret"]);
    const watermark = leaseWatermark(response);
    await this.vault.retainLease({
      assignmentId: lease.assignmentId,
      assignmentGeneration: lease.assignmentGeneration,
      leaseRevision: lease.leaseRevision,
      rawLeaseToken: lease.leaseToken,
    });
    await this.state.write(ACTIVE_KEY, JSON.stringify({ assignmentId: lease.assignmentId }));
    await this.state.delete(CLAIM_KEY);
    this.sentThrough = watermark;
    observed.claim = response.body.disposition;
    return lease;
  }

  private async commitRenewal(intent: PendingRenewal, observed: Record<string, unknown>): Promise<LeaseBinding> {
    if (intent.lease.registryWorkspaceId !== this.registryWorkspaceId)
      throw invalid("Pending renewal workspace changed.");
    const current = this.vault.getLease(intent.lease.assignmentId);
    const old =
      current.leaseRevision === intent.lease.leaseRevision && current.rawLeaseToken === intent.lease.leaseToken;
    const advanced =
      current.leaseRevision === intent.lease.leaseRevision + 1 && current.rawLeaseToken === intent.nextLeaseToken;
    if (current.assignmentGeneration !== intent.lease.assignmentGeneration || (!old && !advanced))
      throw invalid("Pending renewal no longer matches retained authority.");
    const startedAt = performance.now();
    const response = await this.routes.renew(this.context, intent.lease, intent);
    assertLeaseResponse(response, intent.lease, intent.lease.leaseRevision + 1, [
      "renewed",
      "replayed_without_lease_secret",
    ]);
    const watermark = leaseWatermark(response);
    if (watermark < intent.workerSentThrough)
      throw invalid("Gateway renewal moved the transcript watermark backwards.");
    const rotated = {
      ...intent.lease,
      leaseRevision: intent.lease.leaseRevision + 1,
      leaseToken: intent.nextLeaseToken,
    };
    await this.vault.advanceLease(rotated.assignmentId, rotated.leaseRevision, rotated.leaseToken);
    await this.state.delete(RENEWAL_KEY);
    this.sentThrough = watermark;
    const receipt = record(response.body.lease);
    const period =
      typeof receipt.expiresAt === "string" && typeof receipt.heartbeatAt === "string"
        ? Date.parse(receipt.expiresAt) - Date.parse(receipt.heartbeatAt)
        : 0;
    // Missing timing evidence cannot enable automatic execution. A recovered
    // renewal is followed by a fresh renewal before the execution helper starts.
    this.renewalDeadline = Number.isFinite(period) && period > 0 && period <= 900_000 ? startedAt + period : 0;
    observed.leaseRenewal = response.body.disposition;
    observed.leaseRevisionAfterRenewal = rotated.leaseRevision;
    return rotated;
  }
}

function assertLeaseResponse(
  response: WorkerWireResponse,
  binding: LeaseBinding,
  revision: number,
  dispositions: readonly string[],
): void {
  const lease = record(response.body.lease);
  if (
    !dispositions.includes(String(response.body.disposition)) ||
    lease.registryWorkspaceId !== binding.registryWorkspaceId ||
    lease.assignmentId !== binding.assignmentId ||
    lease.assignmentGeneration !== binding.assignmentGeneration ||
    lease.leaseRevision !== revision
  )
    throw invalid("Gateway lease receipt does not match the pending operation.");
}

function leaseWatermark(response: WorkerWireResponse): number {
  const value = record(response.body.lease).workerSentThrough;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid("Gateway transcript watermark is invalid.");
  return Number(value);
}

function parseClaim(raw: string): PendingClaim {
  const value = parseIntent(raw);
  assertIdentifier(value.registryWorkspaceId);
  assertIdentifier(value.assignmentId);
  assertIdentifier(value.idempotencyKey);
  if (value.schemaVersion !== VERSION || typeof value.leaseToken !== "string" || !SECRET.test(value.leaseToken))
    throw invalid("Pending claim is invalid.");
  return value as unknown as PendingClaim;
}

function parseRenewal(raw: string): PendingRenewal {
  const value = parseIntent(raw);
  assertLease(value.lease);
  assertIdentifier(value.idempotencyKey);
  if (
    value.schemaVersion !== VERSION ||
    typeof value.nextLeaseToken !== "string" ||
    !SECRET.test(value.nextLeaseToken) ||
    !Number.isSafeInteger(value.workerSentThrough) ||
    Number(value.workerSentThrough) < 0
  )
    throw invalid("Pending renewal is invalid.");
  return value as unknown as PendingRenewal;
}

function assertLease(value: unknown): asserts value is LeaseBinding {
  const lease = record(value);
  assertIdentifier(lease.registryWorkspaceId);
  assertIdentifier(lease.assignmentId);
  if (
    !positive(lease.assignmentGeneration) ||
    !positive(lease.leaseRevision) ||
    typeof lease.leaseToken !== "string" ||
    !SECRET.test(lease.leaseToken)
  )
    throw invalid("Retained lease binding is invalid.");
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Lease evidence is not an object.");
  return value as Record<string, unknown>;
}

function parseIntent(raw: string): Record<string, unknown> {
  try {
    return record(JSON.parse(raw));
  } catch {
    throw invalid("Pending lease evidence cannot be parsed.");
  }
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function assertIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw invalid("Lease identity is invalid.");
}
function invalid(message: string): Error {
  return new Error(`Worker lease custody: ${message}`);
}
