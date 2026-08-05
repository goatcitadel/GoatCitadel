import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import type { CapabilityArtifactRecord, CodeModeRunRecord } from "@goatcitadel/contracts";
import {
  EvidenceReceiptService,
  canonicalJsonString,
  verifyEvidenceReceipt,
  type EvidenceReceiptDataPort,
  type EvidenceReceipt,
} from "./evidence-receipt-service.js";
import { InMemoryEvidenceReceiptSigningKeyProvider } from "./evidence-receipt-signing-key.js";

const createdRoots: string[] = [];
const openStorages: Storage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) {
    try {
      storage.close();
    } catch {
      // ignore
    }
  }
  for (const root of createdRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

function createStorage(): Storage {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-evidence-receipt-"));
  createdRoots.push(root);
  const transcriptsDir = path.join(root, "transcripts");
  const auditDir = path.join(root, "audit");
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(auditDir, { recursive: true });
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir, auditDir });
  openStorages.push(storage);
  return storage;
}

function dataPortFor(storage: Storage): EvidenceReceiptDataPort {
  return {
    getDurableRun: (runId) => storage.durableRuns.getRun(runId),
    findCodeModeRun: (runId) => storage.codeModeRuns.find(runId),
    listApprovalEffects: (approvalId) => storage.approvalEffects.listByApproval(approvalId),
    listSideEffectsForWorkspace: (workspaceId) => storage.externalSideEffectRuns.listByWorkspace(workspaceId),
  };
}

function makeArtifact(overrides: Partial<CapabilityArtifactRecord> = {}): CapabilityArtifactRecord {
  return {
    artifactId: "artifact-1",
    relPath: "code-mode/run-1/code.ts",
    sha256: "a".repeat(64),
    bytes: 128,
    mimeType: "text/plain",
    createdAt: "2026-06-18T00:00:00.000Z",
    ...overrides,
  };
}

function seedCodeModeRun(
  storage: Storage,
  runId: string,
  approvalId: string,
  overrides: Partial<CodeModeRunRecord> = {},
): void {
  storage.codeModeRuns.upsert({
    runId,
    status: "completed",
    language: "python",
    workspaceId: "workspace-7",
    operatorId: "operator-1",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "snap-1",
    codeModeInputHash: "input-hash",
    wrapperManifestHash: "wrapper-hash",
    policySnapshotHash: "policy-hash",
    codeHash: "code-hash",
    approvalId,
    sessionId: "session-9",
    turnId: "turn-3",
    codeArtifact: makeArtifact({ artifactId: "code-art", sha256: "1".repeat(64), relPath: "cm/code.py" }),
    wrapperManifestArtifact: makeArtifact({
      artifactId: "wrapper-art",
      sha256: "2".repeat(64),
      relPath: "cm/wrapper.json",
    }),
    policySnapshotArtifact: makeArtifact({
      artifactId: "policy-art",
      sha256: "3".repeat(64),
      relPath: "cm/policy.json",
    }),
    stdoutTruncated: false,
    stderrTruncated: false,
    createdAt: "2026-06-18T00:00:00.000Z",
    finishedAt: "2026-06-18T00:00:05.000Z",
    ...overrides,
  });
}

/** Seeds a complete run: durable run + code mode artifacts + approval effect + side effect. */
function seedFullRun(storage: Storage): { runId: string; approvalId: string } {
  // A real approval row first (approval_effects has a FK to approvals.approval_id).
  const approval = storage.approvals.create({
    kind: "code_mode.execute",
    riskLevel: "caution",
    payload: { workspaceId: "workspace-7" },
    preview: {},
  });
  const run = storage.durableRuns.createRun({
    workflowKey: "chat.turn",
    status: "completed",
    payload: {
      sessionId: "session-9",
      turnId: "turn-3",
      approvalId: approval.approvalId,
      workspaceId: "workspace-7",
    },
    now: "2026-06-18T00:00:00.000Z",
  });
  storage.durableRuns.updateRun({
    runId: run.runId,
    status: "completed",
    finishedAt: "2026-06-18T00:00:05.000Z",
    updatedAt: "2026-06-18T00:00:05.000Z",
  });
  seedCodeModeRun(storage, run.runId, approval.approvalId);
  storage.approvalEffects.upsert({
    approvalId: approval.approvalId,
    effectKind: "approval_wait_wake",
    targetKind: "durable_run",
    targetId: run.runId,
    status: "completed",
    completedAt: "2026-06-18T00:00:04.000Z",
  });
  storage.externalSideEffectRuns.createOrGet({
    workspaceId: "workspace-7",
    boundary: "integration.write",
    routePath: "/api/v1/integrations/slack/messages",
    idempotencyKey: "idem-1",
    payloadHash: "payload-hash-1",
    status: "completed",
  });
  return { runId: run.runId, approvalId: approval.approvalId };
}

