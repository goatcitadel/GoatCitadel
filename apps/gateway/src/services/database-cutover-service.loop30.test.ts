import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __databaseCutoverServiceInternals } from "./database-cutover-service.js";

const tempRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("database cutover service loop30 internals", () => {
  it("counts JSONL source events and resolves explicit snapshot layouts", async () => {
    const root = await makeTempRoot();
    const dataDir = path.join(root, "data");
    const transcriptsDir = path.join(dataDir, "transcripts");
    const auditDir = path.join(dataDir, "audit");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(dataDir, "index.db"), "", "utf8");
    await fs.writeFile(path.join(transcriptsDir, "a.jsonl"), '{}\n\n {"ok":true}\n', "utf8");
    await fs.writeFile(path.join(transcriptsDir, "skip.txt"), "{}\n", "utf8");
    await fs.writeFile(path.join(auditDir, "approvals.jsonl"), "{}\n", "utf8");
    await fs.writeFile(path.join(auditDir, "hooks.jsonl"), "\n{}\n", "utf8");

    await expect(__databaseCutoverServiceInternals.countTranscriptEvents(transcriptsDir)).resolves.toBe(2);
    await expect(__databaseCutoverServiceInternals.countAuditEvents(auditDir)).resolves.toBe(2);
    await expect(__databaseCutoverServiceInternals.resolveExplicitSnapshot(root)).resolves.toEqual({
      rootDir: path.resolve(root),
      sqlitePath: path.join(path.resolve(root), "data", "index.db"),
      transcriptsDir: path.join(path.resolve(root), "data", "transcripts"),
      auditDir: path.join(path.resolve(root), "data", "audit"),
    });

    const backupRoot = await makeTempRoot();
    await fs.mkdir(path.join(backupRoot, "payload"), { recursive: true });
    await expect(__databaseCutoverServiceInternals.resolveExplicitSnapshot(backupRoot)).resolves.toMatchObject({
      rootDir: path.join(path.resolve(backupRoot), "payload"),
      sqlitePath: path.join(path.resolve(backupRoot), "payload", "data", "index.db"),
    });
  });

  it("keeps malformed JSONL visible while ignoring unsafe event rows", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(__databaseCutoverServiceInternals.countNonEmptyLines(" a \n\n b\r\n")).toBe(2);
    expect(__databaseCutoverServiceInternals.parseJsonLine('{"eventId":"e1"}', "events.jsonl", 1)).toEqual({
      eventId: "e1",
    });
    expect(__databaseCutoverServiceInternals.parseJsonLine("[1,2,3]", "events.jsonl", 2)).toBeUndefined();
    expect(__databaseCutoverServiceInternals.parseJsonLine("{", "events.jsonl", 3)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("orders tables by foreign-key dependencies and falls back deterministically for cycles", () => {
    const parent = table("parent");
    const child = table("child", ["parent"]);
    const cycleA = table("cycle_a", ["cycle_b"]);
    const cycleB = table("cycle_b", ["cycle_a"]);

    expect(__databaseCutoverServiceInternals.topologicallySortTables([child, parent]).map((item) => item.name)).toEqual(
      ["parent", "child"],
    );
    expect(
      __databaseCutoverServiceInternals.topologicallySortTables([cycleB, cycleA]).map((item) => item.name),
    ).toEqual(["cycle_a", "cycle_b"]);
    expect(__databaseCutoverServiceInternals.quoteIdentifier('weird"name')).toBe('"weird""name"');
  });

  it("mutates cutover step status without throwing on unknown step IDs", () => {
    const steps = [
      { id: "backup", label: "Backup", status: "pending" },
      { id: "verify", label: "Verify", status: "pending" },
      { id: "flip", label: "Flip", status: "pending" },
      { id: "import", label: "Import", status: "pending" },
    ];

    __databaseCutoverServiceInternals.completeStep(steps as never, "backup", "created");
    __databaseCutoverServiceInternals.skipStep(steps as never, "verify", "audit only");
    __databaseCutoverServiceInternals.failStep(steps as never, "flip", "target failed");
    __databaseCutoverServiceInternals.blockStep(steps as never, "import", "execute=false");
    __databaseCutoverServiceInternals.completeStep(steps as never, "missing", "ignored");

    expect(steps).toEqual([
      { id: "backup", label: "Backup", status: "completed", detail: "created" },
      { id: "verify", label: "Verify", status: "skipped", detail: "audit only" },
      { id: "flip", label: "Flip", status: "failed", detail: "target failed" },
      { id: "import", label: "Import", status: "blocked", detail: "execute=false" },
    ]);
  });

  it("verifies source counts against target Postgres evidence and reports every mismatch", async () => {
    const root = await makeTempRoot();
    const transcriptsDir = path.join(root, "transcripts");
    const auditDir = path.join(root, "audit");
    await fs.mkdir(transcriptsDir, { recursive: true });
    await fs.mkdir(auditDir, { recursive: true });
    await fs.writeFile(path.join(transcriptsDir, "session.jsonl"), "{}\n{}\n", "utf8");
    await fs.writeFile(path.join(auditDir, "approvals.jsonl"), "{}\n", "utf8");

    const postgres = {
      queryOne: vi.fn(async (sql: string) => {
        if (sql.includes("transcript_events")) return { count: "1" };
        if (sql.includes("audit_events")) return { count: "0" };
        if (sql.includes('"present_table"')) return { count: "2" };
        throw new Error("relation missing");
      }),
    };

    await expect(
      __databaseCutoverServiceInternals.verifyAgainstSource(
        {
          rootDir: root,
          sqlitePath: path.join(root, "index.db"),
          transcriptsDir,
          auditDir,
        },
        {
          tables: [table("present_table", [], 3), table("missing_table", [], 1), table("schema_migrations", [], 99)],
        },
        postgres as never,
        "snapshot-a",
        "postgres://target",
      ),
    ).resolves.toMatchObject({
      source: "snapshot-a",
      target: "postgres://target",
      verified: false,
      sourceTranscriptEventCount: 2,
      sourceAuditEventCount: 1,
      targetTranscriptEventCount: 1,
      targetAuditEventCount: 0,
      issues: [
        { code: "transcript_count_mismatch" },
        { code: "audit_count_mismatch" },
        { code: "table_row_count_mismatch", path: "present_table" },
        { code: "target_table_missing", path: "missing_table" },
      ],
    });
    expect(postgres.queryOne).not.toHaveBeenCalledWith(expect.stringContaining("schema_migrations"));
  });
});

function table(name: string, referencedTables: string[] = [], rowCount = 0) {
  return {
    name,
    sql: `CREATE TABLE ${name} (id TEXT)`,
    rowCount,
    columns: [],
    foreignKeys: referencedTables.map((referencedTable, index) => ({
      id: index,
      seq: 0,
      referencedTable,
    })),
  };
}

async function makeTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-db-cutover-loop30-"));
  tempRoots.push(root);
  return root;
}
