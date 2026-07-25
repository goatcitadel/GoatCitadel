import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryForgetRequest } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { MemoryLifecycleService, type MemoryForgetApprovalOutcome } from "./memory-lifecycle-service.js";

/**
 * HX-402 P1 (coverage-preserving rewrite): the unapproved criteria-forget
 * branch is retired. Criteria (namespace/query/workspace scope/explicit IDs)
 * resolve to exact item IDs at REQUEST time inside
 * `requestMemoryForgetApproval`; execution happens only through the recovered
 * `memory.lifecycle` approval effect over those exact IDs. These tests keep
 * the original suite's scope-safety, ordering, escaping, atomicity, and
 * provenance coverage modeled onto the approval-first contract.
 */

type BulkForgetRequestInput = MemoryForgetRequest & { requesterId: string };

interface Harness {
  storage: Storage;
  service: MemoryLifecycleService;
  publishRealtime: ReturnType<typeof vi.fn>;
}

const RESOLVER_ID = "operator-resolver";

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.storage.close();
  }
});

function createHarness(): Harness {
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  const publishRealtime = vi.fn();
  const service = new MemoryLifecycleService({
    context: {} as never,
    learned: {} as never,
    maintenance: {} as never,
    admin: {
      gatewaySql: storage.gatewaySql,
      memoryQualityIssues: storage.memoryQualityIssues,
      tryParseJson: <T>(raw: string | null | undefined, fallback: T): T => {
        try {
          return raw ? (JSON.parse(raw) as T) : fallback;
        } catch {
          return fallback;
        }
      },
      requireFeatureEnabled: () => undefined,
      publishRealtime,
    },
    approvalAuthority: {
      approvals: storage.approvals,
      approvalEvents: storage.approvalEvents,
      governanceJourneyEvents: storage.governanceJourneyEvents,
    },
    resolveLearnedMemoryPolicy: vi.fn(() => ({ allowWrite: true, reason: "allowed" as const })),
    readTranscriptOrEmpty: vi.fn(async () => []),
  });
  const harness = { storage, service, publishRealtime };
  harnesses.push(harness);
  return harness;
}

function seedMemoryItem(
  harness: Harness,
  input: {
    itemId: string;
    workspaceId?: string | null;
    legacyWorkspaceId?: string;
    namespace?: string;
    title?: string;
    content?: string;
    status?: "active" | "forgotten";
  },
): void {
  const now = "2026-07-10T00:00:00.000Z";
  harness.storage.gatewaySql
    .prepare(
      `
      INSERT INTO memory_items (
        item_id, namespace, title, content, metadata_json, pinned,
        ttl_override_seconds, expires_at, status, created_at, updated_at, forgotten_at, workspace_id
      ) VALUES (
        @itemId, @namespace, @title, @content, @metadataJson, 0,
        NULL, NULL, @status, @createdAt, @updatedAt, @forgottenAt, @workspaceId
      )
    `,
    )
    .run({
      itemId: input.itemId,
      namespace: input.namespace ?? "workspace.shared",
      title: input.title ?? input.itemId,
      content: input.content ?? "bulk-forget-needle",
      metadataJson: JSON.stringify(input.legacyWorkspaceId ? { workspaceId: input.legacyWorkspaceId } : {}),
      status: input.status ?? "active",
      createdAt: now,
      updatedAt: now,
      forgottenAt: input.status === "forgotten" ? now : null,
      workspaceId: input.workspaceId === undefined ? "workspace-a" : input.workspaceId,
    });
}

function requestForget(harness: Harness, input: MemoryForgetRequest): MemoryForgetApprovalOutcome {
  return harness.service.requestMemoryForgetApproval({
    ...input,
    requesterId: "operator-requester",
  } satisfies BulkForgetRequestInput);
}

function approveAndExecute(harness: Harness, outcome: MemoryForgetApprovalOutcome) {
  if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
  harness.storage.approvals.resolve(outcome.pendingApproval.approvalId, {
    decision: "approve",
    resolvedBy: RESOLVER_ID,
  });
  return harness.service.executeApprovedMemoryLifecycleMutation({
    workspaceId: outcome.pendingApproval.workspaceId,
    approvalId: outcome.pendingApproval.approvalId,
  });
}

function statusOf(harness: Harness, itemId: string): string | undefined {
  return (
    harness.storage.gatewaySql.prepare("SELECT status FROM memory_items WHERE item_id = ?").get(itemId) as
      | { status: string }
      | undefined
  )?.status;
}

function historyRows(harness: Harness): Array<{ item_id: string; actor_id: string | null; payload_json: string }> {
  return harness.storage.gatewaySql
    .prepare("SELECT item_id, actor_id, payload_json FROM memory_change_history ORDER BY item_id")
    .all() as Array<{ item_id: string; actor_id: string | null; payload_json: string }>;
}