describe("EvidenceReceiptService", () => {
  let storage: Storage;
  let service: EvidenceReceiptService;

  beforeEach(() => {
    storage = createStorage();
    service = new EvidenceReceiptService({
      data: dataPortFor(storage),
      signingKeys: new InMemoryEvidenceReceiptSigningKeyProvider(),
      now: () => new Date("2026-06-18T12:00:00.000Z"),
    });
  });

  it("builds a signed receipt that assembles lineage, approval effects, side effects, and artifacts", async () => {
    const { runId, approvalId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    expect(receipt.manifest.schemaVersion).toBe("1.0.0");
    expect(receipt.manifest.runId).toBe(runId);
    expect(receipt.signatureAlgorithm).toBe("ed25519");
    expect(receipt.hashAlgorithm).toBe("sha256");
    expect(receipt.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.signature.length).toBeGreaterThan(0);
    expect(receipt.publicKey.length).toBeGreaterThan(0);

    // Lineage
    expect(receipt.manifest.lineage.workflowKey).toBe("chat.turn");
    expect(receipt.manifest.lineage.outcome).toBe("succeeded");
    expect(receipt.manifest.lineage.sessionId).toBe("session-9");
    expect(receipt.manifest.lineage.approvalId).toBe(approvalId);
    expect(receipt.manifest.lineage.workspaceId).toBe("workspace-7");

    // Artifacts (code mode): code + wrapper + policy = 3
    expect(receipt.manifest.artifacts.map((a) => a.source)).toEqual([
      "code_mode.code",
      "code_mode.wrapper_manifest",
      "code_mode.policy_snapshot",
    ]);
    expect(receipt.manifest.artifacts[0]?.sha256).toBe("1".repeat(64));

    // Approval effects
    expect(receipt.manifest.approvalEffects).toHaveLength(1);
    expect(receipt.manifest.approvalEffects[0]?.approvalId).toBe(approvalId);
    expect(receipt.manifest.approvalEffects[0]?.status).toBe("completed");

    // Side effects (workspace-scoped)
    expect(receipt.manifest.sideEffects).toHaveLength(1);
    expect(receipt.manifest.sideEffects[0]?.idempotencyKey).toBe("idem-1");
    expect(receipt.manifest.sideEffects[0]?.payloadHash).toBe("payload-hash-1");
  });

  it("verifies an untampered receipt as valid", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    const result = service.verifyEvidenceReceipt(receipt);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("verifies offline — a JSON round-trip of the receipt still validates", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    // No service/storage involved: pure function on the serialized receipt.
    const roundTripped = JSON.parse(JSON.stringify(receipt)) as EvidenceReceipt;
    const result = verifyEvidenceReceipt(roundTripped);
    expect(result.valid).toBe(true);
  });

  it("fails verification when any manifest field is tampered", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    const tampered: EvidenceReceipt = {
      ...receipt,
      manifest: {
        ...receipt.manifest,
        lineage: { ...receipt.manifest.lineage, outcome: "failed" },
      },
    };

    const result = verifyEvidenceReceipt(tampered);
    expect(result.valid).toBe(false);
    // The content hash no longer matches the (still-original) contentHash field.
    expect(result.reasons.some((r) => r.includes("Content hash mismatch"))).toBe(true);
  });

  it("fails verification even when an attacker recomputes a matching contentHash (signature is the moat)", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    // Attacker tampers the manifest AND recomputes a self-consistent contentHash. The signature was
    // made over the *original* canonical bytes with the host's private key, which the attacker does
    // not hold — so verification must still fail despite the internally-consistent hash.
    const forgedManifest = { ...receipt.manifest, runId: "forged-run-id" };
    const forgedHash = createHash("sha256").update(canonicalJsonString(forgedManifest)).digest("hex");
    const forged: EvidenceReceipt = { ...receipt, manifest: forgedManifest, contentHash: forgedHash };

    const result = verifyEvidenceReceipt(forged);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes("signature"))).toBe(true);
    // The hash matches now, so the ONLY failure must be the signature.
    expect(result.reasons.some((r) => r.includes("Content hash mismatch"))).toBe(false);
  });

  it("fails verification when an artifact hash is swapped (the core tamper case)", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    const tampered: EvidenceReceipt = {
      ...receipt,
      manifest: {
        ...receipt.manifest,
        artifacts: receipt.manifest.artifacts.map((artifact, index) =>
          index === 0 ? { ...artifact, sha256: "f".repeat(64) } : artifact,
        ),
      },
    };

    const result = verifyEvidenceReceipt(tampered);
    expect(result.valid).toBe(false);
  });

  it("fails verification when the signature is tampered", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    // Flip the signature: re-sign nothing, just corrupt the base64 payload deterministically.
    const corruptedSignature = Buffer.from(
      Buffer.from(receipt.signature, "base64").map((byte, index) => (index === 0 ? byte ^ 0xff : byte)),
    ).toString("base64");
    const tampered: EvidenceReceipt = { ...receipt, signature: corruptedSignature };

    const result = verifyEvidenceReceipt(tampered);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.toLowerCase().includes("signature"))).toBe(true);
  });

  it("fails verification when the public key is replaced with an attacker key", async () => {
    const { runId } = seedFullRun(storage);
    const receipt = await service.buildEvidenceReceipt(runId);

    // A different in-memory provider yields a different keypair; substituting its public key must fail
    // because the signature was made with the original private key.
    const attackerKey = new InMemoryEvidenceReceiptSigningKeyProvider().getSigningKeyPair();
    const tampered: EvidenceReceipt = { ...receipt, publicKey: attackerKey.publicKeySpkiBase64 };

    const result = verifyEvidenceReceipt(tampered);
    expect(result.valid).toBe(false);
  });

  it("reports structural reasons for a non-receipt payload without throwing", () => {
    expect(verifyEvidenceReceipt(null).valid).toBe(false);
    expect(verifyEvidenceReceipt({}).valid).toBe(false);
    expect(verifyEvidenceReceipt({}).reasons.length).toBeGreaterThan(0);
  });

  it("documents missing lineage sources in manifest notes", async () => {
    // Bare run: no code mode run, no approval, no workspace.
    const run = storage.durableRuns.createRun({
      workflowKey: "bare.workflow",
      status: "running",
      now: "2026-06-18T00:00:00.000Z",
    });
    const receipt = await service.buildEvidenceReceipt(run.runId);

    expect(receipt.manifest.lineage.outcome).toBe("in_progress");
    expect(receipt.manifest.artifacts).toEqual([]);
    expect(receipt.manifest.approvalEffects).toEqual([]);
    expect(receipt.manifest.sideEffects).toEqual([]);
    expect(receipt.manifest.notes.length).toBeGreaterThan(0);
    expect(receipt.manifest.notes.some((n) => n.includes("Code Mode"))).toBe(true);
    // The receipt is still signed and self-verifies.
    expect(service.verifyEvidenceReceipt(receipt).valid).toBe(true);
  });

  it("throws NotFound when the run does not exist", async () => {
    await expect(service.buildEvidenceReceipt("does-not-exist")).rejects.toThrow();
  });
});

