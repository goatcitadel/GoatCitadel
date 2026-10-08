import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { CapabilityScopeRepository } from "./capability-scope-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): CapabilityScopeRepository {
  const dbPath = tempDbs.path("goatcitadel-capscope-repo");
  return new CapabilityScopeRepository(tempDbs.open({ dbPath }));
}

describe("CapabilityScopeRepository", () => {
  it("returns an empty list for an unconfigured scope", () => {
    const repo = createRepo();
    assert.deepEqual(repo.listForScope("citadel", "personal"), []);
    assert.deepEqual(repo.list("workspace", "default", "skill"), []);
  });

  it("setEnabled upserts a single assignment scoped by the unique key", () => {
    const repo = createRepo();
    const created = repo.setEnabled("citadel", "personal", "skill", "skill-a", true);
    assert.equal(created.scopeKind, "citadel");
    assert.equal(created.resourceRef, "skill-a");
    assert.equal(created.enabled, true);

    const updated = repo.setEnabled("citadel", "personal", "skill", "skill-a", false);
    assert.equal(updated.assignmentId, created.assignmentId);
    assert.equal(updated.enabled, false);

    const rows = repo.list("citadel", "personal", "skill");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.enabled, false);
  });

  it("replaceSet replaces all rows for one (scope,type) transactionally", () => {
    const repo = createRepo();
    repo.setEnabled("workspace", "default", "skill", "old", true);
    const result = repo.replaceSet("workspace", "default", "skill", [
      { resourceRef: "a", enabled: true },
      { resourceRef: "b", enabled: false },
    ]);
    assert.equal(result.length, 2);
    const refs = repo
      .list("workspace", "default", "skill")
      .map((r) => r.resourceRef)
      .sort();
    assert.deepEqual(refs, ["a", "b"]);
  });

  it("replaceSet with an empty array clears curation (no rows → resolver inherits)", () => {
    const repo = createRepo();
    repo.setEnabled("workspace", "default", "mcp_server", "srv-1", true);
    repo.replaceSet("workspace", "default", "mcp_server", []);
    assert.deepEqual(repo.list("workspace", "default", "mcp_server"), []);
  });

  it("clear removes all rows for one (scope,type) and reports the count", () => {
    const repo = createRepo();
    repo.setEnabled("citadel", "personal", "integration", "conn-1", true);
    repo.setEnabled("citadel", "personal", "integration", "conn-2", true);
    repo.setEnabled("citadel", "personal", "skill", "skill-x", true);
    assert.equal(repo.clear("citadel", "personal", "integration"), 2);
    assert.deepEqual(repo.list("citadel", "personal", "integration"), []);
    assert.equal(repo.list("citadel", "personal", "skill").length, 1);
  });

  it("scopes rows by (scope_kind, scope_id) — no cross-scope leakage", () => {
    const repo = createRepo();
    repo.setEnabled("citadel", "personal", "skill", "shared", true);
    repo.setEnabled("workspace", "default", "skill", "shared", true);
    assert.equal(repo.list("citadel", "personal", "skill").length, 1);
    assert.equal(repo.list("workspace", "default", "skill").length, 1);
    assert.equal(repo.list("workspace", "other", "skill").length, 0);
  });
});
