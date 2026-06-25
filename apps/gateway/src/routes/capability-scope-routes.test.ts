import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { capabilityScopeRoutes } from "./capability-scope-routes.js";
import type { CapabilityScopeView } from "@goatcitadel/contracts";

const MOCK_VIEW: CapabilityScopeView = {
  scopeKind: "citadel",
  scopeId: "personal",
  resourceType: "skill",
  mode: "inherit",
  items: [{ resourceRef: "skill-a", label: "Skill A", enabled: true, available: true, inherited: true }],
  effectiveRefs: ["skill-a"],
};

function buildApp(
  capabilityScope: Record<string, unknown>,
  requireOperatorAuth = vi.fn(async () => undefined),
) {
  const app = Fastify();
  app.decorate("services", { capabilityScope } as never);
  app.decorate("requireOperatorAuth", requireOperatorAuth as never);
  return { app, requireOperatorAuth };
}

describe("capability-scope routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) return;
    await app.close();
    app = null;
  });

  describe("citadel endpoints", () => {
    it("GET /api/v1/citadels/:citadelId/capabilities returns the view", async () => {
      const getView = vi.fn(() => MOCK_VIEW);
      const built = buildApp({ getView });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/citadels/personal/capabilities?type=skill",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(MOCK_VIEW);
      expect(getView).toHaveBeenCalledWith("citadel", "personal", "skill");
    });

    it("GET returns 400 when type query param is invalid", async () => {
      const getView = vi.fn(() => MOCK_VIEW);
      const built = buildApp({ getView });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/citadels/personal/capabilities?type=invalid_type",
      });

      expect(response.statusCode).toBe(400);
    });

    it("GET returns 400 when type query param is missing", async () => {
      const getView = vi.fn(() => MOCK_VIEW);
      const built = buildApp({ getView });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/citadels/personal/capabilities",
      });

      expect(response.statusCode).toBe(400);
    });

    it("PATCH /api/v1/citadels/:citadelId/capabilities calls updateScope", async () => {
      const updatedView: CapabilityScopeView = { ...MOCK_VIEW, mode: "curated", effectiveRefs: ["skill-a"] };
      const updateScope = vi.fn(() => updatedView);
      const built = buildApp({ updateScope });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/citadels/personal/capabilities",
        payload: {
          resourceType: "skill",
          assignments: [{ resourceRef: "skill-a", enabled: true }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(updateScope).toHaveBeenCalledWith("citadel", "personal", {
        resourceType: "skill",
        assignments: [{ resourceRef: "skill-a", enabled: true }],
      });
    });

    it("DELETE /api/v1/citadels/:citadelId/capabilities calls resetScope", async () => {
      const resetScope = vi.fn(() => MOCK_VIEW);
      const built = buildApp({ resetScope });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/citadels/personal/capabilities?type=skill",
      });

      expect(response.statusCode).toBe(200);
      expect(resetScope).toHaveBeenCalledWith("citadel", "personal", "skill");
    });
  });

  describe("workspace endpoints", () => {
    it("GET /api/v1/workspaces/:workspaceId/capabilities returns the view", async () => {
      const wsView: CapabilityScopeView = { ...MOCK_VIEW, scopeKind: "workspace", scopeId: "default" };
      const getView = vi.fn(() => wsView);
      const built = buildApp({ getView });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "GET",
        url: "/api/v1/workspaces/default/capabilities?type=mcp_server",
      });

      expect(response.statusCode).toBe(200);
      expect(getView).toHaveBeenCalledWith("workspace", "default", "mcp_server");
    });

    it("PATCH /api/v1/workspaces/:workspaceId/capabilities calls updateScope", async () => {
      const wsView: CapabilityScopeView = { ...MOCK_VIEW, scopeKind: "workspace", scopeId: "default" };
      const updateScope = vi.fn(() => wsView);
      const built = buildApp({ updateScope });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/workspaces/default/capabilities",
        payload: {
          resourceType: "integration",
          assignments: [{ resourceRef: "conn-1", enabled: false }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(updateScope).toHaveBeenCalledWith("workspace", "default", {
        resourceType: "integration",
        assignments: [{ resourceRef: "conn-1", enabled: false }],
      });
    });

    it("DELETE /api/v1/workspaces/:workspaceId/capabilities calls resetScope", async () => {
      const wsView: CapabilityScopeView = { ...MOCK_VIEW, scopeKind: "workspace", scopeId: "default" };
      const resetScope = vi.fn(() => wsView);
      const built = buildApp({ resetScope });
      app = built.app;
      await app.register(capabilityScopeRoutes);

      const response = await app.inject({
        method: "DELETE",
        url: "/api/v1/workspaces/default/capabilities?type=integration",
      });

      expect(response.statusCode).toBe(200);
      expect(resetScope).toHaveBeenCalledWith("workspace", "default", "integration");
    });
  });
});
