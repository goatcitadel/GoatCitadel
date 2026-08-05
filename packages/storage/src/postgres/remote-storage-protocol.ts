import type { DbTransactionMode } from "../db.js";
import type { PostgresConnectionOptions } from "./client.js";

export interface PostgresRemoteStorageWorkerOptions {
  connection: PostgresConnectionOptions;
  migrationsTable: string;
  transcriptsDir: string;
  auditDir: string;
  startupWaitTimeoutMs?: number;
}

interface PostgresRemoteStorageRequestBase {
  requestId: number;
  transactionId?: string;
}

export type PostgresRemoteStorageRequest =
  | (PostgresRemoteStorageRequestBase & {
      kind: "invoke";
      path: string[];
      args: unknown[];
    })
  | (PostgresRemoteStorageRequestBase & {
      kind: "statement";
      mode: "run" | "get" | "all";
      sql: string;
      args: unknown[];
    })
  | (PostgresRemoteStorageRequestBase & {
      kind: "transaction_begin";
      mode: DbTransactionMode;
      depth: number;
    })
  | (PostgresRemoteStorageRequestBase & {
      kind: "transaction_commit" | "transaction_rollback";
      depth: number;
    })
  | (PostgresRemoteStorageRequestBase & { kind: "close" });

export type PostgresRemoteStorageRequestDraft = PostgresRemoteStorageRequest extends infer Request
  ? Request extends PostgresRemoteStorageRequest
    ? Omit<Request, "requestId" | "transactionId">
    : never
  : never;

export interface SerializedRemoteStorageError {
  name: string;
  message: string;
  stack?: string;
  properties?: Record<string, unknown>;
}

export type PostgresRemoteStorageResponse =
  | { kind: "ready"; ok: true }
  | { kind: "ready"; ok: false; error: SerializedRemoteStorageError }
  | { kind: "response"; requestId: number; ok: true; result?: unknown }
  | { kind: "response"; requestId: number; ok: false; error: SerializedRemoteStorageError };
