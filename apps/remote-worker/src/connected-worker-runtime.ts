import { admitWorker } from "./worker-admission-client.js";
import {
  WORKER_EVENT_GENESIS_SHA256,
  admitMeshNode,
  appendEvents,
  buildEventChain,
  claimOffer,
  newLeaseSecret,
  pollOffers,
  readControl,
  readWorkload,
  renewLease,
  settleAssignment,
  sha256Utf8,
  syncAssignment,
  transcriptDeltaPayload,
  type LeaseBinding,
  type RouteContext,
  type WorkerSettlementOutcome,
} from "./connected-worker-routes.js";
import { WorkerCredentialVault } from "./worker-credential-vault.js";
import { createFileWorkerDurableState, type WorkerDurableStatePort } from "./worker-durable-state.js";
import { WorkerSettlementGuard } from "./worker-settlement-guard.js";
import { WorkerTranscriptOutbox } from "./worker-transcript-outbox.js";
import type { ConnectedWorkerConfig, ConnectedWorkerStage } from "./worker-runtime-config.js";
import { WorkerWireClient } from "./worker-wire-client.js";

/**
 * The connected worker's journey, expressed as resumable stages over durable
 * worker state.
 *
 * Every stage boundary is a legal place to die: the retained credential, lease,
 * transcript outbox, and settlement receipts are all durable, so a restarted
 * process resumes from exactly what it held. The one-time bootstrap secret is
 * consumed only when no credential is retained — a reconnect or restart can
 * never replay it, and the vault has no field to store it in.
 */
export interface ConnectedWorkerReport extends Readonly<Record<string, unknown>> {
  readonly runId: string;
  readonly outcome: "completed" | "stopped";
  readonly stagesCompleted: readonly ConnectedWorkerStage[];
  readonly admitted: "bootstrap_exchange" | "retained_credential";
}

/** The transcript this worker ships. Fixed so a replayed batch is byte-identical. */
const TRANSCRIPT_LINES = Object.freeze([
  "Connected worker accepted the assignment.",
  "Connected worker produced the durable result.",
  "Connected worker is settling the assignment.",
]);

const LEASE_STATE_KEY = "connected-run";

export async function runConnectedWorker(config: ConnectedWorkerConfig): Promise<ConnectedWorkerReport> {
  const state = createFileWorkerDurableState(config.stateDir);
  const vault = await WorkerCredentialVault.open(state);
  const client = new WorkerWireClient(config.transport);
  const stages: ConnectedWorkerStage[] = [];
  const observed: Record<string, unknown> = {};

  const admitted = await ensureCredential(vault, client, config);
  stages.push("admit");
  if (config.stopAfter === "admit") return report(config, "stopped", stages, admitted, observed, vault);

  const context: RouteContext = { client, credential: vault.getCredential() };
  if (config.ticket.meshJoinCredential !== undefined && !(await isMeshAdmitted(state))) {
    const meshResponse = await admitMeshNode(context, {
      workspaceId: config.ticket.executionWorkspaceId,
      rawMeshNodeCredential: config.ticket.meshJoinCredential,
      idempotencyKey: `mesh-admit:${config.ticket.bootstrapId}`,
    });
    observed["meshAdmission"] = meshResponse.body["disposition"];
    await state.write("mesh-admitted", JSON.stringify({ admittedAt: new Date().toISOString() }));
  }

  const lease = await ensureLease(context, state, vault, config, observed);
  stages.push("claim");
  if (config.stopAfter === "claim") return report(config, "stopped", stages, admitted, observed, vault);

  const workload = await readWorkload(context, lease, `workload:${lease.assignmentId}:${String(lease.leaseRevision)}`);
  observed["workloadSha256"] = (workload.body["workload"] as Record<string, unknown> | undefined)?.["workloadSha256"];
  stages.push("workload");
  if (config.stopAfter === "workload") return report(config, "stopped", stages, admitted, observed, vault);

  const outbox = await WorkerTranscriptOutbox.open(state, lease.assignmentId);
  // A run told to stop at `events` ships only the first batch and dies holding
  // an unacknowledged tail — exactly what a killed machine leaves behind.
  const chain = await shipTranscript(context, state, lease, outbox, observed, config.stopAfter === "events");
  stages.push("events");
  if (config.stopAfter === "events") return report(config, "stopped", stages, admitted, observed, vault);

  const nextLeaseToken = newLeaseSecret();
  const renewed = await renewLease(context, lease, {
    nextLeaseToken,
    workerSentThrough: chain.finalSequence,
    idempotencyKey: `renew:${lease.assignmentId}:${String(lease.leaseRevision)}`,
  });
  const renewedLease = (renewed.body["lease"] ?? {}) as Record<string, unknown>;
  observed["leaseRenewal"] = renewed.body["disposition"];
  observed["leaseRevisionAfterRenewal"] = renewedLease["leaseRevision"];
  // The rotated secret and the new revision become the only authority the
  // worker holds; the previous lease token is dead the moment storage commits.
  const rotated: LeaseBinding = {
    ...lease,
    leaseRevision: Number(renewedLease["leaseRevision"]),
    leaseToken: nextLeaseToken,
  };
  await vault.advanceLease(lease.assignmentId, rotated.leaseRevision, nextLeaseToken);

  const control = await readControl(context, rotated, `control:${rotated.assignmentId}`);
  const controlDisposition = String(control.body["disposition"]);
  observed["control"] = controlDisposition;

  const settled = await settle(context, state, rotated, chain, controlDisposition, observed);
  stages.push("settle");
  observed["settlement"] = settled;
  stages.push("complete");
  return report(config, "completed", stages, admitted, observed, vault);
}

