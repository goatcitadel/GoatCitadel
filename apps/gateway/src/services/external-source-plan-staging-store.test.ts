import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXTERNAL_SOURCE_SCHEMA_VERSION, canonicalJsonString } from "@goatcitadel/contracts";
import {
  computeExternalSourceNormalizedSetSha256,
  computeExternalSourceRawSetSha256,
  computeExternalSourceSelectedItemSetSha256,
  sealExternalSourceImportPlan,
} from "@goatcitadel/storage";
import {
  ExternalSourcePlanStagingStore,
  ExternalSourcePlanStagingStoreError,
  type ExternalSourceStagedItemInput,
} from "./external-source-plan-staging-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ExternalSourcePlanStagingStore", () => {
  it("durably stages only normalized bytes behind a content-free owner-only manifest", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-14T08:00:00.000Z");
    const store = new ExternalSourcePlanStagingStore(root, { nowMs: () => nowMs });
    const fixture = buildFixture();

    const manifest = await store.stage({ ...fixture, signal: signal() });
    expect(manifest.items.map((item) => item.normalizedArtifactSha256)).toEqual(
      fixture.items.map((item) => item.normalizedArtifactSha256),
    );
    const manifestPath = path.join(root, "leases", fixture.plan.stagingLeaseId, "manifest.json");
    const manifestText = await fs.readFile(manifestPath, "utf8");
    expect(manifestText).toBe(canonicalJsonString(manifest));
    expect(manifestText).not.toContain("normalized fixture payload");
    if (process.platform !== "win32") {
      expect((await fs.stat(manifestPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(manifestPath))).mode & 0o777).toBe(0o700);
    }

    const read = await store.read({ plan: fixture.plan, signal: signal() });
    expect(Buffer.from(read.items[0]!.normalizedBytes).toString("utf8")).toBe("normalized fixture payload");
    await store.discard(fixture.plan.stagingLeaseId);
    await expect(fs.stat(path.dirname(manifestPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("converges exact replay and fails closed on plan or staged-byte drift", async () => {
    const root = await temporaryRoot();
    const nowMs = Date.parse("2026-07-14T08:00:00.000Z");
    const store = new ExternalSourcePlanStagingStore(root, { nowMs: () => nowMs });
    const fixture = buildFixture();
    const first = await store.stage({ ...fixture, signal: signal() });
    await expect(store.stage({ ...fixture, signal: signal() })).resolves.toEqual(first);

    const drifted = { ...fixture.plan, planId: "different-plan" };
    await expectCode(store.read({ plan: drifted, signal: signal() }), "conflict");
    const changedBytes = new Uint8Array(fixture.items[0]!.normalizedBytes);
    changedBytes[0] = (changedBytes[0] ?? 0) ^ 1;
    await expectCode(
      store.stage({
        plan: fixture.plan,
        items: [{ ...fixture.items[0]!, normalizedBytes: changedBytes }],
        signal: signal(),
      }),
      "tampered",
    );
  });

  it("marks expired leases unavailable and safely cleans only expired owned trees", async () => {
    const root = await temporaryRoot();
    let nowMs = Date.parse("2026-07-14T08:00:00.000Z");
    const store = new ExternalSourcePlanStagingStore(root, { nowMs: () => nowMs });
    const fixture = buildFixture();
    await store.stage({ ...fixture, signal: signal() });
    nowMs = Date.parse(fixture.plan.stagingExpiresAt) + 1;
    await expectCode(store.read({ plan: fixture.plan, signal: signal() }), "expired");
    await expect(store.cleanupExpired({ nowMs })).resolves.toBe(1);
    await expect(fs.stat(path.join(root, "leases", fixture.plan.stagingLeaseId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed for read, write, and delete when the leases ancestor is swapped to a link", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const nowMs = Date.parse("2026-07-14T08:00:00.000Z");
    const store = new ExternalSourcePlanStagingStore(root, { nowMs: () => nowMs });
    const fixture = buildFixture();
    await store.stage({ ...fixture, signal: signal() });
    const sentinelPath = path.join(outside, "outside-sentinel.txt");
    await fs.writeFile(sentinelPath, "outside must remain untouched", "utf8");

    const leasesDir = path.join(root, "leases");
    const ownedLeasesDir = path.join(root, "leases-owned");
    await fs.rename(leasesDir, ownedLeasesDir);
    await createDirectoryLink(outside, leasesDir);
    try {
      await expectCode(store.read({ plan: fixture.plan, signal: signal() }), "tampered");
      const { planSha256: _planSha256, ...planDraft } = fixture.plan;
      const secondPlan = sealExternalSourceImportPlan({
        ...planDraft,
        planId: "external-plan-2",
        stagingLeaseId: "external-stage-2",
      });
      await expectCode(store.stage({ plan: secondPlan, items: fixture.items, signal: signal() }), "tampered");
      await expectCode(store.discard(fixture.plan.stagingLeaseId), "tampered");
      await expectCode(store.cleanupExpired({ nowMs }), "tampered");
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("outside must remain untouched");
    } finally {
      await fs.unlink(leasesDir).catch(() => undefined);
      await fs.rename(ownedLeasesDir, leasesDir).catch(() => undefined);
    }
  });
});

function buildFixture() {
  const normalizedBytes = new Uint8Array(Buffer.from("normalized fixture payload", "utf8"));
  const normalizedArtifactSha256 = sha256(normalizedBytes);
  const item: ExternalSourceStagedItemInput = {
    itemId: "item-1",
    ordinal: 0,
    adapterId: "codex.memory-markdown.v1",
    adapterVersion: "1.0.0",
    producerVersion: "unversioned-markdown.v1",
    rawSha256: "b".repeat(64),
    rawByteCount: 48,
    normalizedArtifactSha256,
    normalizedByteCount: normalizedBytes.byteLength,
    normalizedBytes,
  };
  const plan = sealExternalSourceImportPlan({
    schemaVersion: EXTERNAL_SOURCE_SCHEMA_VERSION,
    planId: "external-plan-1",
    workspaceId: "workspace-1",
    sourceId: "source-1",
    scanId: "scan-1",
    configRevision: 1,
    configSha256: "c".repeat(64),
    manifestSha256: "d".repeat(64),
    adapterVersions: ["1.0.0"],
    selectedItemIds: [item.itemId],
    selectedItemSetSha256: computeExternalSourceSelectedItemSetSha256([item.itemId]),
    rawSetSha256: computeExternalSourceRawSetSha256([item]),
    rawByteCount: item.rawByteCount,
    normalizedSetSha256: computeExternalSourceNormalizedSetSha256([item]),
    normalizedByteCount: item.normalizedByteCount,
    messageCount: 1,
    blockerCodes: [],
    stagingLeaseId: "external-stage-1",
    stagingExpiresAt: "2026-07-14T08:30:00.000Z",
    createdAt: "2026-07-14T08:00:00.000Z",
  });
  return { plan, items: [item] };
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `external-source-staging-${randomUUID()}-`));
  roots.push(root);
  return root;
}

async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await fs.symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function expectCode(promise: Promise<unknown>, code: ExternalSourcePlanStagingStoreError["code"]): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExternalSourcePlanStagingStoreError);
    expect((error as ExternalSourcePlanStagingStoreError).code).toBe(code);
    return;
  }
  throw new Error(`Expected staging error ${code}.`);
}
