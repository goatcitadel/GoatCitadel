import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RUN_VARIABLE_SCHEMA_VERSION, hashRunVariableSchema } from "@goatcitadel/contracts";
import { Storage } from "./index.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";

describe("ChatSessionRunVariableRepository", () => {
  it("round-trips session-scoped bindings and updates without promoting defaults", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    storage.chatSessionMeta.ensure("session-1", undefined, "workspace-1");
    const schema = {
      version: RUN_VARIABLE_SCHEMA_VERSION,
      fields: [{ id: "topic", label: "Topic", type: "text" as const, required: true }],
    };
    const created = storage.chatSessionRunVariables.upsert({
      sessionId: "session-1",
      ownerKind: "prompt_pack",
      ownerId: "pack-1",
      ownerRevision: "revision-1",
      schemaHash: hashRunVariableSchema(schema),
      bindings: { topic: "leases" },
    });
    assert.deepEqual(created.bindings, { topic: "leases" });
    const updated = storage.chatSessionRunVariables.upsert({
      ...created,
      ownerRevision: "revision-2",
      bindings: { topic: "recovery" },
    });
    assert.equal(updated.createdAt, created.createdAt);
    assert.deepEqual(updated.bindings, { topic: "recovery" });
    storage.close();
  });

  it("ships typed-variable storage in both database engines", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    const tables = storage.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_session_run_variable_bindings'")
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((table) => table.name),
      ["chat_session_run_variable_bindings"],
    );
    const postgres = POSTGRES_MIGRATIONS.find((migration) => migration.version === 127);
    assert.equal(postgres?.name, "typed_run_variables");
    assert.match(postgres?.sql ?? "", /chat_session_run_variable_bindings/u);
    assert.match(postgres?.sql ?? "", /run_variable_schema_json/u);
    storage.close();
  });
});
