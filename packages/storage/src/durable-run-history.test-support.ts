import assert from "node:assert/strict";
import { ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { DurableRunRepository } from "./durable-run-repo.js";

export function verifyDurableRunHistory(db: DatabaseClient): void {
  const repo = new DurableRunRepository(db);
  const now = "2026-09-30T00:00:00.000Z";
  const create = (runId: string, payload: Record<string, unknown>, metadata?: Record<string, unknown>) => repo.createRun({
    runId, workflowKey: "chat.turn.execute", payload, metadata, now,
  });
  create("run-c", { workspaceId: "alpha" });
  create("run-b", {}, { workspaceId: "alpha" });
  create("run-a", { workspaceId: "alpha" }, { workspaceId: "alpha" });
  create("run-z-foreign", { workspaceId: "beta" });
  create("run-z-missing", {});
  create("run-z-conflict", { workspaceId: "alpha" }, { workspaceId: "beta" });
  create("run-z-reverse-conflict", { workspaceId: "beta" }, { workspaceId: "alpha" });
  create("run-z-invalid", { workspaceId: 42 }, { workspaceId: "alpha" });
  create("run-z-invalid-meta", { workspaceId: "alpha" }, { workspaceId: ["alpha"] });
  create("run-z-empty-meta", { workspaceId: "alpha" }, { workspaceId: "" });
  repo.createRun({ runId: "run-old", workflowKey: "maintenance", payload: { workspaceId: "alpha" }, now: "2026-09-29T00:00:00.000Z" });
  assert.equal(repo.listRuns(100).length, 11, "legacy unscoped listing retains all records");

  // Bypass the write-side serializer only in this isolated fixture to model
  // legacy disk corruption. Both fields must remain objects; invalid metadata
  // cannot fall back to the valid payload scope (or vice versa).
  const corruptJson = ["{", "", '[{"workspaceId":"alpha"}]', '"alpha"', "42", "null", "true"];
  for (const column of ["payload_json", "metadata_json"] as const) {
    corruptJson.forEach((raw, index) => {
      const runId = `run-z-corrupt-${column}-${index}`;
      create(runId, { workspaceId: "alpha" }, { workspaceId: "alpha" });
      db.prepare(`UPDATE durable_runs SET ${column} = ? WHERE run_id = ?`).run(raw, runId);
    });
  }

  const first = repo.listRunHistory({ workspaceId: "alpha", limit: 2 });
  assert.deepEqual(first.items.map((run) => run.runId), ["run-c", "run-b"]);
  assert.ok(first.nextCursor);
  repo.updateRun({ runId: "run-a", status: "completed", updatedAt: "2026-10-01T00:00:00.000Z" });
  const second = repo.listRunHistory({ workspaceId: "alpha", limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((run) => run.runId), ["run-a", "run-old"]);
  assert.equal(second.items[0]?.status, "completed");
  assert.equal(second.nextCursor, undefined);
  assert.equal(new Set([...first.items, ...second.items].map((run) => run.runId)).size, 4);
  assert.deepEqual(repo.listRunHistory({ workspaceId: "beta" }).items.map((run) => run.runId), ["run-z-foreign"]);
  assert.deepEqual(repo.listRunHistory({ workspaceId: "empty" }), { items: [] });
  assert.equal(db.prepare("SELECT metadata_json FROM durable_runs WHERE run_id = ?").get<{ metadata_json: string }>("run-z-corrupt-metadata_json-0")?.metadata_json, "{", "history remains read-only for corrupt records");

  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  for (const cursor of ["", "bad!", "a".repeat(1025), encode({}), encode({ version: 1, workspaceId: "alpha", runId: "run-b", createdAt: "not-a-date" }), encode({ version: 1, workspaceId: "alpha", runId: "run-b", createdAt: now, extra: true })]) {
    assert.throws(() => repo.listRunHistory({ workspaceId: "alpha", cursor }), ValidationError);
  }
  assert.throws(() => repo.listRunHistory({ workspaceId: "beta", cursor: first.nextCursor }), ValidationError);
  for (const workspaceId of ["", " alpha", "alpha\n", "é".repeat(101)]) {
    assert.throws(() => repo.listRunHistory({ workspaceId }), ValidationError);
  }
  for (const limit of [0, -1, 501, 1.5, Number.NaN]) {
    assert.throws(() => repo.listRunHistory({ workspaceId: "alpha", limit }), ValidationError);
  }
}
