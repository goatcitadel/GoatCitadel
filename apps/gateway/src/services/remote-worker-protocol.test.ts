import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  BoundedRemoteWorkerNonceConsumer,
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_HEADERS,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  verifyRemoteWorkerProofOfPossession,
  type RemoteWorkerProtocolBody,
  type RemoteWorkerResolvedAuthority,
} from "./remote-worker-protocol.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

const NOW = new Date("2026-07-14T20:00:00.000Z");
const PATH = "/api/v1/remote-workers/admission/exchange";
const OPERATION = "admission.exchange";
const CREDENTIAL = "bootstrap_secret_token_1234567890";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SignedFixture {
  body: RemoteWorkerProtocolBody;
  headers: Record<string, string>;
  authority: RemoteWorkerResolvedAuthority;
  transportIdentity: RemoteWorkerTransportIdentity;
  nonceConsumer: ReturnType<typeof vi.fn>;
}

function signedFixture(): SignedFixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeySpkiSha256 = sha256(publicKeySpkiDer);
  const tlsExporter = Buffer.alloc(32, 0x42);
  const transportIdentity: RemoteWorkerTransportIdentity = {
    source: "native_mtls",
    certificateDerSha256: "c".repeat(64),
    publicKeySpkiSha256,
    trustAnchorDerSha256: "a".repeat(64),
    tlsExporterSha256: sha256(tlsExporter),
    tlsExporter,
  };
  const authority: RemoteWorkerResolvedAuthority = {
    kind: "bootstrap",
    authorityId: "bootstrap-1",
    authorityGeneration: 1,
    authorizationCredentialSha256: sha256(CREDENTIAL),
    publicKeySpkiDer,
    publicKeySpkiSha256,
  };
  const body: RemoteWorkerProtocolBody = {
    schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
    operation: OPERATION,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    idempotencyKey: "exchange-1",
    payload: {
      architecture: "x64",
      platform: "windows",
      installedTreeAttestation: {
        schemaVersion: "goatcitadel.remote-worker-installed-tree-attestation.v1",
        files: [{ path: "bundle/worker.js", sha256: "d".repeat(64) }],
        treeSha256: "e".repeat(64),
      },
    },
  };
  const timestamp = NOW.toISOString();
  const nonce = Buffer.alloc(32, 0x19).toString("base64url");
  const material = buildRemoteWorkerPopMaterial({
    rawPath: PATH,
    bodySha256: remoteWorkerProtocolBodySha256(body),
    operation: OPERATION,
    nonce,
    timestamp,
    idempotencyKey: body.idempotencyKey,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    transportIdentity,
  });
  const proof = sign(null, Buffer.from(canonicalJsonString(material), "utf8"), privateKey).toString("base64url");
  return {
    body,
    authority,
    transportIdentity,
    nonceConsumer: vi.fn(() => true),
    headers: {
      [REMOTE_WORKER_PROTOCOL_HEADERS.authorization]: `GoatWorkerBootstrap ${CREDENTIAL}`,
      [REMOTE_WORKER_PROTOCOL_HEADERS.timestamp]: timestamp,
      [REMOTE_WORKER_PROTOCOL_HEADERS.nonce]: nonce,
      [REMOTE_WORKER_PROTOCOL_HEADERS.operation]: OPERATION,
      [REMOTE_WORKER_PROTOCOL_HEADERS.proof]: proof,
      [REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey]: body.idempotencyKey,
    },
  };
}

function verifyFixture(fixture: SignedFixture) {
  return verifyRemoteWorkerProofOfPossession({
    method: "POST",
    rawPath: PATH,
    headers: fixture.headers,
    body: fixture.body,
    expectedOperation: OPERATION,
    authority: fixture.authority,
    transportIdentity: fixture.transportIdentity,
    nonceConsumer: { consume: fixture.nonceConsumer },
    now: NOW,
  });
}

