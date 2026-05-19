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

  it("enforces grant lifetime semantics at the repository boundary", () => {
    const repo = createRepo();

    const ttlGrant = repo.create(
      {
        toolPattern: "browser.search",
        decision: "allow",
        scope: "global",
        grantType: "ttl",
        expiresAt: "2026-03-05T10:05:00.000Z",
        createdBy: "operator",
      },
      "2026-03-05T10:00:00.000Z",
    );

    assert.equal(ttlGrant.expiresAt, "2026-03-05T10:05:00.000Z");
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
            expiresAt: "2026-03-05T09:59:00.000Z",
            createdBy: "operator",
          },
          "2026-03-05T10:00:00.000Z",
        ),
      /future expiresAt/,
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
