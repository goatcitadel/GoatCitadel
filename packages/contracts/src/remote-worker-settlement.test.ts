import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalJsonString } from "./canonical-json.js";
import {
  REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
  REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
  REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION,
  REMOTE_WORKER_SETTLEMENT_BOUNDS,
  REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  assertRemoteWorkerLogicalPath,
  isValidRemoteWorkerLogicalPath,
  isValidRemoteWorkerMime,
  normalizeRemoteWorkerArtifactManifest,
  normalizeRemoteWorkerArtifactPart,
  normalizeRemoteWorkerEffectCorrelation,
  normalizeRemoteWorkerEffectIntent,
  normalizeRemoteWorkerVerificationEvidence,
  remoteWorkerArtifactBlobRelPath,
  remoteWorkerArtifactManifestSha256,
  remoteWorkerArtifactWorkspaceShard,
  remoteWorkerEffectCanTransition,
  remoteWorkerLogicalPathCollisionKey,
  remoteWorkerUploadCanTransition,
  remoteWorkerVerificationAttemptSatisfiesGate,
  type RemoteWorkerArtifactManifest,
  type RemoteWorkerSettlementIdentity,
} from "./remote-worker-settlement.js";

const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const identity: RemoteWorkerSettlementIdentity = {
  registryWorkspaceId: "default",
  executionWorkspaceId: "default",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  workerId: "worker-1",
  workerGeneration: 1,
  runtimeManifestSha256: D("runtime"),
  workspaceCeilingSha256: D("workspace-ceiling"),
  capabilityCeilingSha256: D("capability-ceiling"),
  assignmentManifestSha256: D("assignment-manifest"),
};

function manifestEntry(logicalPath: string, blobSeed: string, byteCount: number) {
  return {
    entryIndex: 0,
    logicalPath,
    logicalPathSha256: D(canonicalJsonString({ logicalPath })),
    blobSha256: D(blobSeed),
    byteCount,
    mimeType: "application/octet-stream",
  };
}

describe("HX-506 frozen bounds", () => {
  it("freezes the packet bounds exactly", () => {
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxUploadAttempts).toBe(4);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxFiles).toBe(64);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxTotalBytes).toBe(64 * 1024 * 1024);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBytes).toBe(256 * 1024);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxParts).toBe(320);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxPartBodyBytes).toBe(512 * 1024);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxManifestJsonBytes).toBe(64 * 1024);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxEffectIntents).toBe(64);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.maxVerifierWallMs).toBe(900_000);
    expect(REMOTE_WORKER_SETTLEMENT_BOUNDS.cleanupClaimSeconds).toBe(300);
    expect(Object.isFrozen(REMOTE_WORKER_SETTLEMENT_BOUNDS)).toBe(true);
  });
});

describe("HX-506 state machines", () => {
  it("allows only the upload transitions in the packet", () => {
    expect(remoteWorkerUploadCanTransition("open", "assembling")).toBe(true);
    expect(remoteWorkerUploadCanTransition("assembling", "committed")).toBe(true);
    expect(remoteWorkerUploadCanTransition("open", "quarantined")).toBe(true);
    expect(remoteWorkerUploadCanTransition("committed", "abandoned")).toBe(false);
    expect(remoteWorkerUploadCanTransition("committed", "committed")).toBe(false);
  });

  it("allows only the effect transitions in the packet", () => {
    expect(remoteWorkerEffectCanTransition("recorded", "approval_wait")).toBe(true);
    expect(remoteWorkerEffectCanTransition("dispatch_claimed", "external_boundary_started")).toBe(true);
    expect(remoteWorkerEffectCanTransition("external_boundary_started", "completed_with_effect")).toBe(true);
    expect(remoteWorkerEffectCanTransition("manual_reconciliation", "manual_reconciliation_resolved")).toBe(true);
    expect(remoteWorkerEffectCanTransition("recorded", "external_boundary_started")).toBe(false);
    expect(remoteWorkerEffectCanTransition("completed_with_effect", "manual_reconciliation")).toBe(false);
  });

  it("only lets a passed Gateway attempt satisfy the verification gate", () => {
    expect(remoteWorkerVerificationAttemptSatisfiesGate("gateway_attempt", "passed")).toBe(true);
    expect(remoteWorkerVerificationAttemptSatisfiesGate("worker_claim", "passed")).toBe(false);
    expect(remoteWorkerVerificationAttemptSatisfiesGate("worker_claim", "worker_reported")).toBe(false);
    expect(remoteWorkerVerificationAttemptSatisfiesGate("gateway_attempt", "failed")).toBe(false);
  });
});

