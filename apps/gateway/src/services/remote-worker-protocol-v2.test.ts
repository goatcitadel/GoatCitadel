import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  REMOTE_WORKER_POP_V2_ROUTE_BINDINGS,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  buildRemoteWorkerPopV2Preimage,
  canonicalJsonString,
} from "@goatcitadel/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  REMOTE_WORKER_POP_SCHEMA_VERSION,
  REMOTE_WORKER_PROTOCOL_HEADERS,
  buildRemoteWorkerPopMaterial,
  remoteWorkerProtocolBodySha256,
  verifyRemoteWorkerProofOfPossession,
  type RemoteWorkerProtocolBody,
  type RemoteWorkerProtocolBodyV1,
  type RemoteWorkerProtocolBodyV2,
  type RemoteWorkerResolvedAuthority,
} from "./remote-worker-protocol.js";
import {
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
  REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
} from "./remote-worker-admission-service.js";
import { REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES } from "./remote-worker-assignment-protocol-service.js";
import { REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES } from "./remote-worker-assignment-dispatch-service.js";
import {
  REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
  REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
} from "./remote-worker-mesh-node-admission-service.js";
import type { RemoteWorkerTransportIdentity } from "./remote-worker-transport-identity.js";

const NOW = new Date("2026-08-09T07:00:00.123Z");
const CREDENTIAL = "runtime_credential_secret_1234567890";
const SYNC_PATH = "/api/v1/remote-workers/assignment-syncs";
const SYNC_OPERATION = "assignment.sync";

interface SignedV2Fixture {
  rawPath: string;
  expectedOperation: string;
  body: RemoteWorkerProtocolBodyV2;
  headers: Record<string, string>;
  authority: RemoteWorkerResolvedAuthority;
  transportIdentity: RemoteWorkerTransportIdentity;
  nonceConsumer: ReturnType<typeof vi.fn>;
}

function signedV2Fixture(): SignedV2Fixture {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeySpkiSha256 = sha256(publicKeySpkiDer);
  const tlsExporter = Buffer.alloc(32, 0x42);
  const authority: RemoteWorkerResolvedAuthority = {
    kind: "credential",
    authorityId: "credential-7",
    authorityGeneration: 7,
    workerGeneration: 3,
    authorizationCredentialSha256: sha256(CREDENTIAL),
    publicKeySpkiDer,
    publicKeySpkiSha256,
  };
  const transportIdentity: RemoteWorkerTransportIdentity = {
    source: "native_mtls",
    certificateDerSha256: "44".repeat(32),
    publicKeySpkiSha256,
    trustAnchorDerSha256: "aa".repeat(32),
    tlsExporterSha256: sha256(tlsExporter),
    tlsExporter,
  };
  const body: RemoteWorkerProtocolBodyV2 = {
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    operation: SYNC_OPERATION,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    workerGeneration: authority.workerGeneration as number,
    idempotencyKey: "assignment-sync:fixture-1",
    payload: { assignmentId: "assignment-1", generation: 1 },
  };
  const timestamp = NOW.toISOString();
  const nonce = Buffer.alloc(32, 0x19).toString("base64url");
  const preimage = buildRemoteWorkerPopV2Preimage({
    schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
    method: "POST",
    rawPath: SYNC_PATH,
    operation: SYNC_OPERATION,
    bodySha256: remoteWorkerProtocolBodySha256(body),
    nonce,
    timestamp,
    idempotencyKey: body.idempotencyKey,
    authorityKind: authority.kind,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    workerGeneration: authority.workerGeneration,
    tlsExporterSha256: transportIdentity.tlsExporterSha256,
    clientCertificateSha256: transportIdentity.certificateDerSha256,
    workerPublicKeySpkiSha256: authority.publicKeySpkiSha256,
  });
  const proof = sign(null, preimage, privateKey).toString("base64url");
  return {
    rawPath: SYNC_PATH,
    expectedOperation: SYNC_OPERATION,
    body,
    authority,
    transportIdentity,
    nonceConsumer: vi.fn(() => true),
    headers: {
      [REMOTE_WORKER_PROTOCOL_HEADERS.authorization]: `Bearer ${CREDENTIAL}`,
      [REMOTE_WORKER_PROTOCOL_HEADERS.timestamp]: timestamp,
      [REMOTE_WORKER_PROTOCOL_HEADERS.nonce]: nonce,
      [REMOTE_WORKER_PROTOCOL_HEADERS.operation]: SYNC_OPERATION,
      [REMOTE_WORKER_PROTOCOL_HEADERS.proof]: proof,
      [REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey]: body.idempotencyKey,
    },
  };
}

function verifyV2Fixture(fixture: SignedV2Fixture) {
  return verifyRemoteWorkerProofOfPossession({
    method: "POST",
    rawPath: fixture.rawPath,
    headers: fixture.headers,
    body: fixture.body,
    expectedOperation: fixture.expectedOperation,
    authority: fixture.authority,
    proofRequirement: "protected_v2_required",
    transportIdentity: fixture.transportIdentity,
    nonceConsumer: { consume: fixture.nonceConsumer },
    now: NOW,
  });
}

