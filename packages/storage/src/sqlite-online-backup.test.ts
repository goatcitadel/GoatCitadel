import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Storage } from "./index.js";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";

describe("SQLite online backup", () => {
  it("produces a coherent read-only snapshot under a committed concurrent write without mutating live DB/WAL bytes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gc-sqlite-online-backup-"));
    const sourcePath = path.join(rootDir, "live", "index.db");
    const snapshotPath = path.join(rootDir, "staged", "data", "index.db");
    const source = createDatabase({ dbPath: sourcePath });
    const writer = new DatabaseSync(sourcePath, { timeout: 5_000 });
    let snapshot: DatabaseSync | undefined;
    try {
      source.exec("PRAGMA wal_autocheckpoint = 0;");
      writer.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA wal_autocheckpoint = 0;");
      source.exec(`
        CREATE TABLE snapshot_parent (epoch INTEGER PRIMARY KEY);
        CREATE TABLE snapshot_child (
          child_id INTEGER PRIMARY KEY,
          epoch INTEGER NOT NULL REFERENCES snapshot_parent(epoch)
        );
        CREATE TABLE snapshot_padding (padding_id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
        INSERT INTO snapshot_parent (epoch) VALUES (1);
      `);
      source.transaction("immediate", () => {
        const insertPadding = source.prepare(
          "INSERT INTO snapshot_padding (padding_id, payload) VALUES (?, zeroblob(4096))",
        );
        for (let paddingId = 1; paddingId <= 512; paddingId += 1) {
          insertPadding.run(paddingId);
        }
      });

      let concurrentCommitObserved = false;
      let progressHadRemainingPages = false;
      let databaseBytesAfterCommit: Buffer | undefined;
      let walBytesAfterCommit: Buffer | undefined;
      const backupTo = source.backupTo?.bind(source);
      if (!backupTo) {
        throw new Error("SQLite test client is missing online backup support");
      }
      await backupTo(snapshotPath, {
        pagesPerBatch: 1,
        onProgress: ({ remainingPages }) => {
          if (concurrentCommitObserved || remainingPages <= 0) {
            return;
          }
          progressHadRemainingPages = true;
          writer.exec(`
            BEGIN IMMEDIATE;
            UPDATE snapshot_parent SET epoch = 2 WHERE epoch = 1;
            INSERT INTO snapshot_child (child_id, epoch) VALUES (1, 2);
            COMMIT;
          `);
          concurrentCommitObserved = true;
          databaseBytesAfterCommit = fs.readFileSync(sourcePath);
          walBytesAfterCommit = fs.readFileSync(`${sourcePath}-wal`);
        },
      });

      assert.equal(progressHadRemainingPages, true, "fixture must commit while online backup still has pages to copy");
      assert.equal(concurrentCommitObserved, true);
      assert.ok(databaseBytesAfterCommit);
      assert.ok(walBytesAfterCommit);
      assert.ok(walBytesAfterCommit.length > 0);
      assert.deepEqual(await readFile(sourcePath), databaseBytesAfterCommit);
      assert.deepEqual(await readFile(`${sourcePath}-wal`), walBytesAfterCommit);
      assert.equal(fs.existsSync(`${snapshotPath}-wal`), false);
      assert.equal(fs.existsSync(`${snapshotPath}-shm`), false);

      snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
      assert.deepEqual({ ...snapshot.prepare("PRAGMA journal_mode").get() }, { journal_mode: "delete" });
      assert.deepEqual({ ...snapshot.prepare("PRAGMA integrity_check").get() }, { integrity_check: "ok" });
      assert.deepEqual(snapshot.prepare("PRAGMA foreign_key_check").all(), []);
      const epoch = Number((snapshot.prepare("SELECT epoch FROM snapshot_parent").get() as { epoch: number }).epoch);
      const childCount = Number(
        (snapshot.prepare("SELECT COUNT(*) AS count FROM snapshot_child").get() as { count: number }).count,
      );
      assert.equal(
        (epoch === 1 && childCount === 0) || (epoch === 2 && childCount === 1),
        true,
        `snapshot crossed committed states: epoch=${epoch}, childCount=${childCount}`,
      );
    } finally {
      snapshot?.close();
      writer.close();
      source.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("removes a partial target when online backup fails", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gc-sqlite-online-backup-failure-"));
    const source = createDatabase({ dbPath: path.join(rootDir, "source.db") });
    const targetPath = path.join(rootDir, "target", "snapshot.db");
    try {
      source.exec("CREATE TABLE snapshot_failure_fixture (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);");
      source.prepare("INSERT INTO snapshot_failure_fixture (id, payload) VALUES (1, zeroblob(65536))").run();
      const backupTo = source.backupTo?.bind(source);
      if (!backupTo) {
        throw new Error("SQLite test client is missing online backup support");
      }
      await assert.rejects(
        backupTo(targetPath, {
          pagesPerBatch: 1,
          onProgress: () => {
            throw new Error("injected progress failure");
          },
        }),
        /injected progress failure/,
      );
      assert.equal(fs.existsSync(targetPath), false);
      assert.equal(fs.existsSync(`${targetPath}-wal`), false);
      assert.equal(fs.existsSync(`${targetPath}-shm`), false);
    } finally {
      source.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  it("fails explicitly for a legacy injected SQLite client without online backup support", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "gc-sqlite-legacy-client-"));
    const underlying = createDatabase({ dbPath: path.join(rootDir, "source.db") });
    const legacyClient: DatabaseClient = {
      dialect: "sqlite",
      prepare: underlying.prepare.bind(underlying),
      exec: underlying.exec.bind(underlying),
      close: underlying.close.bind(underlying),
      transaction: underlying.transaction.bind(underlying),
    };
    const storage = new Storage({
      db: legacyClient,
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
    });
    try {
      await assert.rejects(
        storage.createSqliteSnapshot(path.join(rootDir, "snapshot.db")),
        /configured SQLite storage client does not support online snapshots/,
      );
    } finally {
      storage.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});