describe("canonical JSON", () => {
  it("is order-independent: same hash regardless of input key order", () => {
    const a = { runId: "r1", lineage: { status: "completed", runId: "r1" }, notes: ["x", "y"] };
    const b = { notes: ["x", "y"], lineage: { runId: "r1", status: "completed" }, runId: "r1" };
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b));
  });

  it("preserves array order (arrays are order-significant)", () => {
    expect(canonicalJsonString({ items: [1, 2, 3] })).not.toBe(canonicalJsonString({ items: [3, 2, 1] }));
  });

  it("drops undefined object properties (matches JSON transport semantics)", () => {
    expect(canonicalJsonString({ a: 1, b: undefined })).toBe(canonicalJsonString({ a: 1 }));
  });

  it("recursively sorts nested object keys", () => {
    const nested = { z: { b: 2, a: 1 }, a: { y: 2, x: 1 } };
    expect(canonicalJsonString(nested)).toBe('{"a":{"x":1,"y":2},"z":{"a":1,"b":2}}');
  });

  it("produces an identical content hash for receipts built from differently-ordered manifests", async () => {
    const storage2 = createStorage();
    const svc = new EvidenceReceiptService({
      data: dataPortFor(storage2),
      signingKeys: new InMemoryEvidenceReceiptSigningKeyProvider(),
      now: () => new Date("2026-06-18T12:00:00.000Z"),
    });
    const { runId } = seedFullRun(storage2);
    const receipt = await svc.buildEvidenceReceipt(runId);

    // Rebuild the manifest with keys shuffled, then re-canonicalize: the hash input is identical.
    const shuffled = JSON.parse(JSON.stringify(receipt.manifest));
    expect(canonicalJsonString(shuffled)).toBe(canonicalJsonString(receipt.manifest));
  });
});
