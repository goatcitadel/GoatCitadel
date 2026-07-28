import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { BUILTIN_AGENT_PROFILES, RUN_VARIABLE_SCHEMA_VERSION } from "@goatcitadel/contracts";
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

  it("covers validation, idempotent lifecycle edges, and defensive JSON mapping", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;

    assert.throws(() => repo.get("missing-agent"), /Agent profile missing-agent not found/);
    assert.equal(repo.find("missing-agent"), undefined);
    assert.equal(repo.getByRoleId("missing-role"), undefined);
    assert.equal(repo.hardDelete("missing-agent"), false);
    assert.throws(
      () =>
        repo.create({
          roleId: "   ",
          name: "Role",
          title: "Role",
          summary: "Role",
        }),
      /roleId is required/,
    );
    assert.throws(
      () =>
        repo.create({
          roleId: "qa",
          name: "   ",
          title: "QA",
          summary: "QA",
        }),
      /name is required/,
    );

    const created = repo.create({
      roleId: `${"A".repeat(90)}!!!`,
      name: "QA Goat",
      title: "Quality Analyst",
      summary: "Checks release quality",
      specialties: [" QA ", "QA", "", "Regression"],
      defaultTools: ["browser.open", "browser.open", " "],
      aliases: ["qa", "qa", " tester "],
      presetDefaults: {
        presetLabel: "   ",
        presetSummary: "",
        preferredProviderId: " ",
        preferredModel: "",
        knowledgeAttachmentIds: [" ", ""],
        promptFraming: " ",
      },
    });

    assert.equal(created.roleId.length, 80);
    assert.deepEqual(created.specialties, ["QA", "Regression"]);
    assert.deepEqual(created.defaultTools, ["browser.open"]);
    assert.deepEqual(created.aliases, ["qa", "tester"]);
    assert.equal(created.presetDefaults, undefined);

    const realDefaults = repo.update(created.agentId, {
      presetDefaults: {
        presetLabel: "  QA preset ",
        presetSummary: "  Verify the change ",
        preferredProviderId: " openai ",
        preferredModel: " gpt-5 ",
        knowledgeAttachmentIds: [" doc-1 ", "", "doc-2"],
        promptFraming: "  Be strict ",
        runVariableSchema: {
          version: RUN_VARIABLE_SCHEMA_VERSION,
          fields: [{ id: "scope", label: "Scope", type: "text", required: true }],
        },
        runVariableDefaults: { scope: "runtime" },
      },
    });
    assert.deepEqual(realDefaults.presetDefaults, {
      presetLabel: "QA preset",
      presetSummary: "Verify the change",
      routeHint: undefined,
      preferredProviderId: "openai",
      preferredModel: "gpt-5",
      toolsPosture: undefined,
      knowledgeAttachmentIds: ["doc-1", "doc-2"],
      promptFraming: "Be strict",
      runVariableSchema: {
        version: RUN_VARIABLE_SCHEMA_VERSION,
        fields: [{ id: "scope", label: "Scope", type: "text", required: true, maxLength: 4000 }],
      },
      runVariableDefaults: { scope: "runtime" },
    });

    db.prepare(
      `
      UPDATE agent_profiles
      SET specialties_json = ?,
          default_tools_json = ?,
          aliases_json = ?,
          preset_defaults_json = ?
      WHERE agent_id = ?
    `,
    ).run(
      '"not-array"',
      JSON.stringify([1, " shell.exec ", "shell.exec", " "]),
      "{bad",
      '"not-object"',
      created.agentId,
    );

    const defensive = repo.get(created.agentId);
    assert.deepEqual(defensive.specialties, []);
    assert.deepEqual(defensive.defaultTools, ["shell.exec"]);
    assert.deepEqual(defensive.aliases, []);
    assert.equal(defensive.presetDefaults, undefined);

    const archived = repo.archive(created.agentId, { archivedBy: " ", archiveReason: "" });
    assert.equal(archived.archivedBy, undefined);
    assert.equal(repo.archive(created.agentId, {}).archivedAt, archived.archivedAt);
    const restored = repo.restore(created.agentId);
    assert.equal(restored.lifecycleStatus, "active");
    assert.equal(repo.restore(created.agentId).updatedAt, restored.updatedAt);
    assert.ok(repo.list("all", 0).some((agent) => agent.agentId === created.agentId));
  });
});
