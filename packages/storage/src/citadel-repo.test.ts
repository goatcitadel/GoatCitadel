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
  it("creates, updates, archives, restores, and lists Citadel records", () => {
    const repo = createRepo();
    const created = repo.createRecord(
      {
        name: "Client Alpha",
        description: "Scoped client operating world",
        kind: "client",
        defaultWorkspaceId: "engineering",
      },
      "2026-06-20T00:00:00.000Z",
    );

    assert.equal(created.citadelId, "client-alpha");
    assert.equal(created.slug, "client-alpha");
    assert.equal(created.lifecycleStatus, "active");
    assert.equal(created.defaultWorkspaceId, "engineering");
    assert.deepEqual(
      repo
        .listRecords("active")
        .map((record) => record.citadelId)
        .sort(),
      ["client-alpha", "company", "personal"],
    );

    const updated = repo.updateRecord(
      created.citadelId,
      { name: "Client Alpha HQ", slug: "client-alpha-hq", description: "  ", kind: "company" },
      "2026-06-20T00:05:00.000Z",
    );
    assert.equal(updated.name, "Client Alpha HQ");
    assert.equal(updated.slug, "client-alpha-hq");
    assert.equal(updated.description, undefined);
    assert.equal(updated.kind, "company");

    assert.throws(() => repo.createRecord({ name: "Client Alpha HQ" }), /already in use/);

    const archived = repo.archiveRecord(created.citadelId, "2026-06-20T00:10:00.000Z");
    assert.equal(archived.lifecycleStatus, "archived");
    assert.equal(
      repo.listRecords("active").some((record) => record.citadelId === created.citadelId),
      false,
    );
    assert.equal(repo.listRecords("archived")[0]?.citadelId, created.citadelId);

    const restored = repo.restoreRecord(created.citadelId, "2026-06-20T00:15:00.000Z");
    assert.equal(restored.lifecycleStatus, "active");
  });

  it("seeds Personal and Company Citadel records for new databases", () => {
    const repo = createRepo();

    assert.equal(repo.getRecord("personal").kind, "personal");
    assert.equal(repo.getRecord("personal").defaultWorkspaceId, "default");
    assert.equal(repo.getRecord("company").kind, "company");
    assert.equal(repo.getRecord("company").defaultWorkspaceId, undefined);
  });

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
    assert.deepEqual(chambers.map((chamber) => chamber.name).sort(), ["Finance", "General"]);
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
      repo
        .listCouncilAssignments("ws-1")
        .map((assignment) => assignment.agentId)
        .sort(),
      ["agent-architect", "agent-coder"],
    );

    assert.equal(repo.unassignAgent("ws-1", "agent-architect"), true);
    assert.deepEqual(
      repo.listCouncilAssignments("ws-1").map((assignment) => assignment.agentId),
      ["agent-coder"],
    );
    assert.equal(repo.unassignAgent("ws-1", "nope"), false);
  });

  it("adds, lists, and removes wards scoped to a citadel", () => {
    const repo = createRepo();
    const ward = repo.addWard({
      citadelId: "ws-1",
      name: "No prod writes",
      actionPattern: "database.*",
      effect: "require_approval",
    });
    repo.addWard({ citadelId: "ws-1", name: "No email send", actionPattern: "email.send", effect: "deny" });
    repo.addWard({ citadelId: "ws-2", name: "Other", actionPattern: "*", effect: "allow" });

    assert.equal(ward.effect, "require_approval");
    assert.deepEqual(
      repo
        .listWards("ws-1")
        .map((entry) => entry.name)
        .sort(),
      ["No email send", "No prod writes"],
    );

    assert.equal(repo.removeWard("ws-1", ward.wardId), true);
    assert.equal(repo.listWards("ws-1").length, 1);
    assert.equal(repo.removeWard("ws-1", "nope"), false);
  });

  it("stores, lists (metadata only), reveals, and deletes vault secrets scoped to a citadel", () => {
    const repo = createRepo();
    const sealed = { iv: "aXY=", ciphertext: "Y2lwaGVy", tag: "dGFn" };
    const stored = repo.storeVaultSecret({ citadelId: "ws-1", secretName: "stripe", sealedValue: sealed });
    assert.equal(stored.secretName, "stripe");
    assert.deepEqual(stored.sealedValue, sealed);

    repo.storeVaultSecret({ citadelId: "ws-1", secretName: "openai", sealedValue: sealed });
    repo.storeVaultSecret({ citadelId: "ws-2", secretName: "other", sealedValue: sealed });

    assert.deepEqual(
      repo
        .listVaultSecrets("ws-1")
        .map((entry) => entry.secretName)
        .sort(),
      ["openai", "stripe"],
    );

    // Reveal returns the sealed value; the service opens it with the master key.
    assert.deepEqual(repo.getVaultSecret("ws-1", stored.secretId)?.sealedValue, sealed);

    // Isolation: a ws-2 secret id is not retrievable under ws-1.
    const otherId = repo.listVaultSecrets("ws-2")[0]?.secretId ?? "missing";
    assert.equal(repo.getVaultSecret("ws-1", otherId), undefined);

    assert.equal(repo.deleteVaultSecret("ws-1", stored.secretId), true);
    assert.equal(repo.listVaultSecrets("ws-1").length, 1);
    assert.equal(repo.deleteVaultSecret("ws-1", "nope"), false);
  });

  it("re-storing a vault secret by name overwrites the sealed value and keeps one row", () => {
    const repo = createRepo();
    const a = { iv: "YQ==", ciphertext: "YQ==", tag: "YQ==" };
    const b = { iv: "Yg==", ciphertext: "Yg==", tag: "Yg==" };
    const first = repo.storeVaultSecret({ citadelId: "ws-1", secretName: "k", sealedValue: a });
    const second = repo.storeVaultSecret({ citadelId: "ws-1", secretName: "k", sealedValue: b });
    assert.equal(repo.listVaultSecrets("ws-1").length, 1);
    assert.equal(second.secretId, first.secretId);
    assert.deepEqual(repo.getVaultSecret("ws-1", first.secretId)?.sealedValue, b);
  });

  it("creates, lists, and removes passages originating from a citadel", () => {
    const repo = createRepo();
    const passage = repo.createPassage({
      sourceCitadelId: "ws-1",
      destinationCitadelId: "ws-2",
      allowedFields: ["availability"],
    });
    repo.createPassage({
      sourceCitadelId: "ws-1",
      destinationCitadelId: "ws-3",
      allowedFields: ["status"],
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    repo.createPassage({ sourceCitadelId: "ws-9", destinationCitadelId: "ws-2", allowedFields: ["x"] });

    assert.deepEqual(passage.allowedFields, ["availability"]);
    assert.equal(passage.destinationCitadelId, "ws-2");
    assert.equal(repo.listPassages("ws-1").length, 2);

    assert.equal(repo.removePassage("ws-1", passage.passageId), true);
    assert.equal(repo.listPassages("ws-1").length, 1);
    assert.equal(repo.removePassage("ws-1", "nope"), false);
  });

  it("upserts members with roles and removes them, scoped to a citadel", () => {
    const repo = createRepo();
    const alice = repo.upsertMember({ citadelId: "ws-1", subjectId: "alice", role: "operator" });
    repo.upsertMember({ citadelId: "ws-1", subjectId: "bob", role: "viewer" });
    repo.upsertMember({ citadelId: "ws-2", subjectId: "alice", role: "owner" });

    assert.equal(alice.role, "operator");
    assert.equal(repo.listMembers("ws-1").length, 2);

    // Upsert updates the role idempotently on (citadel, subject).
    const promoted = repo.upsertMember({ citadelId: "ws-1", subjectId: "alice", role: "steward" });
    assert.equal(promoted.role, "steward");
    assert.equal(repo.listMembers("ws-1").length, 2);

    assert.equal(repo.removeMember("ws-1", "alice"), true);
    assert.deepEqual(
      repo.listMembers("ws-1").map((member) => member.subjectId),
      ["bob"],
    );
    assert.equal(repo.removeMember("ws-1", "nope"), false);
  });

  it("creates a mason session and accumulates answers across updates", () => {
    const repo = createRepo();
    const session = repo.createMasonSession();
    assert.equal(session.status, "collecting");
    assert.deepEqual(session.answers, {});

    const afterKind = repo.updateMasonSessionAnswers(session.sessionId, { kind: "company" });
    assert.equal(afterKind?.answers.kind, "company");

    const afterPurpose = repo.updateMasonSessionAnswers(session.sessionId, { purpose: "Run the company" });
    // Earlier answer is retained (merge, not replace).
    assert.equal(afterPurpose?.answers.kind, "company");
    assert.equal(afterPurpose?.answers.purpose, "Run the company");

    const drafted = repo.setMasonSessionStatus(session.sessionId, "drafted");
    assert.equal(drafted?.status, "drafted");
    assert.equal(drafted?.answers.kind, "company");

    assert.equal(repo.getMasonSession("nope"), undefined);
    assert.equal(repo.updateMasonSessionAnswers("nope", { kind: "personal" }), undefined);
  });

  it("records, lists, and removes integration grants scoped to a citadel", () => {
    const repo = createRepo();
    const grant = repo.addIntegrationGrant({
      citadelId: "ws-1",
      provider: "google_calendar",
      account: "user@example.com",
      capabilities: ["calendar.events.read"],
      mode: "read",
    });
    repo.addIntegrationGrant({ citadelId: "ws-1", provider: "stripe", capabilities: ["charges.read"], mode: "read" });
    repo.addIntegrationGrant({ citadelId: "ws-2", provider: "github", capabilities: ["issues.read"], mode: "read" });

    assert.equal(grant.provider, "google_calendar");
    assert.deepEqual(grant.capabilities, ["calendar.events.read"]);
    assert.equal(grant.mode, "read");
    assert.equal(grant.account, "user@example.com");
    assert.deepEqual(
      repo
        .listIntegrationGrants("ws-1")
        .map((entry) => entry.provider)
        .sort(),
      ["google_calendar", "stripe"],
    );

    assert.equal(repo.removeIntegrationGrant("ws-1", grant.grantId), true);
    assert.equal(repo.listIntegrationGrants("ws-1").length, 1);
    assert.equal(repo.removeIntegrationGrant("ws-1", "nope"), false);
  });
});
