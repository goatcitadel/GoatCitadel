import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DryRunCommitRecord } from "@goatcitadel/contracts";
import { DryRunCommitRepository } from "./dry-run-commit-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): DryRunCommitRepository {
  const dbPath = tempDbs.path("goatcitadel-dry-run-commits");
  const db = tempDbs.open({ dbPath });
  return new DryRunCommitRepository(db);
}

function buildRecord(overrides: Partial<DryRunCommitRecord> = {}): DryRunCommitRecord {
  return {
    dryRunId: "dryrun-abc123",
    runId: "run-1",
    boundary: "integration_operator_action",
    workspaceId: "ws-guarded",
    plannedAction: {
      route: "integration.automation.gmail.write",
      target: "conn-1:write",
      payload: { provider: "gmail", to: "ops@example.com", subject: "hi", bodyText: "body" },
    },
    payloadHash: "payload-hash",
    dryRunHash: "dry-run-hash",
    state: "awaiting_commit",
    createdAt: "2026-07-07T00:00:00.000Z",
    updatedAt: "2026-07-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("DryRunCommitRepository", () => {
  it("round-trips a preview record including the planned action payload", () => {
    const repo = createRepo();
    const created = repo.create(buildRecord());

    assert.equal(created.dryRunId, "dryrun-abc123");
    assert.equal(created.state, "awaiting_commit");
    assert.deepEqual(created.plannedAction, {
      route: "integration.automation.gmail.write",
      target: "conn-1:write",
      payload: { provider: "gmail", to: "ops@example.com", subject: "hi", bodyText: "body" },
    });
    assert.equal(created.approvedAt, undefined);
    assert.equal(created.diagnostic, undefined);
    assert.deepEqual(repo.get("dryrun-abc123"), created);
    assert.equal(repo.get("missing"), undefined);
  });

  it("applies partial updates through the full commit lifecycle", () => {
    const repo = createRepo();
    repo.create(buildRecord());

    const approved = repo.update("dryrun-abc123", {
      approvedAt: "2026-07-07T00:01:00.000Z",
      approvedBy: "operator",
      updatedAt: "2026-07-07T00:01:00.000Z",
    });
    assert.equal(approved?.approvedBy, "operator");
    assert.equal(approved?.state, "awaiting_commit");

    const committed = repo.update("dryrun-abc123", {
      state: "committed",
      committedAt: "2026-07-07T00:02:00.000Z",
      externalReferenceId: "id:msg-1",
      updatedAt: "2026-07-07T00:02:00.000Z",
    });
    assert.equal(committed?.state, "committed");
    assert.equal(committed?.committedAt, "2026-07-07T00:02:00.000Z");
    assert.equal(committed?.externalReferenceId, "id:msg-1");
    // Earlier fields survive the partial patch.
    assert.equal(committed?.approvedBy, "operator");
    assert.deepEqual(committed?.plannedAction.payload, {
      provider: "gmail",
      to: "ops@example.com",
      subject: "hi",
      bodyText: "body",
    });

    assert.equal(repo.update("missing", { state: "committed" }), undefined);
  });

  it("persists refusal diagnostics like the in-memory store", () => {
    const repo = createRepo();
    repo.create(buildRecord({ dryRunId: "dryrun-mismatch" }));

    const rejected = repo.update("dryrun-mismatch", {
      state: "rejected_hash_mismatch",
      diagnostic: {
        code: "hash_mismatch",
        message: "commit refused: hashes diverged",
        approvedDryRunHash: "dry-run-hash",
        attemptedCommitHash: "other-hash",
        recordedAt: "2026-07-07T00:03:00.000Z",
      },
      updatedAt: "2026-07-07T00:03:00.000Z",
    });
    assert.equal(rejected?.state, "rejected_hash_mismatch");
    assert.equal(rejected?.diagnostic?.code, "hash_mismatch");
    assert.equal(repo.get("dryrun-mismatch")?.diagnostic?.attemptedCommitHash, "other-hash");
  });
});
