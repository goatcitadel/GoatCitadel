import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_RUNTIME_ENV,
  parseRemoteWorkerRuntimeConfig,
  remoteWorkerRuntimeConfigDiagnostics,
} from "./remote-worker-runtime-config.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function enabledEnvironment(): Record<string, string> {
  return {
    [REMOTE_WORKER_RUNTIME_ENV.enabled]: "true",
    [REMOTE_WORKER_RUNTIME_ENV.host]: "127.0.0.1",
    [REMOTE_WORKER_RUNTIME_ENV.port]: "9443",
    [REMOTE_WORKER_RUNTIME_ENV.serverCertificateFile]: resolve("test-fixtures/worker-server.crt"),
    [REMOTE_WORKER_RUNTIME_ENV.serverKeyFile]: resolve("test-fixtures/worker-server.key"),
    [REMOTE_WORKER_RUNTIME_ENV.clientCaFile]: resolve("test-fixtures/worker-client-ca.crt"),
    [REMOTE_WORKER_RUNTIME_ENV.clientCaSha256]: SHA_A,
    [REMOTE_WORKER_RUNTIME_ENV.manifestSignerKeyId]: "release-2026-07",
    [REMOTE_WORKER_RUNTIME_ENV.manifestSignerPublicKeyFile]: resolve("test-fixtures/manifest-signer.pem"),
    [REMOTE_WORKER_RUNTIME_ENV.manifestSignerSpkiSha256]: SHA_B,
  };
}

describe("remote worker runtime config", () => {
  it("is disabled by default and exposes only secret-free diagnostics", () => {
    const config = parseRemoteWorkerRuntimeConfig({});
    expect(config).toEqual({ enabled: false });
    expect(remoteWorkerRuntimeConfigDiagnostics(config)).toEqual({
      enabled: false,
      transport: "disabled",
      certificateConfigured: false,
      clientCaPinConfigured: false,
      manifestSignerPinConfigured: false,
    });
  });

  it("rejects ambiguous partial or unknown remote-worker configuration while disabled", () => {
    expect(() =>
      parseRemoteWorkerRuntimeConfig({
        [REMOTE_WORKER_RUNTIME_ENV.host]: "127.0.0.1",
      }),
    ).toThrow("settings are present while the runtime is disabled");
    expect(() =>
      parseRemoteWorkerRuntimeConfig({
        [REMOTE_WORKER_RUNTIME_ENV.enabled]: "false",
        GOATCITADEL_REMOTE_WORKER_TRUST_PROXY: "true",
      }),
    ).toThrow("unsupported remote worker setting");
  });

  it.each(["TRUE", "1", "yes", " true", ""])('rejects the non-canonical enablement value "%s"', (value) => {
    expect(() =>
      parseRemoteWorkerRuntimeConfig({
        [REMOTE_WORKER_RUNTIME_ENV.enabled]: value,
      }),
    ).toThrow("exact value true or false");
  });

  it("freezes a native-mTLS-only TLS 1.3 configuration with bounded default TTLs", () => {
    const config = parseRemoteWorkerRuntimeConfig(enabledEnvironment());
    expect(config).toMatchObject({
      enabled: true,
      host: "127.0.0.1",
      port: 9443,
      tls: {
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        requestCert: true,
        rejectUnauthorized: true,
        clientCaSha256: SHA_A,
      },
      manifestSigner: {
        keyId: "release-2026-07",
        spkiSha256: SHA_B,
      },
      bootstrapTtlSeconds: 600,
      credentialTtlSeconds: 900,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(JSON.stringify(remoteWorkerRuntimeConfigDiagnostics(config))).not.toContain("test-fixtures");
    expect(JSON.stringify(remoteWorkerRuntimeConfigDiagnostics(config))).not.toContain(SHA_A);
  });

  it("accepts only bounded integer ports and TTLs", () => {
    const env = enabledEnvironment();
    env[REMOTE_WORKER_RUNTIME_ENV.bootstrapTtlSeconds] = "1";
    env[REMOTE_WORKER_RUNTIME_ENV.credentialTtlSeconds] = "899";
    expect(parseRemoteWorkerRuntimeConfig(env)).toMatchObject({
      bootstrapTtlSeconds: 1,
      credentialTtlSeconds: 899,
    });
    for (const [name, value] of [
      [REMOTE_WORKER_RUNTIME_ENV.port, "0"],
      [REMOTE_WORKER_RUNTIME_ENV.port, "65536"],
      [REMOTE_WORKER_RUNTIME_ENV.port, "1.5"],
      [REMOTE_WORKER_RUNTIME_ENV.bootstrapTtlSeconds, "601"],
      [REMOTE_WORKER_RUNTIME_ENV.credentialTtlSeconds, "901"],
    ] as const) {
      expect(() => parseRemoteWorkerRuntimeConfig({ ...enabledEnvironment(), [name]: value })).toThrow();
    }
  });

  it("rejects missing settings, unsafe hosts, relative paths, weak pins, and non-canonical signer IDs", () => {
    const cases: Record<string, string | undefined>[] = [
      { [REMOTE_WORKER_RUNTIME_ENV.serverKeyFile]: undefined },
      { [REMOTE_WORKER_RUNTIME_ENV.host]: "https://worker.local" },
      { [REMOTE_WORKER_RUNTIME_ENV.host]: "worker.local/path" },
      { [REMOTE_WORKER_RUNTIME_ENV.serverCertificateFile]: "relative/server.crt" },
      { [REMOTE_WORKER_RUNTIME_ENV.clientCaSha256]: "A".repeat(64) },
      { [REMOTE_WORKER_RUNTIME_ENV.manifestSignerSpkiSha256]: "b".repeat(63) },
      { [REMOTE_WORKER_RUNTIME_ENV.manifestSignerKeyId]: "Release Key" },
    ];
    for (const patch of cases) {
      expect(() => parseRemoteWorkerRuntimeConfig({ ...enabledEnvironment(), ...patch })).toThrow();
    }
  });

  it("never includes raw configuration values in failures", () => {
    const secretPath = resolve("sensitive/operator/private-worker-key.pem");
    let caught: unknown;
    try {
      parseRemoteWorkerRuntimeConfig({
        ...enabledEnvironment(),
        [REMOTE_WORKER_RUNTIME_ENV.serverKeyFile]: secretPath,
        [REMOTE_WORKER_RUNTIME_ENV.clientCaSha256]: "not-a-pin",
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain(secretPath);
    expect(JSON.stringify(caught)).not.toContain(secretPath);
    expect(String(caught)).not.toContain("not-a-pin");
  });
});
