import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";

type MigrationRegistryModule = typeof import("./migration-registry.js");

interface TsxEsmApi {
  tsImport(specifier: string, parentUrl: string): Promise<unknown>;
}

interface WorkerInput {
  dbPath: string;
  migrationName: string;
  workerId: string;
  holdInsideMigration: boolean;
  migrationGate: SharedArrayBuffer;
  pauseAfterInitialLedgerRead: boolean;
  ledgerReadGate: SharedArrayBuffer;
  migrationRegistryModuleUrl: string;
  tsxApiUrl: string;
}

const input = workerData as WorkerInput;
const { tsImport } = (await import(input.tsxApiUrl)) as TsxEsmApi;
const { runSqliteMigrations } = (await tsImport(
  input.migrationRegistryModuleUrl,
  input.migrationRegistryModuleUrl,
)) as MigrationRegistryModule;
const migrationGate = new Int32Array(input.migrationGate);
const ledgerReadGate = new Int32Array(input.ledgerReadGate);
const database = new DatabaseSync(input.dbPath, { timeout: 10_000 });
database.exec("PRAGMA busy_timeout = 10000;");

let ledgerReadCount = 0;
const instrumentedDatabase = {
  exec: database.exec.bind(database),
  prepare(sql: string) {
    const statement = database.prepare(sql);
    if (!sql.includes("SELECT version, name FROM schema_migrations ORDER BY version ASC")) {
      return statement;
    }
    return {
      all() {
        const rows = statement.all();
        ledgerReadCount += 1;
        parentPort?.postMessage({ type: "ledger-read", count: ledgerReadCount });
        if (input.pauseAfterInitialLedgerRead && ledgerReadCount === 1) {
          Atomics.wait(ledgerReadGate, 0, 0, 10_000);
        }
        return rows;
      },
    };
  },
} as unknown as DatabaseSync;

let failureMessage: string | undefined;
try {
  parentPort?.postMessage({ type: "ready" });
  runSqliteMigrations(instrumentedDatabase, [
    {
      version: 1,
      name: input.migrationName,
      up: (db) => {
        parentPort?.postMessage({ type: "migration-started" });
        if (input.holdInsideMigration) {
          Atomics.wait(migrationGate, 0, 0, 10_000);
        }
        db.exec(`
          CREATE TABLE IF NOT EXISTS concurrent_startup_effects (
            worker_id TEXT PRIMARY KEY
          );
        `);
        db.prepare("INSERT INTO concurrent_startup_effects (worker_id) VALUES (?)").run(input.workerId);
      },
    },
  ]);
} catch (error) {
  failureMessage = error instanceof Error ? error.message : String(error);
} finally {
  database.close();
}

parentPort?.postMessage(
  failureMessage === undefined ? { type: "completed" } : { type: "failed", message: failureMessage },
);