async function ensureCredential(
  vault: WorkerCredentialVault,
  client: WorkerWireClient,
  config: ConnectedWorkerConfig,
): Promise<ConnectedWorkerReport["admitted"]> {
  if (vault.hasCredential()) return "retained_credential";
  const credential = await admitWorker({
    client,
    ticket: config.ticket,
    clientPrivateKeyPem: config.transport.clientPrivateKeyPem,
    idempotencyKey: `worker-admission:${config.ticket.bootstrapId}`,
  });
  await vault.retainCredential(credential);
  return "bootstrap_exchange";
}

async function isMeshAdmitted(state: WorkerDurableStatePort): Promise<boolean> {
  return (await state.read("mesh-admitted")) !== undefined;
}

/**
 * Claim exactly once. A retained lease is replayed rather than re-claimed, so a
 * restart can never produce a second generation for the same assignment.
 */
async function ensureLease(
  context: RouteContext,
  state: WorkerDurableStatePort,
  vault: WorkerCredentialVault,
  config: ConnectedWorkerConfig,
  observed: Record<string, unknown>,
): Promise<LeaseBinding> {
  const registryWorkspaceId = config.ticket.registryWorkspaceId;
  const retainedId = await state.read(LEASE_STATE_KEY);
  if (retainedId !== undefined) {
    const assignmentId = (JSON.parse(retainedId) as { assignmentId: string }).assignmentId;
    const retained = vault.getLease(assignmentId);
    const lease: LeaseBinding = {
      registryWorkspaceId,
      assignmentId,
      assignmentGeneration: retained.assignmentGeneration,
      leaseRevision: retained.leaseRevision,
      leaseToken: retained.rawLeaseToken,
    };
    const synced = await syncAssignment(context, lease, `sync:${assignmentId}:${String(retained.leaseRevision)}`);
    observed["reconnectSync"] = synced.body["disposition"];
    return lease;
  }

  const polled = await pollOffers(context, {
    registryWorkspaceId,
    idempotencyKey: `poll:${config.runId}`,
    limit: 10,
  });
  const items = (polled.body["items"] ?? []) as readonly Record<string, unknown>[];
  observed["offerCount"] = items.length;
  const first = items[0];
  if (first === undefined) throw new Error("No dispatched offer was available to claim.");
  const assignmentId = String((first["assignment"] as Record<string, unknown>)["assignmentId"]);
  const leaseToken = newLeaseSecret();
  const claimed = await claimOffer(context, {
    registryWorkspaceId,
    assignmentId,
    leaseToken,
    idempotencyKey: `claim:${assignmentId}`,
  });
  observed["claim"] = claimed.body["disposition"];
  const generation = claimed.body["generation"] as Record<string, unknown>;
  const claimedLease = claimed.body["lease"] as Record<string, unknown>;
  const lease: LeaseBinding = {
    registryWorkspaceId,
    assignmentId,
    assignmentGeneration: Number(generation["assignmentGeneration"]),
    leaseRevision: Number(claimedLease["leaseRevision"]),
    leaseToken,
  };
  await vault.retainLease({
    assignmentId,
    rawLeaseToken: leaseToken,
    leaseRevision: lease.leaseRevision,
    assignmentGeneration: lease.assignmentGeneration,
  });
  await state.write(LEASE_STATE_KEY, JSON.stringify({ assignmentId }));
  return lease;
}

interface ShippedChain {
  readonly finalSequence: number;
  readonly finalEventSha256: string;
}

