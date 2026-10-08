import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { ValidationError, type McpServerConnectionReview } from "@goatcitadel/contracts";
import { authPlugin } from "../plugins/auth.js";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { installRouteAccessTracking } from "./route-access.js";
import { mcpRoutes } from "./mcp.js";
import { McpRouteService } from "../services/mcp-route-service.js";

let storage: AsyncStorage,
  root: string | undefined,
  serial = 0;
const apps: FastifyInstance[] = [];
const review = { expectedRevision: "a".repeat(64), expectedConnectionRevision: "b".repeat(64) };
const state = "11111111-1111-4111-8111-111111111111";
const server = {
  serverId: "fixture",
  status: "disconnected",
  revision: "c".repeat(64),
  args: ["--password", "synthetic-private-value"],
};
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "gc-oauth-route-test-"));
  storage = createSqliteAsyncStorage(
    new Storage({
      dbPath: ":memory:",
      transcriptsDir: path.join(root, "transcripts"),
      auditDir: path.join(root, "audit"),
    }),
  );
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
afterAll(async () => {
  await storage.close();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const port = {
    elicitations: {},
    startMcpOAuth: vi.fn(async (_id: string, reviewed?: McpServerConnectionReview, committed?: () => Promise<void>) => {
      await committed?.();
      return {
        authorizeUrl: `https://example.invalid/authorize?state=${state}`,
        state,
        ...(reviewed ? { review: { version: 1, reviewed, server } } : {}),
      };
    }),
    completeMcpOAuth: vi.fn(
      async (
        _id: string,
        _code: string,
        _state?: string,
        _reviewed?: McpServerConnectionReview,
        committed?: () => Promise<void>,
      ) => {
        await committed?.();
        return server;
      },
    ),
  };
  const app = Fastify();
  apps.push(app);
  app.decorate("gatewayConfig", {
    assistant: {
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        token: { value: "synthetic-operator", queryParam: "access_token" },
        basic: { username: "", password: "" },
      },
    },
  } as never);
  app.decorate("gatewayAuth", {
    getOnboardingStartupState: () => ({ completed: true }),
    validateDeviceAccessToken: () => undefined,
    validateCompanionAccessToken: () => undefined,
  } as never);
  app.decorate("services", { mcp: new McpRouteService(port as never) } as never);
  installRouteAccessTracking(app);
  await app.register(authPlugin);
  await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
  await app.register(mcpRoutes);
  const headers = () => ({ authorization: "Bearer synthetic-operator", "Idempotency-Key": `oauth-route-${++serial}` });
  return { app, port, headers, url: "/api/v1/mcp/servers/fixture/oauth" };
}
it.each(["start", "complete"] as const)(
  "guards reviewed %s authentication and exact bounded input before owner admission",
  async (action) => {
    const f = await fixture();
    const url = `${f.url}/${action}-reviewed`;
    const valid = action === "start" ? review : { ...review, code: "synthetic-code", state };
    expect((await f.app.inject({ method: "POST", url, payload: valid })).statusCode).toBe(401);
    for (const payload of [
      {},
      { ...valid, extra: "synthetic-code" },
      { ...valid, expectedRevision: "bad" },
      ...(action === "complete"
        ? [
            { ...valid, code: "x".repeat(8193) },
            { ...valid, state: "bad" },
          ]
        : []),
    ]) {
      const response = await f.app.inject({ method: "POST", url, payload, headers: f.headers() });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("synthetic-code");
    }
    expect(f.port.startMcpOAuth).not.toHaveBeenCalled();
    expect(f.port.completeMcpOAuth).not.toHaveBeenCalled();
  },
);
it.each(["start", "complete"] as const)(
  "returns a projected exact %s receipt and retains committed retry",
  async (action) => {
    const f = await fixture();
    const payload = action === "start" ? review : { ...review, code: "synthetic-code", state },
      headers = f.headers();
    const response = await f.app.inject({ method: "POST", url: `${f.url}/${action}-reviewed`, payload, headers });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("synthetic-private-value");
    expect(response.body).not.toContain("synthetic-code");
    const receipt = response.json();
    expect(action === "start" ? receipt.review.reviewed : receipt.reviewed).toEqual(review);
    expect(receipt.state).toBe(state);
    expect(
      (
        await f.app.inject({
          method: "POST",
          url: `${f.url}/${action}-reviewed`,
          payload: { ...payload, code: "other-code" },
          headers,
        })
      ).statusCode,
    ).toBe(409);
    expect(action === "start" ? f.port.startMcpOAuth : f.port.completeMcpOAuth).toHaveBeenCalledOnce();
  },
);
it.each(["start", "complete"] as const)(
  "preserves actual typed postcommit %s uncertainty and prevents retry",
  async (action) => {
    const f = await fixture();
    if (action === "start")
      f.port.startMcpOAuth.mockImplementation(async (_id, _review, committed) => {
        await committed?.();
        throw new ValidationError({ message: "synthetic-code private follow-up" });
      });
    else
      f.port.completeMcpOAuth.mockImplementation(async (_id, _code, _state, _review, committed) => {
        await committed?.();
        throw new ValidationError({ message: "synthetic-code private follow-up" });
      });
    const headers = f.headers(),
      payload = action === "start" ? review : { ...review, code: "synthetic-code", state };
    const response = await f.app.inject({ method: "POST", url: `${f.url}/${action}-reviewed`, payload, headers });
    expect(response.statusCode).toBe(500);
    expect(response.json().mutationCommitted).toBe(true);
    expect(response.body).not.toContain("synthetic-code");
    expect(
      (await f.app.inject({ method: "POST", url: `${f.url}/${action}-reviewed`, payload, headers })).statusCode,
    ).toBe(409);
  },
);
it("keeps legacy routes and argument counts separate from reviewed admission", async () => {
  const f = await fixture();
  expect(
    (await f.app.inject({ method: "POST", url: `${f.url}/start`, payload: {}, headers: f.headers() })).statusCode,
  ).toBe(200);
  expect(f.port.startMcpOAuth).toHaveBeenCalledExactlyOnceWith("fixture");
  expect(
    (
      await f.app.inject({
        method: "POST",
        url: `${f.url}/complete`,
        payload: { code: "synthetic-code", state },
        headers: f.headers(),
      })
    ).statusCode,
  ).toBe(200);
  expect(f.port.completeMcpOAuth).toHaveBeenCalledExactlyOnceWith("fixture", "synthetic-code", state);
});
