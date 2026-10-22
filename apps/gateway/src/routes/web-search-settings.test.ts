import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { webSearchSettingsRoutes } from "./web-search-settings.js";

const status = { targetId: "search.firecrawl", label: "Firecrawl", activeSource: "keychain" };

describe("web-search settings routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    app = null;
  });

  async function build(services: Record<string, unknown>) {
    app = Fastify();
    app.decorateRequest("idempotencyKey", "");
    app.decorate("services", services as never);
    await app.register(webSearchSettingsRoutes);
    return app;
  }

  it("lists secret-free key status with no-store caching", async () => {
    const listStatuses = vi.fn(() => [status]);
    const server = await build({ webSearchCredentials: { listStatuses } });

    const response = await server.inject({ method: "GET", url: "/api/v1/settings/web/credentials" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [status] });
    expect(response.headers["cache-control"]).toBe("no-store");
  });

  it("rejects unknown targets and malformed bodies before touching the owner", async () => {
    const store = vi.fn();
    const server = await build({ webSearchCredentials: { store } });

    const unknown = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/web/credentials/search.tavily",
      payload: { apiKey: "k", expectedRevision: 1 },
    });
    const extra = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/web/credentials/search.firecrawl",
      payload: { apiKey: "k", expectedRevision: 1, storage: "env" },
    });

    expect(unknown.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(store).not.toHaveBeenCalled();
  });

  it("stores directly when the Evolution Control Plane is off and never echoes the key", async () => {
    const store = vi.fn(async () => status);
    const server = await build({
      webSearchCredentials: { store },
      evolution: { isEnabled: vi.fn(async () => false) },
    });

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/web/credentials/search.firecrawl",
      payload: { apiKey: "fc-secret-value", expectedRevision: 4 },
    });

    expect(response.statusCode).toBe(200);
    expect(store).toHaveBeenCalledWith("search.firecrawl", "fc-secret-value");
    expect(response.body).not.toContain("fc-secret-value");
  });

  it("creates, fills, and confirms a governed plan when the Control Plane is on", async () => {
    const create = vi.fn(async () => ({
      planId: "plan-1",
      revision: 1,
      requiredAction: { kind: "secure_input", actionId: "a-1", actionNonce: "n-1" },
    }));
    const submitWebSearchCredential = vi.fn(async () => ({
      planId: "plan-1",
      revision: 2,
      requiredAction: { kind: "confirmation", actionNonce: "n-2" },
    }));
    const confirm = vi.fn(async () => ({
      planId: "plan-1",
      revision: 3,
      status: "completed",
      risk: "caution",
      summary: "Save the Firecrawl API key",
      result: { summary: "The Firecrawl API key is stored in the OS keychain." },
    }));
    const server = await build({
      webSearchCredentials: { status: vi.fn(() => ({ ...status, keychainAvailable: true })) },
      evolution: { isEnabled: vi.fn(async () => true), create, confirm },
      evolutionRuntimeConfiguration: { submitWebSearchCredential },
    });

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/web/credentials/search.firecrawl",
      payload: { apiKey: "fc-secret-value", expectedRevision: 4 },
    });

    expect(response.statusCode).toBe(200);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        request: {
          kind: "runtime_configuration",
          change: { operation: "web_search_credential", targetId: "search.firecrawl", action: "replace" },
        },
        expectedTargetRevision: 4,
      }),
    );
    expect(JSON.stringify(create.mock.calls)).not.toContain("fc-secret-value");
    expect(submitWebSearchCredential).toHaveBeenCalledWith(expect.objectContaining({ apiKey: "fc-secret-value" }));
    expect(confirm).toHaveBeenCalledWith(expect.anything(), "plan-1", 2, "n-2");
    expect(response.json()).toMatchObject({
      status: { targetId: "search.firecrawl" },
      changePlanReceipt: { status: "completed" },
    });
    expect(response.body).not.toContain("fc-secret-value");
  });

  it("refuses before creating a plan when the OS keychain is unavailable", async () => {
    const create = vi.fn();
    const server = await build({
      webSearchCredentials: { status: vi.fn(() => ({ ...status, keychainAvailable: false })) },
      evolution: { isEnabled: vi.fn(async () => true), create },
      evolutionRuntimeConfiguration: { submitWebSearchCredential: vi.fn() },
    });

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/web/credentials/search.firecrawl",
      payload: { apiKey: "fc-secret-value", expectedRevision: 4 },
    });

    expect(response.statusCode).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });

  it("cancels the plan when secure input fails, so the next save is not blocked", async () => {
    const cancel = vi.fn(async () => ({}));
    const server = await build({
      webSearchCredentials: { status: vi.fn(() => ({ ...status, keychainAvailable: true })) },
      evolution: {
        isEnabled: vi.fn(async () => true),
        create: vi.fn(async () => ({
          planId: "plan-9",
          revision: 1,
          requiredAction: { kind: "secure_input", actionId: "a-1", actionNonce: "n-1" },
        })),
        cancel,
      },
      evolutionRuntimeConfiguration: {
        submitWebSearchCredential: vi.fn(async () => {
          throw new Error("OS keychain backend is unavailable on this host");
        }),
      },
    });

    const response = await server.inject({
      method: "PUT",
      url: "/api/v1/settings/web/credentials/search.firecrawl",
      payload: { apiKey: "fc-secret-value", expectedRevision: 4 },
    });

    expect(response.statusCode).toBe(500);
    expect(cancel).toHaveBeenCalledWith(expect.anything(), "plan-9", 1);
    expect(response.body).not.toContain("fc-secret-value");
  });

  it("runs the Firecrawl check through the owner", async () => {
    const checkFirecrawl = vi.fn(async () => ({ status: "ok", baseUrl: "https://api.firecrawl.dev" }));
    const server = await build({ webSearchCredentials: { checkFirecrawl } });

    const response = await server.inject({ method: "POST", url: "/api/v1/settings/web/firecrawl/check", payload: {} });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });
});
