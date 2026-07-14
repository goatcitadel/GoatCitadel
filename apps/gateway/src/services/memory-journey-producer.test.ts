import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConflictError, type MemoryItemRecord, type MemoryLifecyclePatch } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import {
  buildMemoryItemApprovalStateMaterial,
  buildMemoryItemsApprovalStateMaterial,
  buildMemoryLifecycleApprovalBinding,
  deriveApprovedMemoryHistoryId,
  resolveApprovedMemoryMutation,
  type MemoryLifecycleApprovalBindingV1,
} from "./memory-journey-producer.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("approved memory lifecycle Journey producer", () => {
  it("atomically writes content-free history and Journey evidence and exactly replays an approved patch", () => {
    const harness = createHarness("patch-replay");
    insertMemoryItem(harness, {
      itemId: "memory-patch-1",
      title: "Original title",
      content: "original-content-do-not-project",
      metadata: { originalMarker: "original-metadata-do-not-project" },
    });
    const current = readMemoryItem(harness, "memory-patch-1");
    const patch: MemoryLifecyclePatch = {
      title: "Approved title",
      content: "new-content-do-not-project",
      metadata: { privateMarker: "new-metadata-do-not-project" },
      pinned: true,
    };
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
      correctionActionId: "correction-action-1",
    });
    expect(
      buildMemoryLifecycleApprovalBinding({
        workspaceId: harness.workspaceId,
        sessionId: "session-memory-journey-other",
        turnId: "turn-memory-journey-other",
        subjectKind: "memory_item",
        subjectId: current.itemId,
        action: "item_updated",
        mutation: patch,
        expectedState: buildMemoryItemApprovalStateMaterial(current),
      }).requestSha256,
    ).toBe(binding.requestSha256);
    const approval = approveMemoryMutation(harness, binding);

    const updated = harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
      approvalId: approval.approvalId,
    });

    expect(updated).toMatchObject({
      itemId: current.itemId,
      workspaceId: harness.workspaceId,
      title: patch.title,
      content: patch.content,
      metadata: patch.metadata,
      pinned: true,
    });
    const history = listMemoryHistory(harness);
    expect(history).toHaveLength(1);
    const change = history[0]!;
    expect(change).toMatchObject({
      item_id: current.itemId,
      change_type: "updated",
      actor_id: harness.actorId,
      created_at: approval.resolvedAt,
    });
    expect(JSON.parse(change.payload_json)).toMatchObject({
      approvalId: approval.approvalId,
      requestSha256: binding.requestSha256,
      expectedStateSha256: binding.expectedStateSha256,
      fieldCodes: ["content", "metadata", "pinned", "title"],
      correctionProvenance: "explicit",
      correctionActionId: "correction-action-1",
      storesRawContent: false,
    });
    const journey = harness.storage.governanceJourneyEvents.get(`memory:journey:${change.change_id}`);
    expect(journey).toMatchObject({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      approvalId: approval.approvalId,
      fingerprint: binding.requestSha256,
      eventType: "memory_item_lifecycle",
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      sourceKind: "memory_change_history",
      sourceId: change.change_id,
      poisoningStatus: "clean",
      provenance: {
        sourceRequired: true,
        approvalRequired: true,
        correctionProvenance: "explicit",
        correctionActionId: "correction-action-1",
      },
      summary: {
        fieldCodes: ["content", "metadata", "pinned", "title"],
        memoryMutationObserved: true,
        journeyMutationAuthority: false,
        callable: false,
        directPromotion: false,
      },
    });
    expect(journey.evidenceRefs).toEqual([
      { owner: "approval", refId: approval.approvalId },
      { owner: "memory_history", refId: change.change_id },
    ]);
    const projectedEvidence = JSON.stringify({ history: change, journey });
    for (const forbidden of [
      "original-content-do-not-project",
      "original-metadata-do-not-project",
      "new-content-do-not-project",
      "new-metadata-do-not-project",
    ]) {
      expect(projectedEvidence).not.toContain(forbidden);
    }

    harness.publishRealtime.mockClear();
    expect(
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: approval.approvalId,
      }),
    ).toEqual(updated);
    expect(listMemoryHistory(harness)).toEqual(history);
    expect(listMemoryJourneyRows(harness)).toHaveLength(1);
    expect(harness.publishRealtime).not.toHaveBeenCalled();

    expect(() =>
      harness.service.patchMemoryItem(current.itemId, { ...patch, title: "Different request" }, harness.actorId, {
        approvalId: approval.approvalId,
      }),
    ).toThrow(ConflictError);
    expect(readMemoryItem(harness, current.itemId)).toEqual(updated);
    expect(listMemoryHistory(harness)).toEqual(history);
  });

  it("snapshots raw patch data once so approval hashing and mutation bytes cannot diverge", () => {
    const harness = createHarness("patch-snapshot");
    insertMemoryItem(harness, { itemId: "memory-patch-snapshot" });
    const current = readMemoryItem(harness, "memory-patch-snapshot");
    const approvedPatch = { title: "Approved snapshot title" } satisfies MemoryLifecyclePatch;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: approvedPatch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const approval = approveMemoryMutation(harness, binding);
    let titleReads = 0;
    const accessorPatch = {} as MemoryLifecyclePatch;
    Object.defineProperty(accessorPatch, "title", {
      enumerable: true,
      get: () => {
        titleReads += 1;
        return titleReads <= 7 ? approvedPatch.title : "Unapproved late getter title";
      },
    });

    const updated = harness.service.patchMemoryItem(current.itemId, accessorPatch, harness.actorId, {
      approvalId: approval.approvalId,
    });

    expect(updated.title).toBe(approvedPatch.title);
    expect(updated.title).not.toBe("Unapproved late getter title");
    expect(listMemoryHistory(harness)).toHaveLength(1);
  });

  it("settles an approved same-value patch as a repeatable no-op without evidence or realtime theater", () => {
    const harness = createHarness("patch-no-op");
    insertMemoryItem(harness, { itemId: "memory-patch-no-op", title: "Already canonical" });
    const current = readMemoryItem(harness, "memory-patch-no-op");
    const patch = { title: current.title } satisfies MemoryLifecyclePatch;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const approval = approveMemoryMutation(harness, binding);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(
        harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
          approvalId: approval.approvalId,
        }),
      ).toEqual(current);
    }
    expect(listMemoryHistory(harness)).toEqual([]);
    expect(listMemoryJourneyRows(harness)).toEqual([]);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects semantically equal but byte-different immutable history evidence on replay", () => {
    const harness = createHarness("exact-bytes-history");
    insertMemoryItem(harness, { itemId: "memory-exact-bytes-history" });
    const current = readMemoryItem(harness, "memory-exact-bytes-history");
    const patch = { title: "Exact immutable bytes" } satisfies MemoryLifecyclePatch;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const approval = approveMemoryMutation(harness, binding);
    const updated = harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
      approvalId: approval.approvalId,
    });
    const history = listMemoryHistory(harness)[0]!;
    harness.storage.gatewaySql
      .prepare("UPDATE memory_change_history SET payload_json = @payloadJson WHERE change_id = @changeId")
      .run({
        changeId: history.change_id,
        payloadJson: JSON.stringify(JSON.parse(history.payload_json), null, 2),
      });

    harness.publishRealtime.mockClear();
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: approval.approvalId,
      }),
    ).toThrow(ConflictError);
    expect(readMemoryItem(harness, current.itemId)).toEqual(updated);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects pending, wrong-actor, wrong-workspace, and stale-state authority without mutation", () => {
    const harness = createHarness("authority-rejections");
    insertMemoryItem(harness, { itemId: "memory-authority-1" });
    const current = readMemoryItem(harness, "memory-authority-1");
    const patch = { title: "Approved title" } satisfies MemoryLifecyclePatch;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const pending = harness.storage.approvals.create({
      kind: "memory.lifecycle",
      riskLevel: "caution",
      payload: { memoryLifecycle: binding },
      preview: { title: "Approved memory update" },
      linkage: {
        workspaceId: harness.workspaceId,
        sessionId: harness.sessionId,
        turnId: harness.turnId,
      },
    });
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: pending.approvalId,
      }),
    ).toThrow(ConflictError);

    const resolved = harness.storage.approvals.resolve(pending.approvalId, {
      decision: "approve",
      resolvedBy: harness.actorId,
    });
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, "different-operator", {
        approvalId: resolved.approvalId,
      }),
    ).toThrow(ConflictError);

    const wrongWorkspaceApproval = approveMemoryMutation(harness, binding, {
      workspaceId: "workspace-foreign",
    });
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: wrongWorkspaceApproval.approvalId,
      }),
    ).toThrow(ConflictError);

    const wrongSessionApproval = approveMemoryMutation(harness, binding, {
      sessionId: "session-foreign",
    });
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: wrongSessionApproval.approvalId,
      }),
    ).toThrow(ConflictError);

    const lateResolvedApproval = approveMemoryMutation(harness, binding);
    harness.storage.gatewaySql
      .prepare("UPDATE approvals SET expires_at = @expiresAt WHERE approval_id = @approvalId")
      .run({
        approvalId: lateResolvedApproval.approvalId,
        expiresAt: new Date(Date.parse(lateResolvedApproval.resolvedAt!) - 1).toISOString(),
      });
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: lateResolvedApproval.approvalId,
      }),
    ).toThrow(ConflictError);

    const boundaryResolvedApproval = approveMemoryMutation(harness, binding);
    harness.storage.gatewaySql
      .prepare("UPDATE approvals SET expires_at = @expiresAt WHERE approval_id = @approvalId")
      .run({
        approvalId: boundaryResolvedApproval.approvalId,
        expiresAt: boundaryResolvedApproval.resolvedAt,
      });
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: boundaryResolvedApproval.approvalId,
      }),
    ).toThrow(ConflictError);

    const wrongKindPending = harness.storage.approvals.create({
      kind: "memory.lifecycle.other",
      riskLevel: "caution",
      payload: { memoryLifecycle: binding },
      preview: { title: "Wrong approval kind" },
      linkage: {
        workspaceId: harness.workspaceId,
        sessionId: harness.sessionId,
        turnId: harness.turnId,
      },
    });
    const wrongKindApproval = harness.storage.approvals.resolve(wrongKindPending.approvalId, {
      decision: "approve",
      resolvedBy: harness.actorId,
    });
    const mismatchedBindings: MemoryLifecycleApprovalBindingV1[] = [
      { ...binding, subjectId: "memory-authority-other" },
      { ...binding, action: "batch_mutated" },
      { ...binding, requestSha256: "f".repeat(64) },
    ];
    const mismatchedApprovals = mismatchedBindings.map((mismatchedBinding) =>
      approveMemoryMutation(harness, mismatchedBinding),
    );
    for (const approvalId of [wrongKindApproval.approvalId, ...mismatchedApprovals.map((entry) => entry.approvalId)]) {
      expect(() =>
        harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
          approvalId,
        }),
      ).toThrow(ConflictError);
    }

    const staleBinding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: {
        ...buildMemoryItemApprovalStateMaterial(current),
        titleSha256: "f".repeat(64),
      },
    });
    const staleApproval = approveMemoryMutation(harness, staleBinding);
    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: staleApproval.approvalId,
      }),
    ).toThrow(ConflictError);

    expect(readMemoryItem(harness, current.itemId)).toEqual(current);
    expect(listMemoryHistory(harness)).toEqual([]);
    expect(listMemoryJourneyRows(harness)).toEqual([]);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("uses a PostgreSQL row lock and canonical stored actor when resolving approval authority", () => {
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: "workspace-lock",
      sessionId: "session-lock",
      turnId: "turn-lock",
      subjectKind: "memory_item",
      subjectId: "memory-lock",
      action: "item_updated",
      mutation: { title: "Locked title" },
      expectedState: { version: 1 },
    });
    const prepare = vi.fn((_sql: string) => ({
      get: vi.fn(() => ({
        approval_id: "approval-lock",
        kind: "memory.lifecycle",
        status: "approved",
        linkage_json: JSON.stringify({
          workspaceId: "workspace-lock",
          sessionId: "session-lock",
          turnId: "turn-lock",
        }),
        payload_json: JSON.stringify({ memoryLifecycle: binding }),
        expires_at: "2026-07-14T12:00:00.000Z",
        resolved_at: "2026-07-14T11:59:59.999Z",
        resolved_by: "operator-from-storage",
      })),
      run: vi.fn(),
    }));

    const authority = resolveApprovedMemoryMutation(
      { dialect: "postgres", prepare },
      {
        context: { approvalId: "approval-lock" },
        workspaceId: "workspace-lock",
        actorId: "operator-from-storage",
        subjectKind: "memory_item",
        subjectId: "memory-lock",
        action: "item_updated",
        requestSha256: binding.requestSha256,
      },
    );

    expect(prepare.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(authority.actorId).toBe("operator-from-storage");
  });

  it("records a TTL refresh when the override stays constant but the expiry changes", () => {
    const harness = createHarness("ttl-refresh");
    insertMemoryItem(harness, { itemId: "memory-ttl-refresh" });
    harness.storage.gatewaySql
      .prepare(
        `UPDATE memory_items
         SET ttl_override_seconds = 3600, expires_at = '2026-07-13T01:00:00.000Z'
         WHERE item_id = 'memory-ttl-refresh'`,
      )
      .run();
    const current = readMemoryItem(harness, "memory-ttl-refresh");
    const patch = { ttlOverrideSeconds: 3600 } satisfies MemoryLifecyclePatch;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const approval = approveMemoryMutation(harness, binding);

    const updated = harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
      approvalId: approval.approvalId,
    });

    expect(updated.ttlOverrideSeconds).toBe(3600);
    expect(updated.expiresAt).not.toBe(current.expiresAt);
    const history = listMemoryHistory(harness);
    expect(history).toHaveLength(1);
    const journey = harness.storage.governanceJourneyEvents.get(`memory:journey:${history[0]!.change_id}`);
    expect(journey.summary.fieldCodes).toEqual(["expires_at"]);
  });

  it("rolls the item and history back when immutable Journey evidence conflicts", () => {
    const harness = createHarness("journey-conflict");
    insertMemoryItem(harness, { itemId: "memory-conflict-1" });
    const current = readMemoryItem(harness, "memory-conflict-1");
    const patch = { title: "Must roll back" } satisfies MemoryLifecyclePatch;
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      mutation: patch,
      expectedState: buildMemoryItemApprovalStateMaterial(current),
    });
    const approval = approveMemoryMutation(harness, binding);
    const changeId = deriveApprovedMemoryHistoryId({
      approvalId: approval.approvalId,
      subjectId: current.itemId,
      action: "item_updated",
    });
    harness.storage.governanceJourneyEvents.create({
      schemaVersion: "goatcitadel.journey-event.v1",
      eventId: `memory:journey:${changeId}`,
      idempotencyKey: `conflicting-event:${changeId}`,
      scopeKind: "workspace",
      workspaceId: harness.workspaceId,
      eventType: "memory_item_lifecycle",
      subjectKind: "memory_item",
      subjectId: current.itemId,
      action: "item_updated",
      actorId: harness.actorId,
      actorType: "operator",
      approvalId: approval.approvalId,
      fingerprint: "0".repeat(64),
      sourceKind: "memory_change_history",
      sourceId: "conflicting-source",
      trustDisposition: "conflicting_fixture",
      poisoningStatus: "conflicting",
      evidenceRefs: [
        { owner: "approval", refId: approval.approvalId },
        { owner: "memory_history", refId: "conflicting-source" },
      ],
      provenance: { sourceRequired: true, approvalRequired: true },
      summary: { fixtureKind: "immutable_conflict", directPromotion: false },
      occurredAt: approval.resolvedAt!,
      recordedAt: approval.resolvedAt!,
    });

    expect(() =>
      harness.service.patchMemoryItem(current.itemId, patch, harness.actorId, {
        approvalId: approval.approvalId,
      }),
    ).toThrow(ConflictError);
    expect(readMemoryItem(harness, current.itemId)).toEqual(current);
    expect(listMemoryHistory(harness)).toEqual([]);
    expect(listMemoryJourneyRows(harness)).toHaveLength(1);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("atomically forgets an approved item batch and settles exact recovery replay", () => {
    const harness = createHarness("forget-batch");
    insertMemoryItem(harness, {
      itemId: "memory-forget-a",
      content: "forget-content-a-do-not-project",
      metadata: { marker: "forget-metadata-a-do-not-project" },
    });
    insertMemoryItem(harness, {
      itemId: "memory-forget-b",
      content: "forget-content-b-do-not-project",
      metadata: { marker: "forget-metadata-b-do-not-project" },
    });
    const itemIds = ["memory-forget-a", "memory-forget-b"];
    const items = itemIds.map((itemId) => readMemoryItem(harness, itemId));
    const actionId = "approved-forget-action-1";
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item_batch",
      action: "items_forgotten",
      mutation: { actionId, itemIds },
      expectedState: buildMemoryItemsApprovalStateMaterial(items),
    });
    const approval = approveMemoryMutation(harness, binding);
    const onCommit = vi.fn();
    const afterCommit = vi.fn();

    const result = harness.service.forgetMemory(
      {
        itemIds: [...itemIds].reverse(),
        workspaceId: harness.workspaceId,
        actorId: harness.actorId,
        actionId,
      },
      {
        approvedMutation: { approvalId: approval.approvalId },
        onCommit,
        afterCommit,
      },
    );

    expect(result).toMatchObject({
      actionId,
      matchedCount: 2,
      forgottenCount: 2,
      alreadyForgottenCount: 0,
      itemIds,
    });
    expect(result.items.every((item) => item.status === "forgotten")).toBe(true);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    const history = listMemoryHistory(harness);
    expect(history).toHaveLength(2);
    const journey = listMemoryJourneyRows(harness).sort((left, right) =>
      left.subject_id.localeCompare(right.subject_id),
    );
    expect(journey).toHaveLength(2);
    expect(journey.map((event) => event.subject_id)).toEqual(itemIds);
    expect(journey.map((event) => event.action)).toEqual(["forgotten", "forgotten"]);
    expect(journey.map((event) => event.fingerprint)).toEqual([binding.requestSha256, binding.requestSha256]);
    expect(journey.map((event) => JSON.parse(event.provenance_json).batchOperationIndex)).toEqual([0, 1]);
    const projectedEvidence = JSON.stringify({ history, journey });
    for (const forbidden of [
      "forget-content-a-do-not-project",
      "forget-metadata-a-do-not-project",
      "forget-content-b-do-not-project",
      "forget-metadata-b-do-not-project",
    ]) {
      expect(projectedEvidence).not.toContain(forbidden);
    }

    harness.publishRealtime.mockClear();
    expect(
      harness.service.forgetMemory(
        {
          itemIds,
          workspaceId: harness.workspaceId,
          actorId: harness.actorId,
          actionId,
        },
        {
          approvedMutation: { approvalId: approval.approvalId },
          onCommit,
          afterCommit,
        },
      ),
    ).toEqual(result);
    expect(listMemoryHistory(harness)).toEqual(history);
    expect(listMemoryJourneyRows(harness)).toHaveLength(2);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(afterCommit).toHaveBeenCalledTimes(2);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("rolls every item, history row, hook, and new Journey row back when a later batch event conflicts", () => {
    const harness = createHarness("forget-batch-rollback");
    const itemIds = ["memory-forget-rollback-a", "memory-forget-rollback-b"];
    for (const itemId of itemIds) insertMemoryItem(harness, { itemId });
    const items = itemIds.map((itemId) => readMemoryItem(harness, itemId));
    const actionId = "approved-forget-rollback-action";
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item_batch",
      action: "items_forgotten",
      mutation: { actionId, itemIds },
      expectedState: buildMemoryItemsApprovalStateMaterial(items),
    });
    const approval = approveMemoryMutation(harness, binding);
    const conflictingSubjectId = itemIds[1]!;
    const conflictingChangeId = deriveApprovedMemoryHistoryId({
      approvalId: approval.approvalId,
      subjectId: conflictingSubjectId,
      action: "forgotten",
    });
    harness.storage.governanceJourneyEvents.create({
      schemaVersion: "goatcitadel.journey-event.v1",
      eventId: `memory:journey:${conflictingChangeId}`,
      idempotencyKey: `conflicting-forget-event:${conflictingChangeId}`,
      scopeKind: "workspace",
      workspaceId: harness.workspaceId,
      eventType: "memory_item_lifecycle",
      subjectKind: "memory_item",
      subjectId: conflictingSubjectId,
      action: "forgotten",
      actorId: harness.actorId,
      actorType: "operator",
      approvalId: approval.approvalId,
      fingerprint: "0".repeat(64),
      sourceKind: "memory_change_history",
      sourceId: "conflicting-forget-source",
      trustDisposition: "conflicting_fixture",
      poisoningStatus: "conflicting",
      evidenceRefs: [
        { owner: "approval", refId: approval.approvalId },
        { owner: "memory_history", refId: "conflicting-forget-source" },
      ],
      provenance: { sourceRequired: true, approvalRequired: true },
      summary: { fixtureKind: "immutable_forget_conflict", directPromotion: false },
      occurredAt: approval.resolvedAt!,
      recordedAt: approval.resolvedAt!,
    });
    const onCommit = vi.fn();
    const afterCommit = vi.fn();

    expect(() =>
      harness.service.forgetMemory(
        {
          itemIds,
          workspaceId: harness.workspaceId,
          actorId: harness.actorId,
          actionId,
        },
        {
          approvedMutation: { approvalId: approval.approvalId },
          onCommit,
          afterCommit,
        },
      ),
    ).toThrow(ConflictError);

    expect(itemIds.map((itemId) => readMemoryItem(harness, itemId).status)).toEqual(["active", "active"]);
    expect(listMemoryHistory(harness)).toEqual([]);
    expect(listMemoryJourneyRows(harness)).toHaveLength(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(afterCommit).not.toHaveBeenCalled();
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects lossy forget normalization before consulting or consuming approved authority", () => {
    const harness = createHarness("forget-canonical-input");
    const itemId = "memory-forget-canonical";
    insertMemoryItem(harness, { itemId });
    const current = readMemoryItem(harness, itemId);
    const actionId = "approved-forget-canonical-action";
    const binding = buildMemoryLifecycleApprovalBinding({
      workspaceId: harness.workspaceId,
      sessionId: harness.sessionId,
      turnId: harness.turnId,
      subjectKind: "memory_item",
      subjectId: itemId,
      action: "items_forgotten",
      mutation: { actionId, itemIds: [itemId] },
      expectedState: buildMemoryItemsApprovalStateMaterial([current]),
    });
    const approval = approveMemoryMutation(harness, binding);
    const attempts = [
      { itemIds: [itemId, itemId], workspaceId: harness.workspaceId, actorId: harness.actorId, actionId },
      { itemIds: [` ${itemId}`], workspaceId: harness.workspaceId, actorId: harness.actorId, actionId },
      { itemIds: [itemId], workspaceId: `${harness.workspaceId} `, actorId: harness.actorId, actionId },
      { itemIds: [itemId], workspaceId: harness.workspaceId, actorId: `${harness.actorId} `, actionId },
      { itemIds: [itemId], workspaceId: harness.workspaceId, actorId: harness.actorId, actionId: ` ${actionId}` },
    ];

    for (const input of attempts) {
      expect(() =>
        harness.service.forgetMemory(input, {
          approvedMutation: { approvalId: approval.approvalId },
        }),
      ).toThrow();
    }

    expect(readMemoryItem(harness, itemId)).toEqual(current);
    expect(listMemoryHistory(harness)).toEqual([]);
    expect(listMemoryJourneyRows(harness)).toEqual([]);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });
});

