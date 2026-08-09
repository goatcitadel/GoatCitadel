import { execFile } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, sign, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  REMOTE_WORKER_PROTOCOL_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
  REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
  REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
  canonicalJsonString,
  remoteWorkerProtectedAdmissionContextSha256,
  type FinalizeRemoteWorkerBootstrapAdmissionCommand,
  type RemoteWorkerProtectedAdmissionEvidenceWire,
  type RemoteWorkerRuntimeManifest,
} from "@goatcitadel/contracts";
import {
  RemoteWorkerAdmissionRepository,
  createDatabase,
  type FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput,
} from "@goatcitadel/storage";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayRemoteWorkerAdmissionNativeRequestHandler } from "./remote-worker-admission-composition.js";
import { RemoteWorkerProtectedAdmissionAuthorityService } from "./remote-worker-protected-admission-authority-service.js";
import { RemoteWorkerProtectedAdmissionEvidenceVerifier } from "./remote-worker-protected-admission-evidence-verifier.js";
import {
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
  type RemoteWorkerAdmissionEvidenceVerificationInput,
} from "./remote-worker-admission-service.js";
import * as listenerModule from "./remote-worker-native-tls-listener.js";
import {
  startRemoteWorkerNativeTlsListener,
  type RemoteWorkerNativeHandlerRequest,
} from "./remote-worker-native-tls-listener.js";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_HEADERS,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  type RemoteWorkerProtocolBody,
} from "./remote-worker-protocol.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
import {
  REMOTE_WORKER_TLS_EXPORTER_BYTES,
  REMOTE_WORKER_TLS_EXPORTER_LABEL,
  type RemoteWorkerTransportIdentity,
} from "./remote-worker-transport-identity.js";
import { remoteWorkerWindowsNoFollowHelperDiagnostics } from "./remote-worker-windows-no-follow.js";

