import { parentPort, workerData } from "node:worker_threads";
import { Pool, types, type PoolClient } from "pg";
import type { PostgresConnectionOptions } from "./client.js";
import type { PostgresWorkerRequest, PostgresWorkerResponse } from "./protocol.js";

types.setTypeParser(20, (value) => Number(value));
types.setTypeParser(21, (value) => Number(value));
types.setTypeParser(23, (value) => Number(value));
types.setTypeParser(700, (value) => Number(value));
types.setTypeParser(701, (value) => Number(value));

const pool = new Pool(buildPoolConfig(workerData as PostgresConnectionOptions));
const transactions = new Map<string, PoolClient>();

parentPort?.on("message", async (message: {
  request: PostgresWorkerRequest;
  port: MessagePort;
  signal: SharedArrayBuffer;
}) => {
  const { request, port, signal } = message;
  const state = new Int32Array(signal);
  let response: PostgresWorkerResponse;
  try {
    response = {
      ok: true,
      result: await handleRequest(request),
    };
  } catch (error) {
    const sql = request.kind === "query" || request.kind === "exec" ? request.sql : undefined;
    response = {
      ok: false,
      error: serializeError(error, sql),
    };
  }

  port.postMessage(response);
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0, 1);
  port.close();
});

async function handleRequest(request: PostgresWorkerRequest): Promise<unknown> {
  switch (request.kind) {
    case "query": {
      const executor = request.txId ? getTransactionClient(request.txId) : pool;
      const result = await executor.query(request.sql, request.params);
      if (request.mode === "run") {
        return {
          changes: result.rowCount ?? 0,
          lastInsertRowid: undefined,
        };
      }
      if (request.mode === "one") {
        return result.rows[0];
      }
      return result.rows;
    }
    case "exec": {
      const executor = request.txId ? getTransactionClient(request.txId) : pool;
      const result = await executor.query(request.sql);
      return {
        changes: result.rowCount ?? 0,
        lastInsertRowid: undefined,
      };
    }
    case "tx_begin": {
      const client = await pool.connect();
      await client.query("BEGIN");
      transactions.set(request.txId, client);
      return true;
    }
    case "tx_commit": {
      const client = getTransactionClient(request.txId);
      try {
        await client.query("COMMIT");
      } finally {
        transactions.delete(request.txId);
        client.release();
      }
      return true;
    }
    case "tx_rollback": {
      const client = getTransactionClient(request.txId);
      try {
        await client.query("ROLLBACK");
      } finally {
        transactions.delete(request.txId);
        client.release();
      }
      return true;
    }
    case "close": {
      for (const [txId, client] of transactions.entries()) {
        try {
          await client.query("ROLLBACK");
        } finally {
          transactions.delete(txId);
          client.release();
        }
      }
      await pool.end();
      return true;
    }
  }
}

function getTransactionClient(txId: string): PoolClient {
  const client = transactions.get(txId);
  if (!client) {
    throw new Error(`Missing active Postgres transaction ${txId}`);
  }
  return client;
}

function buildPoolConfig(options: PostgresConnectionOptions) {
  if (options.connectionString?.trim()) {
    return {
      connectionString: options.connectionString.trim(),
      max: options.pool?.max ?? 10,
      min: options.pool?.min ?? 0,
      idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: options.pool?.connectionTimeoutMs ?? 5_000,
      application_name: options.applicationName ?? "goatcitadel-sync-worker",
      ssl: options.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: options.host ?? "127.0.0.1",
    port: options.port ?? 5432,
    database: options.database,
    user: options.user,
    password: options.password,
    max: options.pool?.max ?? 10,
    min: options.pool?.min ?? 0,
    idleTimeoutMillis: options.pool?.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: options.pool?.connectionTimeoutMs ?? 5_000,
    application_name: options.applicationName ?? "goatcitadel-sync-worker",
    ssl: options.sslMode === "require" ? { rejectUnauthorized: false } : undefined,
  };
}

function serializeError(error: unknown, sql?: string) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: sql ? `${error.message}\nSQL: ${sql}` : error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: sql ? `${String(error)}\nSQL: ${sql}` : String(error),
  };
}