describe("remote worker protected proof v2 verification", () => {
  it("keeps all twelve contract route codes pinned while dispatch and execution routes remain dark", () => {
    expect(REMOTE_WORKER_POP_V2_ROUTE_BINDINGS).toStrictEqual([
      {
        code: 1,
        method: "POST",
        rawPath: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_RAW_PATH,
        operation: REMOTE_WORKER_BOOTSTRAP_EXCHANGE_OPERATION,
        authorityKind: "bootstrap",
      },
      ...Object.values(REMOTE_WORKER_ASSIGNMENT_RPC_ROUTES).map((route, index) => ({
        code: index + 2,
        method: "POST",
        rawPath: route.rawPath,
        operation: route.operation,
        authorityKind: "credential",
      })),
      {
        code: 7,
        method: "POST",
        rawPath: REMOTE_WORKER_MESH_NODE_ADMISSION_RAW_PATH,
        operation: REMOTE_WORKER_MESH_NODE_ADMISSION_OPERATION,
        authorityKind: "credential",
      },
      ...Object.values(REMOTE_WORKER_ASSIGNMENT_DISPATCH_ROUTES).map((route, index) => ({
        code: index + 8,
        method: "POST",
        rawPath: route.rawPath,
        operation: route.operation,
        authorityKind: "credential",
      })),
      {
        code: 11,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-inference-exchanges",
        operation: "assignment.inference.exchange",
        authorityKind: "credential",
      },
      {
        code: 12,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-settlement-submissions",
        operation: "assignment.settlement.submit",
        authorityKind: "credential",
      },
    ]);
  });

  it("verifies the fixed binary proof and retains the protected worker generation", async () => {
    const fixture = signedV2Fixture();
    await expect(verifyV2Fixture(fixture)).resolves.toMatchObject({
      schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
      authorityId: "credential-7",
      authorityGeneration: 7,
      workerGeneration: 3,
      operation: SYNC_OPERATION,
      timestamp: NOW.toISOString(),
    });
    expect(fixture.nonceConsumer).toHaveBeenCalledOnce();
  });

  it("rejects a valid v1 proof when protected authority requires v2, without consuming the nonce", async () => {
    const fixture = signedV1Fixture();
    await expect(
      verifyRemoteWorkerProofOfPossession({
        method: "POST",
        rawPath: SYNC_PATH,
        headers: fixture.headers,
        body: fixture.body,
        expectedOperation: SYNC_OPERATION,
        authority: fixture.authority,
        proofRequirement: "protected_v2_required",
        transportIdentity: fixture.transportIdentity,
        nonceConsumer: { consume: fixture.nonceConsumer },
        now: NOW,
      }),
    ).rejects.toThrow("requires proof protocol v2");
    expect(fixture.nonceConsumer).not.toHaveBeenCalled();
  });

  it("does not claim that a legacy v1 receipt bound the optional worker generation", async () => {
    const fixture = signedV1Fixture();
    const receipt = await verifyRemoteWorkerProofOfPossession({
      method: "POST",
      rawPath: SYNC_PATH,
      headers: fixture.headers,
      body: fixture.body,
      expectedOperation: SYNC_OPERATION,
      authority: fixture.authority,
      transportIdentity: fixture.transportIdentity,
      nonceConsumer: { consume: fixture.nonceConsumer },
      now: NOW,
    });
    expect(receipt.schemaVersion).toBe(REMOTE_WORKER_POP_SCHEMA_VERSION);
    expect(receipt).not.toHaveProperty("workerGeneration");
  });

  it("rejects a cross-route and cross-operation replay", async () => {
    const fixture = signedV2Fixture();
    fixture.rawPath = "/api/v1/remote-workers/assignment-lease-renewals";
    fixture.expectedOperation = "assignment.lease.renew";
    fixture.body = { ...fixture.body, operation: "assignment.lease.renew" };
    fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.operation] = "assignment.lease.renew";
    await expect(verifyV2Fixture(fixture)).rejects.toThrow("proof of possession is invalid");
    expect(fixture.nonceConsumer).not.toHaveBeenCalled();
  });

  it("rejects changes to every protected request and transport binding before nonce consumption", async () => {
    const mutations: Array<(fixture: SignedV2Fixture) => void> = [
      (fixture) => {
        fixture.body = { ...fixture.body, payload: { assignmentId: "assignment-2", generation: 1 } };
      },
      (fixture) => {
        fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.nonce] = Buffer.alloc(32, 0x1a).toString("base64url");
      },
      (fixture) => {
        const exporter = Buffer.alloc(32, 0x43);
        fixture.transportIdentity = {
          ...fixture.transportIdentity,
          tlsExporter: exporter,
          tlsExporterSha256: sha256(exporter),
        };
      },
      (fixture) => {
        fixture.transportIdentity = { ...fixture.transportIdentity, certificateDerSha256: "45".repeat(32) };
      },
      (fixture) => {
        const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
        const publicKeySha256 = sha256(publicKey);
        fixture.authority = {
          ...fixture.authority,
          publicKeySpkiDer: publicKey,
          publicKeySpkiSha256: publicKeySha256,
        };
        fixture.transportIdentity = { ...fixture.transportIdentity, publicKeySpkiSha256: publicKeySha256 };
      },
      (fixture) => {
        fixture.authority = { ...fixture.authority, workerGeneration: 4 };
        fixture.body = { ...fixture.body, workerGeneration: 4 };
      },
      (fixture) => {
        fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.timestamp] = "2026-08-09T07:00:00.124Z";
      },
      (fixture) => {
        fixture.body = { ...fixture.body, idempotencyKey: "assignment-sync:fixture-2" };
        fixture.headers[REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey] = "assignment-sync:fixture-2";
      },
    ];

    for (const mutate of mutations) {
      const fixture = signedV2Fixture();
      mutate(fixture);
      await expect(verifyV2Fixture(fixture)).rejects.toThrow();
      expect(fixture.nonceConsumer).not.toHaveBeenCalled();
    }
  });

  it("rejects missing, mismatched, or invalid protected worker generations", async () => {
    const missing = signedV2Fixture();
    const { workerGeneration: _workerGeneration, ...authorityWithoutGeneration } = missing.authority;
    missing.authority = authorityWithoutGeneration;
    await expect(verifyV2Fixture(missing)).rejects.toThrow("worker generation");

    const mismatched = signedV2Fixture();
    mismatched.body = { ...mismatched.body, workerGeneration: 4 };
    await expect(verifyV2Fixture(mismatched)).rejects.toThrow("worker generation");

    const invalid = signedV2Fixture();
    invalid.body = { ...invalid.body, workerGeneration: 0 };
    invalid.authority = { ...invalid.authority, workerGeneration: 0 };
    await expect(verifyV2Fixture(invalid)).rejects.toThrow("worker generation is invalid");
  });
});

