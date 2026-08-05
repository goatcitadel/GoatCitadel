import { parentPort, workerData } from "node:worker_threads";
import { Storage } from "../index.js";
import { applyPostgresMigrationsSync } from "./migrator.js";
import type {
  PostgresRemoteStorageRequest,
  PostgresRemoteStorageResponse,
  PostgresRemoteStorageWorkerOptions,
  SerializedRemoteStorageError,
} from "./remote-storage-protocol.js";
import { PostgresSyncDatabaseClient } from "./sync.js";

const port = parentPort;
if (!port) {
  throw new Error("Postgres remote storage worker requires a parent port.");
}

const options = workerData as PostgresRemoteStorageWorkerOptions;
let storage: Storage | undefined;
let database: PostgresSyncDatabaseClient | undefined;
let activeTransactionId: string | undefined;
let activeTransactionDepth = 0;
let processing = false;
const queue: PostgresRemoteStorageRequest[] = [];

try {
  database = new PostgresSyncDatabaseClient(options.connection, {
    waitTimeoutMs: options.startupWaitTimeoutMs ?? 180_000,
  });
  applyPostgresMigrationsSync(database, { migrationsTable: options.migrationsTable });
  storage = new Storage({
    db: database,
    transcriptsDir: options.transcriptsDir,
    auditDir: options.auditDir,
  });
  post({ kind: "ready", ok: true });
} catch (error) {
  try {
    database?.close();
  } catch {
    // Preserve the startup error.
  }
  post({ kind: "ready", ok: false, error: serializeError(error) });
}

port.on("message", (request: PostgresRemoteStorageRequest) => {
  queue.push(request);
  void drainQueue();
});

async function drainQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    while (queue.length > 0) {
      const index = queue.findIndex(canProcessRequest);
      if (index < 0) return;
      const [request] = queue.splice(index, 1);
      if (!request) continue;
      await processRequest(request);
    }
  } finally {
    processing = false;
  }
}

function canProcessRequest(request: PostgresRemoteStorageRequest): boolean {
  if (!activeTransactionId) return true;
  return request.transactionId === activeTransactionId;
}

async function processRequest(request: PostgresRemoteStorageRequest): Promise<void> {
  if (!storage || !database) {
    respondError(request.requestId, new Error("Postgres remote storage worker did not initialize."));
    return;
  }
  try {
    let result: unknown;
    switch (request.kind) {
      case "invoke":
        result = await invokePath(storage, request.path, request.args);
        break;
      case "statement": {
        const statement = database.prepare(request.sql);
        result =
          request.mode === "run"
            ? statement.run(...request.args)
            : request.mode === "get"
              ? statement.get(...request.args)
              : statement.all(...request.args);
        break;
      }
      case "transaction_begin":
        beginTransaction(request.transactionId, request.depth, request.mode);
        break;
      case "transaction_commit":
        finishTransaction(request.transactionId, request.depth, true);
        break;
      case "transaction_rollback":
        finishTransaction(request.transactionId, request.depth, false);
        break;
      case "close":
        storage.close();
        storage = undefined;
        database = undefined;
        break;
    }
    post({ kind: "response", requestId: request.requestId, ok: true, result });
  } catch (error) {
    respondError(request.requestId, error);
  } finally {
    if (!activeTransactionId) {
      void drainQueue();
    }
  }
}

function beginTransaction(
  transactionId: string | undefined,
  depth: number,
  mode: "deferred" | "immediate" | "exclusive",
): void {
  if (!transactionId) throw new Error("Remote transaction id is required.");
  if (depth === 0) {
    if (activeTransactionId) throw new Error("A remote storage transaction is already active.");
    database!.beginCompatibilityTransaction(transactionId, mode);
    activeTransactionId = transactionId;
    activeTransactionDepth = 0;
    return;
  }
  assertActiveTransaction(transactionId, depth - 1);
  database!.exec(`SAVEPOINT gc_remote_${depth}`);
  activeTransactionDepth = depth;
}

function finishTransaction(transactionId: string | undefined, depth: number, commit: boolean): void {
  if (!transactionId) throw new Error("Remote transaction id is required.");
  assertActiveTransaction(transactionId, depth);
  if (depth > 0) {
    const savepoint = `gc_remote_${depth}`;
    if (commit) {
      database!.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } else {
      database!.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database!.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    activeTransactionDepth = depth - 1;
    return;
  }
  try {
    if (commit) database!.commitCompatibilityTransaction(transactionId);
    else database!.rollbackCompatibilityTransaction(transactionId);
  } finally {
    activeTransactionId = undefined;
    activeTransactionDepth = 0;
  }
}

function assertActiveTransaction(transactionId: string, depth: number): void {
  if (activeTransactionId !== transactionId || activeTransactionDepth !== depth) {
    throw new Error(`Remote storage transaction posture mismatch for ${transactionId} at depth ${depth}.`);
  }
}

async function invokePath(root: object, path: string[], args: unknown[]): Promise<unknown> {
  if (path.length < 1) throw new Error("Remote storage invocation path must identify a method.");
  let receiver: unknown = root;
  for (const segment of path.slice(0, -1)) {
    if (!receiver || typeof receiver !== "object") {
      throw new Error(`Remote storage path is unavailable: ${path.join(".")}`);
    }
    receiver = (receiver as Record<string, unknown>)[segment];
  }
  const methodName = path.at(-1)!;
  if (!receiver || typeof receiver !== "object") {
    throw new Error(`Remote storage receiver is unavailable: ${path.join(".")}`);
  }
  const method = (receiver as Record<string, unknown>)[methodName];
  if (typeof method !== "function") {
    throw new Error(`Remote storage method is unavailable: ${path.join(".")}`);
  }
  return await method.apply(receiver, args);
}

function respondError(requestId: number, error: unknown): void {
  post({ kind: "response", requestId, ok: false, error: serializeError(error) });
}

function post(response: PostgresRemoteStorageResponse): void {
  port!.postMessage(response);
}

function serializeError(error: unknown): SerializedRemoteStorageError {
  if (!(error instanceof Error)) {
    return { name: "Error", message: String(error) };
  }
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(error)) {
    const value = (error as unknown as Record<string, unknown>)[key];
    if (typeof value !== "function") properties[key] = value;
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack ? { stack: error.stack } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}
