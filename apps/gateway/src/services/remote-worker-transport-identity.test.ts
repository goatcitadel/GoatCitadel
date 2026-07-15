import { createHash, X509Certificate } from "node:crypto";
import { TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import * as transportIdentityModule from "./remote-worker-transport-identity.js";
import {
  REMOTE_WORKER_TLS_EXPORTER_BYTES,
  REMOTE_WORKER_TLS_EXPORTER_LABEL,
  deriveRemoteWorkerTransportIdentityFromPort,
  inspectRemoteWorkerTransportRequest,
  remoteWorkerTransportIdentityDiagnostics,
  type RemoteWorkerTlsSocketPort,
  type RemoteWorkerTransportRequestMetadata,
} from "./remote-worker-transport-identity.js";

const LEAF_DER = Buffer.from(
  "MIIBYTCCAROgAwIBAgIUFCM3XIm3+fE1RB9OeUHBR66ZlcUwBQYDK2VwMCYxJDAiBgNVBAMMG0dvYXRDaXRhZGVsIEhYNTAxIFRlc3QgTGVhZjAeFw0yNjA3MTUwNjAzMjBaFw0zNjA3MTIwNjAzMjBaMCYxJDAiBgNVBAMMG0dvYXRDaXRhZGVsIEhYNTAxIFRlc3QgTGVhZjAqMAUGAytlcAMhAEIL7a9iJ6Kh6ReckFsuinmvRlVTh2WWWht7RAS//yk2o1MwUTAdBgNVHQ4EFgQUCaqgoL+XjmLjt7Hu/QOSLkAtcrMwHwYDVR0jBBgwFoAUCaqgoL+XjmLjt7Hu/QOSLkAtcrMwDwYDVR0TAQH/BAUwAwEB/zAFBgMrZXADQQCr8iuS6p1loHxUuSHNP5U37skb9b8nsnNnTGce9F6V67msaMqSmQct5tz9j62EgIDvTcI2yOyAUzvgqve/7uUP",
  "base64",
);
const CA_DER = Buffer.from(
  "MIIBXTCCAQ+gAwIBAgIUBZS8x3nIR0VRa8xx1E+r7vob23QwBQYDK2VwMCQxIjAgBgNVBAMMGUdvYXRDaXRhZGVsIEhYNTAxIFRlc3QgQ0EwHhcNMjYwNzE1MDYwMzIwWhcNMzYwNzEyMDYwMzIwWjAkMSIwIAYDVQQDDBlHb2F0Q2l0YWRlbCBIWDUwMSBUZXN0IENBMCowBQYDK2VwAyEAnzHq0VMloLfUoSg+V4hCY1npPsCaDwF0OIadSQeD9nujUzBRMB0GA1UdDgQWBBR9INon1Del8lK+2hVw24Mlk/WGLTAfBgNVHSMEGDAWgBR9INon1Del8lK+2hVw24Mlk/WGLTAPBgNVHRMBAf8EBTADAQH/MAUGAytlcANBAITTb+DEYQHWuCFjlOxqgQKDdsaMaA4bC/RpP7oJHMGSbSRioyXeFdU4NdgKKVQQi90GmB3O7LvNRnoQ1AvZhAI=",
  "base64",
);
const EXPORTER = Buffer.alloc(REMOTE_WORKER_TLS_EXPORTER_BYTES, 0x5a);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requestWith(entries: readonly (readonly [string, string])[]): RemoteWorkerTransportRequestMetadata {
  const headers: Record<string, string> = {};
  const rawHeaders: string[] = [];
  for (const [name, value] of entries) {
    headers[name.toLowerCase()] = value;
    rawHeaders.push(name, value);
  }
  return { rawPath: "/api/v1/remote-workers/exchange", headers, rawHeaders };
}

function validRequest(): RemoteWorkerTransportRequestMetadata {
  return requestWith([
    ["Host", "worker.local:9443"],
    ["Content-Type", "application/json"],
    ["Content-Length", "123"],
    ["Authorization", `GoatWorkerBootstrap ${"a".repeat(32)}`],
    ["Idempotency-Key", "exchange-1"],
    ["X-GoatCitadel-Worker-Timestamp", "2026-07-15T06:03:20.000Z"],
    ["X-GoatCitadel-Worker-Nonce", Buffer.alloc(32, 1).toString("base64url")],
    ["X-GoatCitadel-Worker-Operation", "admission.exchange"],
    ["X-GoatCitadel-Worker-Proof", Buffer.alloc(64, 2).toString("base64url")],
  ]);
}

function validSocket(overrides: Partial<RemoteWorkerTlsSocketPort> = {}): RemoteWorkerTlsSocketPort {
  return {
    encrypted: true,
    authorized: true,
    peerCertificateChainDer: () => [LEAF_DER, CA_DER],
    exportKeyingMaterial: (length, label, context) => {
      expect(length).toBe(REMOTE_WORKER_TLS_EXPORTER_BYTES);
      expect(label).toBe(REMOTE_WORKER_TLS_EXPORTER_LABEL);
      expect(context).toEqual(Buffer.alloc(0));
      return Buffer.from(EXPORTER);
    },
    ...overrides,
  };
}

describe("remote worker transport identity", () => {
  it("does not expose prototype-based TLSSocket identity as production transport authority", () => {
    const forged = Object.create(TLSSocket.prototype) as TLSSocket;
    Object.assign(forged, {
      encrypted: true,
      authorized: true,
      getPeerCertificate: () => ({ raw: LEAF_DER, issuerCertificate: { raw: CA_DER } }),
      exportKeyingMaterial: () => Buffer.from(EXPORTER),
    });
    expect(forged).toBeInstanceOf(TLSSocket);
    expect(transportIdentityModule).not.toHaveProperty("deriveRemoteWorkerTransportIdentity");
  });

  it("derives certificate, SPKI, trust-anchor, and exporter hashes only after native mTLS authorization", () => {
    const identity = deriveRemoteWorkerTransportIdentityFromPort({
      socket: validSocket(),
      request: validRequest(),
      expectedClientCaSha256: sha256(CA_DER),
    });
    const expectedSpki = new X509Certificate(LEAF_DER).publicKey.export({ format: "der", type: "spki" });
    expect(identity).toMatchObject({
      source: "native_mtls",
      certificateDerSha256: sha256(LEAF_DER),
      publicKeySpkiSha256: sha256(expectedSpki as Buffer),
      trustAnchorDerSha256: sha256(CA_DER),
      tlsExporterSha256: sha256(EXPORTER),
    });
    expect(identity.tlsExporter).toEqual(EXPORTER);
    const diagnostics = remoteWorkerTransportIdentityDiagnostics(identity);
    expect(diagnostics).not.toHaveProperty("tlsExporter");
    expect(JSON.stringify(diagnostics)).not.toContain(EXPORTER.toString("base64url"));
  });

  it.each([{ encrypted: false }, { authorized: false }, { authorizationError: "self signed certificate" }])(
    "rejects unauthorized or unencrypted socket state %#",
    (patch) => {
      expect(() =>
        deriveRemoteWorkerTransportIdentityFromPort({
          socket: validSocket(patch),
          request: validRequest(),
          expectedClientCaSha256: sha256(CA_DER),
        }),
      ).toThrow("mutual TLS authorization failed");
    },
  );

  it("rejects a wrong CA pin, an incomplete/cyclic chain, and malformed exporter bytes", () => {
    const base = { request: validRequest(), expectedClientCaSha256: sha256(CA_DER) };
    expect(() =>
      deriveRemoteWorkerTransportIdentityFromPort({
        ...base,
        socket: validSocket(),
        expectedClientCaSha256: "f".repeat(64),
      }),
    ).toThrow("CA pin did not match");
    expect(() =>
      deriveRemoteWorkerTransportIdentityFromPort({
        ...base,
        socket: validSocket({ peerCertificateChainDer: () => [LEAF_DER] }),
      }),
    ).toThrow("chain is incomplete");
    expect(() =>
      deriveRemoteWorkerTransportIdentityFromPort({
        ...base,
        socket: validSocket({ peerCertificateChainDer: () => [LEAF_DER, CA_DER, LEAF_DER] }),
      }),
    ).toThrow("contains a cycle");
    expect(() =>
      deriveRemoteWorkerTransportIdentityFromPort({
        ...base,
        socket: validSocket({ exportKeyingMaterial: () => Buffer.alloc(31) }),
      }),
    ).toThrow("channel binding is invalid");
  });

  it.each([
    ["Forwarded", "for=192.0.2.1"],
    ["X-Forwarded-For", "192.0.2.1"],
    ["X-Forwarded-Client-Cert", "By=proxy;Hash=forged"],
    ["X-SSL-Client-Cert", "forged"],
    ["SSL-Client-Cert", "forged"],
    ["Cookie", "worker=forged"],
    ["Origin", "https://forged.example"],
    ["Referer", "https://forged.example"],
    ["X-Unknown-Transport", "forged"],
  ])("rejects the forged or unknown transport header %s", (name, value) => {
    const request = validRequest();
    expect(() =>
      inspectRemoteWorkerTransportRequest(requestWith([...pairRawHeaders(request.rawHeaders), [name, value]])),
    ).toThrow("forbidden transport header");
  });

  it("rejects query strings, duplicate authorization, and inconsistent header projections", () => {
    expect(() => inspectRemoteWorkerTransportRequest({ ...validRequest(), rawPath: "/exchange?worker=1" })).toThrow(
      "path is invalid",
    );
    const request = validRequest();
    const duplicateRaw = [...request.rawHeaders, "Authorization", `Bearer ${"b".repeat(32)}`];
    expect(() => inspectRemoteWorkerTransportRequest({ ...request, rawHeaders: duplicateRaw })).toThrow(
      "duplicate transport header",
    );
    expect(() =>
      inspectRemoteWorkerTransportRequest({
        ...request,
        headers: { ...request.headers, authorization: ["one", "two"] },
      }),
    ).toThrow("duplicate or invalid transport header");
  });

  it("keeps raw authorization and forged certificate material out of errors", () => {
    const rawSecret = `GoatWorkerBootstrap ${"secret-token-material".repeat(4)}`;
    let caught: unknown;
    try {
      inspectRemoteWorkerTransportRequest(
        requestWith([
          ["Authorization", rawSecret],
          ["X-Forwarded-Client-Cert", "operator-private-certificate-bytes"],
        ]),
      );
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain(rawSecret);
    expect(String(caught)).not.toContain("operator-private-certificate-bytes");
    expect(JSON.stringify(caught)).not.toContain(rawSecret);
  });
});

function pairRawHeaders(rawHeaders: readonly string[]): [string, string][] {
  const result: [string, string][] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    result.push([rawHeaders[index] as string, rawHeaders[index + 1] as string]);
  }
  return result;
}
