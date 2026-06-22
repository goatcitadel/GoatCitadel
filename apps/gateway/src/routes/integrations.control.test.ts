import fs from "node:fs";
import path from "node:path";
import type { IntegrationPluginRecord } from "@goatcitadel/contracts";
import { buildInstalledIntegrationPluginRecord } from "../services/integration-plugin-author-contract.js";
import { buildGenericChannelInboundSignature } from "../services/generic-channel-webhook.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  cleanupIntegrationTestApp,
  decorateIntegrationServices,
  integrationsRoutes,
} from "./integrations-test-fixtures.js";

describe("integrations control routes", () => {
  let app: FastifyInstance | null = null;
  const connectionId = "11111111-1111-1111-1111-111111111111";

  afterEach(async () => {
    await cleanupIntegrationTestApp(app);
    app = null;
  });

  it("keeps Discord pairing routes behind CodeQL-visible rate limits", () => {
    const source = fs.readFileSync(new URL("./integrations-control-routes.ts", import.meta.url), "utf8");
    expect(source).toMatch(/const RATE_LIMIT_AUTH_MAX = 60/);
    expect(source).toMatch(
      /fastify\.get\(\s*"\/api\/v1\/integrations\/connections\/:connectionId\/discord\/pairings",\s*pairingReadRoute/,
    );
    expect(source).toMatch(
      /"\/api\/v1\/integrations\/connections\/:connectionId\/discord\/pairings\/:pairingId\/approve",\s*pairingMutationRoute/,
    );
    expect(source).toMatch(
      /"\/api\/v1\/integrations\/connections\/:connectionId\/discord\/pairings\/:pairingId\/revoke",\s*pairingMutationRoute/,
    );
    expect(source).toMatch(
      /"\/api\/v1\/integrations\/connections\/:connectionId\/actions\/:actionId",\s*integrationMutationRoute/,
    );
  });

  it("rejects channel inbound payloads with oversized content-length", async () => {
    const ingestChannelMessage = vi.fn();
    app = Fastify();
    decorateIntegrationServices(app, {
      ingestChannelMessage,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/discord/inbound`,
      headers: {
        "content-length": String(300 * 1024),
      },
      payload: {
        eventId: "evt-oversized",
        account: "acct-1",
        actorId: "user-1",
        content: "hello",
      },
    });

    expect(response.statusCode).toBe(413);
    expect(ingestChannelMessage).not.toHaveBeenCalled();
  });

  it("accepts bounded inbound payloads and forwards to gateway ingest", async () => {
    const ingestChannelMessage = vi.fn(async () => ({
      accepted: true,
      sessionId: "sess-1",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      getIntegrationConnection: vi.fn(() => ({
        connectionId,
        key: "discord",
        enabled: true,
        status: "connected",
        config: {
          inboundSecret: "generic-secret",
        },
      })),
      ingestChannelMessage,
    });
    await app.register(integrationsRoutes);
    const payload = {
      eventId: "evt-1",
      account: connectionId,
      actorId: "user-1",
      content: "hello from inbound",
      metadata: {
        source: "test",
      },
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/discord/inbound`,
      headers: {
        "content-type": "application/json",
        "x-goatcitadel-channel-timestamp": timestamp,
        "x-goatcitadel-channel-signature": buildGenericChannelInboundSignature(timestamp, body, "generic-secret"),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(ingestChannelMessage).toHaveBeenCalledWith(
      "discord",
      `generic-channel:${connectionId}:discord:evt-1`,
      expect.objectContaining({
        account: connectionId,
        eventId: "evt-1",
        actorId: "user-1",
        content: "hello from inbound",
      }),
    );
  });

  it("runs connector diagnostics through the integration diagnostics route", async () => {
    const runIntegrationConnectionDiagnostics = vi.fn(async () => ({
      connectorType: "integration_connection",
      connectorId: "11111111-1111-1111-1111-111111111111",
      status: "warn",
      checks: [
        {
          key: "smoke_mode",
          status: "pass",
          message: "Smoke probes are configured.",
        },
      ],
      checkedAt: "2026-03-22T00:00:00.000Z",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      runIntegrationConnectionDiagnostics,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/diagnostics",
    });

    expect(response.statusCode).toBe(200);
    expect(runIntegrationConnectionDiagnostics).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(
      expect.objectContaining({
        connectorType: "integration_connection",
        connectorId: "11111111-1111-1111-1111-111111111111",
        status: "warn",
      }),
    );
  });

  it("invokes shared operator actions through the integration action route", async () => {
    const invokeIntegrationConnectionAction = vi.fn(async () => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "productivity.apple-notes",
      actionId: "read",
      status: "executed",
      message: "Fetched sample note payload.",
      checkedAt: "2026-04-10T00:00:00.000Z",
      output: {
        items: [{ title: "Sample note" }],
      },
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      invokeIntegrationConnectionAction,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/actions/read",
      payload: {
        input: {
          query: "sample",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeIntegrationConnectionAction).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "read", {
      input: { query: "sample" },
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        catalogId: "productivity.apple-notes",
        actionId: "read",
        status: "executed",
      }),
    );
  });

  it("lists external side-effect run ledger records through a read-only projection", async () => {
    const listExternalSideEffectRuns = vi.fn(() => [
      {
        runId: "extfx_111111111111111111111111",
        workspaceId: "workspace-1",
        boundary: "integration_operator_action",
        routePath: "external_side_effect:integration_operator_action:productivity.trello:conn-1:write",
        catalogId: "productivity.trello",
        connectionId: "11111111-1111-1111-1111-111111111111",
        actionId: "write",
        actorScope: "11111111-1111-1111-1111-111111111111",
        idempotencyKey: "operator-key",
        payloadHash: "payload-hash",
        status: "unknown_external_outcome",
        replayPolicy: "idempotent_external",
        replayAttempt: "new",
        resumeState: "not_resumable",
        attemptCount: 1,
        externalCallStartedAt: "2026-05-31T10:00:02.000Z",
        createdAt: "2026-05-31T10:00:00.000Z",
        updatedAt: "2026-05-31T10:00:03.000Z",
      },
    ]);
    app = Fastify();
    decorateIntegrationServices(app, {
      listExternalSideEffectRuns,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/external-side-effects?workspaceId=workspace-1&connectionId=11111111-1111-1111-1111-111111111111&limit=25",
    });

    expect(response.statusCode).toBe(200);
    expect(listExternalSideEffectRuns).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      connectionId: "11111111-1111-1111-1111-111111111111",
      limit: 25,
    });
    expect(response.json()).toEqual({
      items: [
        expect.objectContaining({
          runId: "extfx_111111111111111111111111",
          status: "unknown_external_outcome",
          resumeState: "not_resumable",
        }),
      ],
      summary: expect.objectContaining({
        total: 1,
        successRate: 0,
        unknownOutcomeCount: 1,
        replayAuditEligibleCount: 0,
        manualReconciliationCount: 1,
        posture: expect.objectContaining({
          readOnly: true,
          hiddenPolling: false,
          managedWorkflowLifecycle: false,
        }),
      }),
    });
  });

  it("rejects invalid external connector workspace ids before staging proposals", async () => {
    const stageExternalConnectorAction = vi.fn();
    app = Fastify();
    decorateIntegrationServices(app, {
      stageExternalConnectorAction,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/external-connectors/services/mscr/notion/actions/append-block-children/stage",
      payload: {
        workspaceId: "bad/workspace",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(stageExternalConnectorAction).not.toHaveBeenCalled();
    expect(response.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({
          body: expect.any(Object),
        }),
      }),
    );
  });

  it("forwards the request idempotency key into integration operator actions", async () => {
    const invokeIntegrationConnectionAction = vi.fn(async () => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "productivity.trello",
      actionId: "write",
      status: "blocked",
      message: "Duplicate mutation blocked.",
      checkedAt: "2026-04-10T00:00:00.000Z",
    }));
    app = Fastify();
    app.decorateRequest("idempotencyKey", "");
    app.addHook("preHandler", async (request) => {
      const value = request.headers["idempotency-key"];
      request.idempotencyKey = typeof value === "string" ? value : "";
    });
    decorateIntegrationServices(app, {
      invokeIntegrationConnectionAction,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/actions/write",
      headers: {
        "idempotency-key": "route-header-key",
      },
      payload: {
        input: {
          name: "Durable card",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(invokeIntegrationConnectionAction).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", "write", {
      input: { name: "Durable card" },
      idempotencyKey: "route-header-key",
    });
  });

  it("lists Discord pairings through the integration route", async () => {
    const listDiscordPairings = vi.fn(() => ({
      runtime: {
        connectionId: "11111111-1111-1111-1111-111111111111",
        runtimeMode: "gateway",
        enabled: true,
        ready: true,
        guildIds: ["guild-1"],
      },
      items: [],
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      listDiscordPairings,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/pairings",
    });

    expect(response.statusCode).toBe(200);
    expect(listDiscordPairings).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({
          connectionId: "11111111-1111-1111-1111-111111111111",
          ready: true,
        }),
      }),
    );
  });

  it("approves and revokes Discord pairings through the integration routes", async () => {
    const approveDiscordPairing = vi.fn(() => ({
      pairingId: "22222222-2222-2222-2222-222222222222",
      connectionId: "11111111-1111-1111-1111-111111111111",
      userId: "discord-user",
      code: "ABC123",
      status: "approved",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T01:00:00.000Z",
    }));
    const revokeDiscordPairing = vi.fn(() => ({
      pairingId: "22222222-2222-2222-2222-222222222222",
      connectionId: "11111111-1111-1111-1111-111111111111",
      userId: "discord-user",
      code: "ABC123",
      status: "revoked",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T02:00:00.000Z",
      revokedAt: "2026-03-29T02:00:00.000Z",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      approveDiscordPairing,
      revokeDiscordPairing,
    });
    await app.register(integrationsRoutes);

    const approveResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/pairings/22222222-2222-2222-2222-222222222222/approve",
    });
    expect(approveResponse.statusCode).toBe(200);
    expect(approveDiscordPairing).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );

    const revokeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/pairings/22222222-2222-2222-2222-222222222222/revoke",
    });
    expect(revokeResponse.statusCode).toBe(200);
    expect(revokeDiscordPairing).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222",
    );
  });

  it("reconnects the Discord gateway runtime through the integration route", async () => {
    const reconnectDiscordRuntime = vi.fn(async () => ({
      connectionId: "11111111-1111-1111-1111-111111111111",
      runtimeMode: "gateway",
      enabled: true,
      ready: false,
      guildIds: [],
      lastReconnectAt: "2026-03-29T03:00:00.000Z",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      reconnectDiscordRuntime,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections/11111111-1111-1111-1111-111111111111/discord/reconnect",
    });

    expect(response.statusCode).toBe(200);
    expect(reconnectDiscordRuntime).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
    expect(response.json()).toEqual(
      expect.objectContaining({
        connectionId: "11111111-1111-1111-1111-111111111111",
        lastReconnectAt: "2026-03-29T03:00:00.000Z",
      }),
    );
  });

  it("supports reference plugin install, list, and enable-disable lifecycle routes", async () => {
    const source = path.resolve(process.cwd(), "../../templates/integration-plugins/reference-integration-plugin");
    let plugins: IntegrationPluginRecord[] = [
      buildInstalledIntegrationPluginRecord({
        now: "2026-03-30T08:00:00.000Z",
        pluginId: "reference-integration-plugin",
        source,
      }),
    ];
    plugins = [{ ...plugins[0]!, enabled: false }];
    const listIntegrationPlugins = vi.fn(() => plugins);
    const installIntegrationPlugin = vi.fn((input: { source: string; pluginId?: string }) => {
      const created = buildInstalledIntegrationPluginRecord({
        now: "2026-03-30T09:00:00.000Z",
        pluginId: input.pluginId ?? "reference-integration-plugin",
        source: input.source,
      });
      plugins = [created];
      return created;
    });
    const setIntegrationPluginEnabled = vi.fn((pluginId: string, enabled: boolean) => {
      plugins = plugins.map((plugin) => (plugin.pluginId === pluginId ? { ...plugin, enabled } : plugin));
      return plugins.find((plugin) => plugin.pluginId === pluginId)!;
    });
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationPlugins,
      installIntegrationPlugin,
      setIntegrationPluginEnabled,
    });
    await app.register(integrationsRoutes);

    const installResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/install",
      payload: { source },
    });
    expect(installResponse.statusCode).toBe(201);
    expect(installIntegrationPlugin).toHaveBeenCalledWith({ source });
    expect(installResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        label: "Reference Integration Plugin",
        source,
        enabled: true,
      }),
    );

    const disableResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/reference-integration-plugin/disable",
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(setIntegrationPluginEnabled).toHaveBeenCalledWith("reference-integration-plugin", false);
    expect(disableResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        enabled: false,
      }),
    );

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/integrations/plugins",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(listIntegrationPlugins).toHaveBeenCalled();
    expect(listResponse.json()).toEqual({
      items: expect.arrayContaining([
        expect.objectContaining({
          pluginId: "reference-integration-plugin",
          label: "Reference Integration Plugin",
          source,
          enabled: false,
        }),
      ]),
    });

    const enableResponse = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/reference-integration-plugin/enable",
    });
    expect(enableResponse.statusCode).toBe(200);
    expect(setIntegrationPluginEnabled).toHaveBeenCalledWith("reference-integration-plugin", true);
    expect(enableResponse.json()).toEqual(
      expect.objectContaining({
        pluginId: "reference-integration-plugin",
        enabled: true,
      }),
    );
  });
});
