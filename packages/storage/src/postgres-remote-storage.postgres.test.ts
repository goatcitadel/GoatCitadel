import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

test(
  "real remote Postgres storage keeps the caller event loop responsive during a blocking database wait",
  { skip: connectionString ? false : "set GOATCITADEL_TEST_POSTGRES_URL to run the real Postgres lane" },
  async () => {
    assert.ok(connectionString);
    const rootDir = await mkdtemp(path.join(tmpdir(), "goatcitadel-remote-postgres-"));
    const storage = createPostgresRemoteStorage({
      connection: {
        connectionString,
        database: new URL(connectionString).pathname.slice(1),
        applicationName: "goatcitadel-remote-storage-proof",
        pool: { max: 1, connectionTimeoutMs: 10_000 },
      },
      migrationsTable: "schema_migrations",
      transcriptsDir: path.join(rootDir, "transcripts"),
      auditDir: path.join(rootDir, "audit"),
      startupWaitTimeoutMs: 180_000,
    });

    try {
      await storage.waitUntilReady();
      let timerTicks = 0;
      const timer = setInterval(() => {
        timerTicks += 1;
      }, 25);
      try {
        const statement = storage.db.prepare("SELECT pg_sleep(?) AS slept");
        await statement.get(1);
      } finally {
        clearInterval(timer);
      }

      assert.ok(timerTicks >= 20, `expected the caller event loop to tick during pg_sleep; observed ${timerTicks}`);

      await storage.runImmediateTransaction(async () => {
        const statement = storage.db.prepare("SELECT 1 AS value");
        const row = await statement.get<{ value: number }>();
        assert.equal(row?.value, 1);
      });
    } finally {
      await storage.close();
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);
