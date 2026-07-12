import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { runSqliteMigrations, type SqliteMigration } from "./migration-registry.js";

function createMigration(version: number, name: string, up: SqliteMigration["up"] = () => undefined): SqliteMigration {
  return { version, name, up };
}

function createMigrationLedger(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

interface MigrationWorker {
  completed: Promise<void>;
  ledgerRead: Promise<void>;
  migrationStarted: Promise<void>;
  ready: Promise<void>;
}

function startMigrationWorker(input: {
  dbPath: string;
  migrationName: string;
  workerId: string;
  holdInsideMigration: boolean;
  migrationGate: SharedArrayBuffer;
  pauseAfterInitialLedgerRead: boolean;
  ledgerReadGate: SharedArrayBuffer;
}): MigrationWorker {
  const runtimeModuleExtension = import.meta.url.endsWith(".js") ? ".js" : ".ts";
  const worker = new Worker(
    new URL(`./migration-registry.concurrent-worker${runtimeModuleExtension}`, import.meta.url),
    {
      execArgv: [],
      workerData: {
        ...input,
        migrationRegistryModuleUrl: new URL(`./migration-registry${runtimeModuleExtension}`, import.meta.url).href,
        tsxApiUrl: import.meta.resolve("tsx/esm/api"),
      },
    },
  );
  let resolveReady: () => void;
  let resolveLedgerRead: () => void;
  let resolveMigrationStarted: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const ledgerRead = new Promise<void>((resolve) => {
    resolveLedgerRead = resolve;
  });
  const migrationStarted = new Promise<void>((resolve) => {
    resolveMigrationStarted = resolve;
  });
  const completed = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: { type?: string; message?: string; count?: number }) => {
      if (message.type === "ready") {
        resolveReady();
      } else if (message.type === "ledger-read" && message.count === 1) {
        resolveLedgerRead();
      } else if (message.type === "migration-started") {
        resolveMigrationStarted();
      } else if (message.type === "completed") {
        resolve();
      } else if (message.type === "failed") {
        reject(new Error(message.message ?? "Migration worker failed."));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Migration worker exited with code ${code}.`));
      }
    });
  });
  return { completed, ledgerRead, migrationStarted, ready };
}

describe("SQLite migration registry", () => {
  it("rejects malformed definitions before creating the migration ledger", () => {
    let migrationCallCount = 0;
    const invalidMigration = (version: number, name: string): SqliteMigration =>
      createMigration(version, name, () => {
        migrationCallCount += 1;
      });
    const invalidRegistries: Array<{ migrations: SqliteMigration[]; message: RegExp }> = [
      {
        migrations: [invalidMigration(0, "invalid_version")],
        message: /safe positive integer/,
      },
      {
        migrations: [invalidMigration(Number.MAX_SAFE_INTEGER + 1, "unsafe_version")],
        message: /safe positive integer/,
      },
      {
        migrations: [invalidMigration(2, "valid"), invalidMigration(4, "gap")],
        message: /strictly ascending and contiguous/,
      },
      {
        migrations: [invalidMigration(2, "first"), invalidMigration(2, "duplicate")],
        message: /strictly ascending and contiguous/,
      },
      {
        migrations: [invalidMigration(2, "later"), invalidMigration(1, "reordered")],
        message: /strictly ascending and contiguous/,
      },
      {
        migrations: [invalidMigration(2, " \t ")],
        message: /non-blank name/,
      },
    ];

    for (const { migrations, message } of invalidRegistries) {
      const db = new DatabaseSync(":memory:");
      try {
        assert.throws(() => runSqliteMigrations(db, migrations), message);
        const ledger = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
          .get();
        assert.equal(ledger, undefined);
        assert.equal(migrationCallCount, 0);
      } finally {
        db.close();
      }
    }
  });

  it("rejects a later non-callable callback before any earlier migration can write", () => {
    const db = new DatabaseSync(":memory:");
    let firstMigrationRan = false;
    try {
      db.exec("CREATE TABLE migration_data_probe (id TEXT PRIMARY KEY)");
      const migrations = [
        createMigration(1, "valid_first", (migrationDb) => {
          firstMigrationRan = true;
          migrationDb.exec("CREATE TABLE must_not_exist (id TEXT PRIMARY KEY)");
          migrationDb.prepare("INSERT INTO migration_data_probe (id) VALUES (?)").run("unexpected");
        }),
        {
          version: 2,
          name: "invalid_second",
          up: undefined,
        } as unknown as SqliteMigration,
      ];

      assert.throws(() => runSqliteMigrations(db, migrations), /callable up callback/);
      assert.equal(firstMigrationRan, false);
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_exist'").get(),
        undefined,
      );
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get(),
        undefined,
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_data_probe").get()?.count, 0);
    } finally {
      db.close();
    }
  });

  it("preserves the primary migration error when rollback cleanup also fails", () => {
    const db = new DatabaseSync(":memory:");
    const primaryError = new Error("migration callback failed");

    try {
      assert.throws(
        () =>
          runSqliteMigrations(db, [
            createMigration(1, "failing_migration", (migrationDb) => {
              migrationDb.exec("ROLLBACK");
              throw primaryError;
            }),
          ]),
        (error: unknown) => error === primaryError,
      );
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count, 0);
    } finally {
      db.close();
    }
  });

  it("validates the complete applied ledger before a missing earlier migration can commit", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createMigrationLedger(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        2,
        "divergent_second",
        "2026-07-12T00:00:00.000Z",
      );

      let firstMigrationRan = false;
      const migrations = [
        createMigration(1, "first", (migrationDb) => {
          firstMigrationRan = true;
          migrationDb.exec("CREATE TABLE must_not_commit (id TEXT PRIMARY KEY)");
        }),
        createMigration(2, "second"),
      ];

      assert.throws(
        () => runSqliteMigrations(db, migrations),
        /migration ledger mismatch at version 2.*divergent_second.*second/,
      );
      assert.equal(firstMigrationRan, false);
      assert.equal(
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_commit'").get(),
        undefined,
      );
      assert.deepEqual(
        (
          db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{
            version: number;
            name: string;
          }>
        ).map((row) => ({ version: row.version, name: row.name })),
        [{ version: 2, name: "divergent_second" }],
      );
    } finally {
      db.close();
    }
  });

  it("revalidates concurrent ledger changes under the write lock before callbacks and return", () => {
    const scenarios = [
      {
        name: "unknown future version before a missing migration",
        registryNames: ["first"],
        initialRows: [] as Array<{ version: number; name: string }>,
        injectedRow: { version: 2, name: "future_unknown" },
        expectedError: /unknown version 2/,
      },
      {
        name: "divergent later name before a missing migration",
        registryNames: ["first", "second"],
        initialRows: [] as Array<{ version: number; name: string }>,
        injectedRow: { version: 2, name: "divergent_second" },
        expectedError: /migration ledger mismatch at version 2.*divergent_second.*second/,
      },
      {
        name: "unknown future version after an already-applied snapshot",
        registryNames: ["first"],
        initialRows: [{ version: 1, name: "first" }],
        injectedRow: { version: 2, name: "future_unknown" },
        expectedError: /unknown version 2/,
      },
    ];

    for (const scenario of scenarios) {
      const dbPath = path.join(os.tmpdir(), `goatcitadel-sqlite-ledger-toctou-${randomUUID()}.db`);
      const setup = new DatabaseSync(dbPath);
      try {
        setup.exec("PRAGMA journal_mode = WAL;");
        createMigrationLedger(setup);
        const insertApplied = setup.prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        );
        for (const row of scenario.initialRows) {
          insertApplied.run(row.version, row.name, "2026-07-12T00:00:00.000Z");
        }
      } finally {
        setup.close();
      }

      const runner = new DatabaseSync(dbPath, { timeout: 10_000 });
      const concurrentWriter = new DatabaseSync(dbPath, { timeout: 10_000 });
      let firstLedgerRead = true;
      let firstMigrationRan = false;
      const instrumentedRunner = {
        exec: runner.exec.bind(runner),
        prepare(sql: string) {
          const statement = runner.prepare(sql);
          if (!sql.includes("SELECT version, name FROM schema_migrations ORDER BY version ASC")) {
            return statement;
          }
          return {
            all() {
              const rows = statement.all();
              if (firstLedgerRead) {
                firstLedgerRead = false;
                concurrentWriter
                  .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
                  .run(scenario.injectedRow.version, scenario.injectedRow.name, "2026-07-12T00:00:01.000Z");
              }
              return rows;
            },
          };
        },
      } as unknown as DatabaseSync;

      try {
        const migrations = scenario.registryNames.map((name, index) =>
          createMigration(index + 1, name, (migrationDb) => {
            if (index === 0) {
              firstMigrationRan = true;
              migrationDb.exec("CREATE TABLE must_not_commit (id TEXT PRIMARY KEY)");
            }
          }),
        );

        assert.throws(() => runSqliteMigrations(instrumentedRunner, migrations), scenario.expectedError, scenario.name);
        assert.equal(firstMigrationRan, false, scenario.name);
        assert.equal(
          runner.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'must_not_commit'").get(),
          undefined,
          scenario.name,
        );
        assert.deepEqual(
          (
            runner.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{
              version: number;
              name: string;
            }>
          ).map((row) => ({ version: row.version, name: row.name })),
          [...scenario.initialRows, scenario.injectedRow],
          scenario.name,
        );
      } finally {
        concurrentWriter.close();
        runner.close();
        fs.rmSync(dbPath, { force: true });
        fs.rmSync(`${dbPath}-wal`, { force: true });
        fs.rmSync(`${dbPath}-shm`, { force: true });
      }
    }
  });

  it("rejects unknown applied versions before running migrations", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createMigrationLedger(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        3,
        "unknown",
        "2026-07-12T00:00:00.000Z",
      );
      let migrationRan = false;

      assert.throws(
        () =>
          runSqliteMigrations(db, [
            createMigration(1, "first", () => {
              migrationRan = true;
            }),
            createMigration(2, "second"),
          ]),
        /unknown version 3/,
      );
      assert.equal(migrationRan, false);
    } finally {
      db.close();
    }
  });

  it("preserves applied gaps so missing migrations can be repaired", () => {
    const db = new DatabaseSync(":memory:");
    try {
      createMigrationLedger(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        2,
        "second",
        "2026-07-12T00:00:00.000Z",
      );
      let secondMigrationRan = false;

      runSqliteMigrations(db, [
        createMigration(1, "first", (migrationDb) => {
          migrationDb.exec("CREATE TABLE repaired_first (id TEXT PRIMARY KEY)");
        }),
        createMigration(2, "second", () => {
          secondMigrationRan = true;
        }),
      ]);

      assert.equal(secondMigrationRan, false);
      assert.deepEqual(
        (
          db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{
            version: number;
            name: string;
          }>
        ).map((row) => ({ version: row.version, name: row.name })),
        [
          { version: 1, name: "first" },
          { version: 2, name: "second" },
        ],
      );
      assert.equal(
        (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repaired_first'").get() as
            | { name: string }
            | undefined
        )?.name,
        "repaired_first",
      );
    } finally {
      db.close();
    }
  });

  it("allows contiguous injected slices to start above version one and repeat names", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runSqliteMigrations(db, [createMigration(5, "shared_name"), createMigration(6, "shared_name")]);

      assert.deepEqual(
        (
          db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{
            version: number;
            name: string;
          }>
        ).map((row) => ({ version: row.version, name: row.name })),
        [
          { version: 5, name: "shared_name" },
          { version: 6, name: "shared_name" },
        ],
      );
    } finally {
      db.close();
    }
  });

  it("serializes concurrent startup and rejects a divergent name without replaying either callback", async () => {
    const scenarios = [
      {
        firstName: "concurrent_startup",
        secondName: "concurrent_startup",
        expectedSecondError: undefined,
      },
      {
        firstName: "concurrent_branch_a",
        secondName: "concurrent_branch_b",
        expectedSecondError: /migration ledger mismatch at version 1/,
      },
    ];

    for (const scenario of scenarios) {
      const dbPath = path.join(os.tmpdir(), `goatcitadel-sqlite-concurrent-startup-${randomUUID()}.db`);
      const migrationGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const ledgerReadGate = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      try {
        const setup = new DatabaseSync(dbPath, { timeout: 10_000 });
        setup.exec("PRAGMA journal_mode = WAL;");
        createMigrationLedger(setup);
        setup.close();

        const first = startMigrationWorker({
          dbPath,
          migrationName: scenario.firstName,
          workerId: "first",
          holdInsideMigration: true,
          migrationGate,
          pauseAfterInitialLedgerRead: false,
          ledgerReadGate,
        });
        await first.ready;
        await first.migrationStarted;

        const second = startMigrationWorker({
          dbPath,
          migrationName: scenario.secondName,
          workerId: "second",
          holdInsideMigration: false,
          migrationGate,
          pauseAfterInitialLedgerRead: true,
          ledgerReadGate,
        });
        await second.ready;
        await second.ledgerRead;

        Atomics.store(new Int32Array(migrationGate), 0, 1);
        Atomics.notify(new Int32Array(migrationGate), 0);
        await first.completed;
        Atomics.store(new Int32Array(ledgerReadGate), 0, 1);
        Atomics.notify(new Int32Array(ledgerReadGate), 0);
        if (scenario.expectedSecondError) {
          await assert.rejects(second.completed, scenario.expectedSecondError);
        } else {
          await second.completed;
        }

        const verify = new DatabaseSync(dbPath);
        try {
          assert.deepEqual(
            (
              verify.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all() as Array<{
                version: number;
                name: string;
              }>
            ).map((row) => ({ version: row.version, name: row.name })),
            [{ version: 1, name: scenario.firstName }],
          );
          assert.deepEqual(
            (
              verify.prepare("SELECT worker_id FROM concurrent_startup_effects ORDER BY worker_id ASC").all() as Array<{
                worker_id: string;
              }>
            ).map((row) => row.worker_id),
            ["first"],
          );
        } finally {
          verify.close();
        }
      } finally {
        try {
          fs.rmSync(dbPath, { force: true });
          fs.rmSync(`${dbPath}-wal`, { force: true });
          fs.rmSync(`${dbPath}-shm`, { force: true });
        } catch (error) {
          // A failed worker can still be unwinding when an assertion rejects.
          void error;
        }
      }
    }
  });
});
