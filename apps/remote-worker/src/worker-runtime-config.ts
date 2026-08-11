import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WorkerAdmissionTicket } from "./worker-admission-client.js";
import type { WorkerTransportMaterial } from "./worker-wire-client.js";

/**
 * Process-boundary configuration for the connected worker runtime.
 *
 * Every value is read from the environment exactly once, at startup, and every
 * file path must be absolute. Unknown `GOATCITADEL_CONNECTED_WORKER_*` names are
 * rejected so a typo can never silently disable a stage.
 */
export const CONNECTED_WORKER_ENV = Object.freeze({
  host: "GOATCITADEL_CONNECTED_WORKER_HOST",
  port: "GOATCITADEL_CONNECTED_WORKER_PORT",
  clientCertificateFile: "GOATCITADEL_CONNECTED_WORKER_CLIENT_CERT_FILE",
  clientKeyFile: "GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE",
  trustAnchorFile: "GOATCITADEL_CONNECTED_WORKER_CA_FILE",
  ticketFile: "GOATCITADEL_CONNECTED_WORKER_TICKET_FILE",
  stateDir: "GOATCITADEL_CONNECTED_WORKER_STATE_DIR",
  reportFile: "GOATCITADEL_CONNECTED_WORKER_REPORT_FILE",
  runId: "GOATCITADEL_CONNECTED_WORKER_RUN_ID",
  stopAfter: "GOATCITADEL_CONNECTED_WORKER_STOP_AFTER",
} as const);

const KNOWN_ENV_NAMES = new Set<string>(Object.values(CONNECTED_WORKER_ENV));

/**
 * Stage boundaries a run may deliberately stop at. `events` is the mid-loop cut
 * the reconnect proof uses: the worker dies holding a live lease with
 * unacknowledged transcript events, exactly like a killed machine.
 */
export const CONNECTED_WORKER_STAGES = Object.freeze([
  "admit",
  "claim",
  "workload",
  "inference",
  "events",
  "settle",
  "complete",
] as const);

export type ConnectedWorkerStage = (typeof CONNECTED_WORKER_STAGES)[number];

export interface ConnectedWorkerConfig {
  readonly transport: WorkerTransportMaterial;
  readonly ticket: WorkerAdmissionTicket;
  readonly stateDir: string;
  readonly reportFile: string;
  readonly runId: string;
  readonly stopAfter: ConnectedWorkerStage;
}

export class ConnectedWorkerConfigError extends Error {
  readonly code = "REMOTE_WORKER_RUNTIME_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ConnectedWorkerConfigError";
  }
}

export function parseConnectedWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ConnectedWorkerConfig {
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.startsWith("GOATCITADEL_CONNECTED_WORKER_") && !KNOWN_ENV_NAMES.has(name)) {
      throw new ConnectedWorkerConfigError(`Unsupported connected-worker setting ${name}.`);
    }
  }
  const port = Number(required(env, CONNECTED_WORKER_ENV.port));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConnectedWorkerConfigError("Connected-worker port is invalid.");
  }
  const stopAfterRaw = env[CONNECTED_WORKER_ENV.stopAfter] ?? "complete";
  if (!(CONNECTED_WORKER_STAGES as readonly string[]).includes(stopAfterRaw)) {
    throw new ConnectedWorkerConfigError("Connected-worker stop stage is invalid.");
  }
  return Object.freeze({
    transport: Object.freeze({
      host: required(env, CONNECTED_WORKER_ENV.host),
      port,
      clientCertificatePem: readAbsolute(env, CONNECTED_WORKER_ENV.clientCertificateFile),
      clientPrivateKeyPem: readAbsolute(env, CONNECTED_WORKER_ENV.clientKeyFile),
      trustAnchorPem: readAbsolute(env, CONNECTED_WORKER_ENV.trustAnchorFile),
    }),
    ticket: parseTicket(readAbsolute(env, CONNECTED_WORKER_ENV.ticketFile)),
    stateDir: absolute(required(env, CONNECTED_WORKER_ENV.stateDir), CONNECTED_WORKER_ENV.stateDir),
    reportFile: absolute(required(env, CONNECTED_WORKER_ENV.reportFile), CONNECTED_WORKER_ENV.reportFile),
    runId: required(env, CONNECTED_WORKER_ENV.runId),
    stopAfter: stopAfterRaw as ConnectedWorkerStage,
  });
}

function parseTicket(raw: string): WorkerAdmissionTicket {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectedWorkerConfigError("Connected-worker admission ticket is not an object.");
  }
  return Object.freeze(parsed as WorkerAdmissionTicket);
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0) {
    throw new ConnectedWorkerConfigError(`Connected-worker setting ${name} is required.`);
  }
  return value;
}

function absolute(value: string, name: string): string {
  if (!isAbsolute(value)) throw new ConnectedWorkerConfigError(`Connected-worker setting ${name} must be absolute.`);
  return value;
}

function readAbsolute(env: Readonly<Record<string, string | undefined>>, name: string): string {
  return readFileSync(absolute(required(env, name), name), "utf8");
}
