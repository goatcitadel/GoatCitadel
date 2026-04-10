import type { DbTransactionMode } from "../db.js";

export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
}

export type PostgresWorkerRequest =
  | {
      kind: "query";
      sql: string;
      params: unknown[];
      mode: "run" | "one" | "all";
      txId?: string;
    }
  | {
      kind: "exec";
      sql: string;
      txId?: string;
    }
  | {
      kind: "tx_begin";
      txId: string;
      mode: DbTransactionMode;
    }
  | {
      kind: "tx_commit";
      txId: string;
    }
  | {
      kind: "tx_rollback";
      txId: string;
    }
  | {
      kind: "close";
    };

export type PostgresWorkerResponse =
  | {
      ok: true;
      result: unknown;
    }
  | {
      ok: false;
      error: SerializedWorkerError;
    };
