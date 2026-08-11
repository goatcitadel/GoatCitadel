import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  REMOTE_WORKER_POP_V2_DOMAIN,
  REMOTE_WORKER_POP_V2_PREIMAGE_BYTES,
  REMOTE_WORKER_POP_V2_ROUTE_BINDINGS,
  REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  buildRemoteWorkerPopV2Preimage,
  normalizeRemoteWorkerPopV2Material,
  type RemoteWorkerPopV2Input,
} from "./remote-worker-protocol.js";

const fixture = (): RemoteWorkerPopV2Input => ({
  schemaVersion: REMOTE_WORKER_POP_V2_SCHEMA_VERSION,
  method: "POST",
  rawPath: "/api/v1/remote-workers/mesh-node-admissions",
  operation: "mesh.node.admit",
  bodySha256: "11".repeat(32),
  nonce: Buffer.alloc(32, 0x22).toString("base64url"),
  timestamp: "2026-08-09T07:00:00.123Z",
  idempotencyKey: "mesh-node-admit:fixture-1",
  authorityKind: "credential",
  authorityId: "credential-1",
  authorityGeneration: 7,
  workerGeneration: 3,
  tlsExporterSha256: "33".repeat(32),
  clientCertificateSha256: "44".repeat(32),
  workerPublicKeySpkiSha256: "55".repeat(32),
});

describe("remote worker protected proof v2 contract", () => {
  it("pins the exact twelve protected-proof POST route and operation purposes", () => {
    expect(REMOTE_WORKER_POP_V2_ROUTE_BINDINGS).toStrictEqual([
      {
        code: 1,
        method: "POST",
        rawPath: "/api/v1/remote-workers/bootstrap-exchanges",
        operation: "bootstrap.exchange",
        authorityKind: "bootstrap",
      },
      {
        code: 2,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-syncs",
        operation: "assignment.sync",
        authorityKind: "credential",
      },
      {
        code: 3,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-lease-renewals",
        operation: "assignment.lease.renew",
        authorityKind: "credential",
      },
      {
        code: 4,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-event-batches",
        operation: "assignment.events.append",
        authorityKind: "credential",
      },
      {
        code: 5,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-control-reads",
        operation: "assignment.control.read",
        authorityKind: "credential",
      },
      {
        code: 6,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-settlements",
        operation: "assignment.settle",
        authorityKind: "credential",
      },
      {
        code: 7,
        method: "POST",
        rawPath: "/api/v1/remote-workers/mesh-node-admissions",
        operation: "mesh.node.admit",
        authorityKind: "credential",
      },
      {
        code: 8,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-offer-polls",
        operation: "assignment.offers.poll",
        authorityKind: "credential",
      },
      {
        code: 9,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-claims",
        operation: "assignment.claim",
        authorityKind: "credential",
      },
      {
        code: 10,
        method: "POST",
        rawPath: "/api/v1/remote-workers/assignment-workload-reads",
        operation: "assignment.workload.read",
        authorityKind: "credential",
      },
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
    for (const route of REMOTE_WORKER_POP_V2_ROUTE_BINDINGS) {
      expect(
        normalizeRemoteWorkerPopV2Material({
          ...fixture(),
          rawPath: route.rawPath,
          operation: route.operation,
          authorityKind: route.authorityKind,
          authorityId: route.authorityKind === "bootstrap" ? "bootstrap-1" : "credential-1",
        }).routeCode,
      ).toBe(route.code);
    }
  });

  it("encodes one deterministic, domain-separated fixed-length vector", () => {
    const first = buildRemoteWorkerPopV2Preimage(fixture());
    const second = buildRemoteWorkerPopV2Preimage({ ...fixture() });
    const domainBytes = new TextEncoder().encode(REMOTE_WORKER_POP_V2_DOMAIN);
    expect(first).toStrictEqual(second);
    expect(first.byteLength).toBe(REMOTE_WORKER_POP_V2_PREIMAGE_BYTES);
    expect(first.subarray(0, domainBytes.byteLength)).toStrictEqual(domainBytes);
    expect(first[domainBytes.byteLength - 1]).toBe(0);
    expect(first.subarray(domainBytes.byteLength)).toHaveLength(252);
    expect(createHash("sha256").update(first).digest("hex")).toBe(
      "c9f1db185a7679e20363c365fb0077815b1aefdf0e2367502fc58352202c3918",
    );
  });

  it("binds every fixed field and derives fixed-size hashes for variable identifiers", () => {
    const base = fixture();
    const baseDigest = digest(buildRemoteWorkerPopV2Preimage(base));
    const mutations: RemoteWorkerPopV2Input[] = [
      { ...base, bodySha256: "aa".repeat(32) },
      { ...base, nonce: Buffer.alloc(32, 0xbb).toString("base64url") },
      { ...base, tlsExporterSha256: "cc".repeat(32) },
      { ...base, clientCertificateSha256: "dd".repeat(32) },
      { ...base, workerPublicKeySpkiSha256: "ee".repeat(32) },
      { ...base, authorityId: "credential-2" },
      { ...base, authorityGeneration: 8 },
      { ...base, workerGeneration: 4 },
      { ...base, timestamp: "2026-08-09T07:00:00.124Z" },
      { ...base, idempotencyKey: "mesh-node-admit:fixture-2" },
    ];
    expect(new Set(mutations.map((entry) => digest(buildRemoteWorkerPopV2Preimage(entry))))).toHaveLength(
      mutations.length,
    );
    for (const mutation of mutations) expect(digest(buildRemoteWorkerPopV2Preimage(mutation))).not.toBe(baseDigest);

    const material = normalizeRemoteWorkerPopV2Material(base);
    expect(material.nonceSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(material.authorityIdSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(material.idempotencyKeySha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects cross-route, cross-operation, and cross-authority-purpose replay", () => {
    expect(() => buildRemoteWorkerPopV2Preimage({ ...fixture(), operation: "assignment.settle" })).toThrow(
      /route and operation binding/u,
    );
    expect(() =>
      buildRemoteWorkerPopV2Preimage({
        ...fixture(),
        rawPath: "/api/v1/remote-workers/assignment-settlements",
      }),
    ).toThrow(/route and operation binding/u);
    expect(() => buildRemoteWorkerPopV2Preimage({ ...fixture(), authorityKind: "bootstrap" })).toThrow(
      /authority purpose/u,
    );
  });

  it("rejects malformed lengths, non-canonical values, missing data, accessors, and extra fields", () => {
    const malformed: unknown[] = [
      { ...fixture(), bodySha256: "1".repeat(63) },
      { ...fixture(), bodySha256: "AA".repeat(32) },
      { ...fixture(), nonce: "a".repeat(42) },
      { ...fixture(), timestamp: "2026-08-09T07:00:00Z" },
      { ...fixture(), authorityGeneration: 0 },
      { ...fixture(), workerGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...fixture(), authorityId: "x".repeat(257) },
      { ...fixture(), idempotencyKey: "x".repeat(513) },
      { ...fixture(), unexpected: true },
    ];
    const { nonce: _nonce, ...missingNonce } = fixture();
    malformed.push(missingNonce);
    for (const value of malformed)
      expect(() => buildRemoteWorkerPopV2Preimage(value as RemoteWorkerPopV2Input)).toThrow();

    const accessor = fixture() as unknown as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(accessor, "authorityId", {
      enumerable: true,
      get: () => {
        reads += 1;
        return "credential-1";
      },
    });
    expect(() => buildRemoteWorkerPopV2Preimage(accessor as unknown as RemoteWorkerPopV2Input)).toThrow(/material/u);
    expect(reads).toBe(0);
  });
});

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
