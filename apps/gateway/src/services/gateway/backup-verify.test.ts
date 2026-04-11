import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { verifyBackupAtPath } from "./backup-verify.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("verifyBackupAtPath", () => {
  it("verifies a valid backup directory", async () => {
    const backupPath = await createBackupFixture("valid");
    const result = await verifyBackupAtPath(backupPath);
    expect(result.verified).toBe(true);
    expect(result.contractVerified).toBe(true);
    expect(result.filesVerified).toBe(4);
    expect(result.issues).toEqual([]);
    expect(result.contractCoverage.minimumSet.config.verified).toBe(true);
  });

  it("flags missing and unexpected payload files", async () => {
    const backupPath = await createBackupFixture("extra-file");
    const result = await verifyBackupAtPath(backupPath);
    expect(result.verified).toBe(false);
    expect(result.contractVerified).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("payload_untracked_file");
  });

  it("rejects manifest traversal paths", async () => {
    const backupPath = await createBackupFixture("traversal");
    const result = await verifyBackupAtPath(backupPath);
    expect(result.verified).toBe(false);
    expect(result.contractVerified).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain("manifest_invalid_path");
  });

  it("reports legacy manifests as integrity-verified but contract-incomplete", async () => {
    const backupPath = await createBackupFixture("legacy");
    const result = await verifyBackupAtPath(backupPath);
    expect(result.verified).toBe(true);
    expect(result.contractVerified).toBe(false);
    expect(result.contractCoverage.legacyManifest).toBe(true);
    expect(result.contractCoverage.reasons).toContain("legacy_manifest_missing_contract_coverage");
  });

  it("fails contract verification for manifest-valid backups that miss part of the minimum set", async () => {
    const backupPath = await createBackupFixture("contract-incomplete");
    const result = await verifyBackupAtPath(backupPath);
    expect(result.verified).toBe(true);
    expect(result.contractVerified).toBe(false);
    expect(result.contractCoverage.minimumSet.audit.verified).toBe(false);
    expect(result.contractCoverage.minimumSet.audit.expectedPaths).toEqual(["data/audit/missing.jsonl"]);
    expect(result.contractCoverage.minimumSet.audit.missingPaths).toEqual(["data/audit/missing.jsonl"]);
    expect(result.contractCoverage.reasons).toContain("minimum_set_audit_incomplete");
  });
});

async function createBackupFixture(
  mode: "valid" | "extra-file" | "traversal" | "legacy" | "contract-incomplete",
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-verify-"));
  TEMP_ROOTS.push(root);
  const backupPath = path.join(root, "fixture.backup");
  await mkdir(path.join(backupPath, "payload", "data", "transcripts"), { recursive: true });
  await mkdir(path.join(backupPath, "payload", "data", "audit"), { recursive: true });
  await mkdir(path.join(backupPath, "payload", "config"), { recursive: true });

  const payloadFiles = [
    {
      path: "data/index.db",
      bytes: Buffer.from("sqlite-backup\n", "utf8"),
    },
    {
      path: "data/transcripts/session.jsonl",
      bytes: Buffer.from('{"event":"transcript"}\n', "utf8"),
    },
    {
      path: "data/audit/audit.jsonl",
      bytes: Buffer.from('{"event":"audit"}\n', "utf8"),
    },
    {
      path: "config/llm-providers.json",
      bytes: Buffer.from('{"providers":[]}\n', "utf8"),
    },
  ];

  for (const entry of payloadFiles) {
    const fullPath = path.join(backupPath, "payload", entry.path);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, entry.bytes);
  }

  const manifest = {
    backupId: "fixture-1",
    createdAt: "2026-03-12T12:00:00.000Z",
    appVersion: "1.0.0",
    rootDir: "F:/code/personal-ai",
    files: payloadFiles.map((entry) => ({
      path: mode === "traversal" && entry.path === "data/index.db" ? "../outside.txt" : entry.path,
      sizeBytes: entry.bytes.length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
    ...(mode === "legacy"
      ? {}
      : {
          contractCoverage: {
            contractVersion: "1.0",
            minimumSet: {
              databasePaths: ["data/index.db"],
              transcriptPaths: ["data/transcripts/session.jsonl"],
              auditPaths: mode === "contract-incomplete" ? ["data/audit/missing.jsonl"] : ["data/audit/audit.jsonl"],
              configPaths: ["config/llm-providers.json"],
            },
          },
        }),
  };

  if (mode === "extra-file") {
    await writeFile(path.join(backupPath, "payload", "unexpected.txt"), "hello\n", "utf8");
  }

  await writeFile(path.join(backupPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return backupPath;
}
