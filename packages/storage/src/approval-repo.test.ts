import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository, type DeterministicDetachedApprovalCreateInput } from "./approval-repo.js";

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

function createRepo(): ApprovalRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-repo-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return createRepoAtPath(dbPath);
}

function createRepoAtPath(dbPath: string): ApprovalRepository {
  const db = createDatabase({ dbPath });
  return new ApprovalRepository(db);
}

function createInMemoryHarness(): { db: DatabaseClient; repo: ApprovalRepository } {
  const db = createDatabase({ dbPath: ":memory:" });
  return { db, repo: new ApprovalRepository(db) };
}

function deterministicDetachedInput(
  overrides: Partial<DeterministicDetachedApprovalCreateInput> = {},
): DeterministicDetachedApprovalCreateInput {
  return {
    approvalId: "mesh-capability-activation:" + "a".repeat(64),
    kind: "mesh.capability.activate",
    riskLevel: "danger",
    payload: {
      workspaceId: "workspace-a",
      activationId: "activation-a",
      activationRevision: 1,
      requestSha256: "1".repeat(64),
      capabilityId: "mesh:node-a:tool:status",
      manifestSha256: "2".repeat(64),
      entrySha256: "3".repeat(64),
      descriptorSha256: "4".repeat(64),
      permissionEnvelopeSha256: "5".repeat(64),
      effectPosture: "read_only",
    },
    preview: {
      activationId: "activation-a",
      activationRevision: 1,
      capabilityId: "mesh:node-a:tool:status",
      effectPosture: "read_only",
    },
    linkage: { workspaceId: "workspace-a", sessionId: "session-a", turnId: "turn-a" },
    ...overrides,
  };
}

function formatInstantWithOffset(instantMs: number, offsetHours: number): string {
  const sign = offsetHours >= 0 ? "+" : "-";
  const absoluteHours = Math.abs(offsetHours).toString().padStart(2, "0");
  return new Date(instantMs + offsetHours * 60 * 60_000).toISOString().replace("Z", `${sign}${absoluteHours}:00`);
}

