import fs from "node:fs";
import path from "node:path";
import type { IntegrationConnection, IntegrationPluginRecord } from "@goatcitadel/contracts";
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

  it("projects list and create connection responses without mutating raw service records", async () => {
    const rawConnection = createSecretBearingConnection(connectionId);
    const listIntegrationConnections = vi.fn(() => [rawConnection]);
    const createIntegrationConnection = vi.fn((input: { config?: Record<string, unknown> }) => ({
      ...rawConnection,
      config: input.config ?? {},
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationConnections,
      createIntegrationConnection,
    });
    await app.register(integrationsRoutes);

    const listed = await app.inject({ method: "GET", url: "/api/v1/integrations/connections?limit=5" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0].config).toEqual({
      botToken: "[REDACTED]",
      webhookUrl: "[REDACTED]",
      authorization: "[REDACTED]",
      DATABASE_PASSWORD: "[REDACTED]",
      botTokenEnv: "SLACK_BOT_TOKEN",
      secretRef: "keychain:slack-bot-token",
      tokenId: "runtime-token-id",
      requestCount: 17,
      channelId: "C-OLD",
    });
    expect(rawConnection.config).toMatchObject({
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
      authorization: "Bearer tiny",
      DATABASE_PASSWORD: "db-short",
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/connections",
      payload: {
        catalogId: "channel.slack",
        label: "Slack",
        config: {
          botToken: "created-short",
          webhookUrl: "https://hooks.example.test/new?token=created-hook",
          botTokenEnv: "SLACK_BOT_TOKEN",
          requestCount: 1,
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(createIntegrationConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          botToken: "created-short",
          webhookUrl: "https://hooks.example.test/new?token=created-hook",
        }),
      }),
    );
    expect(created.json().config).toEqual({
      botToken: "[REDACTED]",
      webhookUrl: "[REDACTED]",
      botTokenEnv: "SLACK_BOT_TOKEN",
      requestCount: 1,
    });
    expect(JSON.stringify(created.json())).not.toContain("created-short");
    expect(JSON.stringify(created.json())).not.toContain("created-hook");
  });

  it("preserves hidden existing secrets across guided and advanced public PATCH payloads", async () => {
    const rawConnection = createSecretBearingConnection(connectionId);
    const getIntegrationConnection = vi.fn(() => rawConnection);
    const updateIntegrationConnection = vi.fn((_connectionId: string, input: { config?: Record<string, unknown> }) => ({
      ...rawConnection,
      config: input.config ?? rawConnection.config,
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      getIntegrationConnection,
      updateIntegrationConnection,
    });
    await app.register(integrationsRoutes);

    const guided = await app.inject({
      method: "PATCH",
      url: `/api/v1/integrations/connections/${connectionId}`,
      payload: {
        config: {
          botToken: "[REDACTED]",
          webhookUrl: "[REDACTED]",
          authorization: "[REDACTED]",
          DATABASE_PASSWORD: "[REDACTED]",
          botTokenEnv: "SLACK_BOT_TOKEN",
          secretRef: "keychain:slack-bot-token",
          tokenId: "runtime-token-id",
          requestCount: 18,
          channelId: "C-GUIDED",
        },
      },
    });
    expect(guided.statusCode).toBe(200);
    expect(updateIntegrationConnection).toHaveBeenNthCalledWith(
      1,
      connectionId,
      expect.objectContaining({
        config: expect.objectContaining({
          botToken: "bot-short",
          webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
          authorization: "Bearer tiny",
          DATABASE_PASSWORD: "db-short",
          channelId: "C-GUIDED",
        }),
      }),
    );
    expect(JSON.stringify(guided.json())).not.toContain("bot-short");
    expect(JSON.stringify(guided.json())).not.toContain("hook-short");
    expect(guided.json().config.webhookUrl).toBe("[REDACTED]");

    const advanced = await app.inject({
      method: "PATCH",
      url: `/api/v1/integrations/connections/${connectionId}`,
      payload: {
        config: {
          botTokenEnv: "SLACK_BOT_TOKEN_V2",
          secretRef: "keychain:slack-bot-token",
          tokenId: "runtime-token-id",
          requestCount: 19,
          channelId: "C-ADVANCED",
        },
      },
    });
    expect(advanced.statusCode).toBe(200);
    expect(updateIntegrationConnection).toHaveBeenNthCalledWith(
      2,
      connectionId,
      expect.objectContaining({
        config: {
          botToken: "bot-short",
          webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
          authorization: "Bearer tiny",
          DATABASE_PASSWORD: "db-short",
          botTokenEnv: "SLACK_BOT_TOKEN_V2",
          secretRef: "keychain:slack-bot-token",
          tokenId: "runtime-token-id",
          requestCount: 19,
          channelId: "C-ADVANCED",
        },
      }),
    );
    expect(advanced.json().config).toMatchObject({
      botToken: "[REDACTED]",
      webhookUrl: "[REDACTED]",
      authorization: "[REDACTED]",
      DATABASE_PASSWORD: "[REDACTED]",
      botTokenEnv: "SLACK_BOT_TOKEN_V2",
      requestCount: 19,
    });
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
    const rawDiagnostics = {
      connectorType: "integration_connection",
      connectorId: "11111111-1111-1111-1111-111111111111",
      status: "warn",
      checks: [
        {
          key: "smoke_mode",
          status: "pass",
          message:
            "Probe https://integration.example.test/access-token/integration-diagnostic-path?token=integration-diagnostic-query completed.",
          metadata: {
            authorization: "Bearer integration-diagnostic-short",
            tokenId: "integration-diagnostic-token-id",
            latencyMs: 37,
          },
        },
      ],
      checkedAt: "2026-03-22T00:00:00.000Z",
    };
    const runIntegrationConnectionDiagnostics = vi.fn(async () => rawDiagnostics);
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
        checks: [
          expect.objectContaining({
            message: "Probe https://integration.example.test/access-token/[REDACTED]?token=[REDACTED] completed.",
            metadata: {
              authorization: "[REDACTED]",
              tokenId: "integration-diagnostic-token-id",
              latencyMs: 37,
            },
          }),
        ],
      }),
    );
    expect(rawDiagnostics.checks[0]!.message).toContain("integration-diagnostic-path");
    expect(rawDiagnostics.checks[0]!.metadata.authorization).toBe("Bearer integration-diagnostic-short");
  });

  it("invokes shared operator actions through the integration action route", async () => {
    const rawActionResult = {
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "productivity.apple-notes",
      actionId: "read",
      status: "executed",
      message: "Fetched sample note payload.",
      checkedAt: "2026-04-10T00:00:00.000Z",
      output: {
        items: [{ title: "Sample note" }],
        provider: {
          authorization: "Bearer action-short",
          statusUrl: "https://provider.example.test/client-secret/action-path?token=action-query",
          tokenId: "action-token-id",
          requestCount: 6,
        },
      },
    };
    const invokeIntegrationConnectionAction = vi.fn(async () => rawActionResult);
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
        output: expect.objectContaining({
          provider: {
            authorization: "[REDACTED]",
            statusUrl: "https://provider.example.test/client-secret/[REDACTED]?token=[REDACTED]",
            tokenId: "action-token-id",
            requestCount: 6,
          },
        }),
      }),
    );
    expect(rawActionResult.output.provider.authorization).toBe("Bearer action-short");
    expect(rawActionResult.output.provider.statusUrl).toContain("action-path");
  });

  it("projects credential-bearing integration action failures before returning them", async () => {
    const rawError =
      "Provider rejected https://provider.example.test/token/action-error-path?token=action-error-query with Bearer action-error-short";
    app = Fastify();
    decorateIntegrationServices(app, {
      invokeIntegrationConnectionAction: vi.fn(async () => {
        throw new Error(rawError);
      }),
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/integrations/connections/${connectionId}/actions/read`,
      payload: { input: { query: "sample" } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("action-error-path");
    expect(response.body).not.toContain("action-error-query");
    expect(response.body).not.toContain("action-error-short");
    expect(response.json()).toEqual({
      error: "Provider rejected https://provider.example.test/token/[REDACTED]?token=[REDACTED] with Bearer [REDACTED]",
    });
    expect(rawError).toContain("action-error-path");
  });

  it("lists external side-effect run ledger records through a read-only projection", async () => {
    const rawRun = {
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
      requestPayload: {
        authorization: "Bearer tiny",
        callbackUrl: "https://callback.example.test/result?token=callback-short",
        tokenId: "token-id-safe",
      },
      responsePayload: {
        DATABASE_PASSWORD: "db-short",
        requestCount: 3,
      },
      errorText: "Authorization: Bearer failure-short",
      externalCallStartedAt: "2026-05-31T10:00:02.000Z",
      createdAt: "2026-05-31T10:00:00.000Z",
      updatedAt: "2026-05-31T10:00:03.000Z",
    };
    const listExternalSideEffectRuns = vi.fn(() => [rawRun]);
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
          requestPayload: {
            authorization: "[REDACTED]",
            callbackUrl: "https://callback.example.test/result?token=[REDACTED]",
            tokenId: "token-id-safe",
          },
          responsePayload: {
            DATABASE_PASSWORD: "[REDACTED]",
            requestCount: 3,
          },
          errorText: "Authorization: [REDACTED]",
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
    expect(rawRun.requestPayload.authorization).toBe("Bearer tiny");
    expect(rawRun.responsePayload.DATABASE_PASSWORD).toBe("db-short");
    expect(rawRun.errorText).toContain("failure-short");
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
    const rawPairingList = {
      runtime: {
        connectionId: "11111111-1111-1111-1111-111111111111",
        runtimeMode: "gateway",
        enabled: true,
        ready: true,
        guildIds: ["guild-1"],
        lastError: "Authorization: Bearer discord-runtime-short",
        providerStatus: {
          endpoint: "https://discord.example.test/token/discord-runtime-path?token=discord-runtime-query",
          tokenId: "discord-runtime-token-id",
          reconnectCount: 2,
        },
      },
      items: [
        {
          pairingId: "22222222-2222-2222-2222-222222222222",
          connectionId,
          userId: "discord-user",
          code: "ABC123",
          status: "pending",
          createdAt: "2026-03-29T00:00:00.000Z",
          updatedAt: "2026-03-29T00:00:00.000Z",
          providerPayload: {
            authorization: "Bearer pairing-short",
            tokenId: "pairing-token-id",
            requestCount: 1,
          },
        },
      ],
    };
    const listDiscordPairings = vi.fn(() => rawPairingList);
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
          lastError: "Authorization: [REDACTED]",
          providerStatus: {
            endpoint: "https://discord.example.test/token/[REDACTED]?token=[REDACTED]",
            tokenId: "discord-runtime-token-id",
            reconnectCount: 2,
          },
        }),
        items: [
          expect.objectContaining({
            pairingId: "22222222-2222-2222-2222-222222222222",
            code: "ABC123",
            providerPayload: {
              authorization: "[REDACTED]",
              tokenId: "pairing-token-id",
              requestCount: 1,
            },
          }),
        ],
      }),
    );
    expect(rawPairingList.runtime.lastError).toContain("discord-runtime-short");
    expect(rawPairingList.items[0]!.code).toBe("ABC123");
    expect(rawPairingList.items[0]!.providerPayload.authorization).toBe("Bearer pairing-short");
  });

  it("approves and revokes Discord pairings through the integration routes", async () => {
    const rawApprovedPairing = {
      pairingId: "22222222-2222-2222-2222-222222222222",
      connectionId: "11111111-1111-1111-1111-111111111111",
      userId: "discord-user",
      code: "ABC123",
      status: "approved",
      providerPayload: {
        authorization: "Bearer approved-pairing-short",
        tokenId: "approved-pairing-token-id",
        requestCount: 2,
      },
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T01:00:00.000Z",
    };
    const approveDiscordPairing = vi.fn(() => rawApprovedPairing);
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
    expect(approveResponse.json()).toMatchObject({
      code: "ABC123",
      providerPayload: {
        authorization: "[REDACTED]",
        tokenId: "approved-pairing-token-id",
        requestCount: 2,
      },
    });
    expect(rawApprovedPairing.providerPayload.authorization).toBe("Bearer approved-pairing-short");

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
    const rawReconnect = {
      connectionId: "11111111-1111-1111-1111-111111111111",
      runtimeMode: "gateway",
      enabled: true,
      ready: false,
      guildIds: [],
      lastReconnectAt: "2026-03-29T03:00:00.000Z",
      lastError:
        "Reconnect https://discord.example.test/api-key/reconnect-path?token=reconnect-query failed with Bearer reconnect-short",
      providerStatus: {
        tokenId: "reconnect-token-id",
        attemptCount: 5,
      },
    };
    const reconnectDiscordRuntime = vi.fn(async () => rawReconnect);
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
        lastError:
          "Reconnect https://discord.example.test/api-key/[REDACTED]?token=[REDACTED] failed with Bearer [REDACTED]",
        providerStatus: {
          tokenId: "reconnect-token-id",
          attemptCount: 5,
        },
      }),
    );
    expect(rawReconnect.lastError).toContain("reconnect-path");
  });

  it("projects integration plugin provenance and descriptor diagnostics across lifecycle responses", async () => {
    const rawPlugin = {
      pluginId: "plugin-token-id",
      label: "Projected Plugin",
      version: "1.0.0",
      description: "Authorization: Bearer plugin-description-short",
      source: "https://plugins.example.test/access-token/plugin-source-path?token=plugin-source-query",
      sourceMetadata: {
        type: "url",
        display: "URL: https://plugins.example.test/client-secret/plugin-display-path?token=plugin-display-query",
        integrityStatus: "verified",
        expectedIntegrity: "sha256:plugin-integrity-hash",
      },
      integrityStatus: "verified",
      trustWarnings: [
        {
          code: "plugin.runtime_warning",
          severity: "warning",
          message: "Provider returned Bearer plugin-warning-short",
        },
      ],
      descriptorHealth: {
        status: "warning",
        checkedAt: "2026-07-09T00:00:00.000Z",
        source: "https://plugins.example.test/api-key/plugin-health-path?token=plugin-health-query",
        summary: "Proxy-Authorization: Bearer plugin-health-short",
        issues: [],
        evidence: {
          owner: "gateway",
          source: "integration_plugin_descriptor",
          timestamp: "2026-07-09T00:00:00.000Z",
          status: "warning",
          descriptorHash: "descriptor-hash",
        },
      },
      theme: { accentColor: "#17c3b2", dashboardVariant: "compact" },
      enabled: true,
      installedAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
      capabilities: ["channel.adapter"],
      requestCount: 9,
    } as IntegrationPluginRecord & { requestCount: number };
    const listIntegrationPlugins = vi.fn(() => [rawPlugin]);
    const installIntegrationPlugin = vi.fn(() => rawPlugin);
    const setIntegrationPluginEnabled = vi.fn(() => rawPlugin);
    app = Fastify();
    decorateIntegrationServices(app, {
      listIntegrationPlugins,
      installIntegrationPlugin,
      setIntegrationPluginEnabled,
    });
    await app.register(integrationsRoutes);

    const install = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/install",
      payload: { source: "npm:safe-plugin" },
    });
    const listed = await app.inject({ method: "GET", url: "/api/v1/integrations/plugins" });
    const enabled = await app.inject({
      method: "POST",
      url: "/api/v1/integrations/plugins/plugin-token-id/enable",
    });

    for (const response of [install, enabled]) {
      expect(response.statusCode).toBeLessThan(300);
      expect(response.json()).toMatchObject({
        pluginId: "plugin-token-id",
        description: "Authorization: [REDACTED]",
        source: "https://plugins.example.test/access-token/[REDACTED]?token=[REDACTED]",
        sourceMetadata: {
          display: "URL: https://plugins.example.test/client-secret/[REDACTED]?token=[REDACTED]",
          expectedIntegrity: "sha256:plugin-integrity-hash",
        },
        trustWarnings: [{ message: "Provider returned Bearer [REDACTED]" }],
        descriptorHealth: {
          source: "https://plugins.example.test/api-key/[REDACTED]?token=[REDACTED]",
          summary: "Proxy-Authorization: [REDACTED]",
          evidence: { descriptorHash: "descriptor-hash" },
        },
        theme: { accentColor: "#17c3b2", dashboardVariant: "compact" },
        requestCount: 9,
      });
    }
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items[0]).toMatchObject(install.json());
    expect(rawPlugin.description).toContain("plugin-description-short");
    expect(rawPlugin.source).toContain("plugin-source-path");
    expect(rawPlugin.theme).toEqual({ accentColor: "#17c3b2", dashboardVariant: "compact" });
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

function createSecretBearingConnection(connectionId: string): IntegrationConnection {
  return {
    connectionId,
    catalogId: "channel.slack",
    kind: "channel",
    key: "slack",
    label: "Slack",
    enabled: true,
    status: "connected",
    config: {
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
      authorization: "Bearer tiny",
      DATABASE_PASSWORD: "db-short",
      botTokenEnv: "SLACK_BOT_TOKEN",
      secretRef: "keychain:slack-bot-token",
      tokenId: "runtime-token-id",
      requestCount: 17,
      channelId: "C-OLD",
    },
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}
