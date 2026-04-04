import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepo(): SessionAutonomyPrefsRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-autonomy-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new SessionAutonomyPrefsRepository(db);
}

describe("SessionAutonomyPrefsRepository", () => {
  it("returns defaults when ensuring missing rows", () => {
    const repo = createRepo();
    const prefs = repo.ensure("sess-1");
    assert.equal(prefs.proactiveMode, "off");
    assert.equal(prefs.maxActionsPerHour, 6);
    assert.equal(prefs.maxActionsPerTurn, 2);
    assert.equal(prefs.cooldownSeconds, 60);
    assert.equal(prefs.retrievalMode, "standard");
    assert.equal(prefs.reflectionMode, "off");
  });

  it("lists existing rows by session id in one map", () => {
    const repo = createRepo();
    repo.ensure("sess-1");
    repo.patch("sess-2", { proactiveMode: "suggest", maxActionsPerTurn: 4 });
    const map = repo.listBySessionIds(["sess-1", "sess-2", "sess-3"]);
    assert.equal(map.get("sess-1")?.proactiveMode, "off");
    assert.equal(map.get("sess-2")?.proactiveMode, "suggest");
    assert.equal(map.has("sess-3"), false);
  });

  it("round-trips proactive budget, retrieval mode, and reflection mode", () => {
    const repo = createRepo();
    const prefs = repo.patch("sess-1", {
      proactiveMode: "auto_full",
      maxActionsPerHour: 12,
      maxActionsPerTurn: 5,
      cooldownSeconds: 180,
      retrievalMode: "layered",
      reflectionMode: "on",
    });

    assert.equal(prefs.proactiveMode, "auto_full");
    assert.equal(prefs.maxActionsPerHour, 12);
    assert.equal(prefs.maxActionsPerTurn, 5);
    assert.equal(prefs.cooldownSeconds, 180);
    assert.equal(prefs.retrievalMode, "layered");
    assert.equal(prefs.reflectionMode, "on");

    const reloaded = repo.get("sess-1");
    assert.equal(reloaded?.retrievalMode, "layered");
    assert.equal(reloaded?.reflectionMode, "on");
  });
});