describe("HX-506 logical path validation", () => {
  it("accepts a bounded relative path", () => {
    expect(isValidRemoteWorkerLogicalPath("dir/sub/file.txt")).toBe(true);
    expect(assertRemoteWorkerLogicalPath("a/b/c")).toBe("a/b/c");
  });

  it("rejects the full attack matrix", () => {
    const rejected = [
      "",
      "/etc/passwd", // absolute
      "\\\\server\\share", // UNC
      "C:/windows", // drive
      "C:file", // drive-relative colon
      "\\\\.\\device", // device
      "\\\\?\\path", // device
      "./relative", // dot segment
      "../escape", // dotdot
      "a/../b", // embedded dotdot
      "a//b", // empty segment
      "trailing./x", // trailing dot segment
      "trailing /x", // trailing space segment
      "file:stream", // ADS colon
      "con/x", // reserved
      "nul", // reserved
      "com1.txt", // reserved with extension
      `a${String.fromCharCode(0)}b`, // NUL
      "a\tb", // control
      "dir\\file", // backslash
    ];
    for (const candidate of rejected) {
      expect(isValidRemoteWorkerLogicalPath(candidate), candidate).toBe(false);
    }
  });

  it("rejects oversize paths and segments", () => {
    expect(isValidRemoteWorkerLogicalPath("x".repeat(513))).toBe(false);
    expect(isValidRemoteWorkerLogicalPath(`${"x".repeat(129)}/y`)).toBe(false);
    expect(isValidRemoteWorkerLogicalPath(Array.from({ length: 33 }, () => "a").join("/"))).toBe(false);
  });

  it("collapses NFKC-lowercase collisions to one key", () => {
    expect(remoteWorkerLogicalPathCollisionKey("File.TXT")).toBe(remoteWorkerLogicalPathCollisionKey("file.txt"));
  });
});

describe("HX-506 MIME validation", () => {
  it("accepts opaque octet-stream and simple types", () => {
    expect(isValidRemoteWorkerMime("application/octet-stream")).toBe(true);
    expect(isValidRemoteWorkerMime("text/plain")).toBe(true);
    expect(isValidRemoteWorkerMime("image/png")).toBe(true);
  });

  it("rejects active content, parameters, and oversize MIME", () => {
    for (const forbidden of [
      "text/html",
      "application/xhtml+xml",
      "image/svg+xml",
      "application/javascript",
      "text/javascript",
      "text/plain; charset=utf-8",
      "text/plain ",
      "TEXT/PLAIN",
      "a".repeat(129),
      "noslash",
    ]) {
      expect(isValidRemoteWorkerMime(forbidden), forbidden).toBe(false);
    }
  });
});

describe("HX-506 manifest", () => {
  it("normalizes and hashes deterministically", () => {
    const manifest: RemoteWorkerArtifactManifest = {
      schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      identity,
      pathJailSha256: D("jail"),
      workerClaimIds: ["claim-1"],
      workerClaimSha256: D("claims"),
      requiredVerifierProfileSha256: null,
      fileCount: 1,
      totalBytes: 10,
      entries: [manifestEntry("dir/file.bin", "blob-1", 10)],
    };
    const normalized = normalizeRemoteWorkerArtifactManifest(manifest);
    expect(normalized.fileCount).toBe(1);
    expect(normalized.totalBytes).toBe(10);
    expect(remoteWorkerArtifactManifestSha256(manifest)).toBe(remoteWorkerArtifactManifestSha256(normalized));
  });

  it("rejects NFKC-lowercase-colliding entries", () => {
    const manifest: RemoteWorkerArtifactManifest = {
      schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      identity,
      pathJailSha256: D("jail"),
      workerClaimIds: [],
      workerClaimSha256: D("claims"),
      requiredVerifierProfileSha256: null,
      fileCount: 2,
      totalBytes: 20,
      entries: [
        { ...manifestEntry("File.TXT", "blob-1", 10), entryIndex: 0 },
        { ...manifestEntry("file.txt", "blob-2", 10), entryIndex: 1 },
      ],
    };
    expect(() => normalizeRemoteWorkerArtifactManifest(manifest)).toThrow(/colliding/u);
  });

  it("rejects a fileCount or totalBytes mismatch", () => {
    const base: RemoteWorkerArtifactManifest = {
      schemaVersion: REMOTE_WORKER_ARTIFACT_MANIFEST_SCHEMA_VERSION,
      identity,
      pathJailSha256: D("jail"),
      workerClaimIds: [],
      workerClaimSha256: D("claims"),
      requiredVerifierProfileSha256: null,
      fileCount: 1,
      totalBytes: 10,
      entries: [manifestEntry("a.bin", "blob-1", 10)],
    };
    expect(() => normalizeRemoteWorkerArtifactManifest({ ...base, totalBytes: 11 })).toThrow();
    expect(() => normalizeRemoteWorkerArtifactManifest({ ...base, fileCount: 2 })).toThrow();
  });
});

