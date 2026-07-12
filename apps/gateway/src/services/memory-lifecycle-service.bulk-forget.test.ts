import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryItemRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

interface BulkForgetInput {
  itemIds?: string[];
  namespace?: string;
  query?: string;
  workspaceId?: string;
  includeGlobal?: boolean;
  actionId?: string;
  source?: string;
  actorId?: string;
}

interface BulkForgetResult {
  actionId: string;
  matchedCount: number;
  alreadyForgottenCount: number;
  forgottenCount: number;
  itemIds: string[];
  items: MemoryItemRecord[];
}

interface BulkForgetHooks {
  onCommit?: () => void;
  afterCommit?: () => void;
}

interface Harness {
  storage: Storage;
  service: MemoryLifecycleService;
  publishRealtime: ReturnType<typeof vi.fn>;
}

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

function forgetMemory(harness: Harness, input: BulkForgetInput, hooks?: BulkForgetHooks): BulkForgetResult {
  return (
    harness.service as unknown as {
      forgetMemory(request: BulkForgetInput, commitHooks?: BulkForgetHooks): BulkForgetResult;
    }
  ).forgetMemory(input, hooks);
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

describe("MemoryLifecycleService atomic bulk forget", () => {
  it("forgets every matching row beyond the list cap while excluding foreign and global memory by default", () => {
    const harness = createHarness();
    const expectedIds = Array.from({ length: 501 }, (_, index) => `workspace-a-${String(index).padStart(4, "0")}`);
    for (const itemId of expectedIds) {
      seedMemoryItem(harness, { itemId });
    }
    seedMemoryItem(harness, { itemId: "workspace-a-legacy", workspaceId: null, legacyWorkspaceId: "workspace-a" });
    expectedIds.push("workspace-a-legacy");
    for (let index = 0; index < 5; index += 1) {
      seedMemoryItem(harness, { itemId: `workspace-b-${index}`, workspaceId: "workspace-b" });
    }
    seedMemoryItem(harness, { itemId: "global-item", workspaceId: null });

    const onCommit = vi.fn(() => expect(harness.publishRealtime).not.toHaveBeenCalled());
    const afterCommit = vi.fn(() => expect(harness.publishRealtime).not.toHaveBeenCalled());
    const result = forgetMemory(
      harness,
      {
        namespace: "workspace.shared",
        query: "bulk-forget-needle",
        workspaceId: "workspace-a",
        includeGlobal: false,
        actionId: "forget-action-complete",
        source: "review-regression",
        actorId: "operator-1",
      },
      { onCommit, afterCommit },
    );

    expect(result).toMatchObject({
      actionId: "forget-action-complete",
      matchedCount: 502,
      alreadyForgottenCount: 0,
      forgottenCount: 502,
    });
    expect(result.itemIds).toStrictEqual(expectedIds.sort());
    expect(result.items.map((item) => item.itemId)).toStrictEqual(expectedIds);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveBeenCalledTimes(1);
    expect(harness.publishRealtime).toHaveBeenCalledTimes(502);
    expect(harness.publishRealtime).toHaveBeenCalledWith(
      "system",
      "memory",
      expect.objectContaining({
        type: "memory_item_forgotten",
        itemId: "workspace-a-legacy",
        requestedWorkspaceId: "workspace-a",
        effectiveWorkspaceId: "workspace-a",
      }),
    );
    expect(statusOf(harness, "workspace-b-0")).toBe("active");
    expect(statusOf(harness, "global-item")).toBe("active");

    const history = historyRows(harness);
    expect(history).toHaveLength(502);
    expect(history.every((row) => row.actor_id === "operator-1")).toBe(true);
    for (const row of history) {
      expect(JSON.parse(row.payload_json)).toMatchObject({
        previousStatus: "active",
        actionId: "forget-action-complete",
        source: "review-regression",
        operationCount: 502,
        requestedWorkspaceId: "workspace-a",
        includeGlobal: false,
      });
    }
    expect(JSON.parse(history.find((row) => row.item_id === "workspace-a-legacy")?.payload_json ?? "{}")).toMatchObject(
      { effectiveWorkspaceId: "workspace-a" },
    );
  });

  it("treats namespace/query as AND filters for explicit IDs and reports only real state transitions", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "active-match", title: "literal 100%_done" });
    seedMemoryItem(harness, { itemId: "forgotten-match", title: "literal 100%_done", status: "forgotten" });

    const result = forgetMemory(harness, {
      itemIds: ["forgotten-match", "active-match", "active-match"],
      namespace: "workspace.shared",
      query: "100%_done",
      workspaceId: "workspace-a",
      actionId: "forget-action-explicit",
    });

    expect(result).toMatchObject({
      actionId: "forget-action-explicit",
      matchedCount: 2,
      alreadyForgottenCount: 1,
      forgottenCount: 1,
      itemIds: ["active-match"],
    });
    expect(result.items.map((item) => item.itemId)).toStrictEqual(["active-match"]);
    expect(historyRows(harness)).toHaveLength(1);
    expect(harness.publishRealtime).toHaveBeenCalledTimes(1);
  });

  it("uses one deterministic item-ID order for mixed-case and punctuation targets", () => {
    const harness = createHarness();
    for (const itemId of ["a", "_", "A"]) {
      seedMemoryItem(harness, { itemId });
    }

    const result = forgetMemory(harness, {
      itemIds: ["a", "_", "A"],
      actionId: "forget-action-id-order",
    });

    expect(result).toMatchObject({ matchedCount: 3, forgottenCount: 3 });
    expect(result.itemIds).toStrictEqual(["A", "_", "a"]);
    expect(historyRows(harness)).toHaveLength(3);
  });

  it("escapes LIKE wildcards so a literal forget query cannot widen its destructive match", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "literal", title: "release 100%_done" });
    seedMemoryItem(harness, { itemId: "wildcard-collision", title: "release 100AAAdone" });

    const result = forgetMemory(harness, {
      query: "100%_done",
      workspaceId: "workspace-a",
      actionId: "forget-action-literal-query",
    });

    expect(result).toMatchObject({ matchedCount: 1, forgottenCount: 1, itemIds: ["literal"] });
    expect(statusOf(harness, "literal")).toBe("forgotten");
    expect(statusOf(harness, "wildcard-collision")).toBe("active");
  });

  it("allows an explicit workspace-scoped opt-in to include global rows", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "workspace-item" });
    seedMemoryItem(harness, { itemId: "global-item", workspaceId: null });
    seedMemoryItem(harness, { itemId: "foreign-item", workspaceId: "workspace-b" });

    const result = forgetMemory(harness, {
      namespace: "workspace.shared",
      workspaceId: "workspace-a",
      includeGlobal: true,
      actionId: "forget-action-global-opt-in",
    });

    expect(result).toMatchObject({ matchedCount: 2, forgottenCount: 2 });
    expect(result.itemIds).toStrictEqual(["global-item", "workspace-item"]);
    expect(statusOf(harness, "foreign-item")).toBe("active");
  });

  it("prevalidates every explicit ID and rolls back the entire request when one target is missing or out of scope", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "valid-a" });
    seedMemoryItem(harness, { itemId: "foreign-b", workspaceId: "workspace-b" });

    expect(() =>
      forgetMemory(harness, {
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

  it("rolls back items and history together and emits no realtime event when history persistence fails", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "rollback-a" });
    seedMemoryItem(harness, { itemId: "rollback-b" });
    harness.storage.gatewaySql.exec(`
      CREATE TRIGGER fail_second_bulk_forget_history
      BEFORE INSERT ON memory_change_history
      WHEN (SELECT COUNT(*) FROM memory_change_history) >= 1
      BEGIN
        SELECT RAISE(ABORT, 'simulated history failure');
      END
    `);
    const onCommit = vi.fn();
    const afterCommit = vi.fn();

    expect(() =>
      forgetMemory(
        harness,
        { itemIds: ["rollback-a", "rollback-b"], actionId: "forget-action-rollback" },
        { onCommit, afterCommit },
      ),
    ).toThrow("simulated history failure");

    expect(statusOf(harness, "rollback-a")).toBe("active");
    expect(statusOf(harness, "rollback-b")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
    expect(afterCommit).not.toHaveBeenCalled();
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("keeps the single-item forget route atomic when history persistence fails", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "single-rollback" });
    harness.storage.gatewaySql.exec(`
      CREATE TRIGGER fail_single_forget_history
      BEFORE INSERT ON memory_change_history
      BEGIN
        SELECT RAISE(ABORT, 'single history failure');
      END
    `);
    const onCommit = vi.fn();
    const afterCommit = vi.fn();

    expect(() =>
      (
        harness.service as unknown as {
          forgetMemoryItem(itemId: string, actorId: string, hooks?: BulkForgetHooks): MemoryItemRecord;
        }
      ).forgetMemoryItem("single-rollback", "operator-single", { onCommit, afterCommit }),
    ).toThrow("single history failure");

    expect(statusOf(harness, "single-rollback")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
    expect(onCommit).not.toHaveBeenCalled();
    expect(afterCommit).not.toHaveBeenCalled();
    expect(harness.publishRealtime).not.toHaveBeenCalled();
  });

  it("rejects global inclusion without a workspace boundary before mutating", () => {
    const harness = createHarness();
    seedMemoryItem(harness, { itemId: "still-active" });

    expect(() =>
      forgetMemory(harness, {
        itemIds: ["still-active"],
        includeGlobal: true,
        actionId: "forget-action-invalid-global",
      }),
    ).toThrow();
    expect(statusOf(harness, "still-active")).toBe("active");
    expect(historyRows(harness)).toHaveLength(0);
  });
});
