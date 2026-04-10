import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { ChatSessionWorkbenchRepository } from "./chat-session-workbench-repo.js";

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

describe("ChatSessionWorkbenchRepository", () => {
  it("ensures default workbench state and patches runtime metadata", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-session-workbench-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const projects = new ChatProjectRepository(db);
    const repo = new ChatSessionWorkbenchRepository(db);
    const project = projects.create(
      {
        name: "Atlas",
        workspacePath: "demo",
      },
      "2026-04-10T00:00:00.000Z",
    );

    const ensured = repo.ensure("sess-1", "2026-04-10T00:00:00.000Z");
    assert.equal(ensured.worktreeStatus, "uninitialized");
    assert.equal(ensured.validationStatus, "idle");

    const patched = repo.patch(
      "sess-1",
      {
        projectId: project.projectId,
        baseRef: "main",
        worktreePath: "F:/code/personal-ai/.worktrees/sess-1",
        worktreeStatus: "ready",
        activeFilePath: "workspace/demo/index.ts",
        diffArtifactId: "diff:sess-1",
        outputArtifactId: "code-mode-run:run-1",
        validationStatus: "passed",
      },
      "2026-04-10T00:05:00.000Z",
    );

    assert.equal(patched.projectId, project.projectId);
    assert.equal(patched.baseRef, "main");
    assert.equal(patched.worktreeStatus, "ready");
    assert.equal(patched.activeFilePath, "workspace/demo/index.ts");
    assert.equal(patched.diffArtifactId, "diff:sess-1");
    assert.equal(patched.outputArtifactId, "code-mode-run:run-1");
    assert.equal(patched.validationStatus, "passed");

    const reloaded = repo.get("sess-1");
    assert.equal(reloaded?.worktreePath, "F:/code/personal-ai/.worktrees/sess-1");
    assert.equal(reloaded?.updatedAt, "2026-04-10T00:05:00.000Z");
  });
});
