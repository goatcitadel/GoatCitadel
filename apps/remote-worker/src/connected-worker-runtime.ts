import { randomBytes } from "node:crypto";
import { admitWorker } from "./worker-admission-client.js";
import { WorkerCredentialVault } from "./worker-credential-vault.js";
import { createFileWorkerDurableState } from "./worker-durable-state.js";
import type { ConnectedWorkerConfig, ConnectedWorkerStage } from "./worker-runtime-config.js";
import { WorkerWireClient } from "./worker-wire-client.js";

/**
 * The connected worker's single-pass journey.
 *
 * Each stage is a distinct, resumable step against durable worker state, so a
 * process killed at any boundary restarts from exactly what it retained. The
 * one-time bootstrap secret is consumed only when no credential is retained;
 * every later run reconnects with the retained credential and its signing pin.
 */
export interface ConnectedWorkerReport extends Readonly<Record<string, unknown>> {
  readonly runId: string;
  readonly outcome: "completed" | "stopped";
  readonly stagesCompleted: readonly ConnectedWorkerStage[];
  readonly admitted: "bootstrap_exchange" | "retained_credential";
}

export async function runConnectedWorker(config: ConnectedWorkerConfig): Promise<ConnectedWorkerReport> {
  const state = createFileWorkerDurableState(config.stateDir);
  const vault = await WorkerCredentialVault.open(state);
  const client = new WorkerWireClient(config.transport);
  const stages: ConnectedWorkerStage[] = [];

  let admitted: ConnectedWorkerReport["admitted"];
  if (vault.hasCredential()) {
    admitted = "retained_credential";
  } else {
    const credential = await admitWorker({
      client,
      ticket: config.ticket,
      clientPrivateKeyPem: config.transport.clientPrivateKeyPem,
      idempotencyKey: `worker-admission:${config.ticket.bootstrapId}`,
    });
    await vault.retainCredential(credential);
    admitted = "bootstrap_exchange";
  }
  stages.push("admit");

  return Object.freeze({
    runId: config.runId,
    outcome: config.stopAfter === "admit" ? "stopped" : "completed",
    stagesCompleted: Object.freeze([...stages]),
    admitted,
    credentialId: vault.getCredential().credentialId,
    workerGeneration: vault.getCredential().workerGeneration,
  });
}

/** Canonical 32-byte base64url secret; the Gateway only ever sees its digest. */
export function newWorkerSecret(): string {
  return randomBytes(32).toString("base64url");
}
