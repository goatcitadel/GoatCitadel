import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { SessionAutonomyPrefsRepository } from "./session-autonomy-prefs-repo.js";
import type { DbStatement } from "./db.js";

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

  it("touches proactive run state, clamps budgets, and handles empty or malformed adapter reads", () => {
    const repo = createRepo();

    const touched = repo.touch("sess-touch", "run-1", "2026-03-08T00:00:00.000Z");
    assert.equal(touched.lastProactiveAt, "2026-03-08T00:00:00.000Z");
    assert.equal(touched.lastProactiveRunId, "run-1");

    const clamped = repo.patch("sess-touch", {
      maxActionsPerHour: 999,
      maxActionsPerTurn: -1,
      cooldownSeconds: -5,
    });
    assert.equal(clamped.maxActionsPerHour, 200);
    assert.equal(clamped.maxActionsPerTurn, 1);
    assert.equal(clamped.cooldownSeconds, 0);

    assert.equal(repo.listBySessionIds([" ", ""]).size, 0);

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
      upsertStmt: { run: (...args: unknown[]) => unknown };
      db: ReturnType<typeof createDatabase>;
    };
    internal.getStmt = { get: () => null };
    assert.equal(repo.get("malformed"), undefined);

    internal.upsertStmt = { run: () => ({ changes: 1 }) };
    assert.throws(() => repo.ensure("unreadable", "2026-03-08T00:00:00.000Z"), /session autonomy prefs/);

    const originalPrepare = internal.db.prepare.bind(internal.db);
    internal.db.prepare = (sql: string): DbStatement => {
      if (sql.includes("FROM session_autonomy_prefs") && sql.includes("IN")) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: <T = unknown>() => [{ session_id: "bad", proactive_mode: 42 }] as T[],
        };
      }
      return originalPrepare(sql);
    };
    assert.equal(repo.listBySessionIds(["sess-touch"]).size, 0);
  });
});