describe("ApprovalRepository", () => {
  it("scopes listed approvals to a workspace when a workspaceId filter is provided", () => {
    const repo = createRepo();
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "a" },
      preview: { command: "a" },
      linkage: { workspaceId: "workspace-a", sessionId: "s-a" },
    });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "b" },
      preview: { command: "b" },
      linkage: { workspaceId: "workspace-b", sessionId: "s-b" },
    });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "global" },
      preview: { command: "global" },
    });

    const scoped = repo.list("pending", 100, "workspace-a");
    assert.deepEqual(
      scoped.map((approval) => approval.linkage?.workspaceId),
      ["workspace-a"],
    );

    const unscoped = repo.list("pending", 100);
    assert.equal(unscoped.length, 3);
  });

  it("lists approval pages with stable cursors and workspace filters", () => {
    const repo = createRepo();
    for (const [index, workspaceId] of [
      "workspace-a",
      "workspace-b",
      "workspace-a",
      "workspace-a",
      "workspace-b",
    ].entries()) {
      repo.create({
        kind: "shell.exec",
        riskLevel: "danger",
        payload: { command: `command-${index}` },
        preview: { command: `command-${index}` },
        linkage: { workspaceId },
      });
    }

    const firstPage = repo.listPage({ status: "pending", limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.equal(typeof firstPage.nextCursor, "string");

    const secondPage = repo.listPage({ status: "pending", limit: 2, cursor: firstPage.nextCursor });
    assert.equal(secondPage.items.length, 2);
    assert.deepEqual(
      firstPage.items.filter((item) => secondPage.items.some((next) => next.approvalId === item.approvalId)),
      [],
    );

    const scoped = repo.listPage({ status: "pending", limit: 2, workspaceId: "workspace-a" });
    assert.equal(scoped.items.length, 2);
    assert.deepEqual(
      scoped.items.map((approval) => approval.linkage?.workspaceId),
      ["workspace-a", "workspace-a"],
    );
  });

  it("tracks explanation lifecycle state", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });

    assert.equal(created.explanationStatus, "not_requested");
    assert.equal(created.explanation, undefined);

    const firstMark = repo.markExplanationPending(created.approvalId);
    const secondMark = repo.markExplanationPending(created.approvalId);
    assert.equal(firstMark, true);
    assert.equal(secondMark, false);

    const pending = repo.get(created.approvalId);
    assert.equal(pending.explanationStatus, "pending");

    const completed = repo.setExplanation(created.approvalId, {
      summary: "This command lists files in the current folder.",
      riskExplanation: "It is usually low risk unless used in sensitive locations.",
      saferAlternative: "Limit it to a known workspace path.",
      generatedAt: "2026-02-28T00:00:00.000Z",
      providerId: "openai",
      model: "gpt-4o-mini",
    });
    assert.equal(completed.explanationStatus, "completed");
    assert.equal(completed.explanation?.providerId, "openai");
    assert.equal(completed.explanation?.summary.includes("lists files"), true);
  });

  it("stores explanation failure details", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "fs.write",
      riskLevel: "danger",
      payload: { path: "workspace/a.txt" },
      preview: { path: "workspace/a.txt" },
    });

    assert.equal(repo.markExplanationPending(created.approvalId), true);
    const failed = repo.setExplanationFailed(created.approvalId, "provider timeout");
    assert.equal(failed.explanationStatus, "failed");
    assert.equal(failed.explanationError, "provider timeout");
  });

  it("round-trips approvals with and without expiry", () => {
    const repo = createRepo();
    const withoutExpiry = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });
    const withExpiry = repo.create({
      kind: "browser.click",
      riskLevel: "danger",
      payload: { selector: "#confirm" },
      preview: { selector: "#confirm" },
      expiresAt: "2026-03-22T16:15:00.000Z",
    });

    assert.equal(withoutExpiry.expiresAt, undefined);
    assert.equal(repo.get(withExpiry.approvalId).expiresAt, "2026-03-22T16:15:00.000Z");
  });

  it("issues fixed-duration approval expiry from database time under fast and slow host clocks", () => {
    const repo = createRepo();
    const originalDateNow = Date.now;

    try {
      for (const skewedNow of [0, Date.parse("2099-01-01T00:00:00.000Z")]) {
        Date.now = () => skewedNow;
        const approval = repo.createWithTtlDuration(
          {
            kind: "tool.invoke",
            riskLevel: "danger",
            payload: { skewedNow },
            preview: {},
          },
          15 * 60_000,
        );
        assert.equal(Date.parse(approval.expiresAt!) - Date.parse(approval.createdAt), 15 * 60_000);
        assert.ok(Math.abs(Date.parse(approval.createdAt) - originalDateNow()) < 5_000);
      }
    } finally {
      Date.now = originalDateNow;
    }
  });

  it("creates exact-ID detached approvals from database time and replays without refreshing mutable state", () => {
    const { db, repo } = createInMemoryHarness();
    const originalDateNow = Date.now;
    const wallClockBefore = originalDateNow();
    try {
      Date.now = () => Date.parse("2099-01-01T00:00:00.000Z");
      const input = deterministicDetachedInput();
      const first = repo.createDeterministicDetachedWithTtlDuration(input, 15 * 60_000);
      assert.equal(first.created, true);
      assert.equal(Date.parse(first.approval.expiresAt!) - Date.parse(first.approval.createdAt), 15 * 60_000);
      assert.ok(Math.abs(Date.parse(first.approval.createdAt) - wallClockBefore) < 5_000);

      const raw = db
        .prepare("SELECT linkage_json, payload_json, preview_json FROM approvals WHERE approval_id = ?")
        .get(input.approvalId) as {
        linkage_json: string;
        payload_json: string;
        preview_json: string;
      };
      assert.equal(raw.linkage_json, canonicalJsonString(input.linkage));
      assert.equal(raw.payload_json, canonicalJsonString(input.payload));
      assert.equal(raw.preview_json, canonicalJsonString(input.preview));
      assert.equal(raw.payload_json.includes("__gcApprovalLinkage"), false);

      db.prepare("UPDATE approvals SET status = 'approved', expires_at = ? WHERE approval_id = ?").run(
        "2000-01-01T00:00:00.000Z",
        input.approvalId,
      );
      const replay = repo.createDeterministicDetachedWithTtlDuration(input, 15 * 60_000);
      assert.equal(replay.created, false);
      assert.equal(replay.approval.status, "approved");
      assert.equal(replay.approval.expiresAt, "2000-01-01T00:00:00.000Z");
    } finally {
      Date.now = originalDateNow;
      db.close();
    }
  });

  it("preserves exact detached activation bytes through resolution and still replays the immutable request", () => {
    const { db, repo } = createInMemoryHarness();
    try {
      const input = deterministicDetachedInput();
      repo.createDeterministicDetachedWithTtlDuration(input, 15 * 60_000);
      const before = db
        .prepare("SELECT linkage_json, payload_json, preview_json FROM approvals WHERE approval_id = ?")
        .get(input.approvalId) as { linkage_json: string; payload_json: string; preview_json: string };

      const resolved = repo.resolve(input.approvalId, { decision: "approve", resolvedBy: "operator-1" });
      assert.equal(resolved.status, "approved");
      const after = db
        .prepare("SELECT linkage_json, payload_json, preview_json FROM approvals WHERE approval_id = ?")
        .get(input.approvalId) as { linkage_json: string; payload_json: string; preview_json: string };
      assert.deepEqual(after, before);
      assert.equal(after.payload_json.includes("__gcApprovalLinkage"), false);

      const replay = repo.createDeterministicDetachedWithTtlDuration(input, 15 * 60_000);
      assert.equal(replay.created, false);
      assert.equal(replay.approval.status, "approved");
    } finally {
      db.close();
    }
  });

  it("rejects edits and linkage enrichment for exact detached activation approvals without changing bytes", () => {
    const { db, repo } = createInMemoryHarness();
    try {
      const input = deterministicDetachedInput();
      repo.createDeterministicDetachedWithTtlDuration(input, 15 * 60_000);
      const before = db
        .prepare("SELECT status, linkage_json, payload_json, preview_json FROM approvals WHERE approval_id = ?")
        .get(input.approvalId);

      assert.throws(
        () =>
          repo.resolve(input.approvalId, {
            decision: "edit",
            resolvedBy: "operator-1",
            editedPayload: { ...input.payload },
          }),
        /immutable/u,
      );
      assert.throws(
        () =>
          repo.resolve(input.approvalId, {
            decision: "approve",
            resolvedBy: "operator-1",
            editedPayload: { ...input.payload },
          }),
        /immutable/u,
      );
      assert.throws(
        () => repo.mergeLinkage(input.approvalId, { workspaceId: "workspace-a", tokenId: "token-1" }),
        /linkage is immutable/u,
      );
      assert.deepEqual(
        db
          .prepare("SELECT status, linkage_json, payload_json, preview_json FROM approvals WHERE approval_id = ?")
          .get(input.approvalId),
        before,
      );
    } finally {
      db.close();
    }
  });

  it("conflicts when an exact deterministic approval ID is reused with changed immutable bytes", () => {
    const { db, repo } = createInMemoryHarness();
    try {
      const input = deterministicDetachedInput();
      repo.createDeterministicDetachedWithTtlDuration(input, 15 * 60_000);
      for (const changed of [
        { ...input, kind: "different.kind" },
        { ...input, riskLevel: "nuclear" as const },
        { ...input, payload: { ...input.payload, requestSha256: "9".repeat(64) } },
        { ...input, preview: { ...input.preview, effectPosture: "unknown" } },
        { ...input, linkage: { workspaceId: "workspace-b" } },
      ]) {
        assert.throws(
          () => repo.createDeterministicDetachedWithTtlDuration(changed, 15 * 60_000),
          /different immutable request bytes/i,
        );
      }
    } finally {
      db.close();
    }
  });

  it("rejects unsafe detached records and unknown top-level keys before reading getters", () => {
    const { db, repo } = createInMemoryHarness();
    try {
      for (const field of ["payload", "preview", "linkage"] as const) {
        let inheritedReads = 0;
        const inheritedPrototype = Object.defineProperty({}, "secret", {
          get() {
            inheritedReads += 1;
            return "must-not-read";
          },
        });
        const inherited = Object.assign(Object.create(inheritedPrototype), { safe: "value" });
        assert.throws(() =>
          repo.createDeterministicDetachedWithTtlDuration(
            { ...deterministicDetachedInput(), approvalId: `${field}-prototype`, [field]: inherited },
            15 * 60_000,
          ),
        );
        assert.equal(inheritedReads, 0);

        let accessorReads = 0;
        const accessor = Object.defineProperty({}, "unsafe", {
          enumerable: true,
          get() {
            accessorReads += 1;
            return "must-not-read";
          },
        });
        assert.throws(() =>
          repo.createDeterministicDetachedWithTtlDuration(
            { ...deterministicDetachedInput(), approvalId: `${field}-accessor`, [field]: accessor },
            15 * 60_000,
          ),
        );
        assert.equal(accessorReads, 0);

        let proxyReads = 0;
        const proxied = new Proxy(
          { safe: "value" },
          {
            get(target, property, receiver) {
              proxyReads += 1;
              return Reflect.get(target, property, receiver);
            },
          },
        );
        assert.throws(() =>
          repo.createDeterministicDetachedWithTtlDuration(
            { ...deterministicDetachedInput(), approvalId: `${field}-proxy`, [field]: proxied },
            15 * 60_000,
          ),
        );
        assert.equal(proxyReads, 0);
      }

      assert.throws(() =>
        repo.createDeterministicDetachedWithTtlDuration(
          { ...deterministicDetachedInput(), attackerControlled: true } as DeterministicDetachedApprovalCreateInput,
          15 * 60_000,
        ),
      );
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM approvals").get() as { count: number }).count, 0);
    } finally {
      db.close();
    }
  });

  it("lists bounded expired pending approvals in deadline order", () => {
    const repo = createRepo();
    const databaseNow = Date.now();
    const firstExpired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "first" },
      preview: { command: "first" },
      expiresAt: new Date(databaseNow - 60 * 60_000).toISOString(),
    });
    const secondExpired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "second" },
      preview: { command: "second" },
      expiresAt: new Date(databaseNow - 30 * 60_000).toISOString(),
    });
    const offsetExpired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "offset-expired" },
      preview: { command: "offset-expired" },
      expiresAt: formatInstantWithOffset(databaseNow - 45 * 60_000, 2),
    });
    const excludedExpired = repo.create({
      kind: "auth.device_access",
      riskLevel: "danger",
      payload: { requestId: "device-request" },
      preview: { deviceLabel: "Tablet" },
      expiresAt: new Date(databaseNow - 75 * 60_000).toISOString(),
    });
    const alreadyResolved = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "resolved" },
      preview: { command: "resolved" },
    });
    repo.resolve(alreadyResolved.approvalId, { decision: "reject", resolvedBy: "operator" });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "future" },
      preview: { command: "future" },
      expiresAt: new Date(databaseNow + 60 * 60_000).toISOString(),
    });
    repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "offset-future" },
      preview: { command: "offset-future" },
      expiresAt: formatInstantWithOffset(databaseNow + 90 * 60_000, -2),
    });

    assert.deepEqual(
      repo
        .listExpiredPending("2099-01-01T00:00:00.000Z", 1, "auth.device_access")
        .map((approval) => approval.approvalId),
      [firstExpired.approvalId],
    );
    assert.deepEqual(
      repo.listExpiredPending("1900-01-01T00:00:00.000Z", 10).map((approval) => approval.approvalId),
      [excludedExpired.approvalId, firstExpired.approvalId, offsetExpired.approvalId, secondExpired.approvalId],
    );
    assert.deepEqual(
      repo
        .listExpiredPending("2099-01-01T00:00:00.000Z", 10, "auth.device_access")
        .map((approval) => approval.approvalId),
      [firstExpired.approvalId, offsetExpired.approvalId, secondExpired.approvalId],
    );
  });

  it("uses the approval expiry sweep index for representative pending history", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-expiry-plan-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const db = createDatabase({ dbPath });
    const insert = db.prepare(`
      INSERT INTO approvals (
        approval_id, kind, risk_level, status, linkage_json, payload_json, preview_json,
        explanation_status, created_at, expires_at
      ) VALUES (
        @approvalId, 'shell.exec', 'danger', @status, NULL, '{}', '{}',
        'not_requested', @createdAt, @expiresAt
      )
    `);
    for (let index = 0; index < 500; index += 1) {
      insert.run({
        approvalId: `approval-plan-${index}`,
        status: index % 4 === 0 ? "approved" : "pending",
        createdAt: `2026-03-19T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        expiresAt: new Date(Date.parse("2026-03-20T00:00:00.000Z") + index * 60_000).toISOString(),
      });
    }

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT * FROM approvals
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND (julianday(expires_at) IS NULL OR julianday(expires_at) <= julianday('now'))
           AND (@excludedKind IS NULL OR kind <> @excludedKind)
         ORDER BY julianday(expires_at) ASC, approval_id ASC
         LIMIT @limit`,
      )
      .all({
        excludedKind: "auth.device_access",
        limit: 100,
      }) as Array<{ detail?: string }>;

    assert.match(plan.map((entry) => entry.detail ?? "").join("\n"), /idx_approvals_status_expires_at/);
  });

  it("persists rollback notes without synthesizing missing values", () => {
    const repo = createRepo();
    const withoutRollback = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });
    const withRollback = repo.create({
      kind: "fs.write",
      riskLevel: "danger",
      payload: { path: "workspace/note.md" },
      preview: { path: "workspace/note.md" },
      rollbackNote: "Restore workspace/note.md from the prior backup.",
    });

    assert.equal(repo.get(withoutRollback.approvalId).rollbackNote, undefined);
    assert.equal(repo.get(withRollback.approvalId).rollbackNote, "Restore workspace/note.md from the prior backup.");
  });

  it("prevents double resolution of the same approval", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });

    const resolved = repo.resolve(created.approvalId, {
      decision: "approve",
      resolvedBy: "operator",
    });
    assert.equal(resolved.status, "approved");

    assert.throws(() => {
      repo.resolve(created.approvalId, {
        decision: "reject",
        resolvedBy: "operator",
      });
    });
  });

  it("exposes a fail-closed pending row lock for transaction-owned dependent writes", () => {
    const repo = createRepo();
    const approval = repo.create({
      kind: "approval.remote_token.create",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });

    assert.equal(repo.lockPendingForUpdate(approval.approvalId).status, "pending");
    repo.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
    assert.throws(() => repo.lockPendingForUpdate(approval.approvalId), /already resolved/);
  });

  it("rejects resolution at the approval expiry boundary", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      expiresAt: "2026-03-20T10:00:00.000Z",
    });

    assert.throws(
      () =>
        repo.resolve(
          created.approvalId,
          {
            decision: "approve",
            resolvedBy: "operator",
          },
          { resolvedAt: "2026-03-20T10:00:00.000Z" },
        ),
      /expired/i,
    );
    assert.equal(repo.get(created.approvalId).status, "pending");
  });

  it("reserves expired-resolution bypass for system rejection only", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    for (const decision of ["approve", "edit"] as const) {
      assert.throws(
        () =>
          repo.resolve(
            created.approvalId,
            { decision, resolvedBy: "system:approval-expiry", editedPayload: { command: "changed" } },
            { allowExpired: true },
          ),
        /only be rejected/i,
      );
    }
    assert.throws(
      () => repo.resolve(created.approvalId, { decision: "reject", resolvedBy: "operator" }, { allowExpired: true }),
      /system expiry reconciler/i,
    );
    assert.throws(
      () =>
        repo.resolve(
          created.approvalId,
          { decision: "reject", resolvedBy: "system:approval-expiry:spoof" },
          { allowExpired: true },
        ),
      /system expiry reconciler/i,
    );
    assert.equal(
      repo.resolve(
        created.approvalId,
        { decision: "reject", resolvedBy: "system:approval-expiry" },
        { allowExpired: true },
      ).status,
      "rejected",
    );
  });

  it("surfaces malformed non-null expiry as system-expirable instead of leaving it pending forever", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "legacy" },
      preview: { command: "legacy" },
      expiresAt: "not-a-timestamp",
    });

    assert.equal(repo.isExpiredPendingAtDatabaseNow(created.approvalId), true);
    assert.deepEqual(
      repo.listExpiredPending(undefined, 10).map((approval) => approval.approvalId),
      [created.approvalId],
    );
    assert.throws(() => repo.resolve(created.approvalId, { decision: "approve", resolvedBy: "operator" }), /expired/i);
    assert.equal(
      repo.resolve(
        created.approvalId,
        { decision: "reject", resolvedBy: "system:approval-expiry" },
        { allowExpired: true },
      ).status,
      "rejected",
    );
  });

  it("uses database time for active pending lists and pages regardless of host-clock skew", () => {
    const repo = createRepo();
    const databaseNow = Date.now();
    const expired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "expired" },
      preview: { command: "expired" },
      expiresAt: new Date(databaseNow - 60_000).toISOString(),
    });
    const active = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "active" },
      preview: { command: "active" },
      expiresAt: new Date(databaseNow + 60_000).toISOString(),
    });
    const persistent = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "persistent" },
      preview: { command: "persistent" },
    });
    const malformed = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "malformed" },
      preview: { command: "malformed" },
      expiresAt: "not-a-timestamp",
    });
    const expectedIds = new Set([active.approvalId, persistent.approvalId]);
    const originalDateNow = Date.now;

    try {
      for (const skewedNow of [0, Date.parse("2099-01-01T00:00:00.000Z")]) {
        Date.now = () => skewedNow;
        assert.deepEqual(new Set(repo.list("pending", 100).map((approval) => approval.approvalId)), expectedIds);
        assert.deepEqual(
          new Set(repo.listPage({ status: "pending", limit: 100 }).items.map((approval) => approval.approvalId)),
          expectedIds,
        );
      }
    } finally {
      Date.now = originalDateNow;
    }

    assert.equal(repo.isExpiredPendingAtDatabaseNow(expired.approvalId), true);
    assert.equal(repo.isExpiredPendingAtDatabaseNow(malformed.approvalId), true);
  });

  it("compares approval expiry instants instead of timestamp text offsets", () => {
    const repo = createRepo();
    const databaseNow = Date.now();
    const expired = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "expired-offset" },
      preview: { command: "expired-offset" },
      expiresAt: formatInstantWithOffset(databaseNow - 60_000, 2),
    });
    const active = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "active-offset" },
      preview: { command: "active-offset" },
      expiresAt: formatInstantWithOffset(databaseNow + 60_000, -2),
    });

    assert.throws(
      () =>
        repo.resolve(
          expired.approvalId,
          { decision: "approve", resolvedBy: "operator" },
          { resolvedAt: "2000-01-01T00:00:00.000Z" },
        ),
      /expired/i,
    );
    assert.equal(repo.get(expired.approvalId).status, "pending");
    assert.equal(
      repo.resolve(
        active.approvalId,
        { decision: "approve", resolvedBy: "operator" },
        { resolvedAt: "2099-01-01T00:00:00.000Z" },
      ).status,
      "approved",
    );
  });

  it("allows only one concurrent resolver to win the same approval", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-repo-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const creatorRepo = createRepoAtPath(dbPath);
    const resolverA = createRepoAtPath(dbPath);
    const resolverB = createRepoAtPath(dbPath);
    const created = creatorRepo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    });

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        resolverA.resolve(created.approvalId, {
          decision: "approve",
          resolvedBy: "operator-a",
        }),
      ),
      Promise.resolve().then(() =>
        resolverB.resolve(created.approvalId, {
          decision: "approve",
          resolvedBy: "operator-b",
        }),
      ),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const final = creatorRepo.get(created.approvalId);
    assert.equal(final.status, "approved");
    assert.ok(final.resolvedBy === "operator-a" || final.resolvedBy === "operator-b");
  });

  it("allows only one concurrent expiry reconciler to win an expired approval", async () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-expiry-repo-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    const creatorRepo = createRepoAtPath(dbPath);
    const resolverA = createRepoAtPath(dbPath);
    const resolverB = createRepoAtPath(dbPath);
    const created = creatorRepo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      expiresAt: "2026-03-20T10:00:00.000Z",
    });

    const results = await Promise.allSettled([
      Promise.resolve().then(() =>
        resolverA.resolve(
          created.approvalId,
          {
            decision: "reject",
            resolvedBy: "system:approval-expiry",
          },
          { resolvedAt: "2026-03-20T10:00:01.000Z", allowExpired: true },
        ),
      ),
      Promise.resolve().then(() =>
        resolverB.resolve(
          created.approvalId,
          {
            decision: "reject",
            resolvedBy: "system:approval-expiry",
          },
          { resolvedAt: "2026-03-20T10:00:01.000Z", allowExpired: true },
        ),
      ),
    ]);

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(creatorRepo.get(created.approvalId).status, "rejected");
  });

  it("persists explicit approval linkage separately from the public payload", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      linkage: {
        sessionId: "session-1",
        taskId: "task-1",
        durableRunId: "run-1",
        correlationId: "corr-1",
      },
    });

    assert.deepEqual(created.linkage, {
      sessionId: "session-1",
      taskId: "task-1",
      durableRunId: "run-1",
      correlationId: "corr-1",
    });
    assert.deepEqual(created.payload, { command: "dir" });
    assert.deepEqual(created.preview, { command: "dir" });

    const merged = repo.mergeLinkage(created.approvalId, {
      traceId: "trace-1",
      toolName: "shell_command",
    });

    assert.deepEqual(merged.linkage, {
      sessionId: "session-1",
      taskId: "task-1",
      durableRunId: "run-1",
      correlationId: "corr-1",
      traceId: "trace-1",
      toolName: "shell_command",
    });
    assert.deepEqual(merged.payload, { command: "dir" });
    assert.deepEqual(merged.preview, { command: "dir" });
  });

  it("lists statuses, supports alternate resolutions, and validates defensive linkage paths", () => {
    const repo = createRepo();
    const db = (repo as unknown as { db: ReturnType<typeof createDatabase> }).db;

    assert.throws(() => repo.get("missing-approval"), /Approval missing-approval not found/);
    assert.throws(() => repo.mergeLinkage("missing-approval", { sessionId: "session-1" }), /Approval missing-approval/);

    const blankLinkage = repo.create({
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
      linkage: {
        sessionId: "   ",
        taskId: "",
      } as NonNullable<Parameters<ApprovalRepository["create"]>[0]["linkage"]>,
    });
    assert.equal(blankLinkage.linkage, undefined);

    const edited = repo.create({
      kind: "fs.write",
      riskLevel: "danger",
      payload: { path: "notes.md", content: "draft" },
      preview: { path: "notes.md" },
    });
    const rejected = repo.create({
      kind: "browser.click",
      riskLevel: "caution",
      payload: { selector: "#delete" },
      preview: { selector: "#delete" },
    });

    assert.equal(repo.list("pending", 10).length, 3);
    assert.ok(repo.list(undefined, 10).some((approval) => approval.approvalId === edited.approvalId));

    const editedResult = repo.resolve(edited.approvalId, {
      decision: "edit",
      editedPayload: { path: "notes.md", content: "final" },
      resolvedBy: "operator",
      resolutionNote: "reduced scope",
    });
    assert.equal(editedResult.status, "edited");
    assert.deepEqual(editedResult.payload, { path: "notes.md", content: "final" });
    assert.equal(editedResult.resolutionNote, "reduced scope");

    const rejectedResult = repo.resolve(rejected.approvalId, {
      decision: "reject",
      resolvedBy: "operator",
    });
    assert.equal(rejectedResult.status, "rejected");
    assert.equal(repo.list("rejected", 10)[0]?.approvalId, rejected.approvalId);

    db.prepare(
      `
      UPDATE approvals
      SET linkage_json = NULL,
          payload_json = ?,
          preview_json = ?,
          explanation_json = ?
      WHERE approval_id = ?
    `,
    ).run(
      JSON.stringify({ command: "dir", __gcApprovalLinkage: { sessionId: "embedded-session" } }),
      JSON.stringify({ command: "dir", __gcApprovalLinkage: { taskId: "embedded-task" } }),
      "{bad",
      blankLinkage.approvalId,
    );

    const embedded = repo.get(blankLinkage.approvalId);
    assert.deepEqual(embedded.linkage, { sessionId: "embedded-session" });
    assert.deepEqual(embedded.payload, { command: "dir" });
    assert.deepEqual(embedded.preview, { command: "dir" });
    assert.equal(embedded.explanation, undefined);

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
      listStmt: { all: (...args: unknown[]) => unknown };
      listByStatusStmt: { all: (...args: unknown[]) => unknown };
      listActivePendingStmt: { all: (...args: unknown[]) => unknown };
    };
    internal.getStmt = { get: () => ({ approval_id: "bad" }) };
    assert.throws(() => repo.get("bad-row"), /Unexpected approvals row shape/);

    internal.listStmt = { all: () => ({ not: "an array" }) };
    internal.listByStatusStmt = { all: () => [null] };
    internal.listActivePendingStmt = { all: () => [null] };
    assert.throws(() => repo.list(undefined, 10), /Unexpected approvals row shape/);
    assert.throws(() => repo.list("pending", 10), /Unexpected approvals row shape/);
  });

  it("persists shellExplanations and round-trips them on read", () => {
    const repo = createRepo();
    const created = repo.create({
      kind: "shell.exec",
      riskLevel: "caution",
      payload: { commands: ["rm -rf /tmp/x"] },
      preview: { commands: ["rm -rf /tmp/x"] },
    });

    assert.equal(created.shellExplanations, undefined);

    const updated = repo.setShellExplanations(created.approvalId, [
      {
        command: "rm -rf /tmp/x",
        parsed: true,
        program: "rm",
        summary: "Recursively delete /tmp/x",
        details: [],
        risks: [{ level: "danger", label: "Recursive delete", explanation: "deletes directories" }],
        highestRisk: "danger",
      },
    ]);
    assert.equal(updated, true);

    const fetched = repo.get(created.approvalId);
    assert.equal(fetched.shellExplanations?.length, 1);
    const first = fetched.shellExplanations?.[0];
    assert.ok(first, "shellExplanations[0] should exist");
    assert.equal(first.highestRisk, "danger");
    assert.equal(first.command, "rm -rf /tmp/x");
  });

  it("setShellExplanations returns false for unknown approval id", () => {
    const repo = createRepo();
    assert.equal(repo.setShellExplanations("missing-approval", []), false);
  });
});
