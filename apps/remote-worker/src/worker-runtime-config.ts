import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { WorkerAdmissionTicket } from "./worker-admission-client.js";
import type { WorkerTransportMaterial, WorkerContextTransportMaterial } from "./worker-wire-client.js";
import type { WorkerProtectedAdmissionTicket } from "./worker-protected-admission-client.js";
import type { WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import { createWindowsProtectedWorkerTransport } from "./worker-windows-protected-transport.js";
import { CONNECTED_WORKER_ENV } from "./worker-environment.js";
import type { WorkerMeshToolRegistryReference } from "./worker-mesh-tool-registry.js";
export { CONNECTED_WORKER_ENV } from "./worker-environment.js";

/**
 * Process-boundary configuration for the connected worker runtime.
 *
 * Every value is read from the environment exactly once, at startup, and every
 * file path must be absolute. Unknown `GOATCITADEL_CONNECTED_WORKER_*` names are
 * rejected so a typo can never silently disable a stage.
 */
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
  "tools",
  "events",
  "artifact",
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
  readonly executionMode?: "gateway_inference" | "protocol_probe";
  readonly runMode?: "once" | "continuous";
  readonly meshRegistry?: WorkerMeshToolRegistryReference;
}

/** Supplied by the installed native owner, never reconstructed from retained JSON. */
export interface ProtectedConnectedWorkerConfig extends Omit<ConnectedWorkerConfig, "transport" | "ticket"> {
  readonly transport: WorkerContextTransportMaterial;
  readonly ticket: WorkerProtectedAdmissionTicket;
}

export type WorkerRunConfig = ConnectedWorkerConfig | ProtectedConnectedWorkerConfig;

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
  const snapshot = Object.freeze({ ...env });
  if (snapshot[CONNECTED_WORKER_ENV.protectedKeyFile] !== undefined)
    throw new ConnectedWorkerConfigError("Use protected startup for a protected key reference.");
  const common = readCommonConfig(snapshot);
  return Object.freeze({
    ...common,
    transport: Object.freeze({
      ...common.transport,
      clientPrivateKeyPem: readAbsolute(snapshot, CONNECTED_WORKER_ENV.clientKeyFile),
    }),
    ticket: common.ticket as unknown as WorkerAdmissionTicket,
  });
}

/** Resolve a live native owner from public configuration; retained JSON cannot supply one. */
export function parseConnectedWorkerStartup(env: Readonly<Record<string, string | undefined>> = process.env): {
  readonly config: WorkerRunConfig;
  readonly protectedKeys?: WorkerProtectedKeyOwner;
} {
  const snapshot = Object.freeze({ ...env });
  if (snapshot[CONNECTED_WORKER_ENV.protectedKeyFile] === undefined)
    return Object.freeze({ config: parseConnectedWorkerConfig(snapshot) });
  if (snapshot[CONNECTED_WORKER_ENV.clientKeyFile] !== undefined)
    throw new ConnectedWorkerConfigError("Connected-worker startup cannot combine PEM and protected key settings.");
  const common = readCommonConfig(snapshot);
  if (
    Object.hasOwn(common.ticket, "protectedSignerPrivateKeyPem") ||
    typeof common.ticket.protectedSignerPublicKeySpkiBase64Url !== "string" ||
    common.ticket.protectedSignerPublicKeySpkiBase64Url.length === 0
  )
    throw new ConnectedWorkerConfigError("Protected startup requires a ticket with only public signer authority.");
  const { transport, protectedKeys } = createWindowsProtectedWorkerTransport({
    transport: common.transport,
    tlsKeyIdentifier: readAbsolute(snapshot, CONNECTED_WORKER_ENV.protectedKeyFile),
    admissionSignerSpkiBase64Url: common.ticket.protectedSignerPublicKeySpkiBase64Url,
  });
  const config: ProtectedConnectedWorkerConfig = Object.freeze({
    ...common,
    transport,
    ticket: common.ticket as unknown as WorkerProtectedAdmissionTicket,
  });
  return Object.freeze({ config, protectedKeys });
}

function readCommonConfig(env: Readonly<Record<string, string | undefined>>) {
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
  const executionMode = env[CONNECTED_WORKER_ENV.executionMode] ?? "gateway_inference";
  if (executionMode !== "gateway_inference" && executionMode !== "protocol_probe")
    throw new ConnectedWorkerConfigError("Connected-worker execution mode is invalid.");
  if (!(CONNECTED_WORKER_STAGES as readonly string[]).includes(stopAfterRaw)) {
    throw new ConnectedWorkerConfigError("Connected-worker stop stage is invalid.");
  }
  const runMode = env[CONNECTED_WORKER_ENV.runMode] ?? "once";
  if (runMode !== "once" && runMode !== "continuous")
    throw new ConnectedWorkerConfigError("Connected-worker run mode is invalid.");
  if (runMode === "continuous" && (executionMode !== "gateway_inference" || stopAfterRaw !== "complete"))
    throw new ConnectedWorkerConfigError("Continuous workers require complete governed execution.");
  const registryFile = env[CONNECTED_WORKER_ENV.meshRegistryFile];
  const registrySha256 = env[CONNECTED_WORKER_ENV.meshRegistrySha256];
  const meshRegistry = registryFile === undefined && registrySha256 === undefined ? undefined : (() => {
    if (!registryFile || !registrySha256 || !/^[a-f0-9]{64}$/u.test(registrySha256) || executionMode !== "gateway_inference")
      throw new ConnectedWorkerConfigError("Mesh tool registry requires its absolute file, exact digest and governed execution.");
    return Object.freeze({ file: absolute(registryFile, CONNECTED_WORKER_ENV.meshRegistryFile), sha256: registrySha256 });
  })();
  return Object.freeze({
    transport: Object.freeze({
      host: required(env, CONNECTED_WORKER_ENV.host),
      port,
      clientCertificatePem: readAbsolute(env, CONNECTED_WORKER_ENV.clientCertificateFile),
      trustAnchorPem: readAbsolute(env, CONNECTED_WORKER_ENV.trustAnchorFile),
    }),
    ticket: parseTicket(readAbsolute(env, CONNECTED_WORKER_ENV.ticketFile)),
    stateDir: absolute(required(env, CONNECTED_WORKER_ENV.stateDir), CONNECTED_WORKER_ENV.stateDir),
    reportFile: absolute(required(env, CONNECTED_WORKER_ENV.reportFile), CONNECTED_WORKER_ENV.reportFile),
    runId: required(env, CONNECTED_WORKER_ENV.runId),
    stopAfter: stopAfterRaw as ConnectedWorkerStage,
    executionMode,
    runMode,
    ...(meshRegistry ? { meshRegistry } : {}),
  });
}

function parseTicket(raw: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConnectedWorkerConfigError("Connected-worker admission ticket is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConnectedWorkerConfigError("Connected-worker admission ticket is not an object.");
  }
  return Object.freeze(parsed as Record<string, unknown>);
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
