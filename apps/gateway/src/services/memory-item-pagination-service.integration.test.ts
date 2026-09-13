import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PolicyViolationError, type MemoryItemListPage } from "@goatcitadel/contracts";
import { Storage, createLocalAsyncStorage } from "@goatcitadel/storage";
import { memoryRoutes } from "../routes/memory.js";
import { MemoryLifecycleService, type MemoryLifecycleDependencies } from "./memory-lifecycle-service.js";
import { MemoryRouteService } from "./memory-route-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createHarness(count = 503) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-memory-pages-"));
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  const asyncStorage = createLocalAsyncStorage(storage);
  const enabled = vi.fn(async (_flag: string) => undefined);
  const deps: MemoryLifecycleDependencies = {
    context: {} as never,
    learned: {} as never,
    maintenance: {} as never,
    admin: {
      gatewaySql: asyncStorage.gatewaySql,
      memoryQualityIssues: asyncStorage.memoryQualityIssues,
      memoryItemEnumeration: asyncStorage.memoryItemEnumeration,
      requireFeatureEnabled: enabled,
      publishRealtime: vi.fn(async () => undefined),
      tryParseJson: <T>(raw: string | null | undefined, fallback: T): T => {
        try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
      },
    },
    resolveLearnedMemoryPolicy: async () => ({ allowWrite: false }),
    readTranscriptOrEmpty: async () => [],
  };
  const owner = new MemoryLifecycleService(deps);
  const app = Fastify();
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "none" } } } as never);
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer test-operator") return reply.code(401).send({ error: "Unauthorized" });
  });
  app.decorate("services", { memory: new MemoryRouteService(owner) } as never);
  cleanups.push(async () => {
    await app.close();
    await asyncStorage.close();
    const tempPrefix = path.resolve(os.tmpdir()) + path.sep;
    if (!path.resolve(root).startsWith(tempPrefix) || !path.basename(root).startsWith("gc-memory-pages-")) {
      throw new Error("Refusing cleanup outside the allocated memory fixture directory");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.register(memoryRoutes);
  const insert = storage.db.prepare(`INSERT INTO memory_items
    (item_id, namespace, title, content, metadata_json, pinned, status, created_at, updated_at, workspace_id)
    VALUES (@id, 'review', @id, 'needle content', @metadata, 0, @status,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', @workspace)`);
  storage.db.transaction("immediate", () => {
    for (let index = 0; index < count; index += 1) {
      insert.run({ id: `item-${String(index).padStart(4, "0")}`, workspace: "workspace-a", metadata: "{}", status: "active" });
    }
    insert.run({ id: "global", workspace: null, metadata: "{}", status: "active" });
    insert.run({ id: "legacy-a", workspace: null, metadata: '{"workspaceId":" workspace-a "}', status: "active" });
    insert.run({ id: "foreign", workspace: "workspace-b", metadata: '{"workspaceId":"workspace-a"}', status: "active" });
    insert.run({ id: "forgotten", workspace: "workspace-a", metadata: "{}", status: "forgotten" });
  });
  const get = (input: Record<string, string> = {}, authorized = true) => app.inject({
    method: "GET",
    url: `/api/v1/memory/items?${new URLSearchParams({ workspaceId: "workspace-a", namespace: "review", query: "needle", limit: "500", ...input })}`,
    headers: authorized ? { authorization: "Bearer test-operator" } : {},
  });
  return { get, owner, deps, storage, enabled };
}

describe("Memory lifecycle enumeration through the operator HTTP route", () => {
  it("enumerates a filtered library beyond 500 with stable totals, scope and no omissions", async () => {
    const harness = await createHarness(1_209);
    let response = await harness.get();
    const items: MemoryItemListPage["items"] = [];
    const snapshots = new Set<string>();
    let pages = 0;
    while (true) {
      expect(response.statusCode).toBe(200);
      const page = response.json<MemoryItemListPage>();
      expect(page.total).toBe(1_211);
      expect(page.items.length).toBeLessThanOrEqual(500);
      snapshots.add(page.snapshotAt);
      items.push(...page.items);
      pages += 1;
      if (!page.nextCursor) break;
      expect(pages).toBeLessThan(4);
      const token = JSON.parse(Buffer.from(page.nextCursor.split(".")[0]!, "base64url").toString("utf8"));
      expect(JSON.stringify(token)).not.toContain("needle");
      expect(JSON.stringify(token)).not.toContain("content");
      response = await harness.get({ cursor: page.nextCursor });
    }
    expect(pages).toBe(3);
    expect(snapshots.size).toBe(1);
    expect(items).toHaveLength(1_211);
    expect(new Set(items.map(item => item.itemId)).size).toBe(1_211);
    expect(items.every(item => item.status === "active" && item.workspaceId !== "workspace-b")).toBe(true);
    expect(items.find(item => item.itemId === "legacy-a")?.metadata.workspaceId).toBe(" workspace-a ");
    expect(items.find(item => item.itemId === "item-0000")?.workspaceId).toBe("workspace-a");
    expect(harness.enabled).toHaveBeenCalledWith("memoryLifecycleAdminV1Enabled");
    expect((await harness.get({ query: "absent" })).json()).toMatchObject({ items: [], total: 0 });
    expect((await harness.get({ status: "forgotten" })).json()).toMatchObject({ total: 1, items: [{ itemId: "forgotten" }] });
  });

  it("rejects scope/filter changes while allowing equivalent filters and a different page size", async () => {
    const harness = await createHarness();
    const { nextCursor: cursor } = (await harness.get()).json<MemoryItemListPage>();
    expect(cursor).toBeTruthy();
    for (const change of [{ workspaceId: "workspace-b" }, { namespace: "elsewhere" }, { query: "other" }, { status: "all" }]) {
      const response = await harness.get({ cursor: cursor!, ...change });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: "STATE_CONFLICT", details: { reason: "MEMORY_CURSOR_SCOPE_MISMATCH" } });
      expect(response.json().items).toBeUndefined();
    }
    const equivalent = await harness.get({ cursor: cursor!, query: " NEEDLE ", namespace: " review ", limit: "2" });
    expect(equivalent.statusCode).toBe(200);
    expect(equivalent.json().items).toHaveLength(2);
  });

  it("rejects malformed, modified and pre-restart cursors without returning memory content", async () => {
    const harness = await createHarness();
    const { nextCursor: cursor } = (await harness.get()).json<MemoryItemListPage>();
    const [body, signature] = cursor!.split(".");
    const forgedBody = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    forgedBody.continuation.after.itemId = "forged";
    const forged = `${Buffer.from(JSON.stringify(forgedBody)).toString("base64url")}.${signature}`;
    for (const invalid of ["", "not-a-cursor", "a.b.c", "a".repeat(2_049), forged]) {
      const response = await harness.get({ cursor: invalid });
      expect(response.statusCode).toBe(400);
      expect(response.json().items).toBeUndefined();
    }
    await expect(new MemoryLifecycleService(harness.deps).listMemoryItemsPage({
      workspaceId: "workspace-a", namespace: "review", query: "needle", cursor,
    })).rejects.toMatchObject({ httpStatus: 400, details: { field: "cursor" } });
  });

  it("maps canonical mutation invalidation to a reloadable conflict and requires operator authentication", async () => {
    const harness = await createHarness();
    const { nextCursor: cursor } = (await harness.get()).json<MemoryItemListPage>();
    harness.storage.db.prepare("UPDATE memory_items SET content = 'changed needle content' WHERE item_id = 'item-0001'").run();
    const stale = await harness.get({ cursor: cursor! });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "STATE_CONFLICT", details: { reason: "MEMORY_CURSOR_STALE" } });
    expect((await harness.get()).statusCode).toBe(200);
    harness.enabled.mockClear();
    expect((await harness.get({ cursor: cursor! }, false)).statusCode).toBe(401);
    expect(harness.enabled).not.toHaveBeenCalled();
  });

  it("fails closed when the feature is disabled or its repository owner is absent", async () => {
    const harness = await createHarness(0);
    harness.enabled.mockRejectedValueOnce(new PolicyViolationError({ message: "Memory administration is disabled" }));
    expect((await harness.get()).statusCode).toBe(403);
    const missing = new MemoryLifecycleService({ ...harness.deps, admin: { ...harness.deps.admin, memoryItemEnumeration: undefined } });
    await expect(missing.listMemoryItemsPage()).rejects.toMatchObject({ httpStatus: 503 });
    for (const limit of ["0", "501", "1.5", "NaN"]) expect((await harness.get({ limit })).statusCode).toBe(400);
  });
});
