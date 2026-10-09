import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictError } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { ChannelOAuthAttemptRepository } from "./channel-oauth-attempt-repo.js";
import type { DatabaseClient } from "./db.js";

const opened: Array<{ db: DatabaseClient; file: string }> = [];
afterEach(() => {
  for (const { db, file } of opened.splice(0)) {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
    fs.rmdirSync(path.dirname(file));
  }
});
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-oauth-attempt-test-"));
  const file = path.join(directory, "test.db");
  const db = createDatabase({ dbPath: file }); opened.push({ db, file });
  const repo = new ChannelOAuthAttemptRepository(db);
  const created = repo.create({
    attemptId: randomUUID(), provider: "slack", installationId: "installation-a", workspaceId: "workspace-a",
    actorId: "operator-a", draftId: "draft-a", draftRevision: 7, connectionId: "connection-a",
    connectionRevision: "c".repeat(64), stateHash: "a".repeat(64), status: "pending", secretRefs: {},
    expiresAt: "2026-10-10T00:00:00.000Z",
  });
  return { repo, db, file, created };
}
describe("ChannelOAuthAttemptRepository", () => {
  it("persists immutable scope bindings and survives reopening the owner", () => {
    const f = fixture();
    assert.equal(f.repo.findByStateHash("a".repeat(64))?.attemptId, f.created.attemptId);
    const second = new ChannelOAuthAttemptRepository(f.db);
    assert.deepEqual(second.get(f.created.attemptId), f.created);
    assert.equal(second.get(f.created.attemptId).connectionRevision, "c".repeat(64));
  });
  it("claims each callback once and rejects stale adoption revisions", () => {
    const f = fixture();
    const claimed = f.repo.update(f.created.attemptId, { expectedRevision: 1, status: "exchanging" });
    assert.throws(() => f.repo.update(f.created.attemptId, { expectedRevision: 1, status: "exchanging" }), ConflictError);
    const ready = f.repo.update(claimed.attemptId, { expectedRevision: claimed.revision, status: "ready",
      secretRefs: { botToken: "keychain:goatcitadel:channel-draft:draft-a:botToken:generation-a" },
      install: { installId: "slack:T1:A1", teamId: "T1", appId: "A1", botUserId: "U1", scopes: ["chat:write"] } });
    assert.equal(ready.revision, 3);
    const adopted = f.repo.update(ready.attemptId, { expectedRevision: ready.revision, status: "adopted", adoptedDraftRevision: 8, secretRefs: {} });
    assert.equal(adopted.adoptedDraftRevision, 8);
    assert.deepEqual(adopted.secretRefs, {});
    assert.throws(() => f.repo.update(adopted.attemptId, { expectedRevision: adopted.revision, status: "ready" }), ConflictError);
  });
  it("rolls back a ready receipt consumption with its enclosing owner transaction", () => {
    const f = fixture();
    const claimed = f.repo.update(f.created.attemptId, { expectedRevision: 1, status: "exchanging" });
    const ready = f.repo.update(claimed.attemptId, { expectedRevision: claimed.revision, status: "ready", secretRefs: {} });
    assert.throws(() => f.db.transaction("immediate", () => {
      f.repo.update(ready.attemptId, { expectedRevision: ready.revision, status: "adopted", adoptedDraftRevision: 8 });
      throw new Error("Draft owner CAS failed");
    }));
    assert.equal(f.repo.get(ready.attemptId).status, "ready");
    assert.equal(f.repo.get(ready.attemptId).revision, ready.revision);
  });
  it("enumerates bounded expiry/discard cleanup and never persists raw credentials", () => {
    const f = fixture();
    assert.throws(() => f.repo.update(f.created.attemptId, { expectedRevision: 1, status: "exchanging", secretRefs: { botToken: "xoxb-synthetic" } }));
    assert.equal(f.repo.get(f.created.attemptId).revision, 1);
    assert.equal(f.repo.listExpiring("2026-10-11T00:00:00.000Z").length, 1);
    assert.equal(f.repo.listByDraft("draft-a").length, 1);
    const expired = f.repo.update(f.created.attemptId, { expectedRevision: 1, status: "expired" });
    assert.deepEqual(expired.secretRefs, {});
    assert.equal(f.repo.listExpiring("2026-10-11T00:00:00.000Z").length, 0);
  });
});
