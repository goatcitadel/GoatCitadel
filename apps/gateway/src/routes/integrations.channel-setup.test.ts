import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  cleanupIntegrationTestApp,
  decorateIntegrationServices,
  integrationsRoutes,
} from "./integrations-test-fixtures.js";

describe("channel setup routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await cleanupIntegrationTestApp(app);
    app = null;
  });

  it("returns a channel setup definition", async () => {
    const getChannelSetupDefinition = vi.fn(() => ({
      catalog: { catalogId: "channel.discord", label: "Discord" },
      wizard: { steps: [] },
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      getChannelSetupDefinition,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/catalog/channel.discord/setup-definition",
    });

    expect(response.statusCode).toBe(200);
    expect(getChannelSetupDefinition).toHaveBeenCalledWith("channel.discord");
    expect(response.json()).toEqual(
      expect.objectContaining({
        catalog: expect.objectContaining({ catalogId: "channel.discord" }),
      }),
    );
  });

  it("lists available channel setup definitions", async () => {
    const listChannelSetupDefinitions = vi.fn(() => [
      {
        catalog: { catalogId: "channel.discord", label: "Discord" },
        wizard: { steps: [] },
      },
    ]);
    app = Fastify();
    decorateIntegrationServices(app, {
      listChannelSetupDefinitions,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/setup-definitions",
    });

    expect(response.statusCode).toBe(200);
    expect(listChannelSetupDefinitions).toHaveBeenCalledOnce();
    expect(response.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            catalog: expect.objectContaining({ catalogId: "channel.discord" }),
          }),
        ]),
      }),
    );
  });

  it("lists channel setup drafts", async () => {
    const listChannelSetupDrafts = vi.fn(() => [
      {
        draftId: "11111111-1111-1111-1111-111111111111",
        catalogId: "channel.discord",
        lifecycleMode: "repair",
        enabled: true,
        draft: {},
        contentVersion: "content.v1",
        adapterVersion: "adapter.v1",
        validationVersion: "validation.v1",
        testVersion: "test.v1",
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:10:00.000Z",
      },
    ]);
    app = Fastify();
    decorateIntegrationServices(app, {
      listChannelSetupDrafts,
    });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/channels/drafts?catalogId=channel.discord&limit=10",
    });

    expect(response.statusCode).toBe(200);
    expect(listChannelSetupDrafts).toHaveBeenCalledWith({
      catalogId: "channel.discord",
      limit: 10,
    });
    expect(response.json()).toEqual(
      expect.objectContaining({
        items: expect.arrayContaining([
          expect.objectContaining({
            draftId: "11111111-1111-1111-1111-111111111111",
          }),
        ]),
      }),
    );
  });

  it("creates and updates channel setup drafts", async () => {
    const createChannelSetupDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      revision: 1,
      catalogId: "channel.discord",
      lifecycleMode: "create",
      enabled: true,
      draft: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    }));
    const updateChannelSetupDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      revision: 2,
      catalogId: "channel.discord",
      lifecycleMode: "create",
      enabled: true,
      draft: { defaultChannelId: "123456789012345678" },
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:10:00.000Z",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      createChannelSetupDraft,
      updateChannelSetupDraft,
    });
    await app.register(integrationsRoutes);

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts",
      payload: {
        catalogId: "channel.discord",
        lifecycleMode: "create",
      },
    });

    expect(createResponse.statusCode).toBe(201);
    expect(createChannelSetupDraft).toHaveBeenCalledWith({
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111",
      payload: {
        expectedRevision: 1,
        draft: {
          defaultChannelId: "123456789012345678",
        },
      },
    });

    expect(updateResponse.statusCode).toBe(200);
    expect(updateChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", {
      expectedRevision: 1,
      draft: {
        defaultChannelId: "123456789012345678",
      },
    });
  });

  it("accepts credentials only through the no-store secure-field route and returns presence state", async () => {
    const setChannelSetupDraftSecrets = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      revision: 2,
      catalogId: "channel.telegram",
      lifecycleMode: "create",
      enabled: true,
      draft: { defaultChatId: "123" },
      secretState: {
        botToken: {
          configured: true,
          custody: "temporary",
          secretRef: "keychain:goatcitadel:channel-draft:11111111-1111-1111-1111-111111111111:botToken:nonce-1",
        },
      },
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:01:00.000Z",
    }));
    app = Fastify();
    decorateIntegrationServices(app, { setChannelSetupDraftSecrets });
    await app.register(integrationsRoutes);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/secure-fields",
      payload: { expectedRevision: 1, values: { botToken: "raw-telegram-token" } },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(setChannelSetupDraftSecrets).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", {
      expectedRevision: 1,
      values: { botToken: "raw-telegram-token" },
    });
    expect(response.body).not.toContain("raw-telegram-token");
    expect(response.body).not.toContain("keychain:goatcitadel");
    expect(response.json()).toMatchObject({
      revision: 2,
      draft: { botToken: "[REDACTED]" },
      secretState: { botToken: { configured: true, custody: "temporary" } },
    });
  });

  it("validates, tests, and finalizes channel setup drafts", async () => {
    const validateChannelSetupDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      draftRevision: 2,
      status: "ok",
      levels: ["structural", "semantic"],
      issues: [],
      checkedAt: "2026-03-29T00:00:00.000Z",
    }));
    const testChannelSetupDraft = vi.fn(async () => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      draftRevision: 3,
      status: "ok",
      levels: ["live-auth"],
      issues: [],
      checkedAt: "2026-03-29T00:05:00.000Z",
      recommendedNextAction: "Finalize the connection.",
    }));
    const finalizeChannelSetupDraft = vi.fn(async () => ({
      draftRevision: 4,
      connection: {
        connectionId: "22222222-2222-2222-2222-222222222222",
        catalogId: "channel.discord",
        kind: "channel",
        key: "discord",
        label: "Discord Primary",
        enabled: true,
        status: "connected",
        config: {},
        createdAt: "2026-03-29T00:00:00.000Z",
        updatedAt: "2026-03-29T00:10:00.000Z",
      },
      validation: {
        draftId: "11111111-1111-1111-1111-111111111111",
        draftRevision: 4,
        status: "ok",
        levels: ["structural", "semantic"],
        issues: [],
        checkedAt: "2026-03-29T00:00:00.000Z",
      },
      test: {
        draftId: "11111111-1111-1111-1111-111111111111",
        draftRevision: 4,
        status: "ok",
        levels: ["live-auth"],
        issues: [],
        checkedAt: "2026-03-29T00:05:00.000Z",
      },
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      validateChannelSetupDraft,
      testChannelSetupDraft,
      finalizeChannelSetupDraft,
    });
    await app.register(integrationsRoutes);

    const validateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/validate",
      payload: { expectedRevision: 1 },
    });
    expect(validateResponse.statusCode).toBe(200);
    expect(validateChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", 1);

    const testResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/test",
      payload: { expectedRevision: 2 },
    });
    expect(testResponse.statusCode).toBe(200);
    expect(testChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", 2);

    const finalizeResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts/11111111-1111-1111-1111-111111111111/finalize",
      payload: { expectedRevision: 3 },
    });
    expect(finalizeResponse.statusCode).toBe(200);
    expect(finalizeChannelSetupDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111", 3);
    expect(finalizeResponse.json()).toEqual(
      expect.objectContaining({
        connection: expect.objectContaining({
          connectionId: "22222222-2222-2222-2222-222222222222",
        }),
      }),
    );
  });

  it("creates repair and rotate-secret drafts and supports re-test", async () => {
    const createChannelSetupRepairDraft = vi.fn(() => ({
      draftId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.discord",
      lifecycleMode: "repair",
      enabled: true,
      draft: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    }));
    const createChannelSetupRotateSecretDraft = vi.fn(() => ({
      draftId: "33333333-3333-3333-3333-333333333333",
      catalogId: "channel.discord",
      lifecycleMode: "rotate_secret",
      enabled: true,
      draft: {},
      contentVersion: "content.v1",
      adapterVersion: "adapter.v1",
      validationVersion: "validation.v1",
      testVersion: "test.v1",
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    }));
    const retestChannelConnection = vi.fn(async () => ({
      draftId: "44444444-4444-4444-4444-444444444444",
      status: "ok",
      levels: ["live-auth"],
      issues: [],
      checkedAt: "2026-03-29T00:05:00.000Z",
      recommendedNextAction: "Finalize the connection.",
    }));
    app = Fastify();
    decorateIntegrationServices(app, {
      createChannelSetupRepairDraft,
      createChannelSetupRotateSecretDraft,
      retestChannelConnection,
    });
    await app.register(integrationsRoutes);

    const repairResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/repair-draft",
    });
    expect(repairResponse.statusCode).toBe(201);
    expect(createChannelSetupRepairDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");

    const rotateResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/rotate-secret-draft",
    });
    expect(rotateResponse.statusCode).toBe(201);
    expect(createChannelSetupRotateSecretDraft).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");

    const retestResponse = await app.inject({
      method: "POST",
      url: "/api/v1/channels/connections/11111111-1111-1111-1111-111111111111/retest",
    });
    expect(retestResponse.statusCode).toBe(200);
    expect(retestChannelConnection).toHaveBeenCalledWith("11111111-1111-1111-1111-111111111111");
  });
});
