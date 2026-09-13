import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { Storage, createLocalAsyncStorage } from "@goatcitadel/storage";
import { memoryRoutes } from "../routes/memory.js";
import { MemoryMaintenanceService } from "./memory-maintenance-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { MemoryRouteService } from "./memory-route-service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function createHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-policy-route-"));
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
  const asyncStorage = createLocalAsyncStorage(storage);
  const maintenance = new MemoryMaintenanceService({ storage: asyncStorage, config: {} as never, llmService: {} as never,
    publishRealtime: vi.fn(), requireFeatureEnabled: vi.fn(), isFeatureEnabled: async () => true,
    normalizeWorkspaceId: (workspaceId) => workspaceId?.trim() || "default",
  }, { createDurableRun: vi.fn(), getDurableRun: vi.fn() });
  const owner = new MemoryLifecycleService({ maintenance, admin: {} as never, context: {} as never, learned: {} as never,
    resolveLearnedMemoryPolicy: async () => ({ allowWrite: false }), readTranscriptOrEmpty: async () => [],
  });
  const app = Fastify();
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "none" } } } as never);
  app.decorate("requireOperatorAuth", async (request, reply) => {
    if (request.headers.authorization !== "Bearer policy-test-operator") return reply.code(401).send({ error: "Unauthorized" });
  });
  const commits = vi.fn(async () => undefined);
  app.addHook("onRequest", async (request) => { request.mutationIdempotencyCommit = commits; });
  app.decorate("services", { memory: new MemoryRouteService(owner) } as never);
  cleanups.push(async () => {
    await app.close(); await asyncStorage.close();
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("gc-policy-route-")) throw new Error("Unexpected policy fixture cleanup path");
    fs.rmSync(root, { recursive: true, force: true });
  });
  await app.register(memoryRoutes);
  const headers = { authorization: "Bearer policy-test-operator" };
  const get = async (workspaceId = "workspace-a") => (await app.inject({ method: "GET", url: `/api/v1/memory/maintenance/policy?workspaceId=${workspaceId}`, headers })).json();
  return { app, storage, headers, get, commits };
}

it("binds the real policy revision across HTTP, route facade, lifecycle, maintenance service, and storage", async () => {
  const { app, storage, headers, get, commits } = await createHarness();
  const base = await get();
  const untouched = await get("default");
  const saves = await Promise.all([11, 13].map((minChangedSessions) => app.inject({ method: "PATCH",
    url: "/api/v1/memory/maintenance/policy?workspaceId=workspace-a", headers,
    payload: { expectedRevision: base.revision, minChangedSessions },
  })));
  expect(saves.map((result) => result.statusCode).sort()).toEqual([200, 409]);
  const winner = saves.find((result) => result.statusCode === 200)!.json();
  expect(saves.find((result) => result.statusCode === 409)!.json().details.reason).toBe("MEMORY_POLICY_REVISION_CONFLICT");
  expect(await get()).toEqual(winner);
  expect(await get("default")).toEqual(untouched);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(storage.memoryMaintenance.requirePolicy("workspace-a").revision).toBe(winner.revision);
  const unauthorized = await app.inject({ method: "PATCH", url: "/api/v1/memory/maintenance/policy?workspaceId=workspace-a",
    payload: { expectedRevision: winner.revision, enabled: true } });
  expect(unauthorized.statusCode).toBe(401);
  expect(await get()).toEqual(winner);
});

it("requires both reviewed revisions to apply a recommendation and never rewrites an applied decision", async () => {
  const { app, storage, headers, get, commits } = await createHarness();
  const base = await get();
  const recommendation = storage.memoryMaintenance.createRecommendation({ workspaceId: "workspace-a", kind: "threshold_adjustment",
    status: "queued", summary: "Use a higher threshold", proposedPatch: { minChangedSessions: 9 }, createdAt: base.createdAt, updatedAt: base.updatedAt });
  const url = `/api/v1/memory/maintenance/recommendations/${recommendation.recommendationId}`;
  const withoutPolicy = await app.inject({ method: "POST", url: `${url}/accept`, headers, payload: { expectedRevision: recommendation.revision } });
  expect(withoutPolicy.statusCode).toBe(400);
  const mismatch = await app.inject({ method: "POST", url: `${url}/accept`, headers,
    payload: { expectedRevision: recommendation.revision, expectedPolicyRevision: "0".repeat(64) } });
  expect(mismatch.statusCode).toBe(409);
  expect(await get()).toEqual(base);
  expect(commits).not.toHaveBeenCalled();
  const accepted = await app.inject({ method: "POST", url: `${url}/accept`, headers,
    payload: { expectedRevision: recommendation.revision, expectedPolicyRevision: base.revision } });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().policy.minChangedSessions).toBe(9);
  expect(accepted.json().recommendation.status).toBe("applied");
  const rejected = await app.inject({ method: "POST", url: `${url}/reject`, headers, payload: { expectedRevision: accepted.json().recommendation.revision } });
  expect(rejected.statusCode).toBe(409);
  expect(storage.memoryMaintenance.getRecommendation(recommendation.recommendationId).status).toBe("applied");
  expect(commits).toHaveBeenCalledTimes(1);
});
