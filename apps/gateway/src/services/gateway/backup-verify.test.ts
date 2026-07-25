import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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

  it("rejects a checksum-valid payload whose SQLite database is corrupt", async () => {
    const backupPath = await createBackupFixture("corrupt-sqlite");

    const result = await verifyBackupAtPath(backupPath);

    expect(result.verified).toBe(false);
    expect(result.contractVerified).toBe(false);
    expect(result.filesVerified).toBe(4);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "sqlite_integrity_check_failed",
        path: "data/index.db",
      }),
    );
    expect(result.contractCoverage.minimumSet.database).toMatchObject({
      verified: false,
      missingPaths: ["data/index.db"],
    });
  });

  it("rejects a checksum-valid SQLite payload with foreign key violations", async () => {
    const backupPath = await createBackupFixture("foreign-key-violation");

    const result = await verifyBackupAtPath(backupPath);

    expect(result.verified).toBe(false);
    expect(result.contractVerified).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "sqlite_foreign_key_check_failed",
        path: "data/index.db",
      }),
    );
    expect(result.contractCoverage.minimumSet.database.verified).toBe(false);
  });

  it("keeps Postgres dump verification on the existing manifest checksum path", async () => {
    const backupPath = await createBackupFixture("postgres");

    const result = await verifyBackupAtPath(backupPath);

    expect(result).toMatchObject({
      verified: true,
      contractVerified: true,
      filesVerified: 4,
      issues: [],
    });
    expect(result.contractCoverage.minimumSet.database).toMatchObject({
      expectedPaths: ["database/postgres.dump"],
      verified: true,
    });
  });

  it("rejects a legacy SQLite payload using a noncanonical Windows-equivalent path spelling", async () => {
    const backupPath = await createBackupFixture("legacy-case-corrupt");

    const result = await verifyBackupAtPath(backupPath);

    expect(result.verified).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "manifest_invalid_path",
        path: "Data/index.db",
      }),
    );
  });

  it("returns canonical manifest paths when raw records use Windows separators", async () => {
    const backupPath = await createBackupFixture("postgres-backslash");

    const result = await verifyBackupAtPath(backupPath);

    expect(result.verified).toBe(true);
    expect(result.manifest?.files[0]?.path).toBe("database/postgres.dump");
    expect(result.contractCoverage.minimumSet.database.expectedPaths).toEqual(["database/postgres.dump"]);
  });
});

async function createBackupFixture(
  mode:
    | "valid"
    | "extra-file"
    | "traversal"
    | "legacy"
    | "contract-incomplete"
    | "corrupt-sqlite"
    | "foreign-key-violation"
    | "postgres"
    | "legacy-case-corrupt"
    | "postgres-backslash",
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-backup-verify-"));
  TEMP_ROOTS.push(root);
  const backupPath = path.join(root, "fixture.backup");
  await mkdir(path.join(backupPath, "payload", "data", "transcripts"), { recursive: true });
  await mkdir(path.join(backupPath, "payload", "data", "audit"), { recursive: true });
  await mkdir(path.join(backupPath, "payload", "config"), { recursive: true });

  const sqliteBytes =
    mode === "corrupt-sqlite" || mode === "legacy-case-corrupt"
      ? Buffer.from("this is not a sqlite database\n", "utf8")
      : await createSqliteDatabaseBytes(root, mode === "foreign-key-violation");
  const databaseFile =
    mode === "postgres" || mode === "postgres-backslash"
      ? {
          path: "database/postgres.dump",
          bytes: Buffer.from("opaque postgres custom dump bytes\n", "utf8"),
        }
      : {
          path: mode === "legacy-case-corrupt" ? "Data/index.db" : "data/index.db",
          bytes: sqliteBytes,
        };
  const manifestDatabasePath = mode === "postgres-backslash" ? "database\\postgres.dump" : databaseFile.path;

  const payloadFiles = [
    databaseFile,
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
      path:
        mode === "traversal" && entry.path === "data/index.db"
          ? "../outside.txt"
          : entry === databaseFile
            ? manifestDatabasePath
            : entry.path,
      sizeBytes: entry.bytes.length,
      sha256: createHash("sha256").update(entry.bytes).digest("hex"),
    })),
    ...(mode === "legacy" || mode === "legacy-case-corrupt"
      ? {}
      : {
          contractCoverage: {
            contractVersion: "1.0",
            minimumSet: {
              databasePaths: [manifestDatabasePath],
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

async function createSqliteDatabaseBytes(root: string, includeForeignKeyViolation: boolean): Promise<Buffer> {
  const databasePath = path.join(root, "source.db");
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE parents (parent_id INTEGER PRIMARY KEY);
      CREATE TABLE children (
        child_id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parents(parent_id)
      );
      INSERT INTO parents (parent_id) VALUES (1);
      INSERT INTO children (child_id, parent_id) VALUES (1, ${includeForeignKeyViolation ? 999 : 1});
    `);
  } finally {
    db.close();
  }
  return readFile(databasePath);
}
