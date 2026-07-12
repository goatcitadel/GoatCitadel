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
      sessionId?: string;
    }
  | {
      kind: "exec";
      sql: string;
      txId?: string;
      sessionId?: string;
    }
  | {
      kind: "session_begin";
      sessionId: string;
    }
  | {
      kind: "session_end";
      sessionId: string;
      destroy: boolean;
    }
  | {
      kind: "tx_begin";
      txId: string;
      mode: DbTransactionMode;
      sessionId?: string;
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
