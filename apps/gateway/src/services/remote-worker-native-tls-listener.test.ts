import { execFile } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import * as listenerModule from "./remote-worker-native-tls-listener.js";
import { startRemoteWorkerNativeTlsListener } from "./remote-worker-native-tls-listener.js";
import type { EnabledRemoteWorkerRuntimeConfig } from "./remote-worker-runtime-config.js";
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

async function request(
  port: number,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: string }> {
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
        headers: { "Content-Length": "0" },
        ...overrides,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
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
      const response = await request(port);
      expect(response).toEqual({ status: 503, body: '{"error":"REMOTE_WORKER_UNAVAILABLE"}\n' });
      expect(Object.getPrototypeOf(handle)).toBeNull();

      await expect(request(port, { cert: undefined, key: undefined })).rejects.toThrow();
      await expect(request(port, { minVersion: "TLSv1.2", maxVersion: "TLSv1.2" })).rejects.toThrow();
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