// Public, non-secret test fixtures generated solely for the HX-501 loopback proof.
const CA_PEM = `-----BEGIN CERTIFICATE-----
MIIBeDCCASqgAwIBAgIUZTNs1ByBlRL7pMZAVAYlyN0teqowBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowKDEmMCQGA1UEAwwdR29hdENpdGFkZWwgSFg1
MDEgTGlzdGVuZXIgQ0EwKjAFBgMrZXADIQBSjxcD22J7+xt6LJu4UnOJKaXZhTtc
DNUL0Sc17UIySqNmMGQwHQYDVR0OBBYEFKNuM5RciNLBA4yMy9gbSZJl/TMRMB8G
A1UdIwQYMBaAFKNuM5RciNLBA4yMy9gbSZJl/TMRMBIGA1UdEwEB/wQIMAYBAf8C
AQAwDgYDVR0PAQH/BAQDAgEGMAUGAytlcANBAMQ+p3my9NrSqOm0fF+C0va6qSbw
k9WLzL7qJnU+N2nTjrbotBwiGwx8I9BlDhVNZSY/w3qSBm0+vxWL3+qrvw4=
-----END CERTIFICATE-----
`;
const SERVER_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBkTCCAUOgAwIBAgIUMFqWz4nhKmOp4ZrcncR9oaEoiB4wBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MCowBQYD
K2VwAyEApw4nkG7WgBmO2bN73r98GKsDjA9bngBJLAI1WBISBXyjgZIwgY8wGgYD
VR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwDgYDVR0PAQH/
BAQDAgeAMBMGA1UdJQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBSZDRm2hCmy2yT3
1vE/ppFeanKi0zAfBgNVHSMEGDAWgBSjbjOUXIjSwQOMjMvYG0mSZf0zETAFBgMr
ZXADQQD1b9ZjFapMTW6dOndRfXTl6Md06NKtSLgQFmwCxc3UaAy1VWQESaosmrRO
9Hf/jfKiVRt4jgexXOuD67sB0BoH
-----END CERTIFICATE-----
`;
const SERVER_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIB81SweGGRtBMfQh+I7Wo37pzfi5OH82CMinGgKsCCWQ
-----END PRIVATE KEY-----
`;
const CLIENT_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBdTCCASegAwIBAgIUMFqWz4nhKmOp4ZrcncR9oaEoiB8wBQYDK2VwMCgxJjAk
BgNVBAMMHUdvYXRDaXRhZGVsIEhYNTAxIExpc3RlbmVyIENBMB4XDTI2MDcxNTA3
MzYxNFoXDTM2MDcxMjA3MzYxNFowFjEUMBIGA1UEAwwLd29ya2VyLXRlc3QwKjAF
BgMrZXADIQD2T1jzXgcwp1PO5oB4g11yGDpKYg0rJ9UJHurdPyLLA6N1MHMwDAYD
VR0TAQH/BAIwADAOBgNVHQ8BAf8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwIw
HQYDVR0OBBYEFCu/5nk7wPmPf105JYKUIoPMY3NuMB8GA1UdIwQYMBaAFKNuM5Rc
iNLBA4yMy9gbSZJl/TMRMAUGAytlcANBAPpVSsCZqAookqSqgB3fZnpH59824/M3
4wkMWAKzgxgJIFP7uq0mJDI7UqXoQyjdWVcACP+8igEU/xboG1WNMQU=
-----END CERTIFICATE-----
`;
const CLIENT_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIP7oQh0GClRqd2Tb5kfT1Cbdc78LOylrcLyeqYoBNyo1
-----END PRIVATE KEY-----
`;
const SIGNER_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYW0Sx+Dg9lF7/vSv+5CKkcE6fn9mTwgHMQtJa3YhArQ=
-----END PUBLIC KEY-----
`;

const cleanupRoots: string[] = [];
const openHandles: Array<{ close(): Promise<void> }> = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.allSettled(openHandles.splice(0).map(async (handle) => handle.close()));
  await Promise.all(cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function config(): Promise<EnabledRemoteWorkerRuntimeConfig> {
  const root = await mkdtemp(join(tmpdir(), "goat-worker-listener-"));
  cleanupRoots.push(root);
  const systemRoot = process.env.SystemRoot as string;
  const { stdout } = await execFileAsync(join(systemRoot, "System32", "whoami.exe"), ["/user", "/fo", "csv", "/nh"]);
  const sid = /"(S-1-[0-9-]+)"/u.exec(stdout)?.[1];
  if (sid === undefined) throw new Error("Unable to resolve the Windows test operator SID.");
  await execFileAsync(join(systemRoot, "System32", "icacls.exe"), [
    root,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
  const paths = {
    cert: join(root, "server.crt"),
    key: join(root, "server.key"),
    ca: join(root, "client-ca.crt"),
    signer: join(root, "signer.pub"),
  };
  await Promise.all([
    writeFile(paths.cert, SERVER_CERT_PEM),
    writeFile(paths.key, SERVER_KEY_PEM),
    writeFile(paths.ca, CA_PEM),
    writeFile(paths.signer, SIGNER_PUBLIC_PEM),
  ]);
  const signerDer = Buffer.from(
    SIGNER_PUBLIC_PEM.match(/\n([A-Za-z0-9+/=\n]+)-----END/u)?.[1]?.replace(/\n/gu, "") ?? "",
    "base64",
  );
  return Object.freeze({
    enabled: true,
    host: "127.0.0.1",
    port: 0,
    tls: Object.freeze({
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      requestCert: true,
      rejectUnauthorized: true,
      serverCertificateFile: paths.cert,
      serverKeyFile: paths.key,
      clientCaFile: paths.ca,
      clientCaSha256: createHash("sha256").update(new X509Certificate(CA_PEM).raw).digest("hex"),
    }),
    manifestSigner: Object.freeze({
      keyId: "listener-test",
      publicKeyFile: paths.signer,
      spkiSha256: createHash("sha256").update(signerDer).digest("hex"),
    }),
    bootstrapTtlSeconds: 600,
    credentialTtlSeconds: 900,
  });
}

function portOf(address: string | undefined): number {
  const port = Number(address?.slice((address.lastIndexOf(":") ?? -1) + 1));
  if (!Number.isInteger(port) || port < 1) throw new Error("Listener did not expose a bound port.");
  return port;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function signedRuntimeManifest(): {
  readonly manifest: RemoteWorkerRuntimeManifest;
  readonly signerKeyId: string;
  readonly signerPublicKeyPem: string;
  readonly signerSpkiSha256: string;
} {
  const signerKeyId = "live-handler-signer";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signerSpkiDer = publicKey.export({ format: "der", type: "spki" });
  const signerPublicKeyPem = publicKey.export({ format: "pem", type: "spki" });
  if (!Buffer.isBuffer(signerSpkiDer) || typeof signerPublicKeyPem !== "string") {
    throw new Error("Unable to create the live-handler manifest signer fixture.");
  }
  const payload = Object.freeze({
    schemaVersion: REMOTE_WORKER_RUNTIME_MANIFEST_SCHEMA_VERSION,
    protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
    bundleSha256: sha256("live-bundle"),
    dependencyLockSha256: sha256("live-lock"),
    vendorTreeSha256: sha256("live-vendor"),
    launcherSha256: sha256("live-launcher"),
    installedTreeManifestSha256: sha256("live-tree"),
    installedTreeFileCount: 5,
    platform: "windows",
    architecture: "x64",
  });
  return Object.freeze({
    manifest: Object.freeze({
      payload,
      payloadSha256: sha256(canonicalJsonString(payload)),
      signatureAlgorithm: "ed25519",
      signerKeyId,
      signatureBase64Url: sign(null, Buffer.from(canonicalJsonString(payload), "utf8"), privateKey).toString(
        "base64url",
      ),
    }),
    signerKeyId,
    signerPublicKeyPem,
    signerSpkiSha256: sha256(signerSpkiDer),
  });
}

interface LiveAdmissionRequestFixture {
  readonly bootstrapSecret: string;
  readonly bootstrapId: string;
  readonly authorityGeneration: number;
  readonly idempotencyKey: string;
  readonly protectedAdmissionEvidence?: (input: {
    readonly nonce: string;
    readonly tlsExporterSha256: string;
    readonly publicKeySpkiSha256: string;
    readonly clientCertificateSha256: string;
    readonly transportTrustAnchorSha256: string;
  }) => RemoteWorkerProtectedAdmissionEvidenceWire;
}

async function liveAdmissionRequest(
  port: number,
  input: LiveAdmissionRequestFixture,
  nonceByte: number,
): Promise<{
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  readonly tlsExporterSha256: string;
}> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== undefined) {
        reject(error);
        return;
      }
      try {
        const response = Buffer.concat(chunks);
        const headerEnd = response.indexOf("\r\n\r\n");
        if (headerEnd < 1) throw new Error("Live admission response did not contain HTTP headers.");
        const headers = response.subarray(0, headerEnd).toString("ascii");
        const status = Number(/^HTTP\/1\.1 ([0-9]{3}) /u.exec(headers)?.[1]);
        if (!Number.isInteger(status)) throw new Error("Live admission response status was invalid.");
        const body = JSON.parse(response.subarray(headerEnd + 4).toString("utf8")) as Record<string, unknown>;
        resolve({ status, body: Object.freeze(body), tlsExporterSha256: exporterSha256 });
      } catch (parseError) {
        reject(parseError);
      }
    };
    let exporterSha256 = "";
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      ca: CA_PEM,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
    });
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("secureConnect", () => {
      setImmediate(() => {
        let exporter: Buffer | undefined;
        try {
          exporter = socket.exportKeyingMaterial(
            REMOTE_WORKER_TLS_EXPORTER_BYTES,
            REMOTE_WORKER_TLS_EXPORTER_LABEL,
            Buffer.alloc(0),
          );
          exporterSha256 = sha256(exporter);
          const certificate = new X509Certificate(CLIENT_CERT_PEM);
          const publicKeySpkiDer = certificate.publicKey.export({ format: "der", type: "spki" });
          if (!Buffer.isBuffer(publicKeySpkiDer)) throw new Error("Client SPKI fixture was invalid.");
          const timestamp = new Date().toISOString();
          const nonce = Buffer.alloc(32, nonceByte).toString("base64url");
          const clientCertificateSha256 = sha256(certificate.raw);
          const publicKeySpkiSha256 = sha256(publicKeySpkiDer);
          const transportTrustAnchorSha256 = sha256(new X509Certificate(CA_PEM).raw);
          const protectedAdmissionEvidence = input.protectedAdmissionEvidence?.({
            nonce,
            tlsExporterSha256: exporterSha256,
            publicKeySpkiSha256,
            clientCertificateSha256,
            transportTrustAnchorSha256,
          });
          const body: RemoteWorkerProtocolBody = Object.freeze({
            schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
            operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
            authorityId: input.bootstrapId,
            authorityGeneration: input.authorityGeneration,
            idempotencyKey: input.idempotencyKey,
            payload: Object.freeze({
              schemaVersion: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_SCHEMA_VERSION,
              publicKeySpkiBase64Url: publicKeySpkiDer.toString("base64url"),
              ...(protectedAdmissionEvidence === undefined ? {} : { protectedAdmissionEvidence }),
            }),
          });
          const encodedBody = Buffer.from(canonicalJsonString(body), "utf8");
          const transportIdentity: RemoteWorkerTransportIdentity = Object.freeze({
            source: "native_mtls",
            certificateDerSha256: clientCertificateSha256,
            publicKeySpkiSha256,
            trustAnchorDerSha256: transportTrustAnchorSha256,
            tlsExporterSha256: exporterSha256,
            tlsExporter: exporter,
          });
          const material = buildRemoteWorkerPopMaterial({
            rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
            bodySha256: remoteWorkerProtocolBodySha256(body),
            operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
            nonce,
            timestamp,
            idempotencyKey: input.idempotencyKey,
            authorityId: input.bootstrapId,
            authorityGeneration: input.authorityGeneration,
            transportIdentity,
          });
          const proof = sign(
            null,
            Buffer.from(canonicalJsonString(material), "utf8"),
            createPrivateKey(CLIENT_KEY_PEM),
          ).toString("base64url");
          const requestHeaders = [
            `POST ${REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH} HTTP/1.1`,
            `Host: 127.0.0.1:${String(port)}`,
            "Connection: close",
            "Content-Type: application/json",
            `Content-Length: ${String(encodedBody.byteLength)}`,
            `Authorization: GoatWorkerBootstrap ${input.bootstrapSecret}`,
            `${REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey}: ${input.idempotencyKey}`,
            `${REMOTE_WORKER_PROTOCOL_HEADERS.timestamp}: ${timestamp}`,
            `${REMOTE_WORKER_PROTOCOL_HEADERS.nonce}: ${nonce}`,
            `${REMOTE_WORKER_PROTOCOL_HEADERS.operation}: ${REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION}`,
            `${REMOTE_WORKER_PROTOCOL_HEADERS.proof}: ${proof}`,
            "",
            "",
          ].join("\r\n");
          socket.write(Buffer.concat([Buffer.from(requestHeaders, "ascii"), encodedBody]));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        } finally {
          exporter?.fill(0);
        }
      });
    });
    socket.once("end", () => finish());
    socket.once("close", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

function stableAdmissionBindings(command: FinalizeRemoteWorkerBootstrapAdmissionCommand | undefined): object {
  if (command === undefined) throw new Error("Admission command was not captured.");
  return Object.freeze({
    expectedRegistryWorkspaceId: command.expectedRegistryWorkspaceId,
    expectedBootstrapId: command.expectedBootstrapId,
    expectedTargetWorkerGeneration: command.expectedTargetWorkerGeneration,
    verifiedPublicKeySpkiSha256: command.verifiedPublicKeySpkiSha256,
    verifiedClientCertificateSha256: command.verifiedClientCertificateSha256,
    verifiedRuntimeManifestSha256: command.verifiedRuntimeManifestSha256,
    verifiedWorkspaceCeilingSha256: command.verifiedWorkspaceCeilingSha256,
    verifiedCapabilityCeilingSha256: command.verifiedCapabilityCeilingSha256,
    verifiedTransportIdentitySource: command.verifiedTransportIdentitySource,
    verifiedTransportTrustAnchorSha256: command.verifiedTransportTrustAnchorSha256,
    exchangeIdempotencyKey: command.exchangeIdempotencyKey,
  });
}

async function request(
  port: number,
  overrides: Record<string, unknown> = {},
  body = Buffer.alloc(0),
): Promise<{ status: number; body: string; headers: Readonly<Record<string, string | string[] | undefined>> }> {
  return await new Promise((resolve, reject) => {
    const outgoing = httpsRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/remote-worker/unavailable",
        cert: CLIENT_CERT_PEM,
        key: CLIENT_KEY_PEM,
        ca: CA_PEM,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
        agent: false,
        headers: { "Content-Type": "application/json", "Content-Length": String(body.byteLength) },
        ...overrides,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: Object.freeze({ ...response.headers }),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}

async function malformedTlsRequest(port: number, payload: string): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let secure = false;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    };
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      ca: CA_PEM,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
    });
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("secureConnect", () => {
      secure = true;
      socket.end(payload, "ascii");
    });
    socket.once("close", finish);
    socket.once("error", (error) => {
      if (secure) finish();
      else reject(error);
    });
  });
}

async function trickleIncompleteHeaders(
  port: number,
): Promise<{ readonly elapsedMs: number; readonly response: Buffer }> {
  return await new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const chunks: Buffer[] = [];
    let secure = false;
    let settled = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    const guard = setTimeout(
      () => finish(new Error("trickle connection exceeded its absolute header deadline")),
      8_000,
    );
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (interval !== undefined) clearInterval(interval);
      socket.destroy();
      if (error !== undefined) reject(error);
      else resolve({ elapsedMs: Date.now() - startedAt, response: Buffer.concat(chunks) });
    };
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      cert: CLIENT_CERT_PEM,
      key: CLIENT_KEY_PEM,
      ca: CA_PEM,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: true,
    });
    socket.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    socket.once("secureConnect", () => {
      secure = true;
      interval = setInterval(() => socket.write("P", "ascii"), 250);
    });
    socket.once("close", () => finish());
    socket.once("error", (error) => {
      if (!secure) finish(error);
    });
  });
}

describe("remote worker native TLS listener", () => {
  it("is disabled with a null-prototype, idempotent, zero-side-effect handle", async () => {
    const before = remoteWorkerWindowsNoFollowHelperDiagnostics().active;
    const handle = await startRemoteWorkerNativeTlsListener(Object.freeze({ enabled: false }));
    expect(handle).toEqual({ enabled: false, close: expect.any(Function) });
    expect(Object.getPrototypeOf(handle)).toBeNull();
    await Promise.all([handle.close(), handle.close()]);
    expect(remoteWorkerWindowsNoFollowHelperDiagnostics().active).toBe(before);
  });

  it.runIf(process.platform === "win32")(
    "serves only the fixed unavailable response over native TLS 1.3 mutual authentication",
    async () => {
      const handle = await startRemoteWorkerNativeTlsListener(await config());
      openHandles.push(handle);
      const port = portOf(handle.address);
      const [first, second] = await Promise.all([request(port), request(port)]);
      expect(first).toMatchObject({ status: 503, body: '{"error":"REMOTE_WORKER_UNAVAILABLE"}\n' });
      expect(first.headers).toMatchObject({
        "cache-control": "no-store",
        connection: "close",
        "content-type": "application/json; charset=utf-8",
        "retry-after": "60",
      });
      expect(second).toEqual(first);
      expect(Object.getPrototypeOf(handle)).toBeNull();

      await expect(request(port, { cert: undefined, key: undefined })).rejects.toThrow();
      await expect(request(port, { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" })).rejects.toThrow();
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "passes only frozen normalized request data to a live handler and zeroes ephemeral request authority",
    async () => {
      let captured:
        | {
            readonly bodyBytes: Buffer;
            readonly exporter: Buffer;
          }
        | undefined;
      const handlerBody = Buffer.from('{"accepted":true}\n', "utf8");
      const handler = async (requestValue: RemoteWorkerNativeHandlerRequest) => {
        expect(Object.isFrozen(requestValue)).toBe(true);
        expect(Object.getPrototypeOf(requestValue)).toBeNull();
        expect(Object.isFrozen(requestValue.headers)).toBe(true);
        expect(Object.getPrototypeOf(requestValue.headers)).toBeNull();
        expect(Object.keys(requestValue)).toEqual(["method", "rawPath", "headers", "bodyBytes", "transportIdentity"]);
        expect(requestValue.method).toBe("POST");
        expect(requestValue.rawPath).toBe("/remote-worker/live");
        expect(requestValue.headers["content-type"]).toBe("application/json");
        expect(requestValue.bodyBytes.toString("utf8")).toBe('{"operation":"heartbeat"}');
        expect(requestValue.transportIdentity).toMatchObject({
          source: "native_mtls",
          certificateDerSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          publicKeySpkiSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          trustAnchorDerSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
          tlsExporterSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
        });
        expect(requestValue.transportIdentity.tlsExporter).toHaveLength(32);
        captured = {
          bodyBytes: requestValue.bodyBytes,
          exporter: requestValue.transportIdentity.tlsExporter,
        };
        return Object.freeze({
          statusCode: 202,
          headers: Object.freeze({ "content-type": "application/json", "x-goatcitadel-result": "accepted" }),
          body: handlerBody,
        });
      };
      const handle = await startRemoteWorkerNativeTlsListener(await config(), handler);
      openHandles.push(handle);
      const body = Buffer.from('{"operation":"heartbeat"}', "utf8");
      const result = await request(portOf(handle.address), { path: "/remote-worker/live" }, body);

      expect(result).toMatchObject({
        status: 202,
        body: '{"accepted":true}\n',
        headers: {
          "cache-control": "no-store",
          connection: "close",
          "content-type": "application/json",
          "x-goatcitadel-result": "accepted",
        },
      });
      expect(captured).toBeDefined();
      expect(captured?.bodyBytes.every((value) => value === 0)).toBe(true);
      expect(captured?.exporter.every((value) => value === 0)).toBe(true);
      expect(handlerBody.toString("utf8")).toBe('{"accepted":true}\n');
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "replays one admission secret-free across a fresh exporter-bound TLS connection",
    async () => {
      const baseConfig = await config();
      const signer = signedRuntimeManifest();
      await writeFile(baseConfig.manifestSigner.publicKeyFile, signer.signerPublicKeyPem);
      const runtimeConfig: EnabledRemoteWorkerRuntimeConfig = Object.freeze({
        ...baseConfig,
        manifestSigner: Object.freeze({
          keyId: signer.signerKeyId,
          publicKeyFile: baseConfig.manifestSigner.publicKeyFile,
          spkiSha256: signer.signerSpkiSha256,
        }),
      });
      const database = createDatabase({ dbPath: ":memory:" });
      try {
        const repository = new RemoteWorkerAdmissionRepository(database);
        const evidenceSigner = generateKeyPairSync("ed25519");
        const evidenceSignerSpki = evidenceSigner.publicKey.export({ format: "der", type: "spki" });
        if (!Buffer.isBuffer(evidenceSignerSpki)) throw new Error("Expected DER evidence signer key.");
        const keysetReceiptSha256 = sha256("live-handler-keyset-receipt");
        const protectedAdmissionSignerPin = Object.freeze({
          schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_PIN_SCHEMA_VERSION,
          signatureAlgorithm: "ed25519" as const,
          keysetGeneration: 1,
          keysetReceiptSha256,
          signerSpkiSha256: sha256(evidenceSignerSpki),
          signerSpkiBase64Url: evidenceSignerSpki.toString("base64url"),
        });
        const bootstrapSecret = Buffer.alloc(32, 0x27).toString("base64url");
        const bootstrap = repository.createBootstrap({
          registryWorkspaceId: "default",
          workerLabel: "Fresh TLS replay worker",
          platform: "windows",
          architecture: "x64",
          runtimeManifest: signer.manifest,
          allowedWorkspaceIds: ["default"],
          capabilityClasses: ["durable_compute"],
          protectedAdmissionSignerPin,
          expiresInSeconds: 600,
          createdByActorId: "live-handler-test",
          idempotencyKey: "live-handler-bootstrap-create",
          bootstrapSecretSha256: sha256(bootstrapSecret),
        }).record;
        const evidenceAttempts: RemoteWorkerAdmissionEvidenceVerificationInput[] = [];
        const finalizations: FinalizeRemoteWorkerBootstrapAdmissionWithNonceInput[] = [];
        const bootstrapLookups: string[] = [];
        const serverExporters: string[] = [];
        const handler = await createGatewayRemoteWorkerAdmissionNativeRequestHandler({
          config: runtimeConfig,
          admissionStore: {
            findBootstrapBySecretSha256: (secretSha256) => {
              bootstrapLookups.push(secretSha256);
              return repository.findBootstrapBySecretSha256(secretSha256);
            },
            finalizeBootstrapAdmissionWithNonce: (input) => {
              finalizations.push(input);
              return repository.finalizeBootstrapAdmissionWithNonce(input);
            },
          },
          createEvidenceVerifier: () => ({
            assertAvailable: async () => undefined,
            verify: async (input) => {
              evidenceAttempts.push(input);
              return new RemoteWorkerProtectedAdmissionEvidenceVerifier().verify(input);
            },
          }),
        });
        expect(handler).toBeTypeOf("function");
        const listener = await startRemoteWorkerNativeTlsListener(runtimeConfig, async (requestValue) => {
          serverExporters.push(requestValue.transportIdentity.tlsExporterSha256);
          return await handler(requestValue);
        });
        openHandles.push(listener);
        const requestFixture = Object.freeze({
          bootstrapSecret,
          bootstrapId: bootstrap.bootstrapId,
          authorityGeneration: bootstrap.targetWorkerGeneration,
          idempotencyKey: "live-handler-exchange",
          protectedAdmissionEvidence: (identity: {
            readonly nonce: string;
            readonly tlsExporterSha256: string;
            readonly publicKeySpkiSha256: string;
            readonly clientCertificateSha256: string;
            readonly transportTrustAnchorSha256: string;
          }): RemoteWorkerProtectedAdmissionEvidenceWire => {
            const evidenceNonceSha256 = sha256(identity.nonce);
            const downloadVerificationReceiptSha256 = sha256("live-download");
            const installedTreeAttestationSha256 = sha256("live-installed-tree");
            const installedTreeVerificationReceiptSha256 = sha256("live-installed-receipt");
            const contextSha256 = remoteWorkerProtectedAdmissionContextSha256({
              registryWorkspaceId: bootstrap.registryWorkspaceId,
              bootstrapId: bootstrap.bootstrapId,
              workerId: bootstrap.workerId,
              nodeId: bootstrap.nodeId,
              targetWorkerGeneration: bootstrap.targetWorkerGeneration,
              platform: bootstrap.platform,
              architecture: bootstrap.architecture,
              runtimeManifestSha256: sha256(canonicalJsonString(bootstrap.runtimeManifest)),
              runtimeManifestPayloadSha256: bootstrap.runtimeManifest.payloadSha256,
              workspaceCeilingSha256: bootstrap.workspaceCeilingSha256,
              capabilityCeilingSha256: bootstrap.capabilityCeilingSha256,
              workerPublicKeySpkiSha256: identity.publicKeySpkiSha256,
              clientCertificateSha256: identity.clientCertificateSha256,
              transportTrustAnchorSha256: identity.transportTrustAnchorSha256,
              tlsExporterSha256: identity.tlsExporterSha256,
              evidenceNonceSha256,
              downloadVerificationReceiptSha256,
              installedTreeAttestationSha256,
              installedTreeVerificationReceiptSha256,
            });
            const operationId = Buffer.from(sha256(`live-operation:${identity.nonce}`), "hex").subarray(0, 16);
            const envelope = Buffer.alloc(288);
            envelope.write("GCAE", 0, "ascii");
            envelope.writeUInt16LE(1, 4);
            envelope.writeUInt8(1, 6);
            envelope.writeUInt32LE(288, 8);
            operationId.copy(envelope, 16);
            Buffer.from(evidenceNonceSha256, "hex").copy(envelope, 32);
            envelope.writeBigUInt64LE(1n, 64);
            Buffer.from(contextSha256, "hex").copy(envelope, 96);
            Buffer.from(sha256(canonicalJsonString(bootstrap.runtimeManifest)), "hex").copy(envelope, 128);
            Buffer.from(identity.publicKeySpkiSha256, "hex").copy(envelope, 160);
            Buffer.from(downloadVerificationReceiptSha256, "hex").copy(envelope, 192);
            Buffer.from(installedTreeAttestationSha256, "hex").copy(envelope, 224);
            Buffer.from(installedTreeVerificationReceiptSha256, "hex").copy(envelope, 256);
            const protectedStateSha256 = sha256("live-protected-state");
            const requestBody = Buffer.alloc(384);
            operationId.copy(requestBody, 0);
            Buffer.from(protectedStateSha256, "hex").copy(requestBody, 16);
            requestBody.writeUInt16LE(1, 48);
            requestBody.writeUInt8(2, 50);
            requestBody.writeBigUInt64LE(1n, 52);
            Buffer.from(keysetReceiptSha256, "hex").copy(requestBody, 60);
            requestBody.writeUInt32LE(288, 92);
            envelope.copy(requestBody, 96);
            const signature = sign(
              null,
              Buffer.concat([Buffer.from(`${REMOTE_WORKER_PROTECTED_ADMISSION_SIGNATURE_DOMAIN}\0`, "utf8"), envelope]),
              evidenceSigner.privateKey,
            );
            return Object.freeze({
              schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_EVIDENCE_WIRE_SCHEMA_VERSION,
              envelopeBase64Url: envelope.toString("base64url"),
              signerResult: Object.freeze({
                schemaVersion: REMOTE_WORKER_PROTECTED_ADMISSION_SIGNER_RESULT_SCHEMA_VERSION,
                disposition: "signed" as const,
                operationIdBase64Url: operationId.toString("base64url"),
                workerGeneration: 1,
                envelopeSha256: sha256(envelope),
                keysetReceiptSha256,
                signerSpkiSha256: protectedAdmissionSignerPin.signerSpkiSha256,
                signerSpkiBase64Url: protectedAdmissionSignerPin.signerSpkiBase64Url,
                signatureBase64Url: signature.toString("base64url"),
                protectedStateSha256,
                requestSha256: sha256(requestBody),
              }),
            });
          },
        });

        const first = await liveAdmissionRequest(portOf(listener.address), requestFixture, 0x31);
        const second = await liveAdmissionRequest(portOf(listener.address), requestFixture, 0x32);

        expect(first.status).toBe(201);
        expect(first.body).toMatchObject({
          disposition: "admitted",
          secretDisposition: "returned_once",
          credentialSecret: expect.any(String),
        });
        expect(second.status).toBe(200);
        expect(second.body.disposition).toBe("replayed_without_credential_secret");
        expect(second.body).not.toHaveProperty("credentialSecret");
        expect(second.body.generation).toEqual(first.body.generation);
        expect(second.body.credential).toEqual(first.body.credential);
        expect(second.tlsExporterSha256).not.toBe(first.tlsExporterSha256);
        expect(bootstrapLookups).toEqual([sha256(bootstrapSecret), sha256(bootstrapSecret)]);
        expect(serverExporters).toEqual([first.tlsExporterSha256, second.tlsExporterSha256]);
        expect(evidenceAttempts).toHaveLength(2);
        expect(evidenceAttempts[1]?.contextSha256).not.toBe(evidenceAttempts[0]?.contextSha256);
        expect(evidenceAttempts[1]?.tlsExporterSha256).not.toBe(evidenceAttempts[0]?.tlsExporterSha256);
        expect(evidenceAttempts[1]?.proofOfPossessionReceiptSha256).not.toBe(
          evidenceAttempts[0]?.proofOfPossessionReceiptSha256,
        );
        expect(finalizations).toHaveLength(2);
        expect(finalizations[1]?.nonce.nonceSha256).not.toBe(finalizations[0]?.nonce.nonceSha256);
        expect(finalizations[1]?.command.verifiedTransportReceiptSha256).not.toBe(
          finalizations[0]?.command.verifiedTransportReceiptSha256,
        );
        expect(finalizations[1]?.command.verifiedDownloadReceiptSha256).toBe(
          finalizations[0]?.command.verifiedDownloadReceiptSha256,
        );
        expect(finalizations[1]?.command.credentialIssuanceProofSha256).not.toBe(
          finalizations[0]?.command.credentialIssuanceProofSha256,
        );
        expect(finalizations[1]?.command.credentialTokenSha256).not.toBe(
          finalizations[0]?.command.credentialTokenSha256,
        );
        expect(stableAdmissionBindings(finalizations[1]?.command)).toEqual(
          stableAdmissionBindings(finalizations[0]?.command),
        );
        const authority = await new RemoteWorkerProtectedAdmissionAuthorityService(repository).resolveCurrent({
          registryWorkspaceId: "default",
          workerId: bootstrap.workerId,
          workerGeneration: 1,
        });
        expect(authority.evidence.envelopeBase64Url).toBe(
          finalizations[0]?.command.verifiedProtectedAdmissionEvidence?.envelopeBase64Url,
        );
        expect(authority.workerPublicKeySpkiDer.byteLength).toBe(44);
        const canonicalBootstrap = repository.getBootstrap("default", bootstrap.bootstrapId);
        const authorityStore = {
          findCurrentGeneration: () => authority.generation,
          findLatestGenerationControl: () => undefined,
          findProtectedAdmissionEvidenceRecord: () => authority.evidence,
          getBootstrap: () => canonicalBootstrap,
        };
        await expect(
          new RemoteWorkerProtectedAdmissionAuthorityService({
            ...authorityStore,
            findProtectedAdmissionEvidenceRecord: () => ({
              ...authority.evidence,
              workspaceCeilingSha256: sha256("tampered-persisted-context-field"),
            }),
          }).resolveCurrent({ registryWorkspaceId: "default", workerId: bootstrap.workerId, workerGeneration: 1 }),
        ).rejects.toThrow("Current protected remote worker admission authority is unavailable.");
        await expect(
          new RemoteWorkerProtectedAdmissionAuthorityService({
            ...authorityStore,
            findCurrentGeneration: () => ({ ...authority.generation, bootstrapId: "bootstrap-tampered" }),
          }).resolveCurrent({ registryWorkspaceId: "default", workerId: bootstrap.workerId, workerGeneration: 1 }),
        ).rejects.toThrow("Current protected remote worker admission authority is unavailable.");
        await expect(
          new RemoteWorkerProtectedAdmissionAuthorityService({
            ...authorityStore,
            getBootstrap: () => ({ ...canonicalBootstrap, nodeId: "node-tampered" }),
          }).resolveCurrent({ registryWorkspaceId: "default", workerId: bootstrap.workerId, workerGeneration: 1 }),
        ).rejects.toThrow("Current protected remote worker admission authority is unavailable.");
      } finally {
        database.close();
      }
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "enforces the exact POST/JSON envelope and fails handler errors with a bounded generic response",
    async () => {
      let failedBody: Buffer | undefined;
      let failedExporter: Buffer | undefined;
      const handler = async (requestValue: RemoteWorkerNativeHandlerRequest) => {
        if (requestValue.rawPath === "/remote-worker/throws") {
          failedBody = requestValue.bodyBytes;
          failedExporter = requestValue.transportIdentity.tlsExporter;
          throw new Error("operator-private handler detail");
        }
        if (requestValue.rawPath === "/remote-worker/invalid-response") {
          return {
            statusCode: 200,
            headers: { connection: "keep-alive" },
            body: "{}",
          };
        }
        if (requestValue.rawPath === "/remote-worker/oversized-response") {
          return {
            statusCode: 200,
            body: Buffer.alloc(listenerModule.REMOTE_WORKER_NATIVE_TLS_LIMITS.maxResponseBodyBytes + 1),
          };
        }
        return { statusCode: 200, body: "{}" };
      };
      const handle = await startRemoteWorkerNativeTlsListener(await config(), handler);
      openHandles.push(handle);
      const port = portOf(handle.address);

      await expect(request(port, { method: "GET" })).rejects.toThrow();
      await expect(request(port, { headers: { "Content-Length": "0" } })).rejects.toThrow();
      await expect(
        request(port, {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(listenerModule.REMOTE_WORKER_NATIVE_TLS_LIMITS.maxProtocolBodyBytes + 1),
          },
        }),
      ).rejects.toThrow();
      const chunked = await malformedTlsRequest(
        port,
        "POST /remote-worker/live HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
      );
      expect(chunked).toHaveLength(0);
      const incomplete = await malformedTlsRequest(
        port,
        "POST /remote-worker/live HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 3\r\n\r\n{}",
      );
      expect(incomplete).toHaveLength(0);

      const thrown = await request(port, { path: "/remote-worker/throws" });
      expect(thrown).toMatchObject({ status: 500, body: '{"error":"REMOTE_WORKER_REQUEST_FAILED"}\n' });
      expect(JSON.stringify(thrown)).not.toContain("operator-private handler detail");
      expect(failedBody?.every((value) => value === 0)).toBe(true);
      expect(failedExporter?.every((value) => value === 0)).toBe(true);
      const invalid = await request(port, { path: "/remote-worker/invalid-response" });
      expect(invalid).toMatchObject({ status: 500, body: '{"error":"REMOTE_WORKER_REQUEST_FAILED"}\n' });
      const oversized = await request(port, { path: "/remote-worker/oversized-response" });
      expect(oversized).toMatchObject({ status: 500, body: '{"error":"REMOTE_WORKER_REQUEST_FAILED"}\n' });
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "rejects query/header protocol forgery and destroys a stuck raw socket during bounded close",
    async () => {
      const handle = await startRemoteWorkerNativeTlsListener(await config());
      openHandles.push(handle);
      const port = portOf(handle.address);
      await expect(request(port, { path: "/remote-worker/unavailable?forged=1" })).rejects.toThrow();
      const malformedHeader = await malformedTlsRequest(
        port,
        "POST /remote-worker/unavailable HTTP/1.1\r\nHost: localhost\r\nBad Header: forged\r\n\r\n",
      );
      const malformedLine = await malformedTlsRequest(port, "G ET / HTTP/1.1\r\nHost: localhost\r\n\r\n");
      expect(malformedHeader).toHaveLength(0);
      expect(malformedLine).toHaveLength(0);
      const raw = netConnect({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        raw.once("connect", resolve);
        raw.once("error", reject);
      });
      raw.resume();
      const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
      await Promise.all([handle.close(), handle.close()]);
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("raw socket did not close")), 5_000),
        ),
      ]);
      expect(raw.destroyed).toBe(true);
      await expect(request(port)).rejects.toThrow();
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "enforces an absolute header deadline even while a mutually authenticated client trickles bytes",
    async () => {
      const handle = await startRemoteWorkerNativeTlsListener(await config());
      openHandles.push(handle);
      const result = await trickleIncompleteHeaders(portOf(handle.address));
      expect(result.response).toHaveLength(0);
      expect(result.elapsedMs).toBeLessThan(7_000);
    },
    90_000,
  );

  it.runIf(process.platform === "win32")(
    "keeps startup failures path- and PEM-free",
    async () => {
      const value = await config();
      const secretPath = join(cleanupRoots.at(-1) as string, "operator-private-missing-key.pem");
      const broken = { ...value, tls: { ...value.tls, serverKeyFile: secretPath } } as EnabledRemoteWorkerRuntimeConfig;
      let caught: unknown;
      try {
        await startRemoteWorkerNativeTlsListener(broken);
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain("listener is unavailable");
      expect(String(caught)).not.toContain(secretPath);
      expect(JSON.stringify(caught)).not.toContain("PRIVATE KEY");
    },
    60_000,
  );

  it("exports no socket, request-authority, constructor, or direct-derive surface", () => {
    expect(listenerModule).not.toHaveProperty("socketAdapters");
    expect(listenerModule).not.toHaveProperty("requestAuthorities");
    expect(listenerModule).not.toHaveProperty("createRequestAuthority");
    expect(listenerModule).not.toHaveProperty("deriveRemoteWorkerTransportIdentity");
  });
});
