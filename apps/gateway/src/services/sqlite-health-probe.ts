import { DatabaseSync } from "node:sqlite";
import { parentPort, Worker, workerData } from "node:worker_threads";

type ProbeResult = { reachable: boolean; migrationVersion?: number };

const WORKER_ROLE = "sqlite-health-probe";
const PROBE_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const unavailable: ProbeResult = { reachable: false };

/** The Gateway shares overlapping requests. The worker reopens the database for each fresh probe. */
export class SqliteHealthProbe {
  private worker?: Worker;
  private pending?: { resolve: (result: ProbeResult) => void; timer: NodeJS.Timeout };
  private idleTimer?: NodeJS.Timeout;

  public async read(databasePath: string): Promise<ProbeResult> {
    clearTimeout(this.idleTimer);
    let worker: Worker;
    try {
      worker = this.worker ??= this.startWorker();
      worker.ref();
    } catch {
      return unavailable;
    }

    return new Promise<ProbeResult>((resolve) => {
      const timer = setTimeout(() => this.retire(worker), PROBE_TIMEOUT_MS).unref();
      this.pending = { resolve, timer };
      try {
        worker.postMessage(databasePath);
      } catch {
        this.retire(worker);
      }
    });
  }

  private startWorker(): Worker {
    const worker = new Worker(new URL(import.meta.url), { workerData: WORKER_ROLE, execArgv: [], env: {} });
    worker.on("message", (result: ProbeResult) => {
      if (this.worker !== worker || !this.pending) return;
      const { resolve, timer } = this.pending;
      this.pending = undefined;
      clearTimeout(timer);
      this.idleTimer = setTimeout(() => this.retire(worker), IDLE_TIMEOUT_MS).unref();
      worker.unref();
      resolve(result);
    });
    worker.on("error", () => this.retire(worker));
    worker.on("exit", () => this.retire(worker));
    return worker;
  }

  private retire(worker: Worker): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    clearTimeout(this.idleTimer);
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.resolve(unavailable);
    }
    worker.unref();
    void worker.terminate().catch(() => undefined);
  }
}

function readHealthSnapshot(databasePath: string): ProbeResult {
  let database: DatabaseSync | undefined;
  let migrationVersion: number | undefined;
  let reachable = false;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const probe = database.prepare("SELECT 1 AS ok").get() as { ok?: unknown } | undefined;
    if (probe?.ok !== 1) throw new Error("SQLite readiness probe returned an unexpected result");
    const migrationTable = database
      .prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1")
      .get();
    if (migrationTable) {
      const row = database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
        | { version?: number | bigint | null }
        | undefined;
      if (row?.version !== null && row?.version !== undefined) {
        const version = Number(row.version);
        if (!Number.isSafeInteger(version) || version < 0) throw new Error("SQLite migration version is invalid");
        migrationVersion = version;
      }
    }
    reachable = true;
  } catch {
    // The public health response intentionally omits the path and SQL error.
  } finally {
    try {
      database?.close();
    } catch {
      reachable = false;
    }
  }
  return { reachable, migrationVersion };
}

if (parentPort && workerData === WORKER_ROLE) {
  const port = parentPort;
  port.on("message", (databasePath: string) => port.postMessage(readHealthSnapshot(databasePath)));
}
