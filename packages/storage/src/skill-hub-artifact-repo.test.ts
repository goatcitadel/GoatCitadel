import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalJsonString, skillHubArtifactBundleRelPath } from "@goatcitadel/contracts";
import type { SkillContentIntegrityManifest, SkillHubSnapshotArtifactRecord } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import {
  SkillHubArtifactRepository,
  computeSkillHubManifestSha256,
  computeSkillHubTreeSha256,
} from "./skill-hub-artifact-repo.js";
import { SkillHubSnapshotRepository, type SkillHubSnapshotCreateInput } from "./skill-hub-snapshot-repo.js";
import { createDatabase } from "./sqlite.js";

const opened: DatabaseClient[] = [];
const files: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const file of files.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

describe("SkillHubArtifactRepository", () => {
  it("binds one immutable exact-byte artifact to its snapshot tree", () => {
    const { db, artifacts } = createStore();
    const manifest = manifestFor("SKILL.md", "exact bytes\n");
    createSnapshot(db, "snapshot-1", manifest.treeSha256);
    const input = artifact("artifact-1", "snapshot-1", manifest);

    assert.deepEqual(artifacts.create(input), input);
    assert.deepEqual(artifacts.create(input), input);
    assert.deepEqual(artifacts.findBySnapshot("workspace-1", "snapshot-1"), input);
    assert.deepEqual(artifacts.listByTree("workspace-1", manifest.treeSha256), [input]);

    assert.throws(
      () => artifacts.create({ ...input, bundleRelPath: skillHubArtifactBundleRelPath("f".repeat(64)) }),
      /canonical content-addressed path/,
    );
    assert.throws(
      () => db.prepare("UPDATE skill_hub_snapshot_artifacts SET total_bytes = total_bytes + 1").run(),
      /snapshot artifacts are immutable/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM skill_hub_snapshot_artifacts").run(),
      /snapshot artifacts are immutable/,
    );
  });

  it("rejects foreign trees and conflicting replays at the database boundary", () => {
    const { db, artifacts } = createStore();
    const manifest = manifestFor("SKILL.md", "v1\n");
    const other = manifestFor("SKILL.md", "v2\n");
    createSnapshot(db, "snapshot-1", manifest.treeSha256);
    const input = artifact("artifact-1", "snapshot-1", manifest);
    artifacts.create(input);

    assert.throws(() => artifacts.create({ ...input, artifactId: "artifact-2" }), /conflicts with an immutable record/);
    assert.throws(() =>
      db
        .prepare(
          `
            INSERT INTO skill_hub_snapshot_artifacts (
              artifact_id, workspace_id, snapshot_id, content_tree_sha256, bundle_rel_path,
              manifest_version, manifest_json, manifest_sha256, file_count, total_bytes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          "artifact-foreign",
          "workspace-1",
          "snapshot-1",
          other.treeSha256,
          skillHubArtifactBundleRelPath(other.treeSha256),
          other.manifestVersion,
          canonicalJsonString(other),
          computeSkillHubManifestSha256(other),
          other.fileCount,
          other.totalBytes,
          "2026-07-13T18:01:00.000Z",
        ),
    );
  });

  it("rejects a snapshot artifact linked through a different workspace", () => {
    const { db, artifacts } = createStore();
    const manifest = manifestFor("SKILL.md", "workspace bytes\n");
    createSnapshot(db, "snapshot-workspace-2", manifest.treeSha256, "workspace-2");

    assert.throws(
      () => artifacts.create(artifact("artifact-cross-workspace", "snapshot-workspace-2", manifest)),
      /same workspace|FOREIGN KEY/,
    );
    assert.equal(artifacts.findBySnapshot("workspace-2", "snapshot-workspace-2"), undefined);
  });
});

function createStore(): { db: DatabaseClient; artifacts: SkillHubArtifactRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-skill-hub-artifact-${randomUUID()}.db`);
  files.push(dbPath);
  const db = createDatabase({ dbPath });
  opened.push(db);
  return { db, artifacts: new SkillHubArtifactRepository(db) };
}

function manifestFor(filePath: string, content: string): SkillContentIntegrityManifest {
  const file = {
    path: filePath,
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bytes: Buffer.byteLength(content, "utf8"),
  };
  const initial: SkillContentIntegrityManifest = {
    manifestVersion: "goatcitadel.skill-tree.v1",
    algorithm: "sha256",
    treeSha256: "0".repeat(64),
    fileCount: 1,
    totalBytes: file.bytes,
    excludedPaths: ["source.json", ".git/**"],
    files: [file],
  };
  return { ...initial, treeSha256: computeSkillHubTreeSha256(initial) };
}

function artifact(
  artifactId: string,
  snapshotId: string,
  manifest: SkillContentIntegrityManifest,
): SkillHubSnapshotArtifactRecord {
  return {
    artifactId,
    workspaceId: "workspace-1",
    snapshotId,
    contentTreeSha256: manifest.treeSha256,
    bundleRelPath: skillHubArtifactBundleRelPath(manifest.treeSha256),
    manifest,
    manifestSha256: computeSkillHubManifestSha256(manifest),
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    createdAt: "2026-07-13T18:00:00.000Z",
  };
}

function createSnapshot(db: DatabaseClient, snapshotId: string, treeSha256: string, workspaceId = "workspace-1"): void {
  const audit = {
    policyId: "skill-import",
    policyVersion: "2.0.0",
    policyRevision: 2,
    scanners: [{ scannerId: "static", scannerVersion: "2.0.0", revision: 2, coverageIds: ["scripts"] }],
    findingCodes: [],
    blockerCodes: [],
    approvedBlockerResolutions: [],
  };
  const permissionEnvelope = {
    version: "goatcitadel.skill-permission-envelope.v1" as const,
    toolIds: [],
    environmentVariableNames: [],
    networkOrigins: [],
    filesystem: { readScopes: [], writeScopes: [] },
    scripts: [],
    dependencies: { packages: [], nativeRequirements: [] },
  };
  const empty = () => ({ added: [], removed: [] });
  const input: SkillHubSnapshotCreateInput = {
    snapshotId,
    workspaceId,
    operation: "review",
    sourceProvider: "github",
    sourceType: "git_url",
    sourceRef: `https://github.com/owner/repo.git#${snapshotId}`,
    canonicalSourceKey: `github:owner/repo:skill/${snapshotId}`,
    declaredVersion: "v1.0.0",
    resolvedVersion: snapshotId,
    contentTreeSha256: treeSha256,
    provenance: { capturedBy: "test" },
    audit,
    auditSha256: hashJson(audit),
    permissionEnvelope,
    permissionEnvelopeSha256: hashJson(permissionEnvelope),
    permissionDiff: {
      version: "goatcitadel.skill-permission-diff.v1",
      disposition: "none",
      dimensions: {
        toolIds: empty(),
        environmentVariableNames: empty(),
        networkOrigins: empty(),
        filesystemReadScopes: empty(),
        filesystemWriteScopes: empty(),
        scripts: empty(),
        packages: empty(),
        nativeRequirements: empty(),
      },
    },
    compatibility: { platform: "all" },
    riskLevel: "low",
    trustDisposition: "candidate",
    blockerCodes: [],
    createdAt: "2026-07-13T17:59:00.000Z",
  };
  new SkillHubSnapshotRepository(db).create(input);
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(canonicalJsonString(value), "utf8").digest("hex");
}
