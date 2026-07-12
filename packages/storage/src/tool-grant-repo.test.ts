import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ToolGrantRepository } from "./tool-grant-repo.js";
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

function createRepo(): ToolGrantRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-tool-grants-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ToolGrantRepository(db);
}

function createRepoAtPath(dbPath: string): ToolGrantRepository {
  return new ToolGrantRepository(createDatabase({ dbPath }));
}

describe("ToolGrantRepository", () => {
  it("creates scoped grants with defaults and lists them back", () => {
    const repo = createRepo();

    const grant = repo.create(
      {
        toolPattern: "shell.*",
        decision: "allow",
        scope: "session",
        scopeRef: "sess-1",
        createdBy: "operator",
      },
      "2026-03-05T10:00:00.000Z",
    );

    assert.equal(grant.scopeRef, "sess-1");
    assert.equal(grant.grantType, "persistent");
    assert.equal(repo.list("session", "sess-1").length, 1);
  });

  it("rolls back the inserted grant when its readback fails", () => {
    const repo = createRepo();
    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
    };
    internal.getStmt = {
      get: () => {
        throw new Error("grant readback unavailable");
      },
    };

    assert.throws(
      () =>
        repo.create({
          toolPattern: "browser.*",
          decision: "allow",
          scope: "global",
          createdBy: "operator",
        }),
      /grant readback unavailable/,
    );
    assert.equal(repo.list().length, 0);
  });

  it("lists all active scoped grants for policy decisions without the UI list cap", () => {
    const repo = createRepo();

    const deny = repo.create(
      {
        toolPattern: "shell.exec",
        decision: "deny",
        scope: "session",
        scopeRef: "sess-1",
        createdBy: "operator",
      },
      "2026-03-05T10:00:00.000Z",
    );
    for (let index = 0; index < 501; index += 1) {
      repo.create(
        {
          toolPattern: "shell.exec",
          decision: "allow",
          scope: "session",
          scopeRef: "sess-1",
          createdBy: "operator",
        },
        new Date(Date.UTC(2026, 2, 5, 10, 0, index + 1)).toISOString(),
      );
    }

    assert.equal(
      repo.list("session", "sess-1", 500).some((grant) => grant.grantId === deny.grantId),
      false,
    );
    assert.equal(
      repo.listActive("session", "sess-1").some((grant) => grant.grantId === deny.grantId),
      true,
    );
  });

  it("supports one-time grants and revocation", () => {
    const repo = createRepo();

    const grant = repo.create(
      {
        toolPattern: "browser.interact",
        decision: "allow",
        scope: "global",
        grantType: "one_time",
        createdBy: "operator",
      },
      "2026-03-05T10:00:00.000Z",
    );

    assert.equal(grant.usesRemaining, 1);
    assert.equal(repo.consumeOne(grant.grantId), true);
    assert.equal(repo.get(grant.grantId).usesRemaining, 0);
    assert.equal(repo.consumeOne(grant.grantId), false);
    assert.equal(repo.revoke(grant.grantId, "2026-03-05T10:05:00.000Z", "operator-1"), true);
    assert.equal(repo.get(grant.grantId).revokedAt, "2026-03-05T10:05:00.000Z");
    assert.equal(repo.get(grant.grantId).revokedBy, "operator-1");
  });

  it("excludes revoked and exhausted one-time grants from active discovery", () => {
    const repo = createRepo();
    const scopeRef = "session-active-lifecycle";
    const revoked = repo.create({
      toolPattern: "http.post",
      decision: "allow",
      scope: "session",
      scopeRef,
      createdBy: "operator",
    });
    const exhausted = repo.create({
      toolPattern: "channel.send",
      decision: "allow",
      scope: "session",
      scopeRef,
      grantType: "one_time",
      createdBy: "operator",
    });

    const activeBefore = new Set(repo.listActive("session", scopeRef).map((grant) => grant.grantId));
    assert.equal(activeBefore.has(revoked.grantId), true);
    assert.equal(activeBefore.has(exhausted.grantId), true);

    assert.equal(repo.revoke(revoked.grantId, new Date().toISOString(), "operator"), true);
    assert.equal(repo.consumeOne(exhausted.grantId), true);
    assert.equal(repo.get(exhausted.grantId).usesRemaining, 0);

    const rawIds = new Set(repo.list("session", scopeRef).map((grant) => grant.grantId));
    assert.equal(rawIds.has(revoked.grantId), true);
    assert.equal(rawIds.has(exhausted.grantId), true);
    const activeAfter = new Set(repo.listActive("session", scopeRef).map((grant) => grant.grantId));
    assert.equal(activeAfter.has(revoked.grantId), false);
    assert.equal(activeAfter.has(exhausted.grantId), false);
  });

  it("atomically rejects revoked, expired, and deny grants for every lifetime", () => {
    const repo = createRepo();
    const now = Date.now();
    const persistent = repo.create({
      toolPattern: "channel.send",
      decision: "allow",
      scope: "global",
      createdBy: "operator",
    });
    const activeTtl = repo.create(
      {
        toolPattern: "http.post",
        decision: "allow",
        scope: "global",
        grantType: "ttl",
        expiresAt: new Date(now + 60_000).toISOString(),
        createdBy: "operator",
      },
      new Date(now).toISOString(),
    );
    const expiredTtl = repo.create(
      {
        toolPattern: "webhook.send",
        decision: "allow",
        scope: "global",
        grantType: "ttl",
        expiresAt: new Date(now + 120_000).toISOString(),
        createdBy: "operator",
      },
      new Date(now).toISOString(),
    );
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    db.prepare("UPDATE tool_grants SET expires_at = ? WHERE grant_id = ?").run(
      new Date(now - 60_000).toISOString(),
      expiredTtl.grantId,
    );
    const deny = repo.create({
      toolPattern: "shell.exec",
      decision: "deny",
      scope: "global",
      createdBy: "operator",
    });

    assert.equal(repo.consumeOne(persistent.grantId), true);
    assert.equal(repo.consumeOne(activeTtl.grantId), true);
    assert.equal(repo.consumeOne(expiredTtl.grantId), false);
    assert.equal(repo.consumeOne(deny.grantId), false);
    assert.equal(repo.revoke(persistent.grantId, new Date().toISOString(), "operator"), true);
    assert.equal(repo.consumeOne(persistent.grantId), false);
  });

  it("uses database time for active grant discovery regardless of caller-clock skew", () => {
    const repo = createRepo();
    const databaseNow = Date.now();
    const active = repo.create(
      {
        toolPattern: "http.get",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
        grantType: "ttl",
        expiresAt: new Date(databaseNow + 60_000).toISOString(),
        createdBy: "operator",
      },
      new Date(databaseNow).toISOString(),
    );
    const expired = repo.create(
      {
        toolPattern: "http.post",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
        grantType: "ttl",
        expiresAt: new Date(databaseNow + 180_000).toISOString(),
        createdBy: "operator",
      },
      new Date(databaseNow).toISOString(),
    );
    const malformed = repo.create(
      {
        toolPattern: "webhook.send",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
        grantType: "ttl",
        expiresAt: new Date(databaseNow + 120_000).toISOString(),
        createdBy: "operator",
      },
      new Date(databaseNow).toISOString(),
    );
    const emptyExpiry = repo.create(
      {
        toolPattern: "channel.send",
        decision: "allow",
        scope: "workspace",
        scopeRef: "workspace-1",
        grantType: "ttl",
        expiresAt: new Date(databaseNow + 120_000).toISOString(),
        createdBy: "operator",
      },
      new Date(databaseNow).toISOString(),
    );
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;
    db.prepare("UPDATE tool_grants SET expires_at = ? WHERE grant_id = ?").run(
      new Date(databaseNow - 60_000).toISOString(),
      expired.grantId,
    );
    db.prepare("UPDATE tool_grants SET expires_at = 'not-a-timestamp' WHERE grant_id = ?").run(malformed.grantId);
    db.prepare("UPDATE tool_grants SET expires_at = '' WHERE grant_id = ?").run(emptyExpiry.grantId);

    for (const skewedCallerNow of ["1900-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"]) {
      const ids = new Set(repo.listActive("workspace", "workspace-1", skewedCallerNow).map((grant) => grant.grantId));
      assert.equal(ids.has(active.grantId), true);
      assert.equal(ids.has(expired.grantId), false);
      assert.equal(ids.has(malformed.grantId), false);
      assert.equal(ids.has(emptyExpiry.grantId), false);
    }
  });

  it("issues fixed-duration TTL grants from database time under fast and slow host clocks", () => {
    const repo = createRepo();
    const originalDateNow = Date.now;

    try {
      for (const skewedNow of [0, Date.parse("2099-01-01T00:00:00.000Z")]) {
        Date.now = () => skewedNow;
        const grant = repo.createTtlForDuration(
          {
            toolPattern: `internal.${skewedNow}`,
            decision: "allow",
            scope: "global",
            createdBy: "system",
          },
          5 * 60_000,
        );
        assert.equal(Date.parse(grant.expiresAt!) - Date.parse(grant.createdAt), 5 * 60_000);
        assert.ok(Math.abs(Date.parse(grant.createdAt) - originalDateNow()) < 5_000);
      }
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("rechecks revocation in the consume UPDATE after a stale read", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-tool-grants-race-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const consumer = createRepoAtPath(dbPath);
    const revoker = createRepoAtPath(dbPath);
    const grant = consumer.create({
      toolPattern: "channel.send",
      decision: "allow",
      scope: "global",
      createdBy: "operator",
    });
    const readGrant = consumer.get.bind(consumer);
    consumer.get = (grantId: string) => {
      const stale = readGrant(grantId);
      assert.equal(revoker.revoke(grantId, new Date().toISOString(), "operator-race"), true);
      return stale;
    };

    assert.equal(consumer.consumeOne(grant.grantId), false);
    assert.equal(readGrant(grant.grantId).revokedBy, "operator-race");
  });

  it("enforces grant lifetime semantics at the repository boundary", () => {
    const repo = createRepo();
    const databaseNow = Date.now();
    const expiresAt = new Date(databaseNow + 5 * 60_000).toISOString();
    const createdAt = new Date(databaseNow).toISOString();

    const ttlGrant = repo.create(
      {
        toolPattern: "browser.search",
        decision: "allow",
        scope: "global",
        grantType: "ttl",
        expiresAt,
        createdBy: "operator",
      },
      createdAt,
    );

    assert.equal(ttlGrant.expiresAt, expiresAt);
    assert.equal(ttlGrant.usesRemaining, undefined);
    assert.throws(
      () =>
        repo.create({
          toolPattern: "browser.search",
          decision: "allow",
          scope: "global",
          grantType: "ttl",
          createdBy: "operator",
        }),
      /ttl grants require expiresAt/,
    );
    assert.throws(
      () =>
        repo.create(
          {
            toolPattern: "browser.search",
            decision: "allow",
            scope: "global",
            grantType: "ttl",
            expiresAt: new Date(databaseNow - 60_000).toISOString(),
            createdBy: "operator",
          },
          new Date(databaseNow - 120_000).toISOString(),
        ),
      /database clock/,
    );
    assert.throws(
      () =>
        repo.create({
          toolPattern: "browser.interact",
          decision: "allow",
          scope: "global",
          grantType: "one_time",
          usesRemaining: 2,
          createdBy: "operator",
        }),
      /exactly one/,
    );
    assert.throws(
      () =>
        repo.create({
          toolPattern: "shell.exec",
          decision: "deny",
          scope: "global",
          grantType: "one_time",
          createdBy: "operator",
        }),
      /one_time grants can only be allow grants/,
    );
    assert.throws(
      () =>
        repo.create({
          toolPattern: "shell.exec",
          decision: "allow",
          scope: "global",
          grantType: "persistent",
          expiresAt: "2099-01-01T00:00:00.000Z",
          createdBy: "operator",
        }),
      /persistent grants cannot set expiresAt/,
    );
  });

  it("requires scopeRef for non-global grants", () => {
    const repo = createRepo();

    assert.throws(() => {
      repo.create({
        toolPattern: "shell.exec",
        decision: "allow",
        scope: "session",
        createdBy: "operator",
      });
    }, /scopeRef is required/);
  });

  it("round-trips read-only reference root constraints", () => {
    const repo = createRepo();

    const grant = repo.create(
      {
        toolPattern: "fs.read",
        decision: "allow",
        scope: "session",
        scopeRef: "sess-1",
        createdBy: "operator",
        constraints: {
          referenceRoots: [
            {
              label: "claude-code-reference",
              rootPath: "F:\\code\\claude-code",
              access: "read_only",
            },
          ],
        },
      },
      "2026-04-04T10:00:00.000Z",
    );

    assert.deepEqual(grant.constraints?.referenceRoots, [
      {
        label: "claude-code-reference",
        rootPath: "F:\\code\\claude-code",
        access: "read_only",
      },
    ]);
  });

  it("reports missing and malformed grant rows", () => {
    const repo = createRepo();

    assert.throws(() => repo.get("missing-grant"), /Tool grant missing-grant not found/);
    assert.equal(repo.revoke("missing-grant", "2026-03-05T10:05:00.000Z", "operator-1"), false);

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
      db: ReturnType<typeof createDatabase>;
    };
    internal.getStmt = { get: () => ({ grant_id: "bad" }) };
    assert.throws(() => repo.get("bad-grant"), /Unexpected tool_grants row shape/);

    const originalPrepare = internal.db.prepare.bind(internal.db);
    internal.db.prepare = (sql: string): DbStatement => {
      if (sql.includes("FROM tool_grants")) {
        return {
          run: () => ({ changes: 0 }),
          get: () => undefined,
          all: <T = unknown>() => [null] as T[],
        };
      }
      return originalPrepare(sql);
    };
    assert.throws(() => repo.list(), /Unexpected tool_grants row shape/);
  });
});
