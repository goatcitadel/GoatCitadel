import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { BUILTIN_AGENT_PROFILES } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { AgentProfileRepository } from "./agent-profile-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): AgentProfileRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-agent-profiles-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new AgentProfileRepository(db);
}

describe("AgentProfileRepository", () => {
  it("seeds built-ins idempotently and allows mutable field edits", () => {
    const repo = createRepo();

    repo.seedBuiltins(BUILTIN_AGENT_PROFILES);
    repo.seedBuiltins(BUILTIN_AGENT_PROFILES);

    const active = repo.list("active", 100);
    assert.equal(active.length >= BUILTIN_AGENT_PROFILES.length, true);

    const architect = active.find((item) => item.roleId === "architect");
    const coder = active.find((item) => item.roleId === "coder");
    assert.ok(architect);
    assert.ok(coder);
    assert.equal(architect.isBuiltin, true);
    assert.equal(coder.presetDefaults?.presetLabel, "Code Helper");

    const updated = repo.update(architect.agentId, {
      title: "Chief Systems Architect",
      summary: "Updated summary",
    });
    assert.equal(updated.title, "Chief Systems Architect");
    assert.equal(updated.summary, "Updated summary");
    assert.equal(updated.roleId, "architect");
  });

  it("blocks hard delete for built-ins", () => {
    const repo = createRepo();
    repo.seedBuiltins(BUILTIN_AGENT_PROFILES);
    const architect = repo.list("active", 100).find((item) => item.roleId === "architect");
    assert.ok(architect);
    assert.throws(() => repo.hardDelete(architect.agentId), /Built-in agents cannot be hard deleted/);
  });

  it("supports custom create update archive restore and hard delete", () => {
    const repo = createRepo();
    repo.seedBuiltins(BUILTIN_AGENT_PROFILES);

    const created = repo.create({
      roleId: "writer",
      name: "Writer Goat",
      title: "Docs Writer",
      summary: "Writes docs",
      specialties: ["Docs"],
      defaultTools: ["fs.read"],
      aliases: ["writer"],
    });
    assert.equal(created.isBuiltin, false);
    assert.equal(created.lifecycleStatus, "active");

    const updated = repo.update(created.agentId, {
      specialties: ["Docs", "Examples"],
      aliases: ["writer", "documentation"],
    });
    assert.deepEqual(updated.specialties, ["Docs", "Examples"]);
    assert.deepEqual(updated.aliases, ["writer", "documentation"]);

    const archived = repo.archive(created.agentId, {
      archivedBy: "tester",
      archiveReason: "no longer needed",
    });
    assert.equal(archived.lifecycleStatus, "archived");
    assert.equal(archived.archivedBy, "tester");

    const restored = repo.restore(created.agentId);
    assert.equal(restored.lifecycleStatus, "active");
    assert.equal(restored.archivedAt, undefined);

    const deleted = repo.hardDelete(created.agentId);
    assert.equal(deleted, true);
    assert.equal(repo.find(created.agentId), undefined);
  });

  it("rejects duplicate role ids", () => {
    const repo = createRepo();
    repo.seedBuiltins(BUILTIN_AGENT_PROFILES);
    assert.throws(() => {
      repo.create({
        roleId: "architect",
        name: "Duplicate",
        title: "Duplicate",
        summary: "Duplicate",
      });
    }, /already exists/);
  });
});
