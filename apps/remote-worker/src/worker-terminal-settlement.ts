import {
  canonicalJsonString,
  normalizeRemoteWorkerInferenceUsageEventIds,
  remoteWorkerAssignmentSettlementReplayMaterial,
  type SettleRemoteWorkerAssignmentWorkerCommand,
} from "@goatcitadel/contracts";
import {
  newLeaseSecret,
  settleAssignment,
  sha256Utf8,
  type LeaseBinding,
  type RouteContext,
  type WorkerSettlementOutcome,
} from "./connected-worker-routes.js";
import type { WorkerDurableStatePort } from "./worker-durable-state.js";
import { WorkerSettlementGuard, type WorkerSettlementReceipt } from "./worker-settlement-guard.js";

const PENDING_KEY = "terminal-settlement-pending";
const LEGACY_VERSION = "goatcitadel.worker-terminal-settlement.v1";
const VERSION = "goatcitadel.worker-terminal-settlement.v2";
export interface WorkerTerminalIntent {
  lease: LeaseBinding;
  finalEventSequence: number;
  finalEventSha256: string;
  settlement: WorkerSettlementOutcome;
  usageEventIds: readonly string[];
  renewalLeaseToken?: string;
}

/** The pending request precedes HTTP; the canonical receipt precedes removal.
 * Recovery invokes only settlement replay, never another model or artifact run. */
export class WorkerTerminalSettlement {
  constructor(
    private readonly state: WorkerDurableStatePort,
    private readonly context: RouteContext,
    private readonly send: typeof settleAssignment = settleAssignment,
  ) {}

  async recover(): Promise<WorkerSettlementReceipt | undefined> {
    const raw = await this.state.read(PENDING_KEY);
    if (raw === undefined) return undefined;
    return await this.commit(readPending(raw));
  }

  async settle(input: WorkerTerminalIntent): Promise<WorkerSettlementReceipt> {
    const requested = normalize(input);
    const old = await this.state.read(PENDING_KEY);
    let intent: WorkerTerminalIntent;
    if (old !== undefined) {
      intent = readPending(old);
      const comparable = {
        ...requested,
        ...(intent.renewalLeaseToken === undefined
          ? {}
          : {
              renewalLeaseToken: requested.renewalLeaseToken ?? intent.renewalLeaseToken,
            }),
      };
      if (canonicalJsonString(comparable) !== canonicalJsonString(intent))
        throw new Error("Worker settlement intent conflicts with pending work.");
    } else {
      intent = normalize({
        ...requested,
        ...(requested.settlement.outcome === "cancelled"
          ? {}
          : {
              renewalLeaseToken: requested.renewalLeaseToken ?? newLeaseSecret(),
            }),
      });
      await this.state.write(PENDING_KEY, canonicalJsonString({ schemaVersion: VERSION, intent }));
    }
    return await this.commit(intent);
  }

  private async commit(intent: WorkerTerminalIntent): Promise<WorkerSettlementReceipt> {
    const guard = await WorkerSettlementGuard.open(this.state);
    const expected = requestHash(intent);
    const retained = guard.getReceipt(intent.lease.assignmentId);
    if (retained !== undefined) {
      if (
        retained.settlementSha256 !== expected ||
        retained.assignmentGeneration !== intent.lease.assignmentGeneration ||
        canonicalJsonString(retained.usageEventIds) !== canonicalJsonString(intent.usageEventIds)
      )
        throw new Error("Worker settlement receipt conflicts with its pending intent.");
      // Keep the pending intent until the active assignment pointer is cleared.
      return retained;
    }
    const response = await this.send(this.context, intent.lease, {
      finalEventSequence: intent.finalEventSequence,
      finalEventSha256: intent.finalEventSha256,
      settlement: intent.settlement,
      idempotencyKey: idempotencyKey(intent),
      ...(intent.renewalLeaseToken === undefined ? {} : { renewalLeaseToken: intent.renewalLeaseToken }),
    });
    const record = response.body.settlement as Record<string, unknown> | undefined;
    if (
      !["settled", "replayed"].includes(String(response.body.disposition)) ||
      !record ||
      record.registryWorkspaceId !== intent.lease.registryWorkspaceId ||
      record.assignmentId !== intent.lease.assignmentId ||
      record.assignmentGeneration !== intent.lease.assignmentGeneration ||
      record.outcome !== intent.settlement.outcome ||
      record.requestSha256 !== expected ||
      typeof record.settledAt !== "string"
    )
      throw new Error("Gateway settlement receipt does not bind the retained request.");
    return (
      await guard.recordSettlement({
        assignmentId: intent.lease.assignmentId,
        assignmentGeneration: intent.lease.assignmentGeneration,
        outcome: intent.settlement.outcome,
        settlementSha256: expected,
        usageEventIds: intent.usageEventIds,
        settledAt: record.settledAt,
      })
    ).receipt;
  }

  async acknowledge(): Promise<void> {
    await this.state.delete(PENDING_KEY);
  }
}

function idempotencyKey(intent: WorkerTerminalIntent): string {
  return `settle:${intent.lease.assignmentId}:${intent.lease.assignmentGeneration}`;
}
function requestHash(intent: WorkerTerminalIntent): string {
  return sha256Utf8(
    canonicalJsonString(
      remoteWorkerAssignmentSettlementReplayMaterial({
        registryWorkspaceId: intent.lease.registryWorkspaceId,
        assignmentId: intent.lease.assignmentId,
        expectedAssignmentGeneration: intent.lease.assignmentGeneration,
        expectedLeaseRevision: intent.lease.leaseRevision,
        leaseTokenSha256: sha256Utf8(intent.lease.leaseToken),
        ...(intent.renewalLeaseToken === undefined
          ? {}
          : {
              renewalLeaseTokenSha256: sha256Utf8(intent.renewalLeaseToken),
            }),
        origin: "worker",
        finalEventSequence: intent.finalEventSequence,
        finalEventSha256: intent.finalEventSha256,
        ...intent.settlement,
        idempotencyKey: idempotencyKey(intent),
      } as SettleRemoteWorkerAssignmentWorkerCommand),
    ),
  );
}
function readPending(raw: string): WorkerTerminalIntent {
  let parsed: { schemaVersion?: string; intent?: WorkerTerminalIntent };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Retained worker settlement is invalid.");
  }
  if (!parsed || ![VERSION, LEGACY_VERSION].includes(String(parsed.schemaVersion)) || !parsed.intent)
    throw new Error("Retained worker settlement version is invalid.");
  if (
    (parsed.schemaVersion === VERSION && parsed.intent.settlement?.outcome !== "cancelled") !==
    (parsed.intent.renewalLeaseToken !== undefined)
  )
    throw new Error("Retained worker settlement renewal is invalid.");
  return normalize(parsed.intent);
}
function normalize(input: WorkerTerminalIntent): WorkerTerminalIntent {
  if (
    !input ||
    !input.lease ||
    typeof input.lease.leaseToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(input.lease.leaseToken) ||
    (input.renewalLeaseToken !== undefined &&
      (typeof input.renewalLeaseToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(input.renewalLeaseToken)))
  )
    throw new Error("Worker settlement lease is invalid.");
  // Shared normalization checks every identity, bound, and exclusive outcome.
  requestHash(input);
  return JSON.parse(
    canonicalJsonString({
      ...input,
      usageEventIds:
        input.settlement.outcome !== "completed" &&
        Array.isArray(input.usageEventIds) &&
        input.usageEventIds.length === 0
          ? []
          : normalizeRemoteWorkerInferenceUsageEventIds(input.usageEventIds),
    }),
  ) as WorkerTerminalIntent;
}
