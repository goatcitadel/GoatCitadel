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

describe("backup verification edge cases", () => {
  it("reports missing manifest and payload as contract-incomplete rather than verified", async () => {
    const backupPath = await createEmptyBackup();

    const result = await verifyBackupAtPath(backupPath);

    expect(result).toMatchObject({
      verified: false,
      contractVerified: false,
      filesVerified: 0,
      backupPath: path.resolve(backupPath),
    });
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["manifest_missing", "payload_missing"]),
    );
    expect(result.contractCoverage).toMatchObject({
      contractVersion: "1.0",
      legacyManifest: false,
      reasons: ["manifest_missing_or_invalid"],
      minimumSet: {
        database: {
          expectedPaths: [],
          verifiedPaths: [],
          missingPaths: [],
          verified: false,
        },
      },
    });
  });

  it("rejects invalid manifest JSON and non-object manifest records", async () => {
    const invalidJsonPath = await createEmptyBackup();
    await writeFile(path.join(invalidJsonPath, "manifest.json"), "{not json", "utf8");
    await mkdir(path.join(invalidJsonPath, "payload"), { recursive: true });

    const invalidJson = await verifyBackupAtPath(invalidJsonPath);
    expect(invalidJson.issues.map((issue) => issue.code)).toContain("manifest_invalid_json");
    expect(invalidJson.manifest).toBeUndefined();

    const nonObjectPath = await createEmptyBackup();
    await writeFile(path.join(nonObjectPath, "manifest.json"), "[]", "utf8");
    await mkdir(path.join(nonObjectPath, "payload"), { recursive: true });

    const nonObject = await verifyBackupAtPath(nonObjectPath);
    expect(nonObject.issues.map((issue) => issue.code)).toContain("manifest_invalid_shape");
    expect(nonObject.manifest).toBeUndefined();
  });

  it("keeps verifying valid files while flagging duplicate, invalid, size, checksum, and contract metadata issues", async () => {
    const backupPath = await createEmptyBackup();
    const payloadPath = path.join(backupPath, "payload");
    await mkdir(path.join(payloadPath, "data"), { recursive: true });
    await mkdir(path.join(payloadPath, "config"), { recursive: true });
    const validBytes = Buffer.from("valid database\n", "utf8");
    const wrongSizeBytes = Buffer.from("wrong size\n", "utf8");
    const wrongHashBytes = Buffer.from("wrong hash\n", "utf8");
    await writeFile(path.join(payloadPath, "data", "index.db"), validBytes);
    await writeFile(path.join(payloadPath, "data", "wrong-size.db"), wrongSizeBytes);
    await writeFile(path.join(payloadPath, "data", "wrong-hash.db"), wrongHashBytes);
    await writeFile(path.join(payloadPath, "config", "settings.json"), "{}", "utf8");

    await writeFile(
      path.join(backupPath, "manifest.json"),
      JSON.stringify(
        {
          backupId: "edge-1",
          createdAt: "2026-05-15T01:00:00.000Z",
          appVersion: "1.0.0",
          rootDir: "F:/code/personal-ai",
          files: [
            {
              path: "data/index.db",
              sizeBytes: validBytes.length,
              sha256: createHash("sha256").update(validBytes).digest("hex"),
            },
            {
              path: "data/index.db",
              sizeBytes: validBytes.length,
              sha256: createHash("sha256").update(validBytes).digest("hex"),
            },
            {
              path: "",
              sizeBytes: 0,
              sha256: "empty",
            },
            {
              path: "data/wrong-size.db",
              sizeBytes: wrongSizeBytes.length + 100,
              sha256: createHash("sha256").update(wrongSizeBytes).digest("hex"),
            },
            {
              path: "data/wrong-hash.db",
              sizeBytes: wrongHashBytes.length,
              sha256: "0".repeat(64),
            },
            {
              path: "config/settings.json",
              sizeBytes: "{}".length,
              sha256: createHash("sha256").update("{}", "utf8").digest("hex"),
            },
            {
              path: "manifest-invalid-record",
              sizeBytes: Number.NaN,
              sha256: "bad",
            },
          ],
          contractCoverage: {
            contractVersion: "1.0",
            minimumSet: {
              databasePaths: ["data/index.db", "../escape.db", 12],
              transcriptPaths: [],
              auditPaths: ["data/audit/missing.jsonl"],
              configPaths: ["config/settings.json"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await verifyBackupAtPath(backupPath);

    expect(result.verified).toBe(false);
    expect(result.contractVerified).toBe(false);
    expect(result.filesVerified).toBe(2);
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "manifest_duplicate_path",
        "manifest_invalid_path",
        "manifest_invalid_file_record",
        "payload_size_mismatch",
        "payload_sha256_mismatch",
        "manifest_invalid_contract_coverage",
      ]),
    );
    expect(result.contractCoverage.reasons).toEqual(
      expect.arrayContaining([
        "payload_integrity_failed",
        "minimum_set_transcripts_missing",
        "minimum_set_audit_incomplete",
      ]),
    );
    expect(result.contractCoverage.minimumSet.database.expectedPaths).toEqual(["data/index.db"]);
    expect(result.contractCoverage.minimumSet.config.verified).toBe(true);
  });
});

async function createEmptyBackup(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-verify-loop27-"));
  TEMP_ROOTS.push(root);
  const backupPath = path.join(root, "fixture.backup");
  await mkdir(backupPath, { recursive: true });
  return backupPath;
}
