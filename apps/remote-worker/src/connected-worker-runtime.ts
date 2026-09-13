import { canonicalJsonString } from "@goatcitadel/contracts";
import { admitWorker, type WorkerAdmissionTicket } from "./worker-admission-client.js";
import { admitProtectedWorker } from "./worker-protected-admission-client.js";
import { requireWorkerProtectedKeyOwner, type WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import {
  WORKER_EVENT_GENESIS_SHA256,
  admitMeshNode,
  appendEvents,
  buildEventChain,
  readWorkload,
  sha256Utf8,
  transcriptDeltaPayload,
  type LeaseBinding,
  type RouteContext,
  type WorkerSettlementOutcome,
} from "./connected-worker-routes.js";
import { WorkerCredentialVault } from "./worker-credential-vault.js";
import { createFileWorkerDurableState, type WorkerDurableStatePort } from "./worker-durable-state.js";
import { WorkerTranscriptOutbox } from "./worker-transcript-outbox.js";
import type { WorkerRunConfig, ConnectedWorkerStage } from "./worker-runtime-config.js";
import { WorkerWireClient } from "./worker-wire-client.js";
import { WorkerAssignmentLeaseOwner } from "./worker-assignment-lease-owner.js";
import { runWorkerChatWorkflow } from "./worker-chat-workflow.js";
import { withRenewingWorkerLease } from "./worker-execution-lease.js";
import { callWorkerArtifact, publishWorkerChatArtifact } from "./worker-artifact-publication.js";
import { WorkerTerminalSettlement } from "./worker-terminal-settlement.js";
import type { WorkerMeshCapabilityRuntime } from "./worker-mesh-capability-runtime.js";
import { withWorkerMeshAssignmentPump } from "./worker-mesh-assignment-pump.js";
import { renewWorkerLeaseControl } from "./worker-lease-control.js";

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
const PROTOCOL_PROBE_TRANSCRIPT = Object.freeze([
  "Connected worker accepted the assignment.",
  "Connected worker produced the durable result.",
  "Connected worker is settling the assignment.",
]);

export async function runConnectedWorker(
  config: WorkerRunConfig,
  options: { readonly signal?: AbortSignal; readonly protectedKeys?: WorkerProtectedKeyOwner;
    readonly meshCapabilities?: WorkerMeshCapabilityRuntime } = {},
): Promise<ConnectedWorkerReport> {
  options.signal?.throwIfAborted();
  const state = createFileWorkerDurableState(config.stateDir);
  const vault = await WorkerCredentialVault.open(state);
  const client = new WorkerWireClient(config.transport, options.signal);
  const protectedKeys = options.protectedKeys
    ? requireWorkerProtectedKeyOwner(options.protectedKeys.reference, options.protectedKeys)
    : undefined;
  if (Boolean(config.transport.clientTlsContext) !== Boolean(protectedKeys))
    throw new Error("Worker TLS context requires its protected key owner and cannot fall back to PEM.");
  const stages: ConnectedWorkerStage[] = [];
  const observed: Record<string, unknown> = {};
  observed["executionMode"] = config.executionMode ?? "gateway_inference";

  const admitted = await ensureCredential(vault, client, config, protectedKeys);
  stages.push("admit");
  if (config.stopAfter === "admit") {
    if (protectedKeys) {
      // The operator handoff verifies these exact persisted bytes. A shutdown or
      // an earlier report cannot stand in for successful protected admission.
      observed["enrollment"] = Object.freeze({
        schemaVersion: "goatcitadel.remote-worker.enrollment.v1",
        credentialSha256: sha256Utf8(canonicalJsonString(vault.getCredential())),
      });
    }
    return report(config, "stopped", stages, admitted, observed, vault);
  }

  const context: RouteContext = {
    client,
    credential: vault.getCredential(),
    ...(protectedKeys ? { protectedKeys } : {}),
  };
  if (config.ticket.meshJoinCredential !== undefined && !(await isMeshAdmitted(state))) {
    const meshResponse = await admitMeshNode(context, {
      workspaceId: config.ticket.executionWorkspaceId,
      rawMeshNodeCredential: config.ticket.meshJoinCredential,
      idempotencyKey: `mesh-admit:${config.ticket.bootstrapId}`,
    });
    observed["meshAdmission"] = meshResponse.body["disposition"];
    await state.write("mesh-admitted", JSON.stringify({ admittedAt: new Date().toISOString() }));
  }

  const leaseOwner = new WorkerAssignmentLeaseOwner(context, state, vault, config.ticket.registryWorkspaceId);
  const terminal = new WorkerTerminalSettlement(state, context);
  const recovered = await terminal.recover();
  if (recovered) {
    await leaseOwner.complete(recovered);
    await terminal.acknowledge();
    observed["settlement"] = "recovered";
    observed["settlementOutcome"] = recovered.outcome;
    observed["usageEventIds"] = recovered.usageEventIds;
    stages.push("settle", "complete");
    return report(config, "completed", stages, admitted, observed, vault);
  }
  if (options.meshCapabilities) {
    const mesh = await options.meshCapabilities.recover({ context, state, signal: options.signal,
      workspaceId: config.ticket.executionWorkspaceId, nodeId: config.ticket.nodeId });
    if (mesh.status === "settled") {
      observed["meshInvocation"] = mesh;
      if (!mesh.manualReconciliationRequired) stages.push("complete");
      return report(config, mesh.manualReconciliationRequired ? "stopped" : "completed", stages, admitted, observed, vault);
    }
  }
  const assignment = (scope: RouteContext) => runConnectedAssignment(config, scope, state, vault, stages, observed);
  let outcome: ConnectedWorkerReport["outcome"];
  if (options.meshCapabilities) {
    const runtime = options.meshCapabilities;
    const scopedContext = (signal: AbortSignal): RouteContext => ({ ...context, client: new WorkerWireClient(config.transport, signal) });
    outcome = await withWorkerMeshAssignmentPump({
      signal: options.signal,
      assignment: (signal) => assignment(scopedContext(signal)),
      mesh: (signal) => runtime.runNext({ context: scopedContext(signal), state, signal,
        workspaceId: config.ticket.executionWorkspaceId, nodeId: config.ticket.nodeId }),
      onSettlement: (mesh) => {
        observed["meshInvocation"] = mesh;
        observed["meshSettlementCount"] = Number(observed["meshSettlementCount"] ?? 0) + 1;
      },
    });
    if (outcome === "stopped" && observed["awaiting"] === "assignment_offer" && observed["meshInvocation"]) {
      outcome = "completed";
      stages.push("complete");
    }
  } else outcome = await assignment(context);
  return report(config, outcome, stages, admitted, observed, vault);
}

async function runConnectedAssignment(
  config: WorkerRunConfig,
  context: RouteContext,
  state: WorkerDurableStatePort,
  vault: WorkerCredentialVault,
  stages: ConnectedWorkerStage[],
  observed: Record<string, unknown>,
): Promise<ConnectedWorkerReport["outcome"]> {
  const leaseOwner = new WorkerAssignmentLeaseOwner(context, state, vault, config.ticket.registryWorkspaceId);
  const terminal = new WorkerTerminalSettlement(state, context);
  let lease = await leaseOwner.resumeOrClaim(observed);
  if (!lease) {
    observed["awaiting"] ??= "assignment_offer";
    return "stopped";
  }
  stages.push("claim");
  if (config.stopAfter === "claim") return "stopped";

  const workload = await readWorkload(context, lease, `workload:${lease.assignmentId}:${String(lease.leaseRevision)}`);
  observed["workloadSha256"] = (workload.body["workload"] as Record<string, unknown> | undefined)?.["workloadSha256"];
  stages.push("workload");
  if (config.stopAfter === "workload") return "stopped";

  let transcript: readonly string[] = PROTOCOL_PROBE_TRANSCRIPT;
  let usageEventIds: readonly string[] = [];
  if (config.executionMode !== "protocol_probe") {
    const execution = await runWorkerChatWorkflow({
      context,
      owner: leaseOwner,
      lease,
      observed,
      stages,
      stopAfter: config.stopAfter,
      workload: workload.body["workload"] as Record<string, unknown>,
    });
    lease = execution.lease;
    if (!execution.completed) return "stopped";
    transcript = execution.lines;
    usageEventIds = execution.usageEventIds;
  }

  const outbox = await WorkerTranscriptOutbox.open(state, lease.assignmentId);
  // A run told to stop at `events` ships only the first batch and dies holding
  // an unacknowledged tail — exactly what a killed machine leaves behind.
  const chain = await shipTranscript(
    context,
    state,
    lease,
    outbox,
    observed,
    config.stopAfter === "events",
    transcript,
  );
  stages.push("events");
  if (config.stopAfter === "events") return "stopped";
  let completedArtifact: { resultSha256: string; outputManifestSha256: string } | undefined;
  if (config.executionMode !== "protocol_probe") {
    completedArtifact = await publishWorkerChatArtifact({
      state,
      lease,
      workload: workload.body["workload"] as Record<string, unknown>,
      lines: transcript,
      call: async (phase, submission) => {
        const publication = await withRenewingWorkerLease(
          { context, owner: leaseOwner, lease: lease!, workerSentThrough: chain.finalSequence, observed },
          async (current, signal) => await callWorkerArtifact(context, current, phase, submission, signal),
        );
        lease = publication.lease;
        return publication.value;
      },
    });
    observed["outputManifestSha256"] = completedArtifact.outputManifestSha256;
    stages.push("artifact");
    if (config.stopAfter === "artifact") return "stopped";
  }
  const { lease: rotated, control } = await renewWorkerLeaseControl({
    context, owner: leaseOwner, lease, workerSentThrough: chain.finalSequence, observed,
  });
  const controlDisposition = String(control.body["disposition"]);
  observed["control"] = controlDisposition;

  if (controlDisposition !== "active" && controlDisposition !== "cancel_requested")
    throw new Error("Worker terminal settlement lacks current control authority.");
  const settlement: WorkerSettlementOutcome =
    controlDisposition === "cancel_requested"
      ? { outcome: "cancelled" }
      : completedArtifact
        ? { outcome: "completed", ...completedArtifact }
        : { outcome: "failed", failureSha256: sha256Utf8(`${rotated.assignmentId}:protocol-probe-only`) };
  const settled = await terminal.settle({
    lease: rotated,
    finalEventSequence: chain.finalSequence,
    finalEventSha256: chain.finalEventSha256,
    settlement,
    usageEventIds,
  });
  stages.push("settle");
  observed["settlement"] = "settled";
  observed["settlementOutcome"] = settled.outcome;
  if (config.stopAfter === "settle") return "stopped";
  await leaseOwner.complete(settled);
  await terminal.acknowledge();
  stages.push("complete");
  return "completed";
}

async function ensureCredential(
  vault: WorkerCredentialVault,
  client: WorkerWireClient,
  config: WorkerRunConfig,
  protectedKeys: WorkerProtectedKeyOwner | undefined,
): Promise<ConnectedWorkerReport["admitted"]> {
  if (vault.hasCredential()) {
    const retained = vault.getCredential();
    if (retained.protectedKey) {
      const owner = requireWorkerProtectedKeyOwner(retained.protectedKey, protectedKeys);
      if (
        !("protectedSignerPublicKeySpkiBase64Url" in config.ticket) ||
        Object.prototype.hasOwnProperty.call(config.ticket, "protectedSignerPrivateKeyPem") ||
        config.ticket.registryWorkspaceId !== retained.registryWorkspaceId ||
        config.ticket.targetWorkerGeneration !== retained.workerGeneration ||
        config.ticket.keysetReceiptSha256 !== owner.reference.keysetReceiptSha256 ||
        config.ticket.protectedSignerPublicKeySpkiBase64Url !== owner.admissionSignerSpkiBase64Url
      )
        throw new Error("Worker restart configuration differs from its retained protected authority.");
      const identity = client.identity();
      if (
        identity.clientCertificateSha256 !== retained.clientCertificateSha256 ||
        identity.publicKeySpkiSha256 !== retained.workerPublicKeySpkiSha256
      )
        throw new Error("Worker retained authority differs from its current TLS identity.");
    } else if (protectedKeys)
      throw new Error("Protected worker cannot resume a PEM credential; explicit admission is required.");
    return "retained_credential";
  }
  if (protectedKeys) {
    if (!("protectedSignerPublicKeySpkiBase64Url" in config.ticket))
      throw new Error("Protected worker requires its public admission ticket.");
    const credential = await admitProtectedWorker({
      client,
      ticket: config.ticket,
      protectedKeys,
      idempotencyKey: `worker-admission:${config.ticket.bootstrapId}`,
    });
    await vault.retainCredential(credential);
    return "bootstrap_exchange";
  }
  if (
    typeof config.transport.clientPrivateKeyPem !== "string" ||
    typeof config.ticket.protectedSignerPrivateKeyPem !== "string"
  )
    throw new Error("Worker PEM admission material is unavailable.");
  const credential = await admitWorker({
    client,
    ticket: config.ticket as WorkerAdmissionTicket,
    clientPrivateKeyPem: config.transport.clientPrivateKeyPem,
    idempotencyKey: `worker-admission:${config.ticket.bootstrapId}`,
  });
  await vault.retainCredential(credential);
  return "bootstrap_exchange";
}

async function isMeshAdmitted(state: WorkerDurableStatePort): Promise<boolean> {
  return (await state.read("mesh-admitted")) !== undefined;
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
  transcript: readonly string[],
): Promise<ShippedChain> {
  const chain = buildEventChain({
    registryWorkspaceId: lease.registryWorkspaceId,
    assignmentId: lease.assignmentId,
    assignmentGeneration: lease.assignmentGeneration,
    startSequence: 1,
    previousEventSha256: WORKER_EVENT_GENESIS_SHA256,
    events: transcript.map((text, index) => ({
      eventId: `${lease.assignmentId}-event-${String(index + 1)}`,
      payload: transcriptDeltaPayload(text),
    })),
  });
  const retainedEvents = transcript.map((text) => ({ kind: "transcript_delta", payload: { text } }));
  outbox.assertReplayPrefix(retainedEvents);
  // A process may die between any two enqueues, before the first network batch.
  // Keep the exact retained prefix and persist its missing suffix before send.
  for (const event of retainedEvents.slice(outbox.headSequence())) await outbox.enqueue(event);
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

function report(
  config: WorkerRunConfig,
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