describe("HX-506 parts", () => {
  it("requires non-final parts to be exactly 256 KiB", () => {
    expect(() =>
      normalizeRemoteWorkerArtifactPart({
        globalSequence: 1,
        logicalPathSha256: D("p"),
        filePartIndex: 0,
        isFinalPart: false,
        partBytes: 100,
        partSha256: D("part"),
      }),
    ).toThrow(/256 KiB/u);
  });

  it("accepts a 1-256 KiB final part", () => {
    const part = normalizeRemoteWorkerArtifactPart({
      globalSequence: 1,
      logicalPathSha256: D("p"),
      filePartIndex: 0,
      isFinalPart: true,
      partBytes: 1,
      partSha256: D("part"),
    });
    expect(part.partBytes).toBe(1);
  });
});

describe("HX-506 verification evidence", () => {
  it("keeps a worker claim distinct from a Gateway attempt", () => {
    expect(() =>
      normalizeRemoteWorkerVerificationEvidence({
        schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
        kind: "worker_claim",
        attemptState: "passed",
        verifierProfileSha256: null,
        preExecutionManifestSha256: D("pre"),
        postExecutionManifestSha256: D("post"),
        summary: "claim",
        capturedOutputBytes: 0,
      }),
    ).toThrow();
    const gateway = normalizeRemoteWorkerVerificationEvidence({
      schemaVersion: REMOTE_WORKER_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      kind: "gateway_attempt",
      attemptState: "passed",
      verifierProfileSha256: D("profile"),
      preExecutionManifestSha256: D("pre"),
      postExecutionManifestSha256: D("post"),
      summary: "ok",
      capturedOutputBytes: 100,
    });
    expect(gateway.attemptState).toBe("passed");
  });
});

describe("HX-506 effect intent and correlation", () => {
  it("normalizes an effect intent", () => {
    const normalized = normalizeRemoteWorkerEffectIntent({
      schemaVersion: REMOTE_WORKER_EFFECT_INTENT_SCHEMA_VERSION,
      identity,
      intentIndex: 0,
      effectSelector: "email.send",
      canonicalArgsSha256: D("args"),
      workerIdempotencyKey: "worker-key-1",
    });
    expect(normalized.effectSelector).toBe("email.send");
  });

  it("forbids a completed_with_effect without a canonical HX-305 outcome", () => {
    expect(() =>
      normalizeRemoteWorkerEffectCorrelation({
        schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
        transitionState: "completed_with_effect",
        externalSideEffectRunId: "run-1",
        approvalRecordSha256: null,
        boundaryReceiptSha256: D("boundary"),
        hx305OutcomeSha256: null,
        reconciliationRecordSha256: null,
        sanitizedError: null,
      }),
    ).toThrow(/HX-305/u);
  });

  it("forbids a boundary-crossing transition without a real boundary receipt (result-body spoof)", () => {
    expect(() =>
      normalizeRemoteWorkerEffectCorrelation({
        schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
        transitionState: "completed_with_effect",
        externalSideEffectRunId: "run-1",
        approvalRecordSha256: null,
        boundaryReceiptSha256: null,
        hx305OutcomeSha256: D("hx305"),
        reconciliationRecordSha256: null,
        sanitizedError: null,
      }),
    ).toThrow(/boundary/u);
  });

  it("accepts a blocked-before-dispatch correlation without a boundary", () => {
    const correlation = normalizeRemoteWorkerEffectCorrelation({
      schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
      transitionState: "blocked_before_dispatch",
      externalSideEffectRunId: null,
      approvalRecordSha256: null,
      boundaryReceiptSha256: null,
      hx305OutcomeSha256: null,
      reconciliationRecordSha256: null,
      sanitizedError: "policy denied",
    });
    expect(correlation.transitionState).toBe("blocked_before_dispatch");
  });
});

describe("HX-506 server-derived physical paths", () => {
  it("derives CAS addresses from server workspace and content hashes only", () => {
    const shard = remoteWorkerArtifactWorkspaceShard("default");
    const blob = D("blob-content");
    const relPath = remoteWorkerArtifactBlobRelPath(shard, blob);
    expect(relPath).toBe(`remote-workers/artifacts/${shard}/sha256/${blob.slice(0, 2)}/${blob}`);
    expect(relPath).not.toContain("file.txt");
  });
});
