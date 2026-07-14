import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ExternalSourceDetailResponse,
  ExternalSourceListResponse,
  ExternalSourcePage,
  ExternalSourceScanRecord,
  WorkspacePathBridgeSnapshotRecord,
} from "@goatcitadel/contracts";
import {
  SYNTHETIC_CODEX_PRODUCER_VERSION,
  SYNTHETIC_CODEX_ROLLOUT_JSONL,
  SYNTHETIC_SESSION_ID,
} from "./services/external-source-adapters/fixtures/synthetic-fixtures.js";
import { buildApp } from "./app.js";

const TOKEN = "external-source-smoke-token-1234567890";
const SECOND_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const ENV_KEYS = [
  "GATEWAY_HOST",
  "NODE_ENV",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_INTERNAL_HX407_EXTERNAL_SOURCES_PROOF_ENABLED",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
] as const;
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];

describe("HX-407 external source production composition", { timeout: 90_000 }, () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("registers a verified root, seals a bounded scan, and pages immutable content-free catalog evidence", async () => {
    const configRoot = configureGateway();
    const sourceRoot = createSyntheticCodexRoot(configRoot);
    const gatedApp = await buildApp();
    try {
      const unavailable = await gatedApp.inject({
        method: "GET",
        url: "/api/v1/library/external-sources?workspaceId=default",
        headers: operatorHeaders(),
      });
      expect(unavailable.statusCode).toBe(404);
    } finally {
      await gatedApp.close();
    }
    process.env.GOATCITADEL_INTERNAL_HX407_EXTERNAL_SOURCES_PROOF_ENABLED = "1";
    process.env.NODE_ENV = "production";
    const productionApp = await buildApp();
    try {
      const productionUnavailable = await productionApp.inject({
        method: "GET",
        url: "/api/v1/library/external-sources?workspaceId=default",
        headers: operatorHeaders(),
      });
      expect(productionUnavailable.statusCode).toBe(404);
    } finally {
      await productionApp.close();
    }
    process.env.NODE_ENV = "test";
    const app = await buildApp();
    try {
      const unauthorized = await app.inject({
        method: "GET",
        url: "/api/v1/library/external-sources?workspaceId=default",
      });
      expect(unauthorized.statusCode).toBe(401);

      const verificationId = "external-source-binding-1";
      const verifiedResponse = await app.inject({
        method: "POST",
        url: "/api/v1/ops/workspace-path-bridges/resolve",
        headers: mutationHeaders("path-verify-1"),
        payload: {
          verificationId,
          workspaceId: "default",
          inputPath: sourceRoot,
          inputFlavor: "windows_native",
          targetFlavor: "windows_native",
          requireGitIdentity: false,
        },
      });
      expect(verifiedResponse.statusCode).toBe(200);
      const snapshot = verifiedResponse.json() as WorkspacePathBridgeSnapshotRecord;
      expect(snapshot).toMatchObject({
        snapshotId: verificationId,
        workspaceId: "default",
        status: "verified",
        callable: true,
        canonicalHostPath: sourceRoot,
      });

      const registration = {
        workspaceId: "default",
        expectedWorkspaceRevision: 1,
        kind: "codex_sessions" as const,
        label: "Synthetic Codex sessions",
        canonicalRootPath: snapshot.canonicalHostPath!,
        pathBridgeSnapshotId: snapshot.snapshotId,
        pathBridgeSnapshotSha256: snapshot.snapshotSha256,
        inputFlavor: snapshot.inputFlavor,
        targetFlavor: snapshot.targetFlavor,
        requireGitIdentity: false,
        acceptedProducerVersions: [SYNTHETIC_CODEX_PRODUCER_VERSION],
      };
      const forgedActor = await app.inject({
        method: "POST",
        url: "/api/v1/library/external-sources",
        headers: mutationHeaders("source-forged-1"),
        payload: {
          ...registration,
          ownerActorId: "attacker",
          rootGrantApprovalId: "fabricated-approval",
          ownershipAttestationSha256: digest("fabricated attestation"),
        },
      });
      expect(forgedActor.statusCode).toBe(400);

      const createResponse = await app.inject({
        method: "POST",
        url: "/api/v1/library/external-sources",
        headers: mutationHeaders("source-create-1"),
        payload: registration,
      });
      expect(createResponse.statusCode).toBe(201);
      expect(createResponse.headers["cache-control"]).toBe("no-store");
      const created = createResponse.json() as ExternalSourceDetailResponse;
      expect(created.source).toMatchObject({
        workspaceId: "default",
        kind: "codex_sessions",
        canonicalRootPath: sourceRoot,
        pathBridgeSnapshotId: snapshot.snapshotId,
        pathBridgeSnapshotSha256: snapshot.snapshotSha256,
        adapterId: "codex.rollout-jsonl.v1",
        adapterVersion: "1.0.0",
        revision: 1,
        status: "active",
      });
      expect(created.source.ownerActorId).toMatch(/^token:/u);
      expect(created.source.authActorId).toBe(created.source.ownerActorId);
      expect(created.source.authActorSource).toBe("token");

      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/library/external-sources?workspaceId=default",
        headers: operatorHeaders(),
      });
      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.headers["cache-control"]).toBe("no-store");
      expect(listResponse.headers["x-goatcitadel-execution-authority"]).toBe("none");
      const list = listResponse.json() as ExternalSourceListResponse;
      expect(list.items).toHaveLength(1);
      expect(listResponse.body).not.toContain(sourceRoot);
      expect(listResponse.body).not.toContain(created.source.ownerActorId);
      expect(listResponse.body).not.toContain(snapshot.snapshotId);

      const scanResponse = await app.inject({
        method: "POST",
        url: `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}/scans`,
        headers: mutationHeaders("source-scan-1"),
        payload: { workspaceId: "default", expectedRevision: 1 },
      });
      expect(scanResponse.statusCode).toBe(201);
      const scan = scanResponse.json() as ExternalSourceScanRecord;
      expect(scan).toMatchObject({
        workspaceId: "default",
        sourceId: created.source.sourceId,
        configRevision: 1,
        status: "sealed",
        examinedEntryCount: 6,
        itemCount: 2,
        supportedItemCount: 2,
        quarantinedItemCount: 0,
        blockerCodes: [],
      });

      const firstPageResponse = await app.inject({
        method: "GET",
        url: `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}/items?workspaceId=default&scanId=${encodeURIComponent(scan.scanId)}&dispositions=supported&limit=1`,
        headers: operatorHeaders(),
      });
      expect(firstPageResponse.statusCode).toBe(200);
      const firstPage = firstPageResponse.json() as ExternalSourcePage;
      expect(firstPage.items).toHaveLength(1);
      expect(firstPage.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/u);
      expect(firstPageResponse.body).not.toContain(sourceRoot);
      expect(firstPageResponse.body).not.toContain("Synthetic Codex user-visible request.");

      const changedLiveBytes = SYNTHETIC_CODEX_ROLLOUT_JSONL.replace(
        "Synthetic Codex user-visible request.",
        "SYNTHETIC_LIVE_MUTATION_AFTER_SEAL",
      );
      fs.writeFileSync(firstRolloutPath(sourceRoot), changedLiveBytes, "utf8");

      const secondPageResponse = await app.inject({
        method: "GET",
        url: `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}/items?workspaceId=default&scanId=${encodeURIComponent(scan.scanId)}&dispositions=supported&limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        headers: operatorHeaders(),
      });
      expect(secondPageResponse.statusCode).toBe(200);
      const secondPage = secondPageResponse.json() as ExternalSourcePage;
      expect(secondPage.items).toHaveLength(1);
      expect(secondPage.nextCursor).toBeUndefined();
      expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.itemId)).size).toBe(2);
      expect(secondPageResponse.body).not.toContain("SYNTHETIC_LIVE_MUTATION_AFTER_SEAL");

      const tamperedCursor = await app.inject({
        method: "GET",
        url: `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}/items?workspaceId=default&scanId=${encodeURIComponent(scan.scanId)}&dispositions=quarantined&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
        headers: operatorHeaders(),
      });
      expect(tamperedCursor.statusCode).toBe(400);
      expect(tamperedCursor.json()).toMatchObject({ code: "invalid_cursor" });

      const disabledResponse = await app.inject({
        method: "PATCH",
        url: `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}`,
        headers: mutationHeaders("source-disable-1"),
        payload: { workspaceId: "default", status: "disabled", expectedRevision: 1 },
      });
      expect(disabledResponse.statusCode).toBe(200);
      expect((disabledResponse.json() as ExternalSourceDetailResponse).source).toMatchObject({
        status: "disabled",
        revision: 2,
      });
      const disabledScan = await app.inject({
        method: "POST",
        url: `/api/v1/library/external-sources/${encodeURIComponent(created.source.sourceId)}/scans`,
        headers: mutationHeaders("source-disabled-scan-1"),
        payload: { workspaceId: "default", expectedRevision: 2 },
      });
      expect(disabledScan.statusCode).toBe(409);
      expect(disabledScan.json()).toMatchObject({ code: "source_not_active" });
    } finally {
      await app.close();
    }
  });
});