describe("MemoryLifecycleService approval-first bulk forget", () => {
  it("resolves criteria beyond the list cap at request time and forgets every bound row atomically on approval", () => {
    const harness = createHarness();
    const expectedIds = Array.from({ length: 501 }, (_, index) => `workspace-a-${String(index).padStart(4, "0")}`);
    for (const itemId of expectedIds) {
      seedMemoryItem(harness, { itemId });
    }
    for (let index = 0; index < 5; index += 1) {
      seedMemoryItem(harness, { itemId: `workspace-b-${index}`, workspaceId: "workspace-b" });
    }
    seedMemoryItem(harness, { itemId: "global-item", workspaceId: null });

    const outcome = requestForget(harness, {
      namespace: "workspace.shared",
      query: "bulk-forget-needle",
      workspaceId: "workspace-a",
      includeGlobal: false,
      actionId: "forget-action-complete",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    // Criteria bind at request time to exact, deterministically ordered IDs.
    expect(outcome.pendingApproval.itemIds).toStrictEqual([...expectedIds].sort());
    // No durable mutation before approval.
    expect(historyRows(harness)).toHaveLength(0);
    expect(statusOf(harness, "workspace-a-0000")).toBe("active");

    const applied = approveAndExecute(harness, outcome);
    expect(applied).toMatchObject({
      disposition: "applied",
      action: "items_forgotten",
      changedCount: 501,
    });
    expect(statusOf(harness, "workspace-a-0000")).toBe("forgotten");
    expect(statusOf(harness, "workspace-b-0")).toBe("active");
    expect(statusOf(harness, "global-item")).toBe("active");

    const history = historyRows(harness);
    expect(history).toHaveLength(501);
    expect(history.every((row) => row.actor_id === RESOLVER_ID)).toBe(true);
    for (const row of history) {
      expect(JSON.parse(row.payload_json)).toMatchObject({
        approvalId: outcome.pendingApproval.approvalId,
        operationKind: "approved_forget",
        storesRawContent: false,
      });
    }
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "system",
      "memory",
      expect.objectContaining({
        type: "memory_item_forgotten",
        itemId: "workspace-a-0000",
        requestedWorkspaceId: "workspace-a",
        effectiveWorkspaceId: "workspace-a",
        source: "approved_memory_lifecycle",
      }),
    );
  });

  it("treats namespace/query as AND filters for explicit IDs and settles already-forgotten targets without approval", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "active-match", title: "literal 100%_done" });
    seedMemoryItem(harness, { itemId: "forgotten-match", title: "literal 100%_done", status: "forgotten" });

    const outcome = requestForget(harness, {
      itemIds: ["forgotten-match", "active-match", "active-match"],
      namespace: "workspace.shared",
      query: "100%_done",
      workspaceId: "workspace-a",
      actionId: "forget-action-explicit",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    // Only the real state transition is bound; the forgotten row needs no approval.
    expect(outcome.pendingApproval.itemIds).toStrictEqual(["active-match"]);

    const applied = approveAndExecute(harness, outcome);
    expect(applied).toMatchObject({ changedCount: 1 });
    expect(statusOf(harness, "active-match")).toBe("forgotten");
    expect(historyRows(harness)).toHaveLength(1);

    // Criteria matching ONLY forgotten rows are a pure no-op: no approval row.
    const noOp = requestForget(harness, {
      itemIds: ["forgotten-match"],
      workspaceId: "workspace-a",
    });
    expect(noOp).toMatchObject({ pendingApproval: null, noMutationRequired: true, alreadyForgottenCount: 1 });
  });

  it("uses one deterministic item-ID order for mixed-case and punctuation targets", () => {
    const harness = createHarness();
    for (const itemId of ["a", "_", "A"]) {
      seedMemoryItem(harness, { itemId });
    }

    const outcome = requestForget(harness, {
      itemIds: ["a", "_", "A"],
      workspaceId: "workspace-a",
      actionId: "forget-action-id-order",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    expect(outcome.pendingApproval.itemIds).toStrictEqual(["A", "_", "a"]);

    const applied = approveAndExecute(harness, outcome);
    expect(applied).toMatchObject({ changedCount: 3, itemIds: ["A", "_", "a"] });
    expect(historyRows(harness)).toHaveLength(3);
  });

  it("escapes LIKE wildcards so a literal forget query cannot widen its destructive match", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "literal", title: "release 100%_done" });
    seedMemoryItem(harness, { itemId: "wildcard-collision", title: "release 100AAAdone" });

    const outcome = requestForget(harness, {
      query: "100%_done",
      workspaceId: "workspace-a",
      actionId: "forget-action-literal-query",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    expect(outcome.pendingApproval.itemIds).toStrictEqual(["literal"]);

    approveAndExecute(harness, outcome);
    expect(statusOf(harness, "literal")).toBe("forgotten");
    expect(statusOf(harness, "wildcard-collision")).toBe("active");
  });

  it("fails closed on legacy/global rows: approval-scoped forgets require canonical workspace ownership", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "workspace-item" });
    seedMemoryItem(harness, { itemId: "global-item", workspaceId: null });
    seedMemoryItem(harness, { itemId: "legacy-item", workspaceId: null, legacyWorkspaceId: "workspace-a" });

    // Global/legacy rows resolve into the include-global scope but cannot be
    // bound to a workspace approval: missing workspace scope is never replaced
    // with an inferred default, so the request fails closed with zero deltas.
    expect(() =>
      requestForget(harness, {
        namespace: "workspace.shared",
        workspaceId: "workspace-a",
        includeGlobal: true,
        actionId: "forget-action-global-opt-in",
      }),
    ).toThrow(/workspace-owned/i);
    expect(statusOf(harness, "workspace-item")).toBe("active");
    expect(statusOf(harness, "global-item")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);

    // The canonical-workspace subset remains forgettable through approval.
    const outcome = requestForget(harness, {
      itemIds: ["workspace-item"],
      workspaceId: "workspace-a",
      actionId: "forget-action-workspace-only",
    });
    approveAndExecute(harness, outcome);
    expect(statusOf(harness, "workspace-item")).toBe("forgotten");
  });

  it("prevalidates every explicit ID at request time and leaves state untouched when one target is missing or out of scope", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "valid-a" });
    seedMemoryItem(harness, { itemId: "foreign-b", workspaceId: "workspace-b" });

    expect(() =>
      requestForget(harness, {
        itemIds: ["valid-a", "foreign-b", "missing-c"],
        workspaceId: "workspace-a",
        actionId: "forget-action-prevalidate",
      }),
    ).toThrow();
    expect(statusOf(harness, "valid-a")).toBe("active");
    expect(statusOf(harness, "foreign-b")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("rolls back items, history, and governed evidence together when history persistence fails mid-execution", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "rollback-a" });
    seedMemoryItem(harness, { itemId: "rollback-b" });
    const outcome = requestForget(harness, {
      itemIds: ["rollback-a", "rollback-b"],
      workspaceId: "workspace-a",
      actionId: "forget-action-rollback",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    harness.storage.approvals.resolve(outcome.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: RESOLVER_ID,
    });
    harness.storage.gatewaySql.exec(`
      CREATE TRIGGER fail_second_bulk_forget_history
      BEFORE INSERT ON memory_change_history
      WHEN (SELECT COUNT(*) FROM memory_change_history) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'simulated history failure');
      END
    `);
    harness.publishRealtime.mockClear();

    // Unexpected infrastructure failures propagate RAW (not as the terminal
    // MemoryLifecycleApplyError) so the approval-effect worker defers the
    // effect for bounded retry instead of failing the mutation closed.
    expect(() =>
      harness.service.executeApprovedMemoryLifecycleMutation({
        workspaceId: "workspace-a",
        approvalId: outcome.pendingApproval.approvalId,
      }),
    ).toThrow("simulated history failure");

    expect(statusOf(harness, "rollback-a")).toBe("active");
    expect(statusOf(harness, "rollback-b")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
    const governedCount = harness.storage.gatewaySql
      .prepare("SELECT COUNT(*) AS count FROM governed_lifecycle_events")
      .get() as { count?: number };
    expect(Number(governedCount.count)).toBe(0);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("keeps approved single-item forgets atomic when history persistence fails", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "single-rollback" });
    const outcome = requestForget(harness, {
      itemIds: ["single-rollback"],
      workspaceId: "workspace-a",
      actionId: "single-forget-rollback",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    harness.storage.approvals.resolve(outcome.pendingApproval.approvalId, {
      decision: "approve",
      resolvedBy: RESOLVER_ID,
    });
    harness.storage.gatewaySql.exec(`
      CREATE TRIGGER fail_single_forget_history
      BEFORE INSERT ON memory_change_history
      BEGIN
        SELECT RAISE(ABORT, 'single history failure');
      END
    `);
    harness.publishRealtime.mockClear();

    expect(() =>
      harness.service.executeApprovedMemoryLifecycleMutation({
        workspaceId: "workspace-a",
        approvalId: outcome.pendingApproval.approvalId,
      }),
    ).toThrow("single history failure");

    expect(statusOf(harness, "single-rollback")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("preserves approval provenance in single-item forget history", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "single-provenance" });

    const outcome = requestForget(harness, {
      itemIds: ["single-provenance"],
      workspaceId: "workspace-a",
      actionId: "single-forget-action",
    });
    if (!outcome.pendingApproval) throw new Error("Expected a pending forget approval.");
    approveAndExecute(harness, outcome);

    expect(historyRows(harness)).toHaveLength(1);
    expect(JSON.parse(historyRows(harness)[0]?.payload_json ?? "{}")).toMatchObject({
      approvalId: outcome.pendingApproval.approvalId,
      requestSha256: outcome.pendingApproval.requestSha256,
      operationKind: "approved_forget",
      storesRawContent: false,
    });
  });

  it("rejects global inclusion without a workspace boundary before resolving anything", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "still-active" });

    expect(() =>
      requestForget(harness, {
        itemIds: ["still-active"],
        includeGlobal: true,
        actionId: "forget-action-invalid-global",
      }),
    ).toThrow();
    expect(statusOf(harness, "still-active")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
  });
});
