import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION, canonicalJsonString } from "@goatcitadel/contracts";
import {
  RoutedContextSnapshotRepository,
  projectChatRoutedContextInspection,
  renderChatRoutedContextEntries,
  sealChatRoutedContextSnapshot,
  verifyChatRoutedContextSnapshot,
} from "./routed-context-snapshot-repo.js";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";

const createdFiles: string[] = [];
const createdDbs: DatabaseClient[] = [];

afterEach(() => {
  for (const db of createdDbs.splice(0)) {
    db.close();
  }
  for (const file of createdFiles.splice(0)) {
    fs.rmSync(file, { force: true });
    fs.rmSync(`${file}-wal`, { force: true });
    fs.rmSync(`${file}-shm`, { force: true });
  }
});

function createStore() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-routed-context-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  createdDbs.push(db);
  return { db, repo: new RoutedContextSnapshotRepository(db) };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function buildSnapshot() {
  const entries = [
    {
      index: 0,
      kind: "attachment" as const,
      ref: "attachment-1",
      label: "notes.txt",
      disposition: "included" as const,
      sourceScope: "workspace" as const,
      sourceWorkspaceId: "workspace-1",
      sourceVersion: "sha256:a1",
      sourceHash: "c".repeat(64),
      originalBytes: 20,
      originalTokens: 4,
      admittedBytes: 20,
      admittedTokens: 4,
      truncated: false,
      admittedText: "exact admitted bytes",
    },
  ];
  const contextText = renderChatRoutedContextEntries(entries);
  return sealChatRoutedContextSnapshot({
    snapshotId: "chat-routed-context-turn-1",
    schemaVersion: CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION,
    turnId: "turn-1",
    sessionId: "session-1",
    workspaceId: "workspace-1",
    capabilityProfileId: "chat-capability-profile-turn-1",
    capabilityProfileHash: "a".repeat(64),
    sourceRequestHash: hash(canonicalJsonString(entries.map(({ kind, ref }) => ({ kind, ref })))),
    contentHash: hash(contextText),
    budget: {
      effectiveProviderId: "provider-1",
      effectiveModel: "model-1",
      contextWindowTokens: 16_384,
      promptReservedTokens: 4_000,
      outputReservedTokens: 2_048,
      hardCapTokens: 4_096,
      effectiveBudgetTokens: 4_096,
      usedTokens: 19,
      usedBytes: Buffer.byteLength(contextText, "utf8"),
      estimatorVersion: "gc-approx-tokens.v1",
      budgetPolicyVersion: "chat.routed-context-budget.v1",
    },
    entries,
    contextText,
    createdAt: "2026-07-13T00:00:00.000Z",
  });
}

describe("RoutedContextSnapshotRepository", () => {
  it("persists one immutable exact-byte snapshot and exposes a content-free inspection projection", () => {
    const { db, repo } = createStore();
    const snapshot = buildSnapshot();
    assert.deepEqual(repo.create(snapshot), snapshot);
    assert.deepEqual(repo.create(snapshot), snapshot);
    assert.deepEqual(repo.findByTurn("turn-1"), snapshot);

    const inspection = projectChatRoutedContextInspection(snapshot);
    assert.equal(inspection.includedCount, 1);
    assert.equal(inspection.truncatedCount, 0);
    assert.equal(inspection.omittedCount, 0);
    assert.equal(inspection.alreadyAttachedCount, 0);
    assert.equal("admittedText" in inspection.entries[0]!, false);

    assert.throws(
      () =>
        db
          .prepare("UPDATE chat_routed_context_snapshots SET content_hash = ? WHERE snapshot_id = ?")
          .run("d".repeat(64), snapshot.snapshotId),
      /immutable/u,
    );
    assert.throws(
      () => db.prepare("DELETE FROM chat_routed_context_snapshots WHERE snapshot_id = ?").run(snapshot.snapshotId),
      /immutable/u,
    );
  });

  it("fails closed on same-id different bytes and invalid total context accounting", () => {
    const { repo } = createStore();
    const snapshot = buildSnapshot();
    repo.create(snapshot);
    const conflictingEntries = snapshot.entries.map((entry) => ({
      ...entry,
      originalBytes: entry.originalBytes + 1,
      admittedBytes: entry.admittedBytes + 1,
      admittedText: `${entry.admittedText}!`,
    }));
    const conflictingText = renderChatRoutedContextEntries(conflictingEntries);
    const conflicting = sealChatRoutedContextSnapshot({
      ...snapshot,
      entries: conflictingEntries,
      contextText: conflictingText,
      contentHash: hash(conflictingText),
      budget: { ...snapshot.budget, usedBytes: Buffer.byteLength(conflictingText, "utf8") },
    });
    assert.throws(() => repo.create(conflicting), /conflicts with an existing immutable record/u);

    const overBudget = sealChatRoutedContextSnapshot({
      ...snapshot,
      snapshotId: "chat-routed-context-turn-2",
      turnId: "turn-2",
      capabilityProfileId: "chat-capability-profile-turn-2",
      budget: { ...snapshot.budget, promptReservedTokens: 14_500 },
    });
    assert.throws(() => repo.create(overBudget), /governed context budget/u);
  });

  it("keeps display labels out of provider context and rejects shape or accounting drift", () => {
    const snapshot = buildSnapshot();
    const relabeledEntries = snapshot.entries.map((entry) => ({ ...entry, label: "operator-only label" }));
    const relabeled = sealChatRoutedContextSnapshot({
      ...snapshot,
      entries: relabeledEntries,
      contextText: renderChatRoutedContextEntries(relabeledEntries),
    });
    assert.equal(relabeled.contextText, snapshot.contextText);
    assert.equal(relabeled.contentHash, snapshot.contentHash);
    assert.notEqual(relabeled.snapshotHash, snapshot.snapshotHash);

    const unknownTopLevel = { ...snapshot, unexpected: true } as unknown as typeof snapshot;
    assert.throws(() => verifyChatRoutedContextSnapshot(unknownTopLevel), /unsupported fields/u);
    const unknownBudget = {
      ...snapshot,
      budget: { ...snapshot.budget, unexpected: true },
    } as unknown as typeof snapshot;
    assert.throws(() => verifyChatRoutedContextSnapshot(unknownBudget), /unsupported fields/u);
    const forgedEntry = {
      ...snapshot,
      entries: [{ ...snapshot.entries[0]!, kind: "url" }],
    } as unknown as typeof snapshot;
    assert.throws(() => verifyChatRoutedContextSnapshot(forgedEntry), /invalid entry kind/u);
    const impossibleEntry = sealChatRoutedContextSnapshot({
      ...snapshot,
      entries: [{ ...snapshot.entries[0]!, originalBytes: 1 }],
    });
    assert.throws(() => verifyChatRoutedContextSnapshot(impossibleEntry), /admits more context/u);
    const forgedSourceRequestHash = sealChatRoutedContextSnapshot({
      ...snapshot,
      sourceRequestHash: "b".repeat(64),
    });
    assert.throws(() => verifyChatRoutedContextSnapshot(forgedSourceRequestHash), /source request hash verification/u);
  });
});
