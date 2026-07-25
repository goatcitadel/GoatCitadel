import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { createDatabase } from "./sqlite.js";
import { WorkspaceRepository } from "./workspace-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
  }
});

function assertWriteConflict(
  action: () => unknown,
  expected: { resourceKind: string; resourceId: string; expectedRevision: number; currentRevision: number },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "WRITE_CONFLICT");
    assert.deepEqual(error.details, expected);
    return true;
  });
}

describe("operator resource revision CAS", () => {
  it("fences stale workspace and chat-project writers across two real SQLite clients", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-resource-cas-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    let clientA: DatabaseClient | undefined;
    let clientB: DatabaseClient | undefined;
    try {
      clientA = createDatabase({ dbPath });
      clientB = createDatabase({ dbPath });
      const workspacesA = new WorkspaceRepository(clientA);
      const workspacesB = new WorkspaceRepository(clientB);
      const projectsA = new ChatProjectRepository(clientA);
      const projectsB = new ChatProjectRepository(clientB);

      const workspace = workspacesA.create({ name: "CAS Workspace" }, "2026-07-12T00:00:00.000Z");
      const workspaceSnapshotA = workspacesA.get(workspace.workspaceId);
      const workspaceSnapshotB = workspacesB.get(workspace.workspaceId);
      assert.equal(workspaceSnapshotA.revision, 1);
      assert.equal(workspaceSnapshotB.revision, 1);

      const workspaceWinner = workspacesA.updateWithRevision(
        workspace.workspaceId,
        { name: "Winner A" },
        workspaceSnapshotA.revision,
        "2026-07-12T00:01:00.000Z",
      );
      assert.equal(workspaceWinner.revision, 2);
      assert.equal(workspaceWinner.name, "Winner A");
      assertWriteConflict(
        () =>
          workspacesB.updateWithRevision(
            workspace.workspaceId,
            { name: "Stale B" },
            workspaceSnapshotB.revision,
            "2026-07-12T00:02:00.000Z",
          ),
        {
          resourceKind: "workspace",
          resourceId: workspace.workspaceId,
          expectedRevision: 1,
          currentRevision: 2,
        },
      );
      assert.deepEqual(
        {
          name: workspacesA.get(workspace.workspaceId).name,
          revision: workspacesA.get(workspace.workspaceId).revision,
        },
        { name: "Winner A", revision: 2 },
      );

      const archivedWorkspace = workspacesB.archiveWithRevision(workspace.workspaceId, 2, "2026-07-12T00:03:00.000Z");
      assert.equal(archivedWorkspace.revision, 3);
      const archiveNoop = workspacesA.archiveWithRevision(workspace.workspaceId, 3, "2026-07-12T00:04:00.000Z");
      assert.equal(archiveNoop.revision, 3);
      assert.equal(archiveNoop.archivedAt, "2026-07-12T00:03:00.000Z");
      assertWriteConflict(() => workspacesA.archiveWithRevision(workspace.workspaceId, 2), {
        resourceKind: "workspace",
        resourceId: workspace.workspaceId,
        expectedRevision: 2,
        currentRevision: 3,
      });
      assert.equal(workspacesA.restoreWithRevision(workspace.workspaceId, 3).revision, 4);

      const project = projectsA.create(
        { workspaceId: workspace.workspaceId, name: "CAS Project", workspacePath: "repo" },
        "2026-07-12T00:05:00.000Z",
      );
      const projectSnapshotA = projectsA.get(project.projectId);
      const projectSnapshotB = projectsB.get(project.projectId);
      const projectWinner = projectsA.updateWithRevision(
        project.projectId,
        { color: "teal" },
        projectSnapshotA.revision,
        "2026-07-12T00:06:00.000Z",
      );
      assert.equal(projectWinner.revision, 2);
      assertWriteConflict(
        () =>
          projectsB.updateWithRevision(
            project.projectId,
            { color: "red" },
            projectSnapshotB.revision,
            "2026-07-12T00:07:00.000Z",
          ),
        {
          resourceKind: "chat_project",
          resourceId: project.projectId,
          expectedRevision: 1,
          currentRevision: 2,
        },
      );
      assert.deepEqual(
        { color: projectsA.get(project.projectId).color, revision: projectsA.get(project.projectId).revision },
        { color: "teal", revision: 2 },
      );

      const archivedProject = projectsB.archiveWithRevision(project.projectId, 2);
      assert.equal(archivedProject.revision, 3);
      assert.equal(projectsA.archiveWithRevision(project.projectId, 3).revision, 3);
      const restoredProject = projectsA.restoreWithRevision(project.projectId, 3);
      assert.equal(restoredProject.revision, 4);
      assertWriteConflict(() => projectsB.hardDeleteWithRevision(project.projectId, 3), {
        resourceKind: "chat_project",
        resourceId: project.projectId,
        expectedRevision: 3,
        currentRevision: 4,
      });
      assert.equal(projectsA.get(project.projectId).revision, 4);
      assert.equal(projectsB.hardDeleteWithRevision(project.projectId, 4), true);
      assert.throws(() => projectsA.updateWithRevision(project.projectId, { name: "Missing" }, 4), NotFoundError);
    } finally {
      clientB?.close();
      clientA?.close();
    }
  });
});
