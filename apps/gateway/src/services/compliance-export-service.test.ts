import { describe, expect, it } from "vitest";
import { NotFoundError, type DurableRunRecord, type ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import {
  ComplianceExportService,
  computeBundleContentHash,
  verifyComplianceBundle,
  type ComplianceBundle,
  type ComplianceExportDataPort,
} from "./compliance-export-service.js";
import { InMemoryEvidenceReceiptSigningKeyProvider } from "./evidence-receipt-signing-key.js";

const FIXED_NOW = "2026-06-19T12:00:00.000Z";

function makeRun(overrides: Partial<DurableRunRecord> & { runId: string; createdAt: string }): DurableRunRecord {
  return {
    workflowKey: "chat.turn",
    status: "completed",
    attemptCount: 1,
    maxAttempts: 3,
    version: 2,
    payload: {},
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

/**
 * Data port backed by an in-memory list of runs. `getDurableRun` resolves by id (so the B1 receipt
 * builder works for each selected run); `listDurableRunsForExport` returns the whole list (the
 * service does range/workspace filtering + capping itself).
 */
function dataPortFor(runs: DurableRunRecord[]): ComplianceExportDataPort {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  return {
    getDurableRun: (id) => {
      const run = byId.get(id);
      if (!run) {
        throw new NotFoundError({ entity: "Durable run", id });
      }
      return run;
    },
    findCodeModeRun: () => undefined,
    listApprovalEffects: () => [],
    listSideEffectsForWorkspace: () => [],
    listDurableRunsForExport: () => runs.slice(),
  };
}

function buildService(runs: DurableRunRecord[]): ComplianceExportService {
  return new ComplianceExportService({
    data: dataPortFor(runs),
    signingKeys: new InMemoryEvidenceReceiptSigningKeyProvider(),
    now: () => new Date(FIXED_NOW),
  });
}

const TWO_RUNS: DurableRunRecord[] = [
  makeRun({ runId: "run-a", createdAt: "2026-06-10T09:00:00.000Z", finishedAt: "2026-06-10T09:05:00.000Z" }),
  makeRun({ runId: "run-b", createdAt: "2026-06-12T09:00:00.000Z", finishedAt: "2026-06-12T09:05:00.000Z" }),
];

const WIDE_RANGE = { fromTs: "2026-06-01T00:00:00.000Z", toTs: "2026-06-30T00:00:00.000Z" };

describe("ComplianceExportService.buildComplianceBundle", () => {
  it("builds a signed bundle over the runs in range and verifies valid", () => {
    const service = buildService(TWO_RUNS);

    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    expect(bundle.schemaVersion).toBe("1.0.0");
    expect(bundle.generatedAt).toBe(FIXED_NOW);
    expect(bundle.range).toEqual({ fromTs: WIDE_RANGE.fromTs, toTs: WIDE_RANGE.toTs });
    expect(bundle.receiptCount).toBe(2);
    expect(bundle.truncated).toBe(false);
    expect(bundle.receipts).toHaveLength(2);
    expect(bundle.bundleContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(bundle.bundleSignature.length).toBeGreaterThan(0);
    expect(bundle.publicKey.length).toBeGreaterThan(0);
    // Newest-first ordering.
    expect(bundle.receipts.map((r) => r.manifest.runId)).toEqual(["run-b", "run-a"]);

    const verification = service.verifyComplianceBundle(bundle);
    expect(verification.valid).toBe(true);
    expect(verification.reasons).toEqual([]);
    expect(verification.perReceipt).toEqual([
      { runId: "run-b", valid: true },
      { runId: "run-a", valid: true },
    ]);
  });

  it("reuses the projected signed receipt manifest without exposing canonical secrets", () => {
    const rawLastError = "Provider failed with Authorization: Bearer compliance-error-secret";
    const rawExternalReference =
      "url:https://bundle-user:bundle-password@example.test/result?token=compliance-reference-secret";
    const run = makeRun({
      runId: "run-compliance-secret",
      createdAt: "2026-06-11T00:00:00.000Z",
      status: "failed",
      payload: { workspaceId: "workspace-compliance" },
      lastError: rawLastError,
    });
    const sideEffect: ExternalSideEffectRunRecord = {
      runId: "extfx-compliance-secret",
      workspaceId: "workspace-compliance",
      boundary: "integration.write",
      routePath: "/api/v1/integrations/webhook/send",
      actorScope: "operator",
      idempotencyKey: "idem-compliance-secret",
      payloadHash: "payload-hash-compliance-secret",
      status: "completed",
      replayPolicy: "audit_only",
      resumeState: "completed",
      externalReferenceId: rawExternalReference,
      attemptCount: 1,
      completedAt: "2026-06-11T00:00:01.000Z",
      createdAt: "2026-06-11T00:00:00.000Z",
      updatedAt: "2026-06-11T00:00:01.000Z",
    };
    const data = dataPortFor([run]);
    data.listSideEffectsForWorkspace = () => [sideEffect];
    const service = new ComplianceExportService({
      data,
      signingKeys: new InMemoryEvidenceReceiptSigningKeyProvider(),
      now: () => new Date(FIXED_NOW),
    });

    const bundle = service.buildComplianceBundle({
      ...WIDE_RANGE,
      workspaceId: "workspace-compliance",
    });

    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("compliance-error-secret");
    expect(serialized).not.toContain("bundle-password");
    expect(serialized).not.toContain("compliance-reference-secret");
    expect(bundle.receipts[0]?.manifest.lineage.lastError).toBe("Provider failed with Authorization: [REDACTED]");
    expect(bundle.receipts[0]?.manifest.sideEffects[0]?.externalReferenceId).toBe(
      "url:https://[REDACTED]@example.test/result?token=[REDACTED]",
    );
    expect(service.verifyComplianceBundle(bundle).valid).toBe(true);
    expect(run.lastError).toBe(rawLastError);
    expect(sideEffect.externalReferenceId).toBe(rawExternalReference);
  });

  it("filters runs outside the requested time range", () => {
    const runs: DurableRunRecord[] = [
      ...TWO_RUNS,
      makeRun({ runId: "run-old", createdAt: "2026-01-01T00:00:00.000Z", finishedAt: "2026-01-01T00:01:00.000Z" }),
      makeRun({ runId: "run-future", createdAt: "2027-01-01T00:00:00.000Z", finishedAt: "2027-01-01T00:01:00.000Z" }),
    ];
    const service = buildService(runs);

    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    expect(bundle.receipts.map((r) => r.manifest.runId).sort()).toEqual(["run-a", "run-b"]);
  });

  it("filters by workspaceId via run correlation when requested", () => {
    const runs: DurableRunRecord[] = [
      makeRun({
        runId: "run-ws1",
        createdAt: "2026-06-11T00:00:00.000Z",
        payload: { workspaceId: "ws-1" },
      }),
      makeRun({
        runId: "run-ws2",
        createdAt: "2026-06-11T00:00:00.000Z",
        metadata: { workspace_id: "ws-2" },
      }),
    ];
    const service = buildService(runs);

    const bundle = service.buildComplianceBundle({ ...WIDE_RANGE, workspaceId: "ws-1" });

    expect(bundle.workspaceId).toBe("ws-1");
    expect(bundle.receipts.map((r) => r.manifest.runId)).toEqual(["run-ws1"]);
    expect(service.verifyComplianceBundle(bundle).valid).toBe(true);
  });

  it("caps at `limit`, truncates, and keeps the newest receipts", () => {
    const runs: DurableRunRecord[] = [
      makeRun({ runId: "run-1", createdAt: "2026-06-10T00:00:00.000Z" }),
      makeRun({ runId: "run-2", createdAt: "2026-06-11T00:00:00.000Z" }),
      makeRun({ runId: "run-3", createdAt: "2026-06-12T00:00:00.000Z" }),
    ];
    const service = buildService(runs);

    const bundle = service.buildComplianceBundle({ ...WIDE_RANGE, limit: 2 });

    expect(bundle.truncated).toBe(true);
    expect(bundle.receiptCount).toBe(2);
    // Newest two by createdAt.
    expect(bundle.receipts.map((r) => r.manifest.runId)).toEqual(["run-3", "run-2"]);
    expect(service.verifyComplianceBundle(bundle).valid).toBe(true);
  });

  it("rejects an inverted range", () => {
    const service = buildService(TWO_RUNS);
    expect(() =>
      service.buildComplianceBundle({ fromTs: "2026-06-30T00:00:00.000Z", toTs: "2026-06-01T00:00:00.000Z" }),
    ).toThrow(/fromTs must be less than or equal to toTs/);
  });

  it("rejects a non-ISO timestamp", () => {
    const service = buildService(TWO_RUNS);
    expect(() => service.buildComplianceBundle({ fromTs: "not-a-date", toTs: WIDE_RANGE.toTs })).toThrow(
      /not a valid ISO-8601 timestamp/,
    );
  });

  it("produces an empty but valid bundle when no runs are in range", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle({
      fromTs: "2025-01-01T00:00:00.000Z",
      toTs: "2025-12-31T00:00:00.000Z",
    });
    expect(bundle.receiptCount).toBe(0);
    expect(bundle.receipts).toEqual([]);
    expect(service.verifyComplianceBundle(bundle).valid).toBe(true);
  });
});

describe("verifyComplianceBundle tamper detection", () => {
  it("flags a tampered receipt manifest: that receipt invalid AND a bundle reason", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    // Mutate one receipt's manifest WITHOUT re-signing it.
    const tampered: ComplianceBundle = {
      ...bundle,
      receipts: bundle.receipts.map((receipt, index) =>
        index === 0 ? { ...receipt, manifest: { ...receipt.manifest, workflowKey: "tampered.workflow" } } : receipt,
      ),
    };

    const result = verifyComplianceBundle(tampered);
    expect(result.valid).toBe(false);
    // The tampered receipt is reported invalid in the per-receipt breakdown.
    const tamperedRunId = bundle.receipts[0].manifest.runId;
    expect(result.perReceipt).toContainEqual({ runId: tamperedRunId, valid: false });
    // And the bundle surfaces a reason about that receipt.
    expect(result.reasons.some((reason) => reason.includes(tamperedRunId))).toBe(true);
  });

  it("flags a tampered bundle signature", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    const flippedSignature = Buffer.from(bundle.bundleSignature, "base64");
    flippedSignature[0] ^= 0xff;
    const tampered: ComplianceBundle = {
      ...bundle,
      bundleSignature: flippedSignature.toString("base64"),
    };

    const result = verifyComplianceBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("signature does not verify"))).toBe(true);
    // Every receipt is still individually valid — only the bundle-level signature broke.
    expect(result.perReceipt.every((entry) => entry.valid)).toBe(true);
  });

  it("flags a removed receipt via bundleContentHash mismatch", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    const tampered: ComplianceBundle = {
      ...bundle,
      receipts: bundle.receipts.slice(1), // drop the first receipt
    };

    const result = verifyComplianceBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("content hash mismatch"))).toBe(true);
  });

  it("flags a reordered receipt list via bundleContentHash mismatch", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    const tampered: ComplianceBundle = {
      ...bundle,
      receipts: [...bundle.receipts].reverse(),
    };

    const result = verifyComplianceBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("content hash mismatch"))).toBe(true);
  });

  it("flags a swapped-in foreign receipt (different run) via bundleContentHash mismatch", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    // Build a separate, independently-valid receipt for a run NOT committed by this bundle.
    const otherService = buildService([makeRun({ runId: "run-foreign", createdAt: "2026-06-13T00:00:00.000Z" })]);
    const foreignBundle = otherService.buildComplianceBundle(WIDE_RANGE);
    const foreignReceipt = foreignBundle.receipts[0];

    const tampered: ComplianceBundle = {
      ...bundle,
      receipts: [foreignReceipt, bundle.receipts[1]],
    };

    const result = verifyComplianceBundle(tampered);
    expect(result.valid).toBe(false);
    // The foreign receipt is itself individually valid (it was properly signed)...
    expect(result.perReceipt).toContainEqual({ runId: "run-foreign", valid: true });
    // ...but the bundle no longer commits to it → content hash mismatch.
    expect(result.reasons.some((reason) => reason.includes("content hash mismatch"))).toBe(true);
  });

  it("flags a receiptCount that disagrees with the receipts present", () => {
    const service = buildService(TWO_RUNS);
    const bundle = service.buildComplianceBundle(WIDE_RANGE);

    const tampered: ComplianceBundle = { ...bundle, receiptCount: 99 };
    const result = verifyComplianceBundle(tampered);
    expect(result.valid).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("receiptCount"))).toBe(true);
  });

  it("rejects structurally invalid input", () => {
    expect(verifyComplianceBundle(null).valid).toBe(false);
    expect(verifyComplianceBundle({}).valid).toBe(false);
    expect(verifyComplianceBundle({ receipts: [], bundleContentHash: "x" }).valid).toBe(false);
  });
});

describe("computeBundleContentHash", () => {
  it("is order-sensitive over the commitments", () => {
    const a = computeBundleContentHash([
      { runId: "r1", contentHash: "h1", signature: "s1" },
      { runId: "r2", contentHash: "h2", signature: "s2" },
    ]);
    const reordered = computeBundleContentHash([
      { runId: "r2", contentHash: "h2", signature: "s2" },
      { runId: "r1", contentHash: "h1", signature: "s1" },
    ]);
    expect(a).not.toBe(reordered);
  });
});