/**
 * Ship the transcript in two batches so a run stopped at `events` dies holding
 * an unacknowledged tail; the next run resends byte-identical frames, which the
 * Gateway replay-acknowledges without re-materializing.
 */
async function shipTranscript(
  context: RouteContext,
  state: WorkerDurableStatePort,
  lease: LeaseBinding,
  outbox: WorkerTranscriptOutbox,
  observed: Record<string, unknown>,
  firstBatchOnly: boolean,
): Promise<ShippedChain> {
  const chain = buildEventChain({
    registryWorkspaceId: lease.registryWorkspaceId,
    assignmentId: lease.assignmentId,
    assignmentGeneration: lease.assignmentGeneration,
    startSequence: 1,
    previousEventSha256: WORKER_EVENT_GENESIS_SHA256,
    events: TRANSCRIPT_LINES.map((text, index) => ({
      eventId: `${lease.assignmentId}-event-${String(index + 1)}`,
      payload: transcriptDeltaPayload(text),
    })),
  });
  if (outbox.headSequence() === 0) {
    for (const line of TRANSCRIPT_LINES) await outbox.enqueue({ kind: "transcript_delta", payload: { text: line } });
  }
  const dispositions: string[] = [];
  const batches = firstBatchOnly ? [chain.slice(0, 2)] : [chain.slice(0, 2), chain.slice(2)];
  for (const batch of batches) {
    if (batch.length === 0) continue;
    const response = await appendEvents(context, lease, {
      events: batch,
      idempotencyKey: `events:${lease.assignmentId}:${String(batch[0]?.sequence ?? 0)}`,
    });
    dispositions.push(String(response.body["disposition"]));
    await outbox.acknowledge(Number(response.body["acknowledgedThrough"] ?? 0));
    await state.write(
      "transcript-progress",
      JSON.stringify({ acknowledgedThrough: response.body["acknowledgedThrough"] }),
    );
  }
  observed["eventDispositions"] = dispositions;
  const last = chain.at(-1);
  if (last === undefined) throw new Error("Transcript chain was empty.");
  return { finalSequence: last.sequence, finalEventSha256: last.eventSha256 };
}

/**
 * Terminal settlement. A `completed` outcome must cite a committed HX-506
 * artifact manifest, so a worker whose Gateway composes no artifact settlement
 * owner settles the outcome it can actually evidence: `cancelled` when the
 * server asked it to stop, `failed` otherwise.
 */
async function settle(
  context: RouteContext,
  state: WorkerDurableStatePort,
  lease: LeaseBinding,
  chain: ShippedChain,
  controlDisposition: string,
  observed: Record<string, unknown>,
): Promise<string> {
  const guard = await WorkerSettlementGuard.open(state);
  const outcome: WorkerSettlementOutcome =
    controlDisposition === "cancel_requested"
      ? { outcome: "cancelled" }
      : { outcome: "failed", failureSha256: sha256Utf8(`${lease.assignmentId}:no-artifact-owner`) };
  const response = await settleAssignment(context, lease, {
    finalEventSequence: chain.finalSequence,
    finalEventSha256: chain.finalEventSha256,
    settlement: outcome,
    idempotencyKey: `settle:${lease.assignmentId}`,
  });
  const record = (response.body["settlement"] ?? {}) as Record<string, unknown>;
  observed["settlementOutcome"] = outcome.outcome;
  const recorded = await guard.recordSettlement({
    assignmentId: lease.assignmentId,
    assignmentGeneration: lease.assignmentGeneration,
    outcome: outcome.outcome,
    settlementSha256: sha256Utf8(JSON.stringify(record["requestSha256"] ?? lease.assignmentId)),
    // The Gateway is the sole HX-306 authority; the worker mints no usage id.
    usageEventIds: [],
    settledAt: String(record["settledAt"] ?? new Date().toISOString()),
  });
  observed["settlementFirstTime"] = recorded.firstTime;
  return String(response.body["disposition"]);
}

function report(
  config: ConnectedWorkerConfig,
  outcome: ConnectedWorkerReport["outcome"],
  stages: readonly ConnectedWorkerStage[],
  admitted: ConnectedWorkerReport["admitted"],
  observed: Readonly<Record<string, unknown>>,
  vault: WorkerCredentialVault,
): ConnectedWorkerReport {
  const credential = vault.getCredential();
  return Object.freeze({
    runId: config.runId,
    outcome,
    stagesCompleted: Object.freeze([...stages]),
    admitted,
    credentialId: credential.credentialId,
    credentialGeneration: credential.credentialGeneration,
    workerGeneration: credential.workerGeneration,
    ...observed,
  });
}