describe("remote worker proof-of-possession protocol", () => {
  it("accepts an exact canonical request bound to its key, certificate, TLS exporter, and nonce", async () => {
    const fixture = signedFixture();
    const receipt = await verifyFixture(fixture);
    expect(receipt).toMatchObject({
      schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
      authorityId: "bootstrap-1",
      authorityGeneration: 1,
      operation: OPERATION,
      timestamp: NOW.toISOString(),
      bodySha256: remoteWorkerProtocolBodySha256(fixture.body),
      publicKeySpkiSha256: fixture.authority.publicKeySpkiSha256,
      certificateDerSha256: fixture.transportIdentity.certificateDerSha256,
      tlsExporterSha256: fixture.transportIdentity.tlsExporterSha256,
    });
    expect(receipt.proofOfPossessionReceiptSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fixture.nonceConsumer).toHaveBeenCalledWith({
      authorityId: "bootstrap-1",
      authorityGeneration: 1,
      nonce: fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.nonce],
      timestamp: NOW.toISOString(),
      expiresAt: "2026-07-14T20:01:00.000Z",
    });
    expect(JSON.stringify(receipt)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(receipt)).not.toContain(fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.proof] as string);
  });

  it("accepts the exact Bearer scheme only for a resolved runtime credential authority", async () => {
    const fixture = signedFixture();
    fixture.authority = { ...fixture.authority, kind: "credential" };
    fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.authorization] = `Bearer ${CREDENTIAL}`;
    await expect(verifyFixture(fixture)).resolves.toMatchObject({ authorityId: "bootstrap-1" });
  });

  it("freezes authority and transport identity before awaited nonce consumption", async () => {
    const fixture = signedFixture();
    const authority = fixture.authority as {
      kind: RemoteWorkerResolvedAuthority["kind"];
      authorityId: string;
      authorityGeneration: number;
    };
    const transport = fixture.transportIdentity as {
      certificateDerSha256: string;
      tlsExporterSha256: string;
      tlsExporter: Buffer;
    };
    fixture.nonceConsumer = vi.fn(async () => {
      authority.kind = "credential";
      authority.authorityId = "credential-forged-after-proof";
      authority.authorityGeneration = 99;
      transport.certificateDerSha256 = "f".repeat(64);
      transport.tlsExporter.fill(0xff);
      transport.tlsExporterSha256 = sha256(transport.tlsExporter);
      return true;
    });

    await expect(verifyFixture(fixture)).resolves.toMatchObject({
      authorityId: "bootstrap-1",
      authorityGeneration: 1,
      certificateDerSha256: "c".repeat(64),
      tlsExporterSha256: sha256(Buffer.alloc(32, 0x42)),
    });
    expect(fixture.nonceConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ authorityId: "bootstrap-1", authorityGeneration: 1 }),
    );
  });

  it("rejects accessor-backed authority and transport records without invoking getters", async () => {
    for (const target of ["authority", "transport"] as const) {
      const fixture = signedFixture();
      let reads = 0;
      if (target === "authority") {
        const originalAuthorityId = fixture.authority.authorityId;
        const authority = { ...fixture.authority };
        Object.defineProperty(authority, "authorityId", {
          enumerable: true,
          configurable: true,
          get: () => {
            reads += 1;
            return originalAuthorityId;
          },
        });
        fixture.authority = authority;
      } else {
        const originalCertificateDerSha256 = fixture.transportIdentity.certificateDerSha256;
        const transportIdentity = { ...fixture.transportIdentity };
        Object.defineProperty(transportIdentity, "certificateDerSha256", {
          enumerable: true,
          configurable: true,
          get: () => {
            reads += 1;
            return originalCertificateDerSha256;
          },
        });
        fixture.transportIdentity = transportIdentity;
      }

      await expect(verifyFixture(fixture)).rejects.toThrow("plain data fields");
      expect(reads).toBe(0);
      expect(fixture.nonceConsumer).not.toHaveBeenCalled();
    }
  });

  it("rejects a TLS-exporter mismatch without consuming the nonce", async () => {
    const fixture = signedFixture();
    const changedExporter = Buffer.alloc(32, 0x43);
    fixture.transportIdentity = {
      ...fixture.transportIdentity,
      tlsExporter: changedExporter,
      tlsExporterSha256: sha256(changedExporter),
    };
    await expect(verifyFixture(fixture)).rejects.toThrow("proof of possession is invalid");
    expect(fixture.nonceConsumer).not.toHaveBeenCalled();
  });

  it("rejects the wrong signing key or a certificate/SPKI mismatch", async () => {
    const fixture = signedFixture();
    const wrongKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
    fixture.authority = {
      ...fixture.authority,
      publicKeySpkiDer: wrongKey,
      publicKeySpkiSha256: sha256(wrongKey),
    };
    fixture.transportIdentity = {
      ...fixture.transportIdentity,
      publicKeySpkiSha256: fixture.authority.publicKeySpkiSha256,
    };
    await expect(verifyFixture(fixture)).rejects.toThrow("proof of possession is invalid");
    const keyMismatch = signedFixture();
    keyMismatch.transportIdentity = { ...keyMismatch.transportIdentity, publicKeySpkiSha256: "f".repeat(64) };
    await expect(verifyFixture(keyMismatch)).rejects.toThrow("transport key does not match");
  });

  it("rejects changed body bytes and body/header/authority disagreement", async () => {
    const changedBody = signedFixture();
    changedBody.body = { ...changedBody.body, payload: { architecture: "arm64", platform: "linux" } };
    await expect(verifyFixture(changedBody)).rejects.toThrow("proof of possession is invalid");

    for (const mutate of [
      (fixture: SignedFixture) => (fixture.body = { ...fixture.body, operation: "credential.rotate" }),
      (fixture: SignedFixture) => (fixture.body = { ...fixture.body, idempotencyKey: "different" }),
      (fixture: SignedFixture) => (fixture.body = { ...fixture.body, authorityId: "bootstrap-2" }),
      (fixture: SignedFixture) => (fixture.body = { ...fixture.body, authorityGeneration: 2 }),
      (fixture: SignedFixture) => (fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.operation] = "credential.rotate"),
      (fixture: SignedFixture) => (fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey] = "different"),
    ]) {
      const fixture = signedFixture();
      mutate(fixture);
      await expect(verifyFixture(fixture)).rejects.toThrow("disagrees with its authenticated headers or authority");
    }
  });

  it("binds every nested installed-tree attestation byte into the canonical body proof", async () => {
    const fixture = signedFixture();
    const payload = structuredClone(fixture.body.payload) as {
      installedTreeAttestation: { files: { path: string; sha256: string }[] };
    };
    payload.installedTreeAttestation.files[0]!.sha256 = "f".repeat(64);
    fixture.body = { ...fixture.body, payload };
    await expect(verifyFixture(fixture)).rejects.toThrow("proof of possession is invalid");
    expect(fixture.nonceConsumer).not.toHaveBeenCalled();
  });

  it("rejects stale, future, or non-canonical timestamps before nonce consumption", async () => {
    for (const timestamp of [
      "2026-07-14T19:58:59.999Z",
      "2026-07-14T20:01:00.001Z",
      "2026-07-14T20:00:00Z",
      "2026-07-14T13:00:00.000-07:00",
    ]) {
      const fixture = signedFixture();
      fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.timestamp] = timestamp;
      await expect(verifyFixture(fixture)).rejects.toThrow(/timestamp/u);
      expect(fixture.nonceConsumer).not.toHaveBeenCalled();
    }
  });

  it("rejects malformed and replayed nonces, and consumes only after signature verification", async () => {
    const malformed = signedFixture();
    malformed.headers[REMOTE_WORKER_PROTOCOL_HEADERS.nonce] = "not-a-32-byte-nonce";
    await expect(verifyFixture(malformed)).rejects.toThrow("nonce encoding is invalid");
    expect(malformed.nonceConsumer).not.toHaveBeenCalled();

    const replay = signedFixture();
    replay.nonceConsumer = vi.fn(() => false);
    await expect(verifyFixture(replay)).rejects.toThrow("nonce was already consumed");
    expect(replay.nonceConsumer).toHaveBeenCalledOnce();

    const unavailable = signedFixture();
    unavailable.nonceConsumer = vi.fn(() => {
      throw new Error("database secret detail");
    });
    await expect(verifyFixture(unavailable)).rejects.toThrow("replay protection is unavailable");
  });

  it("provides a bounded, expiry-aware, hash-only replay cache that fails closed at capacity", () => {
    let now = NOW;
    const cache = new BoundedRemoteWorkerNonceConsumer({ maximumEntries: 1, clock: () => now });
    const first = {
      authorityId: "bootstrap-1",
      authorityGeneration: 1,
      nonce: Buffer.alloc(32, 1).toString("base64url"),
      timestamp: NOW.toISOString(),
      expiresAt: "2026-07-14T20:01:00.000Z",
    };
    expect(cache.consume(first)).toBe(true);
    expect(cache.consume(first)).toBe(false);
    expect(cache.consume({ ...first, nonce: Buffer.alloc(32, 2).toString("base64url") })).toBe(false);
    expect(cache.size).toBe(1);
    now = new Date("2026-07-14T20:01:00.000Z");
    expect(
      cache.consume({
        ...first,
        nonce: Buffer.alloc(32, 2).toString("base64url"),
        timestamp: now.toISOString(),
        expiresAt: "2026-07-14T20:02:00.000Z",
      }),
    ).toBe(true);
    expect(cache.size).toBe(1);
  });

  it("rejects wrong authorization purpose, raw credential, and duplicate protocol headers", async () => {
    const wrongScheme = signedFixture();
    wrongScheme.headers[REMOTE_WORKER_PROTOCOL_HEADERS.authorization] = `Bearer ${CREDENTIAL}`;
    await expect(verifyFixture(wrongScheme)).rejects.toThrow("authorization purpose is invalid");

    const wrongCredential = signedFixture();
    wrongCredential.headers[REMOTE_WORKER_PROTOCOL_HEADERS.authorization] =
      "GoatWorkerBootstrap wrong_credential_material_123";
    await expect(verifyFixture(wrongCredential)).rejects.toThrow("authorization credential is invalid");

    const duplicate = signedFixture();
    duplicate.headers.Authorization = duplicate.headers.authorization as string;
    await expect(verifyFixture(duplicate)).rejects.toThrow("missing or duplicated");
  });

  it("rejects missing/unknown body fields, non-JSON payloads, oversized bodies, and query paths", async () => {
    const unknown = signedFixture();
    unknown.body = { ...unknown.body, unexpected: true } as RemoteWorkerProtocolBody;
    await expect(verifyFixture(unknown)).rejects.toThrow("missing or unknown fields");

    const missing = signedFixture();
    const { payload: _payload, ...withoutPayload } = missing.body;
    missing.body = withoutPayload as RemoteWorkerProtocolBody;
    await expect(verifyFixture(missing)).rejects.toThrow("missing or unknown fields");

    const nonJson = signedFixture();
    nonJson.body = { ...nonJson.body, payload: { value: undefined } } as unknown as RemoteWorkerProtocolBody;
    await expect(verifyFixture(nonJson)).rejects.toThrow("non-JSON value");

    const oversized = signedFixture();
    oversized.body = { ...oversized.body, payload: { value: "x".repeat(512 * 1024) } };
    await expect(verifyFixture(oversized)).rejects.toThrow("exceeds its byte limit");

    await expect(
      verifyRemoteWorkerProofOfPossession({
        method: "POST",
        rawPath: `${PATH}?debug=true`,
        headers: signedFixture().headers,
        body: signedFixture().body,
        expectedOperation: OPERATION,
        authority: signedFixture().authority,
        transportIdentity: signedFixture().transportIdentity,
        nonceConsumer: { consume: () => true },
        now: NOW,
      }),
    ).rejects.toThrow("path is invalid");
  });

  it("never includes authorization, proof, or replay backend secrets in errors", async () => {
    const fixture = signedFixture();
    const rawProof = fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.proof] as string;
    fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.authorization] =
      `GoatWorkerBootstrap ${"private-material".repeat(8)}`;
    let caught: unknown;
    try {
      await verifyFixture(fixture);
    } catch (error) {
      caught = error;
    }
    const rendered = `${String(caught)} ${JSON.stringify(caught)}`;
    expect(rendered).not.toContain("private-material");
    expect(rendered).not.toContain(rawProof);
    expect(rendered.length).toBeLessThan(512);
  });
});
