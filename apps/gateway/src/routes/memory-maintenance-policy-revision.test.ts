import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryRoutes } from "./memory.js";

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

async function createHarness() {
  app = Fastify();
  app.decorate("requireOperatorAuth", vi.fn(async () => undefined));
  app.decorate("gatewayConfig", { assistant: { auth: { mode: "none" } } } as never);
  const patchMaintenancePolicy = vi.fn(async () => ({ workspaceId: "workspace-a", revision: "b".repeat(64) }));
  app.decorate("services", { memory: { patchMaintenancePolicy } } as never);
  await app.register(memoryRoutes);
  return { app, patchMaintenancePolicy };
}

describe("memory maintenance policy revision boundary", () => {
  it("binds query workspace and the operator's expected revision to the owner call", async () => {
    const { app, patchMaintenancePolicy } = await createHarness();
    const response = await app.inject({ method: "PATCH", url: "/api/v1/memory/maintenance/policy?workspaceId=workspace-a",
      payload: { enabled: true, expectedRevision: "a".repeat(64) } });
    expect(response.statusCode).toBe(200);
    expect(patchMaintenancePolicy).toHaveBeenCalledWith("workspace-a", { enabled: true, expectedRevision: "a".repeat(64) });
  });

  it("rejects a save without a revision before invoking the owner", async () => {
    const { app, patchMaintenancePolicy } = await createHarness();
    const response = await app.inject({ method: "PATCH", url: "/api/v1/memory/maintenance/policy?workspaceId=workspace-a", payload: { enabled: true } });
    expect(response.statusCode).toBe(400);
    expect(patchMaintenancePolicy).not.toHaveBeenCalled();
  });

  it("rejects conflicting workspace declarations instead of choosing one", async () => {
    const { app, patchMaintenancePolicy } = await createHarness();
    const response = await app.inject({ method: "PATCH", url: "/api/v1/memory/maintenance/policy?workspaceId=workspace-a",
      payload: { workspaceId: "workspace-b", enabled: true, expectedRevision: "a".repeat(64) } });
    expect(response.statusCode).toBe(400);
    expect(patchMaintenancePolicy).not.toHaveBeenCalled();
  });
});
