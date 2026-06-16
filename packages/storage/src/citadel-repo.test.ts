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

  it("adds, lists, and removes council members scoped to a citadel", () => {
    const repo = createRepo();
    const cos = repo.addCouncilMember({
      citadelId: "ws-1",
      name: "Chief of Staff",
      archetype: "chief_of_staff",
      role: "Coordinate priorities",
    });
    repo.addCouncilMember({ citadelId: "ws-1", name: "Planner", archetype: "planner", role: "Plan the week" });
    repo.addCouncilMember({ citadelId: "ws-2", name: "Other", archetype: "operator", role: "x" });

    assert.equal(cos.archetype, "chief_of_staff");
    assert.deepEqual(
      repo.listCouncilMembers("ws-1").map((member) => member.name).sort(),
      ["Chief of Staff", "Planner"],
    );
    assert.deepEqual(repo.getCouncilMember(cos.memberId), cos);

    assert.equal(repo.removeCouncilMember(cos.memberId), true);
    assert.deepEqual(
      repo.listCouncilMembers("ws-1").map((member) => member.name),
      ["Planner"],
    );
  });

  it("creates, lists, and transitions missions scoped to a citadel", () => {
    const repo = createRepo();
    const mission = repo.createMission({ citadelId: "ws-1", title: "Plan week", objective: "plan" });
    repo.createMission({ citadelId: "ws-1", title: "Organize docs", objective: "organize", mode: "review" });
    repo.createMission({ citadelId: "ws-2", title: "Other", objective: "x" });

    assert.equal(mission.state, "draft");
    assert.equal(mission.mode, "ask");
    assert.equal(repo.listMissions("ws-1").length, 2);

    const running = repo.updateMissionState(mission.missionId, "running");
    assert.equal(running?.state, "running");
    assert.equal(running?.completedAt, undefined);

    const done = repo.updateMissionState(mission.missionId, "completed");
    assert.equal(done?.state, "completed");
    assert.ok(done?.completedAt);

    assert.equal(repo.updateMissionState("missing", "running"), undefined);
  });
});