function configureGateway(): string {
  const root = createIsolatedConfigRoot();
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_ROOT_DIR = root;
  return root;
}

function createSyntheticCodexRoot(configRoot: string): string {
  const sourceRoot = path.resolve(configRoot, "workspace", "external-codex");
  const sessions = path.join(sourceRoot, "sessions", "2026", "07", "14");
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(firstRolloutPath(sourceRoot), SYNTHETIC_CODEX_ROLLOUT_JSONL, "utf8");
  fs.writeFileSync(
    path.join(sessions, `rollout-2026-07-14T00-01-00-${SECOND_SESSION_ID}.jsonl`),
    SYNTHETIC_CODEX_ROLLOUT_JSONL.replaceAll(SYNTHETIC_SESSION_ID, SECOND_SESSION_ID),
    "utf8",
  );
  return sourceRoot;
}

function firstRolloutPath(sourceRoot: string): string {
  return path.join(
    sourceRoot,
    "sessions",
    "2026",
    "07",
    "14",
    `rollout-2026-07-14T00-00-00-${SYNTHETIC_SESSION_ID}.jsonl`,
  );
}

function operatorHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}` };
}

function mutationHeaders(idempotencyKey: string): Record<string, string> {
  return { ...operatorHeaders(), "idempotency-key": idempotencyKey };
}

function createIsolatedConfigRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-external-sources-"));
  fs.cpSync(path.join(findRepoRoot(), "config"), path.join(root, "config"), { recursive: true });
  tempRoots.push(root);
  return root;
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
