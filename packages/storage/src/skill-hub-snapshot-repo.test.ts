import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalJsonString, diffSkillPermissionEnvelopes } from "@goatcitadel/contracts";
import type { SkillPermissionEnvelopeV1 } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { SkillHubSnapshotRepository, type SkillHubSnapshotCreateInput } from "./skill-hub-snapshot-repo.js";
import { createDatabase } from "./sqlite.js";

const createdFiles: string[] = [];
const openedDatabases: DatabaseClient[] = [];
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

afterEach(() => {
  for (const db of openedDatabases.splice(0)) db.close();
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Best-effort cleanup only; assertions own test outcomes.
    }
  }
});

function createStore(): { db: DatabaseClient; repo: SkillHubSnapshotRepository; dbPath: string } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-hub-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  openedDatabases.push(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_hub_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      source_provider TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      canonical_source_key TEXT NOT NULL,
      declared_version TEXT,
      resolved_version TEXT,
      content_tree_sha256 TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      audit_json TEXT NOT NULL,
      audit_sha256 TEXT NOT NULL,
      permission_envelope_json TEXT NOT NULL,
      permission_envelope_sha256 TEXT NOT NULL,
      permission_diff_json TEXT NOT NULL,
      compatibility_json TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      trust_disposition TEXT NOT NULL,
      prior_snapshot_id TEXT,
      blocker_codes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_hub_version_claims (
      workspace_id TEXT NOT NULL,
      canonical_source_key TEXT NOT NULL,
      version_kind TEXT NOT NULL,
      version_value TEXT NOT NULL,
      first_tree_sha256 TEXT NOT NULL,
      first_snapshot_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, canonical_source_key, version_kind, version_value)
    );
  `);
  return { db, repo: new SkillHubSnapshotRepository(db), dbPath };
}

function snapshot(overrides: Partial<SkillHubSnapshotCreateInput> = {}): SkillHubSnapshotCreateInput {
  const audit = overrides.audit ?? {
    policyId: "skill-import",
    policyVersion: "2.0.0",
    policyRevision: 2,
    scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts", "secrets"] }],
    findingCodes: [],
    blockerCodes: [],
    approvedBlockerResolutions: [],
  };
  const permissionEnvelope = overrides.permissionEnvelope ?? {
    version: "goatcitadel.skill-permission-envelope.v1",
    toolIds: [],
    environmentVariableNames: [],
    networkOrigins: [],
    filesystem: { readScopes: [], writeScopes: [] },
    scripts: [],
    dependencies: { packages: [], nativeRequirements: [] },
  };
  const emptyDimension = () => ({ added: [], removed: [] });
  const base: SkillHubSnapshotCreateInput = {
    snapshotId: "snapshot-1",
    workspaceId: "workspace-1",
    operation: "review",
    sourceProvider: "github",
    sourceType: "git_url",
    sourceRef: "https://github.com/owner/repo.git#main",
    canonicalSourceKey: "github:owner/repo:skill/demo",
    declaredVersion: "v1.0.0",
    resolvedVersion: "1".repeat(40),
    contentTreeSha256: SHA_A,
    provenance: { capturedBy: "gateway" },
    audit,
    auditSha256: hashJson(audit),
    permissionEnvelope,
    permissionEnvelopeSha256: hashJson(permissionEnvelope),
    permissionDiff: {
      version: "goatcitadel.skill-permission-diff.v1",
      disposition: "none",
      dimensions: {
        toolIds: emptyDimension(),
        environmentVariableNames: emptyDimension(),
        networkOrigins: emptyDimension(),
        filesystemReadScopes: emptyDimension(),
        filesystemWriteScopes: emptyDimension(),
        scripts: emptyDimension(),
        packages: emptyDimension(),
        nativeRequirements: emptyDimension(),
      },
    },
    compatibility: { callability: "governed_candidate" },
    riskLevel: "low",
    trustDisposition: "candidate",
    blockerCodes: [],
    createdAt: "2026-07-13T12:00:00.000Z",
  };
  return {
    ...base,
    ...overrides,
    audit,
    auditSha256: overrides.auditSha256 ?? hashJson(audit),
    permissionEnvelope,
    permissionEnvelopeSha256: overrides.permissionEnvelopeSha256 ?? hashJson(permissionEnvelope),
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}

describe("SkillHubSnapshotRepository", () => {
  it("enumerates deterministically inside workspace scope before applying the bound", () => {
    const { repo } = createStore();
    repo.create(snapshot({ snapshotId: "workspace-a-1", workspaceId: "workspace-a" }));
    repo.create(
      snapshot({
        snapshotId: "workspace-a-2",
        workspaceId: "workspace-a",
        priorSnapshotId: "workspace-a-1",
        createdAt: "2026-07-13T12:02:00.000Z",
      }),
    );
    repo.create(
      snapshot({
        snapshotId: "workspace-b-1",
        workspaceId: "workspace-b",
        createdAt: "2026-07-13T12:03:00.000Z",
      }),
    );
    repo.create(
      snapshot({
        snapshotId: "workspace-a-3",
        workspaceId: "workspace-a",
        priorSnapshotId: "workspace-a-2",
        createdAt: "2026-07-13T12:02:00.000Z",
      }),
    );

    assert.deepEqual(
      repo.listByWorkspace("workspace-a", 2).map((item) => item.snapshotId),
      ["workspace-a-3", "workspace-a-2"],
    );
    assert.deepEqual(
      repo.listByWorkspace("workspace-b", 2).map((item) => item.snapshotId),
      ["workspace-b-1"],
    );
  });

  it("retains same-version different-byte snapshots and forces the new record blocked", () => {
    const { repo } = createStore();
    repo.create(snapshot());
    const drift = repo.create(
      snapshot({
        snapshotId: "snapshot-2",
        operation: "update_stage",
        priorSnapshotId: "snapshot-1",
        contentTreeSha256: SHA_B,
        createdAt: "2026-07-13T12:01:00.000Z",
      }),
    );

    assert.equal(drift.trustDisposition, "blocked");
    assert.deepEqual(drift.blockerCodes, ["UPSTREAM_VERSION_BYTE_DRIFT"]);
    assert.equal(repo.findSameVersionByteDrift(drift)?.snapshotId, "snapshot-1");
    assert.deepEqual(
      repo.listBySource("workspace-1", "github:owner/repo:skill/demo").map((item) => item.snapshotId),
      ["snapshot-2", "snapshot-1"],
    );
  });

  it("is idempotent for exact records and rejects mutation under a reused snapshot ID", () => {
    const { repo } = createStore();
    const input = snapshot();
    const stored = repo.create(input);
    assert.deepEqual(repo.create(input), stored);
    assert.deepEqual(stored.auditFloor, {
      version: "goatcitadel.skill-upstream-audit-floor.v1",
      policyId: "skill-import",
      policyVersion: "2.0.0",
      policyRevision: 2,
      scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts", "secrets"] }],
      effectiveBlockerCodes: [],
    });
    assert.equal(stored.auditFloorSha256, hashJson(stored.auditFloor));
    assert.throws(
      () =>
        repo.create(
          snapshot({
            audit: {
              ...snapshot().audit,
              policyRevision: 1,
              blockerCodes: ["AUDIT_DOWNGRADE"],
            },
          }),
        ),
      /conflicts with an existing immutable record/,
    );
    assert.equal(repo.get("snapshot-1").audit.policyRevision, 2);
  });

  it("forces any blocked audit or permission assessment into a non-callable disposition", () => {
    const { repo } = createStore();
    const stored = repo.create(
      snapshot({
        blockerCodes: ["PERMISSION_WIDENED", "AUDIT_DOWNGRADE"],
        trustDisposition: "candidate",
      }),
    );
    assert.equal(stored.trustDisposition, "blocked");
    assert.deepEqual(stored.blockerCodes, ["AUDIT_DOWNGRADE", "PERMISSION_WIDENED"]);
  });

  it("rejects raw content, secret-shaped keys, and oversized audit compatibility payloads", () => {
    const { repo } = createStore();
    assert.throws(
      () => repo.create(snapshot({ compatibility: { rawText: "candidate body" } })),
      /forbidden or invalid key/,
    );
    assert.throws(() => repo.create(snapshot({ provenance: { token: "not-allowed" } })), /forbidden or invalid key/);
    assert.throws(() => repo.create(snapshot({ compatibility: { notes: "x".repeat(2_049) } })), /oversized string/);
    assert.equal(repo.find("snapshot-1"), undefined);
  });

  it("recomputes canonical audit and permission hashes and fails closed on row tampering", () => {
    const { db, repo } = createStore();
    assert.throws(() => repo.create(snapshot({ auditSha256: SHA_A })), /audit hash does not match canonical JSON/);
    assert.throws(
      () => repo.create(snapshot({ permissionEnvelopeSha256: SHA_B })),
      /permission envelope hash does not match canonical JSON/,
    );
    repo.create(snapshot());
    db.exec("DROP TRIGGER IF EXISTS trg_skill_hub_snapshots_no_update");
    db.prepare("UPDATE skill_hub_snapshots SET audit_json = ? WHERE snapshot_id = ?").run(
      JSON.stringify({ policyId: "forged" }),
      "snapshot-1",
    );
    assert.throws(() => repo.get("snapshot-1"), /audit details are malformed/);
  });

  it("uses database version claims across repository instances instead of process-local state", () => {
    const { repo, dbPath } = createStore();
    repo.create(snapshot());
    const secondDb = createDatabase({ dbPath });
    openedDatabases.push(secondDb);
    const secondRepo = new SkillHubSnapshotRepository(secondDb);
    const drift = secondRepo.create(
      snapshot({
        snapshotId: "snapshot-other-writer",
        contentTreeSha256: SHA_B,
        operation: "update_stage",
        priorSnapshotId: "snapshot-1",
        createdAt: "2026-07-13T12:02:00.000Z",
      }),
    );
    assert.equal(drift.trustDisposition, "blocked");
    assert.deepEqual(drift.blockerCodes, ["UPSTREAM_VERSION_BYTE_DRIFT"]);
    assert.equal(
      secondDb.prepare("SELECT COUNT(*) AS count FROM skill_hub_version_claims").get<{ count: number }>()?.count,
      2,
    );
  });

  it("persists a source-scoped monotonic audit floor across downgrade bounce attempts", () => {
    const { db, repo } = createStore();
    const revision10 = {
      ...snapshot().audit,
      policyVersion: "10.0.0",
      policyRevision: 10,
      scanners: [{ scannerId: "static", scannerVersion: "10.0.0", revision: 10, coverageIds: ["scripts", "secrets"] }],
    };
    const first = repo.create(snapshot({ audit: revision10, auditSha256: hashJson(revision10) }));
    assert.deepEqual(first.blockerCodes, []);

    const revision5 = {
      ...revision10,
      policyVersion: "5.0.0",
      policyRevision: 5,
      scanners: [{ scannerId: "static", scannerVersion: "5.0.0", revision: 5, coverageIds: ["scripts"] }],
    };
    const downgraded = repo.create(
      snapshot({
        snapshotId: "snapshot-5",
        priorSnapshotId: "snapshot-1",
        audit: revision5,
        auditSha256: hashJson(revision5),
        createdAt: "2026-07-13T12:05:00.000Z",
      }),
    );
    assert.deepEqual(downgraded.blockerCodes, ["AUDIT_DOWNGRADE"]);
    assert.equal(downgraded.auditFloor.policyRevision, 10);

    const revision6 = {
      ...revision10,
      policyVersion: "6.0.0",
      policyRevision: 6,
      scanners: [{ scannerId: "static", scannerVersion: "6.0.0", revision: 6, coverageIds: [] }],
    };
    const bounced = repo.create(
      snapshot({
        snapshotId: "snapshot-6",
        priorSnapshotId: "snapshot-5",
        audit: revision6,
        auditSha256: hashJson(revision6),
        createdAt: "2026-07-13T12:06:00.000Z",
      }),
    );
    assert.deepEqual(bounced.blockerCodes, ["AUDIT_DOWNGRADE", "AUDIT_MISSING"]);
    assert.equal(bounced.auditFloor.policyRevision, 10);
    assert.deepEqual(bounced.auditFloor.scanners[0]?.coverageIds, ["scripts", "secrets"]);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM skill_hub_audit_floors").get<{ count: number }>()?.count, 1);
  });

  it("rejects direct SQL floor downgrades and fails closed on a forged floor hash", () => {
    const { db, repo } = createStore();
    repo.create(snapshot());
    const floor = db.prepare("SELECT floor_json FROM skill_hub_audit_floors").get<{ floor_json: string }>();
    assert.ok(floor);
    const parsed = JSON.parse(floor.floor_json) as Record<string, unknown>;
    const downgraded = { ...parsed, policyRevision: 1, effectiveBlockerCodes: [] };
    assert.throws(
      () =>
        db
          .prepare("UPDATE skill_hub_audit_floors SET floor_json = ?, floor_sha256 = ?")
          .run(canonicalJsonString(downgraded), hashJson(downgraded)),
      /audit floors are monotonic/,
    );

    db.exec("DROP TRIGGER IF EXISTS trg_skill_hub_audit_floors_monotonic_guard");
    db.prepare("UPDATE skill_hub_audit_floors SET floor_sha256 = ?").run(SHA_C);
    assert.throws(
      () =>
        repo.create(
          snapshot({
            snapshotId: "snapshot-forged-floor",
            priorSnapshotId: "snapshot-1",
            createdAt: "2026-07-13T12:10:00.000Z",
          }),
        ),
      /audit floor hash does not match canonical JSON/,
    );
  });

  it("recomputes permission diffs, blocks widening, and rejects stale or forged lineage", () => {
    const { db, repo } = createStore();
    const first = repo.create(snapshot());
    const widenedEnvelope: SkillPermissionEnvelopeV1 = {
      ...(first.permissionEnvelope as unknown as SkillPermissionEnvelopeV1),
      toolIds: ["memory.read"],
    };
    const exactDiff = diffSkillPermissionEnvelopes(
      first.permissionEnvelope as unknown as SkillPermissionEnvelopeV1,
      widenedEnvelope,
    );
    assert.throws(
      () =>
        repo.create(
          snapshot({
            snapshotId: "snapshot-forged-diff",
            priorSnapshotId: "snapshot-1",
            operation: "update_stage",
            permissionEnvelope: widenedEnvelope as unknown as Record<string, unknown>,
            permissionEnvelopeSha256: hashJson(widenedEnvelope),
            createdAt: "2026-07-13T12:01:00.000Z",
          }),
        ),
      /permission diff does not match/,
    );

    const widened = repo.create(
      snapshot({
        snapshotId: "snapshot-widened",
        priorSnapshotId: "snapshot-1",
        operation: "update_stage",
        permissionEnvelope: widenedEnvelope as unknown as Record<string, unknown>,
        permissionEnvelopeSha256: hashJson(widenedEnvelope),
        permissionDiff: exactDiff as unknown as Record<string, unknown>,
        createdAt: "2026-07-13T12:02:00.000Z",
      }),
    );
    assert.equal(widened.trustDisposition, "blocked");
    assert.ok(widened.blockerCodes.includes("PERMISSION_WIDENED"));

    const rollbackEnvelope = first.permissionEnvelope as unknown as SkillPermissionEnvelopeV1;
    const rollbackDiff = diffSkillPermissionEnvelopes(widenedEnvelope, rollbackEnvelope);
    const revoked = repo.create(
      snapshot({
        snapshotId: "snapshot-revoked",
        priorSnapshotId: "snapshot-widened",
        operation: "rollback_check",
        permissionEnvelope: rollbackEnvelope as unknown as Record<string, unknown>,
        permissionEnvelopeSha256: hashJson(rollbackEnvelope),
        permissionDiff: rollbackDiff as unknown as Record<string, unknown>,
        trustDisposition: "revoked",
        createdAt: "2026-07-13T12:03:00.000Z",
      }),
    );
    assert.equal(revoked.trustDisposition, "revoked");
    assert.equal(revoked.permissionDiff.disposition, "narrowed");

    assert.throws(
      () =>
        repo.create(
          snapshot({
            snapshotId: "snapshot-stale",
            priorSnapshotId: "snapshot-1",
            operation: "rollback_check",
            createdAt: "2026-07-13T12:04:00.000Z",
          }),
        ),
      /latest prior snapshot snapshot-revoked/,
    );

    db.exec("DROP TRIGGER IF EXISTS trg_skill_hub_snapshots_no_update");
    db.prepare("UPDATE skill_hub_snapshots SET permission_diff_json = ? WHERE snapshot_id = ?").run(
      JSON.stringify(snapshot().permissionDiff),
      "snapshot-widened",
    );
    assert.throws(() => repo.get("snapshot-widened"), /permission diff does not match/);
  });

  it("rejects a self-consistent but lineage-forged audit floor on read", () => {
    const { db, repo } = createStore();
    const stored = repo.create(snapshot());
    const forgedFloor = {
      ...stored.auditFloor,
      policyVersion: "99.0.0",
      policyRevision: 99,
    };
    db.exec("DROP TRIGGER IF EXISTS trg_skill_hub_snapshots_no_update");
    db.prepare("UPDATE skill_hub_snapshots SET audit_floor_json = ?, audit_floor_sha256 = ? WHERE snapshot_id = ?").run(
      canonicalJsonString(forgedFloor),
      hashJson(forgedFloor),
      "snapshot-1",
    );
    assert.throws(() => repo.get("snapshot-1"), /audit floor does not match its immutable source lineage/);
  });
});
