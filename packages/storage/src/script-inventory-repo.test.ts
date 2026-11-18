import { afterEach, it } from "node:test";
import assert from "node:assert/strict";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";
import { ScriptInventoryRepository } from "./script-inventory-repo.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";
import { ChatGeneratedArtifactRepository } from "./chat-generated-artifact-repo.js";
import { ChatToolRunRepository } from "./chat-tool-run-repo.js";
import { ChatProjectRepository } from "./chat-project-repo.js";
import { ManagedProjectFileRepository } from "./managed-project-file-repo.js";
import { CodeModeRunRepository } from "./code-mode-run-repo.js";
import type { CodeModeRunRecord } from "@goatcitadel/contracts";

const temp = new TempSqliteFiles();
afterEach(() => temp.cleanup());
it("uses current managed heads and immutable Code Mode artifacts without rewriting either", () => {
  const db = temp.open({ dbPath: temp.path("scripts-owners") });
  const session = new ChatSessionMetaRepository(db);
  session.ensure("session", undefined, "one");
  const project = new ChatProjectRepository(db).create({
    name: "Fixture",
    workspacePath: "fixture",
    workspaceId: "one",
  });
  const managed = new ManagedProjectFileRepository(db);
  const file = managed.save({
    workspaceId: "one",
    projectId: project.projectId,
    path: "scripts/run.py",
    expectedRevision: null,
    effectId: "save",
    contentBase64: Buffer.from("print('hello')").toString("base64"),
  });
  new ChatToolRunRepository(db).create({
    toolRunId: "save",
    sessionId: "session",
    turnId: "turn",
    toolName: "project.files.save",
    status: "executed",
    result: { ...file },
  });
  const artifact = {
    artifactId: "code",
    relPath: "code.py",
    sha256: "sha",
    bytes: 3,
    mimeType: "text/plain",
    createdAt: "2026-11-17",
  };
  const run: CodeModeRunRecord = {
    runId: "run",
    workspaceId: "one",
    sessionId: "session",
    turnId: "turn",
    status: "approval_pending",
    language: "typescript",
    saveCandidateOnSuccess: false,
    capabilitySnapshotId: "snapshot",
    codeModeInputHash: "input",
    wrapperManifestHash: "wrapper",
    policySnapshotHash: "policy",
    codeHash: "source",
    codeArtifact: artifact,
    wrapperManifestArtifact: artifact,
    policySnapshotArtifact: artifact,
    stdoutTruncated: false,
    stderrTruncated: false,
    executionRecovery: { generation: 0, phase: "not_started", disposition: "none" },
    createdAt: "2026-11-17",
  };
  const code = new CodeModeRunRepository(db);
  code.upsert(run);
  code.upsert({ ...run, runId: "run-with-same-source" });
  const before = code.get("run");
  const items = new ScriptInventoryRepository(db).list("one");
  assert.equal(items.filter((item) => item.kind === "managed").length, 1);
  assert.equal(items.find((item) => item.kind === "managed")?.sessionId, "session");
  assert.equal(items.find((item) => item.kind === "code")?.sourceId, artifact.artifactId);
  assert.equal(new Set(items.filter((item) => item.kind === "code").map((item) => item.id)).size, 2);
  assert.deepEqual(code.get("run"), before);
  assert.equal(
    managed.read({ workspaceId: "one", projectId: project.projectId, path: file.path })?.revisionId,
    file.revisionId,
  );
  assert.equal(new ScriptInventoryRepository(db).list("other").length, 0);
});
it("projects recorded creations once, scopes by canonical session and excludes failed writes", () => {
  const db = temp.open({ dbPath: temp.path("scripts-inventory") });
  const meta = new ChatSessionMetaRepository(db);
  meta.ensure("session-a", undefined, "workspace-a");
  meta.ensure("session-b", undefined, "workspace-b");
  const generated = new ChatGeneratedArtifactRepository(db);
  for (const [id, workspaceId, sessionId] of [
    ["one", "workspace-a", "session-a"],
    ["two", "workspace-b", "session-b"],
    ["mismatch", "workspace-a", "session-b"],
  ]) {
    generated.create({
      artifactId: id!,
      workspaceId,
      sessionId: sessionId!,
      turnId: "turn",
      title: "Script",
      kind: "code",
      content: "print('hello')",
      sourceSurface: "chat",
      version: 1,
      createdAt: "2026-11-17",
      updatedAt: "2026-11-17",
    });
  }
  const tools = new ChatToolRunRepository(db);
  for (const [id, sessionId, status] of [
    ["write", "session-a", "executed"],
    ["write-again", "session-a", "executed"],
    ["failed", "session-a", "failed"],
    ["foreign", "session-b", "executed"],
  ] as const) {
    tools.create({
      toolRunId: id,
      sessionId,
      turnId: "turn",
      toolName: "fs.write",
      status,
      result: { path: id === "failed" ? "/failed.py" : "/script.py" },
    });
  }
  const repo = new ScriptInventoryRepository(db);
  const before = generated.get("one");
  const items = repo.list("workspace-a");
  assert.equal(items.filter((item) => item.kind === "generated").length, 1);
  assert.equal(items.filter((item) => item.kind === "workspace").length, 1);
  assert.ok(items.every((item) => item.workspaceId === "workspace-a" && item.sessionId === "session-a"));
  assert.deepEqual(generated.get("one"), before);
  assert.deepEqual(
    repo.list("workspace-a").map((item) => item.id),
    items.map((item) => item.id),
  );
});
