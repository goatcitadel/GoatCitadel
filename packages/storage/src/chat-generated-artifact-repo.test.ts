import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ChatGeneratedArtifactRecord } from "@goatcitadel/contracts";
import type { DatabaseClient, DbStatement } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatGeneratedArtifactRepository } from "./chat-generated-artifact-repo.js";

const createdFiles: string[] = [];
type FakeStatementOverrides = {
  run?: (...params: unknown[]) => { changes: number };
  get?: (...params: unknown[]) => unknown;
  all?: (...params: unknown[]) => unknown;
};

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

function createRepo(): ChatGeneratedArtifactRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-generated-artifacts-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new ChatGeneratedArtifactRepository(createDatabase({ dbPath }));
}

function artifact(overrides: Partial<ChatGeneratedArtifactRecord> = {}): ChatGeneratedArtifactRecord {
  return {
    artifactId: "artifact-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    turnId: "turn-1",
    title: "Runbook",
    kind: "markdown",
    content: "# Runbook",
    language: "md",
    sourceSurface: "chat",
    version: 1,
    providerId: "openai",
    model: "gpt-5.4",
    sourceBlockIndex: 2,
    contentHash: "hash-1",
    createdAt: "2026-04-22T00:00:00.000Z",
    updatedAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  };
}

describe("ChatGeneratedArtifactRepository", () => {
  it("creates, trims, clamps, lists, batches, and filters generated artifacts", () => {
    const repo = createRepo();
    const first = repo.create(
      artifact({
        version: 0,
        workspaceId: "   ",
        language: "   ",
        providerId: "   ",
        model: "   ",
        sourceBlockIndex: -5,
        contentHash: "   ",
      }),
    );
    const second = repo.create(
      artifact({
        artifactId: "artifact-2",
        workspaceId: " workspace-1 ",
        turnId: "turn-1",
        title: "HTML preview",
        kind: "html",
        content: "<main>Preview</main>",
        language: " html ",
        sourceSurface: "cowork",
        version: 2.8,
        supersedesArtifactId: " artifact-1 ",
        providerId: " anthropic ",
        model: " claude-sonnet-4.5 ",
        sourceBlockIndex: 4.7,
        contentHash: " hash-2 ",
        createdAt: "2026-04-22T00:01:00.000Z",
        updatedAt: "2026-04-22T00:01:00.000Z",
      }),
    );

    assert.equal(first.version, 1);
    assert.equal(first.workspaceId, undefined);
    assert.equal(first.language, undefined);
    assert.equal(first.providerId, undefined);
    assert.equal(first.model, undefined);
    assert.equal(first.sourceBlockIndex, 0);
    assert.equal(first.contentHash, undefined);
    assert.equal(second.version, 2);
    assert.equal(second.workspaceId, "workspace-1");
    assert.equal(second.supersedesArtifactId, "artifact-1");
    assert.equal(second.sourceBlockIndex, 4);
    assert.equal(repo.get("artifact-2").model, "claude-sonnet-4.5");

    assert.deepEqual(
      repo.listBySession("session-1").map((item) => item.artifactId),
      ["artifact-2", "artifact-1"],
    );
    assert.deepEqual(
      repo.listBySession("session-1", 0).map((item) => item.artifactId),
      ["artifact-2"],
    );
    assert.deepEqual(
      repo.listByTurn("turn-1").map((item) => item.artifactId),
      ["artifact-2", "artifact-1"],
    );
    assert.deepEqual(repo.listBySessionIds([]), new Map());
    assert.deepEqual(repo.listByTurnIds([]), new Map());
    assert.deepEqual(
      repo
        .listBySessionIds(["session-1"])
        .get("session-1")
        ?.map((item) => item.artifactId),
      ["artifact-2", "artifact-1"],
    );
    assert.deepEqual(
      repo
        .listByTurnIds(["turn-1"])
        .get("turn-1")
        ?.map((item) => item.artifactId),
      ["artifact-2", "artifact-1"],
    );
    assert.deepEqual(
      repo
        .listVisible({ workspaceId: " workspace-1 ", sourceSurface: "cowork", kind: "html", limit: 0 })
        .map((item) => item.artifactId),
      ["artifact-2"],
    );
    assert.deepEqual(
      repo.listVisible().map((item) => item.artifactId),
      ["artifact-2", "artifact-1"],
    );
  });

  it("rejects missing required fields and missing artifacts", () => {
    const repo = createRepo();
    assert.throws(() => repo.get("missing-artifact"), /Generated artifact missing-artifact not found/);
    assert.throws(() => repo.create(artifact({ artifactId: "   " })), /artifactId is required/);
    assert.throws(() => repo.create(artifact({ sessionId: "   " })), /sessionId is required/);
    assert.throws(() => repo.create(artifact({ turnId: "   " })), /turnId is required/);
    assert.throws(() => repo.create(artifact({ title: "   " })), /title is required/);
  });

  it("filters malformed persisted rows from direct and dynamic queries", () => {
    const row = {
      artifact_id: "artifact-valid",
      session_id: "session-1",
      workspace_id: null,
      turn_id: "turn-1",
      title: "Valid",
      kind: "text",
      content: "hello",
      language: null,
      source_surface: "code",
      version: 1,
      supersedes_artifact_id: null,
      provider_id: null,
      model: null,
      source_block_index: null,
      content_hash: null,
      created_at: "2026-04-22T00:00:00.000Z",
      updated_at: "2026-04-22T00:00:00.000Z",
    };
    const repo = new ChatGeneratedArtifactRepository(
      fakeDatabase([
        fakeStatement(),
        fakeStatement({ get: () => null }),
        fakeStatement({ all: () => [null, { ...row, artifact_id: 42 }, row] }),
        fakeStatement({ all: () => "not-an-array" }),
        fakeStatement({ all: () => [row] }),
        fakeStatement({ all: () => [row] }),
        fakeStatement({ all: () => [row] }),
      ]),
    );

    assert.throws(() => repo.get("artifact-valid"), /Generated artifact artifact-valid not found/);
    assert.deepEqual(
      repo.listBySession("session-1").map((item) => item.artifactId),
      ["artifact-valid"],
    );
    assert.deepEqual(repo.listByTurn("turn-1"), []);
    assert.deepEqual(
      repo
        .listBySessionIds(["session-1"])
        .get("session-1")
        ?.map((item) => item.artifactId),
      ["artifact-valid"],
    );
    assert.deepEqual(
      repo
        .listByTurnIds(["turn-1"])
        .get("turn-1")
        ?.map((item) => item.artifactId),
      ["artifact-valid"],
    );
    assert.deepEqual(
      repo.listVisible({ sourceSurface: "code" }).map((item) => item.artifactId),
      ["artifact-valid"],
    );
  });
});

function fakeDatabase(statements: DbStatement[]): DatabaseClient {
  let index = 0;
  return {
    dialect: "sqlite",
    prepare: () => statements[index++] ?? fakeStatement(),
    exec: () => undefined,
    close: () => undefined,
    transaction: (_mode, callback) => callback(),
  };
}

function fakeStatement(overrides: FakeStatementOverrides = {}): DbStatement {
  return {
    run: overrides.run ?? (() => ({ changes: 1 })),
    get: <T = unknown>(...params: unknown[]) => (overrides.get?.(...params) as T | undefined) ?? undefined,
    all: <T = unknown>(...params: unknown[]) => (overrides.all?.(...params) ?? []) as T[],
  };
}
