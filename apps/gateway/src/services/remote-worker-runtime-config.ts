import { isAbsolute } from "node:path";
import {
  REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS,
  REMOTE_WORKER_MAX_CREDENTIAL_TTL_SECONDS,
} from "@goatcitadel/contracts";

export const REMOTE_WORKER_RUNTIME_ENV = Object.freeze({
  enabled: "GOATCITADEL_REMOTE_WORKERS_ENABLED",
  host: "GOATCITADEL_REMOTE_WORKER_HOST",
  port: "GOATCITADEL_REMOTE_WORKER_PORT",
  serverCertificateFile: "GOATCITADEL_REMOTE_WORKER_TLS_SERVER_CERT_FILE",
  serverKeyFile: "GOATCITADEL_REMOTE_WORKER_TLS_SERVER_KEY_FILE",
  clientCaFile: "GOATCITADEL_REMOTE_WORKER_TLS_CLIENT_CA_FILE",
  clientCaSha256: "GOATCITADEL_REMOTE_WORKER_TLS_CLIENT_CA_SHA256",
  manifestSignerKeyId: "GOATCITADEL_REMOTE_WORKER_MANIFEST_SIGNER_KEY_ID",
  manifestSignerPublicKeyFile: "GOATCITADEL_REMOTE_WORKER_MANIFEST_SIGNER_PUBLIC_KEY_FILE",
  manifestSignerSpkiSha256: "GOATCITADEL_REMOTE_WORKER_MANIFEST_SIGNER_SPKI_SHA256",
  bootstrapTtlSeconds: "GOATCITADEL_REMOTE_WORKER_BOOTSTRAP_TTL_SECONDS",
  credentialTtlSeconds: "GOATCITADEL_REMOTE_WORKER_CREDENTIAL_TTL_SECONDS",
} as const);

const KNOWN_ENV_NAMES = new Set<string>(Object.values(REMOTE_WORKER_RUNTIME_ENV));
const REMOTE_WORKER_ENV_PREFIXES = ["GOATCITADEL_REMOTE_WORKER_", "GOATCITADEL_REMOTE_WORKERS_"];

export interface DisabledRemoteWorkerRuntimeConfig {
  readonly enabled: false;
}

export interface EnabledRemoteWorkerRuntimeConfig {
  readonly enabled: true;
  readonly host: string;
  readonly port: number;
  readonly tls: {
    readonly minVersion: "TLSv1.3";
    readonly maxVersion: "TLSv1.3";
    readonly requestCert: true;
    readonly rejectUnauthorized: true;
    readonly serverCertificateFile: string;
    readonly serverKeyFile: string;
    readonly clientCaFile: string;
    readonly clientCaSha256: string;
  };
  readonly manifestSigner: {
    readonly keyId: string;
    readonly publicKeyFile: string;
    readonly spkiSha256: string;
  };
  readonly bootstrapTtlSeconds: number;
  readonly credentialTtlSeconds: number;
}

export type RemoteWorkerRuntimeConfig = DisabledRemoteWorkerRuntimeConfig | EnabledRemoteWorkerRuntimeConfig;

export interface RemoteWorkerRuntimeConfigDiagnostics {
  readonly enabled: boolean;
  readonly transport: "disabled" | "native_mtls_tls_1_3";
  readonly certificateConfigured: boolean;
  readonly clientCaPinConfigured: boolean;
  readonly manifestSignerPinConfigured: boolean;
  readonly bootstrapTtlSeconds?: number;
  readonly credentialTtlSeconds?: number;
}

export class RemoteWorkerRuntimeConfigError extends Error {
  readonly code = "REMOTE_WORKER_RUNTIME_CONFIG_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkerRuntimeConfigError";
  }
}

export function parseRemoteWorkerRuntimeConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RemoteWorkerRuntimeConfig {
  rejectUnknownRemoteWorkerEnvironment(env);
  const enabledRaw = env[REMOTE_WORKER_RUNTIME_ENV.enabled];
  if (enabledRaw !== undefined && enabledRaw !== "false" && enabledRaw !== "true") {
    throw invalid("Remote worker enablement must be the exact value true or false.");
  }
  if (enabledRaw !== "true") {
    const partialNames = Object.values(REMOTE_WORKER_RUNTIME_ENV).filter(
      (name) => name !== REMOTE_WORKER_RUNTIME_ENV.enabled && env[name] !== undefined,
    );
    if (partialNames.length > 0) {
      throw invalid("Remote worker settings are present while the runtime is disabled.");
    }
    return Object.freeze({ enabled: false });
  }

  const host = required(env, REMOTE_WORKER_RUNTIME_ENV.host);
  if (host.length > 253 || host.trim() !== host || /[\s\\/?#@]|\p{Cc}/u.test(host) || host.includes("://")) {
    throw invalid("Remote worker host is invalid.");
  }
  const port = boundedInteger(required(env, REMOTE_WORKER_RUNTIME_ENV.port), 1, 65_535, "port");
  const serverCertificateFile = absoluteFile(env, REMOTE_WORKER_RUNTIME_ENV.serverCertificateFile);
  const serverKeyFile = absoluteFile(env, REMOTE_WORKER_RUNTIME_ENV.serverKeyFile);
  const clientCaFile = absoluteFile(env, REMOTE_WORKER_RUNTIME_ENV.clientCaFile);
  const clientCaSha256 = sha256(env, REMOTE_WORKER_RUNTIME_ENV.clientCaSha256, "client CA pin");
  const manifestSignerKeyId = canonicalKeyId(required(env, REMOTE_WORKER_RUNTIME_ENV.manifestSignerKeyId));
  const manifestSignerPublicKeyFile = absoluteFile(env, REMOTE_WORKER_RUNTIME_ENV.manifestSignerPublicKeyFile);
  const manifestSignerSpkiSha256 = sha256(
    env,
    REMOTE_WORKER_RUNTIME_ENV.manifestSignerSpkiSha256,
    "manifest signer pin",
  );
  const bootstrapTtlSeconds = optionalBoundedInteger(
    env[REMOTE_WORKER_RUNTIME_ENV.bootstrapTtlSeconds],
    1,
    REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS,
    REMOTE_WORKER_MAX_BOOTSTRAP_TTL_SECONDS,
    "bootstrap TTL",
  );
  const credentialTtlSeconds = optionalBoundedInteger(
    env[REMOTE_WORKER_RUNTIME_ENV.credentialTtlSeconds],
    1,
    REMOTE_WORKER_MAX_CREDENTIAL_TTL_SECONDS,
    REMOTE_WORKER_MAX_CREDENTIAL_TTL_SECONDS,
    "credential TTL",
  );

  return Object.freeze({
    enabled: true,
    host,
    port,
    tls: Object.freeze({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
      serverCertificateFile,
      serverKeyFile,
      clientCaFile,
      clientCaSha256,
    }),
    manifestSigner: Object.freeze({
      keyId: manifestSignerKeyId,
      publicKeyFile: manifestSignerPublicKeyFile,
      spkiSha256: manifestSignerSpkiSha256,
    }),
    bootstrapTtlSeconds,
    credentialTtlSeconds,
  });
}

export function remoteWorkerRuntimeConfigDiagnostics(
  config: RemoteWorkerRuntimeConfig,
): RemoteWorkerRuntimeConfigDiagnostics {
  if (!config.enabled) {
    return Object.freeze({
      enabled: false,
      transport: "disabled",
      certificateConfigured: false,
      clientCaPinConfigured: false,
      manifestSignerPinConfigured: false,
    });
  }
  return Object.freeze({
    enabled: true,
    transport: "native_mtls_tls_1_3",
    certificateConfigured: true,
    clientCaPinConfigured: true,
    manifestSignerPinConfigured: true,
    bootstrapTtlSeconds: config.bootstrapTtlSeconds,
    credentialTtlSeconds: config.credentialTtlSeconds,
  });
}

function rejectUnknownRemoteWorkerEnvironment(env: Readonly<Record<string, string | undefined>>): void {
  for (const [name, value] of Object.entries(env)) {
    if (
      value !== undefined &&
      REMOTE_WORKER_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)) &&
      !KNOWN_ENV_NAMES.has(name)
    ) {
      throw invalid("An unsupported remote worker setting is present.");
    }
  }
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value.length === 0 || value.trim() !== value || /\p{Cc}/u.test(value)) {
    throw invalid("A required remote worker setting is missing or invalid.");
  }
  return value;
}

function absoluteFile(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = required(env, name);
  if (!isAbsolute(value)) {
    throw invalid("A remote worker credential file path must be absolute.");
  }
  return value;
}

function sha256(env: Readonly<Record<string, string | undefined>>, name: string, label: string): string {
  const value = required(env, name);
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw invalid(`Remote worker ${label} is invalid.`);
  }
  return value;
}

function canonicalKeyId(value: string): string {
  if (value.length > 128 || !/^[a-z0-9](?:[a-z0-9._:-]{0,126}[a-z0-9])?$/u.test(value)) {
    throw invalid("Remote worker manifest signer key ID is invalid.");
  }
  return value;
}

function optionalBoundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
  label: string,
): number {
  return value === undefined ? fallback : boundedInteger(value, minimum, maximum, label);
}

function boundedInteger(value: string, minimum: number, maximum: number, label: string): number {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw invalid(`Remote worker ${label} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw invalid(`Remote worker ${label} is outside its allowed range.`);
  }
  return parsed;
}

function invalid(message: string): RemoteWorkerRuntimeConfigError {
  return new RemoteWorkerRuntimeConfigError(message);
}
