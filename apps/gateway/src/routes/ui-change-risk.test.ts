import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { uiChangeRiskRoutes } from "./ui-change-risk.js";

describe("ui change risk routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  async function createApp(): Promise<FastifyInstance> {
    const next = Fastify();
    await next.register(uiChangeRiskRoutes);
    return next;
  }

  it("rejects invalid payloads without changing the response contract", async () => {
    app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ui/change-risk/evaluate",
      payload: {
        pageId: "",
        changes: [{ field: "", from: "a", to: "b" }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toHaveProperty("error");
  });

  it("classifies critical, warning, and safe changes with per-field reason codes", async () => {
    app = await createApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/ui/change-risk/evaluate",
      payload: {
        pageId: "files",
        changes: [
          { field: "displayName", from: "same", to: "same" },
          { field: "toolProfile", from: "safe", to: "danger" },
          { field: "networkAllowlist", from: "api.example.com", to: " " },
          { field: "providerBaseUrl", from: "https://api.example.com", to: "notaurl" },
          { field: "secondaryBaseUrl", from: "https://api.example.com", to: "ftp://api.example.com" },
          { field: "localBaseUrl", from: "https://api.example.com", to: "http://localhost:11434/v1" },
          { field: "authMode", from: "none", to: "token" },
          { field: "auth.password", from: "old", to: "new" },
          { field: "integration.slack.config", from: {}, to: { endpoint: "http://slack.example.com/hook" } },
          { field: "integration.email.config", from: {}, to: { apiToken: "inline-token" } },
          { field: "paths.exportPath", from: "artifacts/a.md", to: "../escape.md" },
          { field: "paths.outputPath", from: "artifacts/a.md", to: "custom/a.md" },
          { field: "budgetMode", from: "balanced", to: "saver" },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pageId: "files",
      overall: "critical",
      items: [
        { field: "displayName", level: "safe", reasonCodes: ["no_change"] },
        { field: "toolProfile", level: "critical", reasonCodes: ["danger_profile"] },
        { field: "networkAllowlist", level: "warning", reasonCodes: ["allowlist_empty"] },
        { field: "providerBaseUrl", level: "critical", reasonCodes: ["invalid_url"] },
        { field: "secondaryBaseUrl", level: "critical", reasonCodes: ["invalid_protocol"] },
        { field: "localBaseUrl", level: "warning", reasonCodes: ["local_provider"] },
        { field: "authMode", level: "warning", reasonCodes: ["auth_mode_changed"] },
        { field: "auth.password", level: "critical", reasonCodes: ["auth_secret_change"] },
        { field: "integration.slack.config", level: "critical", reasonCodes: ["integration_plain_http"] },
        { field: "integration.email.config", level: "warning", reasonCodes: ["integration_secret_inline"] },
        { field: "paths.exportPath", level: "critical", reasonCodes: ["path_traversal_pattern"] },
        { field: "paths.outputPath", level: "warning", reasonCodes: ["nonstandard_path"] },
        { field: "budgetMode", level: "safe", reasonCodes: ["changed"] },
      ],
    });
  });

  it("derives warning and safe overall levels when no critical item is present", async () => {
    app = await createApp();

    const warningResponse = await app.inject({
      method: "POST",
      url: "/api/v1/ui/change-risk/evaluate",
      payload: {
        pageId: "settings",
        changes: [{ field: "providerBaseUrl", from: "https://api.example.com", to: "http://127.0.0.1:1234" }],
      },
    });
    const safeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/ui/change-risk/evaluate",
      payload: {
        pageId: "settings",
        changes: [
          { field: "providerBaseUrl", from: "https://old.example.com", to: "https://api.example.com" },
          { field: "retries", from: 1, to: 2 },
          { field: "enabled", from: false, to: true },
          { field: "metadata", from: null, to: { owner: "operator" } },
        ],
      },
    });

    expect(warningResponse.statusCode).toBe(200);
    expect(warningResponse.json()).toMatchObject({ overall: "warning" });
    expect(safeResponse.statusCode).toBe(200);
    expect(safeResponse.json()).toMatchObject({
      overall: "safe",
      items: [
        { field: "providerBaseUrl", reasonCodes: ["changed"] },
        { field: "retries", reasonCodes: ["changed"] },
        { field: "enabled", reasonCodes: ["changed"] },
        { field: "metadata", reasonCodes: ["changed"] },
      ],
    });
  });
});
