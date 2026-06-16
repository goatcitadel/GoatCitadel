import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { CitadelRepository } from "./citadel-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function createRepo(): CitadelRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-citadel-repo-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new CitadelRepository(createDatabase({ dbPath }));
}

describe("CitadelRepository", () => {
  it("upserts and reads a charter with defaults applied", () => {
    const repo = createRepo();
    const charter = repo.upsertCharter({
      citadelId: "ws-1",
      purpose: "Run the company",
      kind: "company",
      goals: ["ship 1.0"],
    });
    assert.equal(charter.citadelId, "ws-1");
    assert.equal(charter.kind, "company");
    assert.deepEqual(charter.goals, ["ship 1.0"]);
    assert.deepEqual(charter.boundaries, []);
    assert.equal(charter.riskPosture, "balanced");
    assert.equal(charter.modelPolicyDefault, "hybrid_guarded");

    assert.deepEqual(repo.getCharter("ws-1"), charter);
  });

  it("updates an existing charter on upsert", () => {
    const repo = createRepo();
    repo.upsertCharter({ citadelId: "ws-1", purpose: "v1", kind: "company" });
    const updated = repo.upsertCharter({
      citadelId: "ws-1",
      purpose: "v2",
      kind: "company",
      riskPosture: "conservative",
    });
    assert.equal(updated.purpose, "v2");
    assert.equal(updated.riskPosture, "conservative");
    assert.equal(repo.getCharter("ws-1")?.purpose, "v2");
  });

  it("returns undefined for a missing charter", () => {
    const repo = createRepo();
    assert.equal(repo.getCharter("nope"), undefined);
  });

  it("creates chambers and lists them scoped to a citadel", () => {
    const repo = createRepo();
    const general = repo.createChamber({ citadelId: "ws-1", name: "General" });
    repo.createChamber({ citadelId: "ws-1", name: "Finance", sensitivity: "restricted", sealed: true });
    repo.createChamber({ citadelId: "ws-2", name: "Other" });

    assert.equal(general.sensitivity, "private");
    assert.equal(general.sealed, false);

    const chambers = repo.listChambers("ws-1");
    assert.deepEqual(
      chambers.map((chamber) => chamber.name).sort(),
      ["Finance", "General"],
    );
    const finance = chambers.find((chamber) => chamber.name === "Finance");
    assert.equal(finance?.sealed, true);
    assert.equal(finance?.sensitivity, "restricted");

    assert.deepEqual(repo.getChamber(general.chamberId), general);
  });

  it("assembles a citadel view from charter and chambers", () => {
    const repo = createRepo();
    repo.upsertCharter({ citadelId: "ws-1", purpose: "p", kind: "project" });
    repo.createChamber({ citadelId: "ws-1", name: "General" });

    const citadel = repo.getCitadel("ws-1");
    assert.equal(citadel?.citadelId, "ws-1");
    assert.equal(citadel?.charter.kind, "project");
    assert.equal(citadel?.chambers.length, 1);

    assert.equal(repo.getCitadel("ws-missing"), undefined);
  });

  it("assigns existing agents to a citadel council idempotently and unassigns them", () => {
    const repo = createRepo();
    const architect = repo.assignAgent({ citadelId: "ws-1", agentId: "agent-architect" });
    repo.assignAgent({ citadelId: "ws-1", agentId: "agent-architect" }); // idempotent — no duplicate
    repo.assignAgent({ citadelId: "ws-1", agentId: "agent-coder" });
    repo.assignAgent({ citadelId: "ws-2", agentId: "agent-architect" });

    assert.equal(architect.agentId, "agent-architect");
    assert.deepEqual(
      repo.listCouncilAssignments("ws-1").map((assignment) => assignment.agentId).sort(),
      ["agent-architect", "agent-coder"],
    );

    assert.equal(repo.unassignAgent("ws-1", "agent-architect"), true);
    assert.deepEqual(
      repo.listCouncilAssignments("ws-1").map((assignment) => assignment.agentId),
      ["agent-coder"],
    );
    assert.equal(repo.unassignAgent("ws-1", "nope"), false);
  });
});
