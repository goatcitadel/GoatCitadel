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
  // This suite exercises snapshot verification/immutability semantics in
  // isolation. The turn-write admission chain the incarnation guard enforces is
  // proven by the session-mutation-admission and capability-profile suites.
  db.exec("DROP TRIGGER trg_chat_routed_context_snapshots_incarnation_insert_guard");
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

  it("persists byte-exact external entries with complete provenance and rejects provenance drift", () => {
    const { repo } = createStore();
    const text = "external canary bytes: lobster-matrix-7f3a";
    const provenance = {
      sourceId: "source-1",
      importId: "import-1",
      itemId: "item-1",
      attachmentId: "external-attachment-1",
      attachmentRevision: 1,
      normalizedArtifactSha256: hash(text),
    };
    const entries = [
      {
        index: 0,
        kind: "external_attachment" as const,
        ref: "external-attachment-1",
        label: "Codex session",
        disposition: "included" as const,
        sourceScope: "workspace" as const,
        sourceWorkspaceId: "workspace-1",
        sourceVersion: `external:rev:1:sha256:${hash(text)}`,
        sourceHash: hash(text),
        externalProvenance: provenance,
        originalBytes: Buffer.byteLength(text, "utf8"),
        originalTokens: 12,
        admittedBytes: Buffer.byteLength(text, "utf8"),
        admittedTokens: 12,
        truncated: false,
        admittedText: text,
      },
    ];
    const contextText = renderChatRoutedContextEntries(entries);
    const snapshot = sealChatRoutedContextSnapshot({
      snapshotId: "chat-routed-context-external-1",
      schemaVersion: CHAT_ROUTED_CONTEXT_SNAPSHOT_VERSION,
      turnId: "turn-external-1",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      capabilityProfileId: "chat-capability-profile-turn-external-1",
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
        usedTokens: 30,
        usedBytes: Buffer.byteLength(contextText, "utf8"),
        estimatorVersion: "gc-approx-tokens.v1",
        budgetPolicyVersion: "chat.routed-context-budget.v1",
      },
      entries,
      contextText,
      createdAt: "2026-07-14T00:00:00.000Z",
    });
    assert.deepEqual(repo.create(snapshot), snapshot);
    const stored = repo.findByTurn("turn-external-1");
    assert.deepEqual(stored?.entries[0]?.externalProvenance, provenance);
    assert.equal(stored?.entries[0]?.admittedText, text);

    const inspection = projectChatRoutedContextInspection(snapshot);
    assert.deepEqual(inspection.entries[0]?.externalProvenance, provenance);
    assert.equal("admittedText" in inspection.entries[0]!, false);

    const missingProvenance = sealChatRoutedContextSnapshot({
      ...snapshot,
      entries: entries.map(({ externalProvenance: _externalProvenance, ...entry }) => entry),
    });
    assert.throws(() => verifyChatRoutedContextSnapshot(missingProvenance), /missing external provenance/u);
    const foreignHash = sealChatRoutedContextSnapshot({
      ...snapshot,
      entries: entries.map((entry) => ({
        ...entry,
        externalProvenance: { ...provenance, normalizedArtifactSha256: "b".repeat(64) },
      })),
    });
    assert.throws(() => verifyChatRoutedContextSnapshot(foreignHash), /does not bind its source hash/u);
    const truncatedExternal = sealChatRoutedContextSnapshot({
      ...snapshot,
      entries: entries.map((entry) => ({
        ...entry,
        disposition: "truncated" as const,
        truncated: true,
        originalBytes: entry.originalBytes + 4,
        originalTokens: entry.originalTokens + 4,
      })),
    });
    assert.throws(() => verifyChatRoutedContextSnapshot(truncatedExternal), /non-exact external bytes/u);
    const internalWithProvenance = sealChatRoutedContextSnapshot({
      ...buildSnapshot(),
      entries: buildSnapshot().entries.map((entry) => ({ ...entry, externalProvenance: provenance })),
    });
    assert.throws(() => verifyChatRoutedContextSnapshot(internalWithProvenance), /provenance on an internal entry/u);
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
