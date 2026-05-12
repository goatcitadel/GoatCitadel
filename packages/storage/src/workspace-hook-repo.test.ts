import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ValidationError, type HookActionConfig } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import { WorkspaceHookRepository } from "./workspace-hook-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore best-effort temp database cleanup failures.
    }
  }
});

function createRepoWithDb(): { repo: WorkspaceHookRepository; db: ReturnType<typeof createDatabase> } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-workspace-hook-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    repo: new WorkspaceHookRepository(db),
    db,
  };
}

function webhook(url = " https://example.test/hook ", secret = " secret-token "): HookActionConfig {
  return {
    type: "webhook",
    webhook: {
      url,
      secret,
    },
  };
}

describe("WorkspaceHookRepository", () => {
  it("creates, lists, filters, updates, and deletes workspace hooks", () => {
    const { repo } = createRepoWithDb();

    assert.deepEqual(repo.list("workspace-1"), []);
    assert.throws(
      () => repo.get("workspace-1", "missing-hook"),
      (error: unknown) => error instanceof ValidationError && /Unknown hook/.test(error.message),
    );
    assert.throws(
      () =>
        repo.create({
          workspaceId: "workspace-1",
          label: " ",
          trigger: "llm.request.before",
          mode: "mutate",
          action: webhook(),
        }),
      (error: unknown) => error instanceof ValidationError && /label/.test(error.message),
    );
    assert.throws(
      () =>
        repo.create({
          workspaceId: "workspace-1",
          label: "Broken",
          trigger: "llm.request.before",
          mode: "mutate",
          action: { type: "unsupported" } as unknown as HookActionConfig,
        }),
      (error: unknown) => error instanceof ValidationError && /Unsupported hook action/.test(error.message),
    );
    assert.throws(
      () =>
        repo.create({
          workspaceId: "workspace-1",
          label: "Broken",
          trigger: "llm.request.before",
          mode: "mutate",
          action: { type: "webhook", webhook: { url: " " } },
        }),
      (error: unknown) => error instanceof ValidationError && /action\.webhook\.url/.test(error.message),
    );

    const lowPriority = repo.create(
      {
        workspaceId: "workspace-1",
        label: " Low priority ",
        trigger: "llm.request.before",
        mode: "observe",
        enabled: false,
        priority: -50_000,
        timeoutMs: 50,
        action: webhook(" https://example.test/low ", " "),
      },
      "2026-03-24T10:00:00.000Z",
    );
    assert.match(lowPriority.hookId, /^hook_[0-9a-f]{24}$/);
    assert.equal(lowPriority.label, "Low priority");
    assert.equal(lowPriority.phase, "before");
    assert.equal(lowPriority.enabled, false);
    assert.equal(lowPriority.priority, -10_000);
    assert.equal(lowPriority.timeoutMs, 250);
    assert.equal(lowPriority.failPolicy, "open");
    assert.deepEqual(lowPriority.action, {
      type: "webhook",
      webhook: {
        url: "https://example.test/low",
      },
    });

    const highPriority = repo.create(
      {
        workspaceId: "workspace-1",
        label: "High priority",
        trigger: "tool.call.after",
        mode: "intercept",
        priority: 50_000,
        timeoutMs: 120_000,
        failPolicy: "closed",
        action: webhook("https://example.test/high", "keep"),
      },
      "2026-03-24T10:01:00.000Z",
    );
    assert.equal(highPriority.phase, "after");
    assert.equal(highPriority.priority, 10_000);
    assert.equal(highPriority.timeoutMs, 60_000);
    assert.equal(highPriority.failPolicy, "closed");

    assert.deepEqual(
      repo.list("workspace-1", Number.NaN).map((hook) => hook.hookId),
      [highPriority.hookId, lowPriority.hookId],
    );
    assert.deepEqual(
      repo.list("workspace-1", 20).map((hook) => hook.hookId),
      [highPriority.hookId, lowPriority.hookId],
    );
    assert.deepEqual(repo.listByTrigger("workspace-1", "llm.request.before"), []);
    assert.deepEqual(
      repo.listByTrigger("workspace-1", "tool.call.after", 0).map((hook) => hook.hookId),
      [highPriority.hookId],
    );

    const updated = repo.update(
      "workspace-1",
      lowPriority.hookId,
      {
        label: "Enabled request hook",
        enabled: true,
        priority: 125,
        timeoutMs: 1_500,
        failPolicy: "closed",
        action: webhook("https://example.test/request", "next"),
      },
      "2026-03-24T10:05:00.000Z",
    );
    assert.equal(updated.label, "Enabled request hook");
    assert.equal(updated.enabled, true);
    assert.equal(updated.priority, 125);
    assert.equal(updated.timeoutMs, 1_500);
    assert.equal(updated.failPolicy, "closed");
    assert.equal(updated.updatedAt, "2026-03-24T10:05:00.000Z");
    assert.deepEqual(
      repo.listByTrigger("workspace-1", "llm.request.before").map((hook) => hook.hookId),
      [updated.hookId],
    );

    assert.equal(repo.delete("workspace-1", "missing-hook"), false);
    assert.equal(repo.delete("workspace-1", updated.hookId), true);
    assert.throws(() => repo.update("workspace-1", updated.hookId, { label: "gone" }), /Unknown hook/);
  });

  it("rejects malformed action JSON from persisted rows", () => {
    const { repo, db } = createRepoWithDb();
    db.prepare(
      `
      INSERT INTO workspace_hooks (
        hook_id,
        workspace_id,
        label,
        trigger,
        mode,
        enabled,
        priority,
        timeout_ms,
        fail_policy,
        action_json,
        created_at,
        updated_at
      ) VALUES (
        'hook_malformed',
        'workspace-1',
        'Malformed',
        'llm.request.before',
        'mutate',
        1,
        100,
        5000,
        'open',
        '[]',
        '2026-03-24T10:00:00.000Z',
        '2026-03-24T10:00:00.000Z'
      )
    `,
    ).run();

    assert.throws(
      () => repo.get("workspace-1", "hook_malformed"),
      (error: unknown) => error instanceof ValidationError && /invalid action config/.test(error.message),
    );
  });
});