function signedV1Fixture(): {
  body: RemoteWorkerProtocolBodyV1;
  headers: Record<string, string>;
  authority: RemoteWorkerResolvedAuthority;
  transportIdentity: RemoteWorkerTransportIdentity;
  nonceConsumer: ReturnType<typeof vi.fn>;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeySpkiDer = publicKey.export({ format: "der", type: "spki" });
  const publicKeySpkiSha256 = sha256(publicKeySpkiDer);
  const tlsExporter = Buffer.alloc(32, 0x42);
  const authority: RemoteWorkerResolvedAuthority = {
    kind: "credential",
    authorityId: "credential-7",
    authorityGeneration: 7,
    workerGeneration: 3,
    authorizationCredentialSha256: sha256(CREDENTIAL),
    publicKeySpkiDer,
    publicKeySpkiSha256,
  };
  const transportIdentity: RemoteWorkerTransportIdentity = {
    source: "native_mtls",
    certificateDerSha256: "44".repeat(32),
    publicKeySpkiSha256,
    trustAnchorDerSha256: "aa".repeat(32),
    tlsExporterSha256: sha256(tlsExporter),
    tlsExporter,
  };
  const body: RemoteWorkerProtocolBodyV1 = {
    schemaVersion: REMOTE_WORKER_POP_SCHEMA_VERSION,
    operation: SYNC_OPERATION,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    idempotencyKey: "assignment-sync:fixture-1",
    payload: { assignmentId: "assignment-1", generation: 1 },
  };
  const timestamp = NOW.toISOString();
  const nonce = Buffer.alloc(32, 0x19).toString("base64url");
  const material = buildRemoteWorkerPopMaterial({
    rawPath: SYNC_PATH,
    bodySha256: remoteWorkerProtocolBodySha256(body as RemoteWorkerProtocolBody),
    operation: SYNC_OPERATION,
    nonce,
    timestamp,
    idempotencyKey: body.idempotencyKey,
    authorityId: authority.authorityId,
    authorityGeneration: authority.authorityGeneration,
    transportIdentity,
  });
  return {
    body,
    authority,
    transportIdentity,
    nonceConsumer: vi.fn(() => true),
    headers: {
      [REMOTE_WORKER_PROTOCOL_HEADERS.authorization]: `Bearer ${CREDENTIAL}`,
      [REMOTE_WORKER_PROTOCOL_HEADERS.timestamp]: timestamp,
      [REMOTE_WORKER_PROTOCOL_HEADERS.nonce]: nonce,
      [REMOTE_WORKER_PROTOCOL_HEADERS.operation]: SYNC_OPERATION,
      [REMOTE_WORKER_PROTOCOL_HEADERS.proof]: sign(
        null,
        Buffer.from(canonicalJsonString(material), "utf8"),
        privateKey,
      ).toString("base64url"),
      [REMOTE_WORKER_PROTOCOL_HEADERS.idempotencyKey]: body.idempotencyKey,
    },
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
