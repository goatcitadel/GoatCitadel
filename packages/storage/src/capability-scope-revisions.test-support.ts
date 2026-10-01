import assert from "node:assert/strict";
import { ConflictError, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { CapabilityScopeRepository } from "./capability-scope-repo.js";
import { CitadelRepository } from "./citadel-repo.js";
import { WorkspaceRepository } from "./workspace-repo.js";

export const scopeConflict = (error: unknown) =>
  error instanceof ConflictError &&
  error.code === "WRITE_CONFLICT" &&
  error.details?.reason === "CAPABILITY_SCOPE_REVISION_CONFLICT";

export function verifyCapabilityScopeRevisions(db: DatabaseClient): void {
  const repo = new CapabilityScopeRepository(db),
    citadels = new CitadelRepository(db),
    workspaces = new WorkspaceRepository(db);
  const parent = citadels.createRecord({ name: "Capability review parent" });
  const other = citadels.createRecord({ name: "Capability other parent" });
  const workspace = workspaces.create({ name: "Capability reviewed workspace", citadelId: parent.citadelId });
  const read = () => repo.getSelectionReview("workspace", workspace.workspaceId, "skill")!;
  const save = (expectedRevision: string, assignments = [{ resourceRef: "one", enabled: true }]) =>
    repo.replaceReviewed("workspace", workspace.workspaceId, { resourceType: "skill", expectedRevision, assignments });
  const initial = read();
  assert.match(initial.revision, /^[a-f0-9]{64}$/);
  assert.equal(initial.citadelId, parent.citadelId);
  assert.deepEqual(initial.assignments, []);
  assert.deepEqual(initial.parentAssignments, []);
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS count FROM system_settings WHERE setting_key LIKE 'capability_scope.selection_nonce.v1:%'",
      )
      .get<{ count: number }>()!.count,
    0,
    "review reads must not create nonce state",
  );
  assert.notEqual(
    initial.revision,
    repo.getSelectionReview("workspace", workspace.workspaceId, "integration")?.revision,
  );
  assert.notEqual(initial.revision, repo.getSelectionReview("citadel", parent.citadelId, "skill")?.revision);
  assert.equal(repo.getSelectionReview("workspace", "missing", "skill"), undefined);
  assert.throws(
    () =>
      repo.replaceReviewed("workspace", "missing", {
        resourceType: "skill",
        expectedRevision: initial.revision,
        assignments: [],
      }),
    NotFoundError,
  );
  for (const expectedRevision of ["", "wrong", undefined, 1])
    assert.throws(() => save(expectedRevision as string), ValidationError);
  for (const assignments of [
    [{ resourceRef: " ", enabled: true }],
    [
      { resourceRef: "same", enabled: true },
      { resourceRef: "same", enabled: false },
    ],
  ])
    assert.throws(() => save(initial.revision, assignments), ValidationError);
  assert.deepEqual(read(), initial);
  const receipt = save(initial.revision);
  assert.equal(receipt.previousRevision, initial.revision);
  assert.deepEqual(receipt.selectionReview, read());
  assert.notEqual(receipt.selectionReview.revision, initial.revision);
  assert.throws(() => save(initial.revision), scopeConflict);
  const mixed = ["z", "_private", "Alpha", "alpha", "9", "-prefix"].map((resourceRef) => ({
    resourceRef,
    enabled: false,
  }));
  const ordered = [...mixed].sort((a, b) =>
    a.resourceRef < b.resourceRef ? -1 : a.resourceRef > b.resourceRef ? 1 : 0,
  );
  assert.deepEqual(save(read().revision, mixed).selectionReview.assignments, ordered);
  repo.replaceSet("citadel", parent.citadelId, "skill", mixed);
  assert.deepEqual(read().parentAssignments, ordered);
  repo.clear("citadel", parent.citadelId, "skill");
  save(read().revision, []);
  assert.deepEqual(read().assignments, initial.assignments);
  assert.notEqual(read().revision, initial.revision, "empty-set ABA cannot revive an earlier review");

  const writers = [
    () => repo.setEnabled("workspace", workspace.workspaceId, "skill", "raw", true),
    () => repo.setEnabled("workspace", workspace.workspaceId, "skill", "raw", true),
    () => repo.delete(repo.list("workspace", workspace.workspaceId, "skill")[0]!.assignmentId),
    () => repo.replaceSet("workspace", workspace.workspaceId, "skill", []),
    () => repo.clear("workspace", workspace.workspaceId, "skill"),
    () => repo.setEnabled("citadel", parent.citadelId, "skill", "parent", false),
    () => repo.clear("citadel", parent.citadelId, "skill"),
  ];
  for (const write of writers) {
    const before = read();
    write();
    assert.notEqual(read().revision, before.revision);
    assert.throws(() => save(before.revision), scopeConflict);
  }
  let before = read();
  repo.setEnabled("workspace", workspace.workspaceId, "integration", "unrelated", false);
  assert.deepEqual(read(), before, "other resource families do not invalidate this selection");
  workspaces.update(workspace.workspaceId, { name: "Changed workspace" });
  assert.throws(() => save(before.revision), scopeConflict);
  before = read();
  workspaces.update(workspace.workspaceId, { citadelId: other.citadelId });
  assert.throws(() => save(before.revision), scopeConflict);
  assert.equal(read().citadelId, other.citadelId);
  before = read();
  const archived = citadels.archiveRecord(other.citadelId, other.revision);
  assert.throws(() => save(before.revision), scopeConflict);
  assert.throws(
    () => save(read().revision),
    (error: unknown) => error instanceof ConflictError && error.details?.reason === "CAPABILITY_SCOPE_ARCHIVED",
  );
  citadels.restoreRecord(other.citadelId, archived.revision);
  before = read();
  workspaces.archive(workspace.workspaceId);
  assert.throws(() => save(before.revision), scopeConflict);
  assert.throws(
    () => save(read().revision),
    (error: unknown) => error instanceof ConflictError && error.details?.reason === "CAPABILITY_SCOPE_ARCHIVED",
  );
  workspaces.restore(workspace.workspaceId);
  before = read();
  const failing = new CapabilityScopeRepository({
    dialect: db.dialect,
    close: db.close.bind(db),
    exec: db.exec.bind(db),
    transaction: db.transaction.bind(db),
    prepare(sql) {
      const statement = db.prepare(sql);
      return sql.startsWith("INSERT INTO system_settings")
        ? {
            get: statement.get.bind(statement),
            all: statement.all.bind(statement),
            run() {
              throw new Error("nonce failure");
            },
          }
        : statement;
    },
  });
  assert.throws(
    () =>
      failing.replaceReviewed("workspace", workspace.workspaceId, {
        resourceType: "skill",
        expectedRevision: before.revision,
        assignments: [{ resourceRef: "rollback", enabled: true }],
      }),
    /nonce failure/,
  );
  assert.deepEqual(read(), before, "nonce and assignments roll back together");
  // Legacy compatibility: unregistered scopes remain valid for existing runtime callers.
  repo.setEnabled("workspace", "legacy-missing", "skill", "legacy", false);
  assert.equal(repo.list("workspace", "legacy-missing", "skill").length, 1);
  assert.equal(repo.getSelectionReview("workspace", "legacy-missing", "skill"), undefined);
}
