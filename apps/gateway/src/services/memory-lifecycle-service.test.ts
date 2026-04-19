import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

describe("MemoryLifecycleService", () => {
  it("routes context, learned-memory, and maintenance entry points through one owner", async () => {
    const service = new MemoryLifecycleService({
      context: {
        compose: vi.fn(async () => ({ contextId: "ctx-1" })),
        get: vi.fn(() => ({ contextId: "ctx-1" })),
        listByRun: vi.fn(() => [{ contextId: "ctx-1" }]),
        listRecent: vi.fn(() => [{ contextId: "ctx-2" }]),
        stats: vi.fn(() => ({ totalRuns: 1 })),
      } as never,
      learned: {
        extractAndPersistLearnedMemory: vi.fn(),
        listChatSessionLearnedMemory: vi.fn(() => ({ items: [], conflicts: [] })),
        updateChatSessionLearnedMemory: vi.fn(() => ({ itemId: "item-1" })),
        rebuildChatSessionLearnedMemory: vi.fn(async () => ({ rebuiltAt: "now", items: [], conflicts: [] })),
      } as never,
      maintenance: {
        getPolicy: vi.fn(() => ({ workspaceId: "default" })),
        patchPolicy: vi.fn(() => ({ workspaceId: "default" })),
        getStatus: vi.fn(() => ({ workspaceId: "default" })),
        listRuns: vi.fn(() => []),
        runNow: vi.fn(() => ({ runId: "run-1" })),
        getRunProvenance: vi.fn(() => ({ run: { runId: "run-1" }, sources: [], changes: [] })),
        listRecommendations: vi.fn(() => []),
        acceptRecommendation: vi.fn(() => ({
          recommendation: { recommendationId: "rec-1" },
          policy: { workspaceId: "default" },
        })),
        rejectRecommendation: vi.fn(() => ({ recommendationId: "rec-1" })),
        runDueEvaluation: vi.fn(async () => undefined),
        noteSuccessfulRootTurn: vi.fn(async () => undefined),
        parseWorkflowPayload: vi.fn(() => ({ workspaceId: "default" })),
        syncFromDurableRun: vi.fn(),
        executeDurableRun: vi.fn(async () => ({ ok: true })),
      } as never,
      admin: {
        gatewaySql: {
          prepare: vi.fn(() => ({
            get: vi.fn(),
            all: vi.fn(() => []),
            run: vi.fn(),
          })),
        },
        tryParseJson: vi.fn((raw, fallback) => {
          try {
            return raw ? JSON.parse(raw) : fallback;
          } catch {
            return fallback;
          }
        }),
        requireFeatureEnabled: vi.fn(),
        publishRealtime: vi.fn(),
      },
      readTranscriptOrEmpty: vi.fn(async () => []),
    });

    await expect(service.composeContext({ scope: "chat", prompt: "hello" })).resolves.toMatchObject({
      contextId: "ctx-1",
    });
    await expect(service.prewarmContext({ scope: "chat", prompt: "hello again" })).resolves.toBeUndefined();
    expect(service.listSessionLearnedMemory("session-1")).toEqual({ items: [], conflicts: [] });
    await expect(service.rebuildSessionLearnedMemory("session-1")).resolves.toMatchObject({ rebuiltAt: "now" });
    expect(service.getMaintenancePolicy("default")).toMatchObject({ workspaceId: "default" });
    await expect(service.executeMaintenanceDurableRun({ runId: "run-1" } as never)).resolves.toEqual({ ok: true });
  });

  it("owns memory item admin list, update, forget, and history flows", () => {
    const publishRealtime = vi.fn();
    const requireFeatureEnabled = vi.fn();
    const row: {
      item_id: string;
      namespace: string;
      title: string;
      content: string;
      metadata_json: string;
      pinned: number;
      ttl_override_seconds: number | null;
      expires_at: string | null;
      status: "active" | "forgotten";
      created_at: string;
      updated_at: string;
      forgotten_at: string | null;
    } = {
      item_id: "item-1",
      namespace: "workspace.default",
      title: "Original title",
      content: "Original content",
      metadata_json: JSON.stringify({ source: "test" }),
      pinned: 0,
      ttl_override_seconds: null,
      expires_at: null,
      status: "active",
      created_at: "2026-04-10T00:00:00.000Z",
      updated_at: "2026-04-10T00:00:00.000Z",
      forgotten_at: null,
    };
    const historyRows: Array<{
      change_id: string;
      item_id: string;
      change_type: string;
      actor_id: string | null;
      payload_json: string;
      created_at: string;
    }> = [];
    const gatewaySql = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("FROM memory_items") && sql.includes("WHERE item_id = ?")) {
          return {
            get: vi.fn(() => ({ ...row })),
            all: vi.fn(() => []),
            run: vi.fn(),
          };
        }
        if (sql.includes("FROM memory_items") && sql.includes("WHERE 1 = 1")) {
          return {
            get: vi.fn(),
            all: vi.fn(() => [{ ...row }]),
            run: vi.fn(),
          };
        }
        if (sql.includes("UPDATE memory_items")) {
          return {
            get: vi.fn(),
            all: vi.fn(() => []),
            run: vi.fn((params: Record<string, unknown>) => {
              if (params.title !== undefined) {
                row.title = String(params.title);
                row.content = String(params.content);
                row.metadata_json = String(params.metadataJson);
                row.pinned = Number(params.pinned ?? 0);
                row.ttl_override_seconds = (params.ttlOverrideSeconds as number | null | undefined) ?? null;
              }
              if (params.forgottenAt !== undefined) {
                row.status = "forgotten";
                row.forgotten_at = String(params.forgottenAt);
              }
              row.updated_at = String(params.updatedAt ?? row.updated_at);
            }),
          };
        }
        if (sql.includes("INSERT INTO memory_change_history")) {
          return {
            get: vi.fn(),
            all: vi.fn(() => []),
            run: vi.fn((params: Record<string, unknown>) => {
              historyRows.unshift({
                change_id: String(params.changeId),
                item_id: String(params.itemId),
                change_type: String(params.changeType),
                actor_id: params.actorId ? String(params.actorId) : null,
                payload_json: String(params.payloadJson ?? "{}"),
                created_at: String(params.createdAt),
              });
            }),
          };
        }
        if (sql.includes("FROM memory_change_history")) {
          return {
            get: vi.fn(),
            all: vi.fn(() => [...historyRows]),
            run: vi.fn(),
          };
        }
        throw new Error(`Unexpected SQL in test harness: ${sql}`);
      }),
    };
    const service = new MemoryLifecycleService({
      context: {} as never,
      learned: {} as never,
      maintenance: {} as never,
      admin: {
        gatewaySql,
        tryParseJson: (raw, fallback) => {
          try {
            return raw ? JSON.parse(raw) : fallback;
          } catch {
            return fallback;
          }
        },
        requireFeatureEnabled,
        publishRealtime,
      },
      readTranscriptOrEmpty: vi.fn(async () => []),
    });

    expect(service.listMemoryItems()).toHaveLength(1);
    const updated = service.patchMemoryItem("item-1", { title: "Updated title", pinned: true }, "operator-1");
    expect(updated).toMatchObject({
      itemId: "item-1",
      title: "Updated title",
      pinned: true,
    });

    const forgotten = service.forgetMemoryItem("item-1", "operator-1");
    expect(forgotten).toMatchObject({
      itemId: "item-1",
      status: "forgotten",
    });

    const history = service.listMemoryItemHistory("item-1");
    expect(history.map((item) => item.changeType)).toEqual(
      expect.arrayContaining(["pin_changed", "updated", "forgotten"]),
    );
    expect(requireFeatureEnabled).toHaveBeenCalledWith("memoryLifecycleAdminV1Enabled");
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "memory",
      expect.objectContaining({ type: "memory_item_updated", itemId: "item-1" }),
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "memory",
      expect.objectContaining({ type: "memory_item_forgotten", itemId: "item-1" }),
    );
  });

  it("owns operator-facing memory file listing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gc-memory-lifecycle-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.writeFile(path.join(memoryDir, "older.md"), "old", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(path.join(memoryDir, "newer.md"), "new content", "utf8");

    const service = new MemoryLifecycleService({
      context: {} as never,
      learned: {} as never,
      maintenance: {} as never,
      admin: {
        gatewaySql: {} as never,
        tryParseJson: vi.fn(),
        requireFeatureEnabled: vi.fn(),
        publishRealtime: vi.fn(),
      },
      files: {
        rootDir: tempRoot,
        workspaceDir: "workspace",
        writeJailRoots: [workspaceDir],
        normalizeRelativePath: (relativePath) => relativePath,
      },
      readTranscriptOrEmpty: vi.fn(async () => []),
    });

    try {
      const items = await service.listMemoryFiles();
      expect(items.map((item) => item.relativePath)).toEqual(["memory/newer.md", "memory/older.md"]);
      expect(items[0]?.size).toBe(Buffer.byteLength("new content"));
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
