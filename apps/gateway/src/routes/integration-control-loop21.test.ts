import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerIntegrationControlRoutes } from "./integrations-control-routes.js";
import { mediaRoutes } from "./media.js";
import { registerObsidianIntegrationRoutes } from "./integrations-obsidian-routes.js";
import { toolsRoutes } from "./tools.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const pairingId = "00000000-0000-4000-8000-000000000002";
const grantId = "00000000-0000-4000-8000-000000000003";

describe("Loop 21 route facade coverage", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("delegates integration control routes and maps validation, not-found, and conflict errors", async () => {
    const integrations = {
      listIntegrationCatalog: vi.fn((kind?: string) => [{ catalogId: "slack", kind: kind ?? "all" }]),
      getIntegrationFormSchema: vi.fn((catalogId: string) => {
        if (catalogId === "missing") {
          throw new Error("unknown catalog");
        }
        return { catalogId, fields: [] };
      }),
      listIntegrationConnections: vi.fn((kind?: string, limit?: number) => [{ connectionId, kind, limit }]),
      createIntegrationConnection: vi.fn((input) => ({ connectionId, ...input })),
      updateIntegrationConnection: vi.fn((id: string, input) => ({ connectionId: id, ...input })),
      deleteIntegrationConnection: vi.fn(() => true),
      invokeIntegrationConnectionAction: vi.fn(async (id: string, actionId: string, body) => ({
        connectionId: id,
        actionId,
        body,
      })),
      listDiscordPairings: vi.fn((id: string) => ({ items: [{ connectionId: id, pairingId }] })),
      approveDiscordPairing: vi.fn((id: string, nextPairingId: string) => ({
        connectionId: id,
        pairingId: nextPairingId,
        approved: true,
      })),
      revokeDiscordPairing: vi.fn((id: string, nextPairingId: string) => ({
        connectionId: id,
        pairingId: nextPairingId,
        revoked: true,
      })),
      reconnectDiscordRuntime: vi.fn(async (id: string) => ({ connectionId: id, status: "connected" })),
      listIntegrationPlugins: vi.fn(() => [{ pluginId: "plugin-1" }]),
      installIntegrationPlugin: vi.fn((input) => ({ pluginId: input.pluginId ?? "installed", ...input })),
      setIntegrationPluginEnabled: vi.fn((pluginId: string, enabled: boolean) => ({ pluginId, enabled })),
      runIntegrationConnectionDiagnostics: vi.fn(async (id: string) => ({ connectionId: id, ok: true })),
    };
    app = Fastify();
    app.decorate("services", { integrations } as never);
    registerIntegrationControlRoutes(app);

    await expect(
      app.inject({ method: "GET", url: "/api/v1/integrations/catalog?kind=channel" }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(integrations.listIntegrationCatalog).toHaveBeenCalledWith("channel");
    await expect(app.inject({ method: "GET", url: "/api/v1/integrations/catalog?kind=bad" })).resolves.toMatchObject({
      statusCode: 400,
    });

    expect((await app.inject({ method: "GET", url: "/api/v1/integrations/catalog/slack/form-schema" })).json()).toEqual(
      {
        catalogId: "slack",
        fields: [],
      },
    );
    await expect(
      app.inject({ method: "GET", url: "/api/v1/integrations/catalog/x/form-schema" }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "GET", url: "/api/v1/integrations/catalog/missing/form-schema" }),
    ).resolves.toMatchObject({
      statusCode: 404,
    });

    await app.inject({ method: "GET", url: "/api/v1/integrations/connections?kind=channel&limit=5" });
    expect(integrations.listIntegrationConnections).toHaveBeenCalledWith("channel", 5);
    await expect(app.inject({ method: "GET", url: "/api/v1/integrations/connections?limit=0" })).resolves.toMatchObject(
      {
        statusCode: 400,
      },
    );

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections",
      payload: { catalogId: "slack", label: "Slack", enabled: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ connectionId, catalogId: "slack" });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/connections", payload: {} }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    integrations.createIntegrationConnection.mockImplementationOnce(() => {
      throw new Error("duplicate connection");
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/connections", payload: { catalogId: "slack" } }),
    ).resolves.toMatchObject({ statusCode: 400 });

    await app.inject({
      method: "PATCH",
      url: `/api/v1/integrations/connections/${connectionId}`,
      payload: { status: "connected", lastSyncAt: "2026-05-14T00:00:00.000Z" },
    });
    expect(integrations.updateIntegrationConnection).toHaveBeenCalledWith(
      connectionId,
      expect.objectContaining({ status: "connected" }),
    );
    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/integrations/connections/not-a-uuid", payload: { label: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    integrations.updateIntegrationConnection.mockImplementationOnce(() => {
      throw new Error("connection disabled");
    });
    await expect(
      app.inject({
        method: "PATCH",
        url: `/api/v1/integrations/connections/${connectionId}`,
        payload: { label: "New" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });

    expect(
      (await app.inject({ method: "DELETE", url: `/api/v1/integrations/connections/${connectionId}` })).json(),
    ).toEqual({
      deleted: true,
    });
    await expect(app.inject({ method: "DELETE", url: "/api/v1/integrations/connections/nope" })).resolves.toMatchObject(
      {
        statusCode: 400,
      },
    );

    const invoked = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/actions/ping`,
      payload: { input: { channel: "ops" } },
    });
    expect(invoked.json()).toMatchObject({ connectionId, actionId: "ping", body: { input: { channel: "ops" } } });
    await expect(
      app.inject({
        method: "POST",
        url: `/api/v1/integrations/connections/${connectionId}/actions/ping`,
        payload: { input: "not-object" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    integrations.invokeIntegrationConnectionAction.mockRejectedValueOnce(new Error("unknown integration connection"));
    await expect(
      app.inject({ method: "POST", url: `/api/v1/integrations/connections/${connectionId}/actions/ping`, payload: {} }),
    ).resolves.toMatchObject({ statusCode: 404 });
    integrations.invokeIntegrationConnectionAction.mockRejectedValueOnce(new Error("rate limited"));
    await expect(
      app.inject({ method: "POST", url: `/api/v1/integrations/connections/${connectionId}/actions/ping`, payload: {} }),
    ).resolves.toMatchObject({ statusCode: 409 });

    expect(
      (
        await app.inject({ method: "GET", url: `/api/v1/integrations/connections/${connectionId}/discord/pairings` })
      ).json(),
    ).toEqual({ items: [{ connectionId, pairingId }] });
    await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/discord/pairings/${pairingId}/approve`,
    });
    await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/discord/pairings/${pairingId}/revoke`,
    });
    await app.inject({ method: "POST", url: `/api/v1/integrations/connections/${connectionId}/discord/reconnect` });
    expect(integrations.approveDiscordPairing).toHaveBeenCalledWith(connectionId, pairingId);
    expect(integrations.revokeDiscordPairing).toHaveBeenCalledWith(connectionId, pairingId);
    expect(integrations.reconnectDiscordRuntime).toHaveBeenCalledWith(connectionId);
    await expect(
      app.inject({ method: "GET", url: "/api/v1/integrations/connections/not-a-uuid/discord/pairings" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: `/api/v1/integrations/connections/${connectionId}/discord/pairings/not-a-uuid/approve`,
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({
        method: "POST",
        url: `/api/v1/integrations/connections/${connectionId}/discord/pairings/not-a-uuid/revoke`,
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/connections/not-a-uuid/discord/reconnect" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    integrations.listDiscordPairings.mockImplementationOnce(() => {
      throw new Error("unknown connection");
    });
    await expect(
      app.inject({ method: "GET", url: `/api/v1/integrations/connections/${connectionId}/discord/pairings` }),
    ).resolves.toMatchObject({ statusCode: 404 });
    integrations.approveDiscordPairing.mockImplementationOnce(() => {
      throw new Error("pairing conflict");
    });
    await expect(
      app.inject({
        method: "POST",
        url: `/api/v1/integrations/connections/${connectionId}/discord/pairings/${pairingId}/approve`,
      }),
    ).resolves.toMatchObject({ statusCode: 409 });
    integrations.revokeDiscordPairing.mockImplementationOnce(() => {
      throw new Error("unknown pairing");
    });
    await expect(
      app.inject({
        method: "POST",
        url: `/api/v1/integrations/connections/${connectionId}/discord/pairings/${pairingId}/revoke`,
      }),
    ).resolves.toMatchObject({ statusCode: 404 });
    integrations.reconnectDiscordRuntime.mockRejectedValueOnce(new Error("runtime busy"));
    await expect(
      app.inject({ method: "POST", url: `/api/v1/integrations/connections/${connectionId}/discord/reconnect` }),
    ).resolves.toMatchObject({ statusCode: 409 });

    expect((await app.inject({ method: "GET", url: "/api/v1/integrations/plugins" })).json()).toEqual({
      items: [{ pluginId: "plugin-1" }],
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/integrations/plugins/install",
          payload: { source: "npm:@goatcitadel/plugin", sourceType: "npm", pluginId: "plugin-2" },
        })
      ).statusCode,
    ).toBe(201);
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/plugins/install", payload: {} }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    integrations.installIntegrationPlugin.mockImplementationOnce(() => {
      throw new Error("install failed");
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/plugins/install", payload: { source: "local" } }),
    ).resolves.toMatchObject({ statusCode: 400 });

    await app.inject({ method: "POST", url: "/api/v1/integrations/plugins/plugin-1/enable" });
    await app.inject({ method: "POST", url: "/api/v1/integrations/plugins/plugin-1/disable" });
    expect(integrations.setIntegrationPluginEnabled).toHaveBeenCalledWith("plugin-1", true);
    expect(integrations.setIntegrationPluginEnabled).toHaveBeenCalledWith("plugin-1", false);
    integrations.setIntegrationPluginEnabled.mockImplementationOnce(() => {
      throw new Error("missing plugin");
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/plugins/plugin-1/enable" }),
    ).resolves.toMatchObject({
      statusCode: 404,
    });
    integrations.setIntegrationPluginEnabled.mockImplementationOnce(() => {
      throw new Error("missing plugin");
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/plugins/plugin-1/disable" }),
    ).resolves.toMatchObject({
      statusCode: 404,
    });

    await app.inject({ method: "GET", url: `/api/v1/integrations/connections/${connectionId}/diagnostics` });
    expect(integrations.runIntegrationConnectionDiagnostics).toHaveBeenCalledWith(connectionId);
    await expect(
      app.inject({ method: "GET", url: "/api/v1/integrations/connections/not-a-uuid/diagnostics" }),
    ).resolves.toMatchObject({ statusCode: 400 });
    integrations.runIntegrationConnectionDiagnostics.mockRejectedValueOnce(new Error("unknown integration connection"));
    await expect(
      app.inject({ method: "GET", url: `/api/v1/integrations/connections/${connectionId}/diagnostics` }),
    ).resolves.toMatchObject({ statusCode: 404 });
    integrations.runIntegrationConnectionDiagnostics.mockRejectedValueOnce(new Error("probe failed"));
    await expect(
      app.inject({ method: "GET", url: `/api/v1/integrations/connections/${connectionId}/diagnostics` }),
    ).resolves.toMatchObject({ statusCode: 409 });
  });

  it("delegates Obsidian integration routes and preserves route-level error mapping", async () => {
    const obsidian = {
      getObsidianIntegrationStatus: vi.fn(async () => ({ enabled: true })),
      updateObsidianIntegrationConfig: vi.fn((patch) => ({ ...patch, saved: true })),
      testObsidianIntegration: vi.fn(async () => ({ ok: true })),
      searchObsidianNotes: vi.fn(async (query: string, limit?: number) => [{ path: "note.md", query, limit }]),
      readObsidianNote: vi.fn(async (notePath: string) => ({ path: notePath, content: "# Note" })),
      appendObsidianNote: vi.fn(async (notePath: string, markdownBlock: string) => ({ path: notePath, markdownBlock })),
      captureObsidianInboxEntry: vi.fn(async (entry) => ({ captured: entry.id })),
    };
    app = Fastify();
    app.decorate("services", { obsidian } as never);
    registerObsidianIntegrationRoutes(app);

    expect((await app.inject({ method: "GET", url: "/api/v1/integrations/obsidian/status" })).json()).toEqual({
      enabled: true,
    });
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/v1/integrations/obsidian/config",
          payload: { enabled: true, vaultPath: "C:/vault", mode: "read_only", allowedSubpaths: ["Inbox"] },
        })
      ).json(),
    ).toMatchObject({ saved: true, mode: "read_only" });
    expect((await app.inject({ method: "POST", url: "/api/v1/integrations/obsidian/test" })).json()).toEqual({
      ok: true,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/integrations/obsidian/search",
          payload: { query: "agent", limit: 3 },
        })
      ).json(),
    ).toEqual({ items: [{ path: "note.md", query: "agent", limit: 3 }] });
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/integrations/obsidian/note?path=note.md" })).json(),
    ).toEqual({
      path: "note.md",
      content: "# Note",
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/integrations/obsidian/append",
      payload: { path: "note.md", markdownBlock: "- item" },
    });
    expect(obsidian.appendObsidianNote).toHaveBeenCalledWith("note.md", "- item");
    await app.inject({
      method: "POST",
      url: "/api/v1/integrations/obsidian/inbox/capture",
      payload: { id: "inbox-1", request: "Capture this", priority: "high" },
    });
    expect(obsidian.captureObsidianInboxEntry).toHaveBeenCalledWith(expect.objectContaining({ id: "inbox-1" }));

    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/integrations/obsidian/config", payload: { mode: "write" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/obsidian/search", payload: { query: "" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "GET", url: "/api/v1/integrations/obsidian/note" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/obsidian/append", payload: { path: "note.md" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/obsidian/inbox/capture", payload: { id: "x" } }),
    ).resolves.toMatchObject({ statusCode: 400 });

    obsidian.updateObsidianIntegrationConfig.mockImplementationOnce(() => {
      throw new Error("bad vault");
    });
    await expect(
      app.inject({ method: "PATCH", url: "/api/v1/integrations/obsidian/config", payload: { enabled: false } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    obsidian.testObsidianIntegration.mockRejectedValueOnce(new Error("offline"));
    await expect(app.inject({ method: "POST", url: "/api/v1/integrations/obsidian/test" })).resolves.toMatchObject({
      statusCode: 400,
    });
    obsidian.searchObsidianNotes.mockRejectedValueOnce(new Error("search failed"));
    await expect(
      app.inject({ method: "POST", url: "/api/v1/integrations/obsidian/search", payload: { query: "agent" } }),
    ).resolves.toMatchObject({ statusCode: 400 });
    obsidian.readObsidianNote.mockRejectedValueOnce(new Error("read failed"));
    await expect(
      app.inject({ method: "GET", url: "/api/v1/integrations/obsidian/note?path=note.md" }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    obsidian.appendObsidianNote.mockRejectedValueOnce(new Error("append failed"));
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/integrations/obsidian/append",
        payload: { path: "note.md", markdownBlock: "x" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    obsidian.captureObsidianInboxEntry.mockRejectedValueOnce(new Error("capture failed"));
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/integrations/obsidian/inbox/capture",
        payload: { id: "inbox-2", request: "Capture" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
  });

  it("delegates media and tools routes with validation and service-error branches", async () => {
    const media = {
      createMediaJob: vi.fn((input) => ({ jobId: "job-1", ...input })),
      getMediaJob: vi.fn((jobId: string) => ({ jobId, status: "done" })),
      listMediaJobs: vi.fn((sessionId?: string) => [{ jobId: "job-1", sessionId }]),
      getChatAttachmentPreview: vi.fn((attachmentId: string) => ({ attachmentId, text: "preview" })),
    };
    const tools = {
      listToolCatalog: vi.fn(() => [{ name: "browser.search" }]),
      evaluateToolAccess: vi.fn((input) => ({ decision: "allow", input })),
      listToolGrants: vi.fn((scope?: string, scopeRef?: string, limit?: number) => [{ scope, scopeRef, limit }]),
      createToolGrant: vi.fn((input) => ({ grantId, ...input })),
      revokeToolGrant: vi.fn(() => true),
    };
    app = Fastify();
    app.decorate("services", { media, tools } as never);
    await app.register(mediaRoutes);
    await app.register(toolsRoutes);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/media/jobs",
          payload: { type: "ocr", sessionId: "session-1" },
        })
      ).statusCode,
    ).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/v1/media/jobs/job-1" })).json()).toEqual({
      jobId: "job-1",
      status: "done",
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/media/jobs?sessionId=session-1" })).json()).toEqual({
      items: [{ jobId: "job-1", sessionId: "session-1" }],
    });
    expect((await app.inject({ method: "GET", url: "/api/v1/chat/attachments/att-1/preview" })).json()).toEqual({
      attachmentId: "att-1",
      text: "preview",
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { type: "bad" } }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    media.createMediaJob.mockImplementationOnce(() => {
      throw new Error("create failed");
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/media/jobs", payload: { type: "analyze" } }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    media.getMediaJob.mockImplementationOnce(() => {
      throw new Error("missing job");
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/media/jobs/job-missing" })).resolves.toMatchObject({
      statusCode: 404,
    });
    media.getChatAttachmentPreview.mockImplementationOnce(() => {
      throw new Error("missing attachment");
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/chat/attachments/missing/preview" })).resolves.toMatchObject(
      {
        statusCode: 404,
      },
    );

    expect((await app.inject({ method: "GET", url: "/api/v1/tools/catalog" })).json()).toEqual({
      items: [{ name: "browser.search" }],
    });
    const evaluated = await app.inject({
      method: "POST",
      url: "/api/v1/tools/access/evaluate",
      payload: { toolName: "browser.search", agentId: "agent-1", sessionId: "session-1", args: { q: "goat" } },
    });
    expect(evaluated.json()).toMatchObject({ decision: "allow" });
    await app.inject({ method: "GET", url: "/api/v1/tools/grants?scope=session&scopeRef=session-1&limit=2" });
    expect(tools.listToolGrants).toHaveBeenCalledWith("session", "session-1", 2);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/tools/grants",
          payload: {
            toolPattern: "browser.*",
            decision: "allow",
            scope: "session",
            scopeRef: "session-1",
            createdBy: "operator",
          },
        })
      ).statusCode,
    ).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/tools/grants/${grantId}/revoke` })).json()).toEqual({
      revoked: true,
      grantId,
    });
    await expect(
      app.inject({ method: "POST", url: "/api/v1/tools/access/evaluate", payload: {} }),
    ).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "GET", url: "/api/v1/tools/grants?limit=0" })).resolves.toMatchObject({
      statusCode: 400,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/tools/grants", payload: {} })).resolves.toMatchObject({
      statusCode: 400,
    });
    tools.createToolGrant.mockImplementationOnce(() => {
      throw new Error("grant conflict");
    });
    await expect(
      app.inject({
        method: "POST",
        url: "/api/v1/tools/grants",
        payload: { toolPattern: "browser.*", decision: "allow", scope: "global", createdBy: "operator" },
      }),
    ).resolves.toMatchObject({ statusCode: 400 });
    tools.revokeToolGrant.mockReturnValueOnce(false);
    await expect(app.inject({ method: "POST", url: `/api/v1/tools/grants/${grantId}/revoke` })).resolves.toMatchObject({
      statusCode: 404,
    });
    await expect(app.inject({ method: "POST", url: "/api/v1/tools/grants/not-a-uuid/revoke" })).resolves.toMatchObject({
      statusCode: 400,
    });
  });
});