interface Harness {
  storage: Storage;
  service: MemoryLifecycleService;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  actorId: string;
  publishRealtime: ReturnType<typeof vi.fn>;
}

function createHarness(label: string): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `goatcitadel-memory-journey-${label}-`));
  const storage = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  cleanups.push(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const publishRealtime = vi.fn();
  const service = new MemoryLifecycleService({
    context: {} as never,
    learned: {} as never,
    maintenance: {} as never,
    admin: {
      gatewaySql: storage.gatewaySql,
      tryParseJson: <T>(raw: string | null | undefined, fallback: T): T => {
        try {
          return raw ? (JSON.parse(raw) as T) : fallback;
        } catch {
          return fallback;
        }
      },
      memoryQualityIssues: storage.memoryQualityIssues,
      requireFeatureEnabled: vi.fn(),
      publishRealtime,
    },
    resolveLearnedMemoryPolicy: vi.fn(() => ({ allowWrite: true, reason: "allowed" })),
    readTranscriptOrEmpty: vi.fn(async () => []),
  });
  return {
    storage,
    service,
    workspaceId: "workspace-memory-journey",
    sessionId: "session-memory-journey",
    turnId: "turn-memory-journey",
    actorId: "operator-memory-journey",
    publishRealtime,
  };
}

function insertMemoryItem(
  harness: Harness,
  input: {
    itemId: string;
    title?: string;
    content?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const createdAt = "2026-07-13T00:00:00.000Z";
  harness.storage.gatewaySql
    .prepare(
      `INSERT INTO memory_items (
         item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds,
         expires_at, status, created_at, updated_at, forgotten_at, workspace_id
       ) VALUES (
         @itemId, @namespace, @title, @content, @metadataJson, 0, NULL,
         NULL, 'active', @createdAt, @createdAt, NULL, @workspaceId
       )`,
    )
    .run({
      itemId: input.itemId,
      namespace: "workspace.preferences",
      title: input.title ?? "Original memory title",
      content: input.content ?? "Original memory content",
      metadataJson: JSON.stringify(input.metadata ?? { source: "test" }),
      createdAt,
      workspaceId: harness.workspaceId,
    });
}

function readMemoryItem(harness: Harness, itemId: string): MemoryItemRecord {
  const item = harness.service.getActiveMemoryItemForRoutedContext(itemId, harness.workspaceId, {
    nowIso: "2026-07-14T00:00:00.000Z",
  });
  if (item) return item;
  const row = harness.storage.gatewaySql
    .prepare(
      `SELECT item_id, namespace, title, content, metadata_json, pinned, ttl_override_seconds,
              expires_at, status, created_at, updated_at, forgotten_at, workspace_id
       FROM memory_items WHERE item_id = ?`,
    )
    .get(itemId) as
    | {
        item_id: string;
        namespace: string;
        title: string;
        content: string;
        metadata_json: string;
        pinned: number;
        ttl_override_seconds: number | null;
        expires_at: string | null;
        status: MemoryItemRecord["status"];
        created_at: string;
        updated_at: string;
        forgotten_at: string | null;
        workspace_id: string | null;
      }
    | undefined;
  if (!row) throw new Error(`Missing test memory item ${itemId}.`);
  return {
    itemId: row.item_id,
    namespace: row.namespace,
    title: row.title,
    content: row.content,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    pinned: Boolean(row.pinned),
    ttlOverrideSeconds: row.ttl_override_seconds ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    status: row.status,
    lifecycleState: row.status === "forgotten" ? "forgotten" : "active",
    workspaceId: row.workspace_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgottenAt: row.forgotten_at ?? undefined,
  };
}

function approveMemoryMutation(
  harness: Harness,
  binding: MemoryLifecycleApprovalBindingV1,
  linkage: { workspaceId?: string; sessionId?: string; turnId?: string } = {},
) {
  const pending = harness.storage.approvals.create({
    kind: "memory.lifecycle",
    riskLevel: "caution",
    payload: { memoryLifecycle: binding },
    preview: { title: "Approved memory mutation" },
    linkage: {
      workspaceId: linkage.workspaceId ?? harness.workspaceId,
      sessionId: linkage.sessionId ?? harness.sessionId,
      turnId: linkage.turnId ?? harness.turnId,
    },
  });
  return harness.storage.approvals.resolve(pending.approvalId, {
    decision: "approve",
    resolvedBy: harness.actorId,
  });
}

function listMemoryHistory(harness: Harness): Array<{
  change_id: string;
  item_id: string;
  change_type: string;
  actor_id: string | null;
  payload_json: string;
  created_at: string;
}> {
  return harness.storage.gatewaySql
    .prepare(
      `SELECT change_id, item_id, change_type, actor_id, payload_json, created_at
       FROM memory_change_history ORDER BY item_id, change_id`,
    )
    .all() as ReturnType<typeof listMemoryHistory>;
}

function listMemoryJourneyRows(harness: Harness): Array<{
  event_id: string;
  subject_id: string;
  action: string;
  fingerprint: string | null;
  provenance_json: string;
}> {
  return harness.storage.gatewaySql
    .prepare(
      `SELECT event_id, subject_id, action, fingerprint, provenance_json
       FROM governance_journey_events WHERE event_type = 'memory_item_lifecycle'
       ORDER BY subject_id, event_id`,
    )
    .all() as ReturnType<typeof listMemoryJourneyRows>;
}
