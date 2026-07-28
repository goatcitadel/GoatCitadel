import type { RunTemplateInvocation, RunVariableBindings } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

export interface ChatSessionRunVariableBindingRecord {
  sessionId: string;
  ownerKind: RunTemplateInvocation["ownerKind"];
  ownerId: string;
  ownerRevision: string;
  schemaHash: string;
  bindings: RunVariableBindings;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  session_id: string;
  owner_kind: RunTemplateInvocation["ownerKind"];
  owner_id: string;
  owner_revision: string;
  schema_hash: string;
  bindings_json: string;
  created_at: string;
  updated_at: string;
}

export class ChatSessionRunVariableRepository {
  private readonly upsertStmt;
  private readonly getStmt;

  public constructor(private readonly db: DatabaseClient) {
    this.upsertStmt = db.prepare(`
      INSERT INTO chat_session_run_variable_bindings (
        session_id, owner_kind, owner_id, owner_revision, schema_hash, bindings_json, created_at, updated_at
      ) VALUES (
        @sessionId, @ownerKind, @ownerId, @ownerRevision, @schemaHash, @bindingsJson, @createdAt, @updatedAt
      )
      ON CONFLICT(session_id, owner_kind, owner_id) DO UPDATE SET
        owner_revision = excluded.owner_revision,
        schema_hash = excluded.schema_hash,
        bindings_json = excluded.bindings_json,
        updated_at = excluded.updated_at
    `);
    this.getStmt = db.prepare(`
      SELECT * FROM chat_session_run_variable_bindings
      WHERE session_id = @sessionId AND owner_kind = @ownerKind AND owner_id = @ownerId
    `);
  }

  public upsert(
    input: Omit<ChatSessionRunVariableBindingRecord, "createdAt" | "updatedAt">,
    now = new Date().toISOString(),
  ): ChatSessionRunVariableBindingRecord {
    this.upsertStmt.run({
      sessionId: input.sessionId,
      ownerKind: input.ownerKind,
      ownerId: input.ownerId,
      ownerRevision: input.ownerRevision,
      schemaHash: input.schemaHash,
      bindingsJson: JSON.stringify(input.bindings),
      createdAt: now,
      updatedAt: now,
    });
    return this.get(input.sessionId, input.ownerKind, input.ownerId)!;
  }

  public get(
    sessionId: string,
    ownerKind: RunTemplateInvocation["ownerKind"],
    ownerId: string,
  ): ChatSessionRunVariableBindingRecord | undefined {
    const value = this.getStmt.get({ sessionId, ownerKind, ownerId });
    return isRow(value) ? mapRow(value) : undefined;
  }
}

function mapRow(row: Row): ChatSessionRunVariableBindingRecord {
  let bindings: RunVariableBindings;
  try {
    bindings = JSON.parse(row.bindings_json) as RunVariableBindings;
  } catch {
    // Corrupt bindings never become template input.
    bindings = {};
  }
  return {
    sessionId: row.session_id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    ownerRevision: row.owner_revision,
    schemaHash: row.schema_hash,
    bindings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isRow(value: unknown): value is Row {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<Row>;
  return (
    typeof row.session_id === "string" &&
    (row.owner_kind === "prompt_pack" || row.owner_kind === "agent_preset") &&
    typeof row.owner_id === "string" &&
    typeof row.owner_revision === "string" &&
    typeof row.schema_hash === "string" &&
    typeof row.bindings_json === "string" &&
    typeof row.created_at === "string" &&
    typeof row.updated_at === "string"
  );
}
