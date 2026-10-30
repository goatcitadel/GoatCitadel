import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ValidationError } from "@goatcitadel/contracts";
import {
  cleanupIntegrationTestApp,
  decorateIntegrationServices,
  integrationsRoutes,
} from "./integrations-test-fixtures.js";
import { installRouteAccessTracking } from "./route-access.js";

describe("channel setup routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await cleanupIntegrationTestApp(app);
    app = null;
  });

  it("deletes only a revision-reviewed draft and acknowledges its identity", async () => {
    const discardChannelSetupDraft = vi.fn().mockResolvedValue(true);
    app = Fastify();
    decorateIntegrationServices(app, { discardChannelSetupDraft });
    await app.register(integrationsRoutes);
    const draftId = "11111111-1111-1111-1111-111111111111";
    const missingReview = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/drafts/${draftId}`,
      payload: {},
    });
    expect(missingReview.statusCode).toBe(400);
    expect(discardChannelSetupDraft).not.toHaveBeenCalled();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/v1/channels/drafts/${draftId}`,
      payload: { expectedRevision: 3 },
    });
    expect(response.statusCode).toBe(200);
    expect(discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith(draftId, 3);
    expect(response.json()).toEqual({ draftId, deleted: true });
  });

  it("returns a channel setup definition", async () => {
    const getChannelSetupDefinition = vi.fn(async () => ({
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
    const listChannelSetupDefinitions = vi.fn(async () => [
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

  it("validates and tests drafts but requires governed activation review", async () => {
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
    expect(finalizeResponse.statusCode).toBe(409);
    expect(finalizeChannelSetupDraft).not.toHaveBeenCalled();
    expect(finalizeResponse.json()).toMatchObject({ code: "CHANNEL_ACTIVATION_REVIEW_UNAVAILABLE" });
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

  describe("Discord setup check", () => {
    const url = "/api/v1/channels/discord/setup-check";
    const draftId = "11111111-1111-1111-1111-111111111111";
    const result = {
      bot: { id: "111", name: "Goat Bot" },
      applicationId: "222",
      messageContentIntent: true,
      makers: [{ id: "333", name: "Sam" }],
      servers: [{ id: "1000000001", name: "Home" }],
    };

    async function appWith(checkDiscordSetup: ReturnType<typeof vi.fn>) {
      app = Fastify();
      decorateIntegrationServices(app, { checkDiscordSetup });
      await app.register(integrationsRoutes);
      return app;
    }

    it("passes a draft check through, and is never cached", async () => {
      const checkDiscordSetup = vi.fn(async () => result);
      const server = await appWith(checkDiscordSetup);
      const payload = { draftId, expectedRevision: 3, guildId: "1000000001", directMessageWith: "3333333333" };
      const response = await server.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(result);
      expect(checkDiscordSetup).toHaveBeenCalledExactlyOnceWith(payload);
      const bare = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(bare.statusCode).toBe(200);
      expect(checkDiscordSetup).toHaveBeenLastCalledWith({ draftId, expectedRevision: 3 });
    });

    it("takes a strict body", async () => {
      const checkDiscordSetup = vi.fn(async () => result);
      const server = await appWith(checkDiscordSetup);
      for (const payload of [
        { draftId, expectedRevision: 3, token: "abc.def" },
        { draftId, expectedRevision: 3, source: "draft" },
        { draftId: "not-a-guid", expectedRevision: 3 },
        { draftId, expectedRevision: 0 },
        { draftId, expectedRevision: 1.5 },
        { draftId },
        { expectedRevision: 3 },
        {},
      ]) {
        const response = await server.inject({ method: "POST", url, payload });
        expect(response.statusCode).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(checkDiscordSetup).not.toHaveBeenCalled();
    });

    it("takes a server and a person only as Discord ids", async () => {
      const checkDiscordSetup = vi.fn(async () => result);
      const server = await appWith(checkDiscordSetup);
      const bad = ["123456789", "1".repeat(26), "12345678901x", "../guilds", " 1234567890", "1234567890\n", ""];
      for (const field of ["guildId", "directMessageWith"]) {
        for (const value of [...bad, 1234567890]) {
          const response = await server.inject({
            method: "POST",
            url,
            payload: { draftId, expectedRevision: 3, [field]: value },
          });
          expect(response.statusCode).toBe(400);
        }
        for (const value of ["1234567890", "1".repeat(25)]) {
          const response = await server.inject({
            method: "POST",
            url,
            payload: { draftId, expectedRevision: 3, [field]: value },
          });
          expect(response.statusCode).toBe(200);
        }
      }
      expect(checkDiscordSetup).toHaveBeenCalledTimes(4);
    });

    it("answers a refusal with 400 and its fixed sentence", async () => {
      const refusal = "GoatCitadel opens a direct message only with someone who made the bot.";
      const checkDiscordSetup = vi.fn().mockRejectedValue(new ValidationError({ message: refusal }));
      const server = await appWith(checkDiscordSetup);
      const response = await server.inject({
        method: "POST",
        url,
        payload: { draftId, expectedRevision: 3, directMessageWith: "9999999999" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ error: refusal });
    });

    it("answers anything unexpected with a generic 500 that quotes nothing", async () => {
      const checkDiscordSetup = vi.fn().mockRejectedValue(new Error("Authorization: Bot abc.def"));
      const server = await appWith(checkDiscordSetup);
      const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("abc.def");
    });
  });

  describe("Slack setup check", () => {
    const url = "/api/v1/channels/slack/setup-check";
    const draftId = "11111111-1111-1111-1111-111111111111";
    const result = {
      workspace: { id: "T1", name: "Acme" },
      bot: { userId: "UBOT", name: "goatcitadel" },
      appToken: "ok",
      codeSender: { actorId: "U1", directChannelId: "D2", displayName: "Sam" },
      channels: [{ id: "C1", name: "general", private: false }],
    };

    async function appWith(checkSlackSetup: ReturnType<typeof vi.fn>, options: { rateLimited?: true } = {}) {
      app = Fastify();
      decorateIntegrationServices(app, { checkSlackSetup });
      if (options.rateLimited) await app.register(rateLimit, { global: false, allowList: [] });
      await app.register(integrationsRoutes);
      return app;
    }

    it("passes a draft check through, and is never cached", async () => {
      const checkSlackSetup = vi.fn(async () => result);
      const server = await appWith(checkSlackSetup);
      const payload = {
        draftId,
        expectedRevision: 3,
        checkAppToken: true,
        setupCode: "Ab3dEf7hJk",
        listChannels: true,
      };
      const response = await server.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(result);
      expect(checkSlackSetup).toHaveBeenCalledExactlyOnceWith(payload);
      const bare = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(bare.statusCode).toBe(200);
      expect(checkSlackSetup).toHaveBeenLastCalledWith({ draftId, expectedRevision: 3 });
    });

    it("takes a strict body", async () => {
      const checkSlackSetup = vi.fn(async () => result);
      const server = await appWith(checkSlackSetup);
      for (const payload of [
        { draftId, expectedRevision: 3, token: "xoxb-1" },
        { draftId, expectedRevision: 3, botToken: "xoxb-1" },
        { draftId, expectedRevision: 3, source: "draft" },
        { draftId, expectedRevision: 3, guildId: "1234567890" },
        { draftId, expectedRevision: 3, checkAppToken: false },
        { draftId, expectedRevision: 3, checkAppToken: "yes" },
        { draftId, expectedRevision: 3, listChannels: false },
        { draftId, expectedRevision: 3, listChannels: 1 },
        { draftId, expectedRevision: 3, setupCode: 12345 },
        { draftId, expectedRevision: 3, setupCode: null },
        { draftId: "not-a-guid", expectedRevision: 3 },
        { draftId, expectedRevision: 0 },
        { draftId, expectedRevision: 1.5 },
        { draftId },
        { expectedRevision: 3 },
        {},
      ]) {
        const response = await server.inject({ method: "POST", url, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(checkSlackSetup).not.toHaveBeenCalled();
    });

    it("takes a setup code of at most 128 characters", async () => {
      const checkSlackSetup = vi.fn(async () => result);
      const server = await appWith(checkSlackSetup);
      const tooLong = await server.inject({
        method: "POST",
        url,
        payload: { draftId, expectedRevision: 3, setupCode: "a".repeat(129) },
      });
      expect(tooLong.statusCode).toBe(400);
      expect(checkSlackSetup).not.toHaveBeenCalled();
      const longest = await server.inject({
        method: "POST",
        url,
        payload: { draftId, expectedRevision: 3, setupCode: "a".repeat(128) },
      });
      expect(longest.statusCode).toBe(200);
      expect(checkSlackSetup).toHaveBeenCalledTimes(1);
    });

    it("answers a refusal with 400 and its fixed sentence", async () => {
      const refusal = "Slack didn't accept the bot token.";
      const checkSlackSetup = vi.fn().mockRejectedValue(new ValidationError({ message: refusal }));
      const server = await appWith(checkSlackSetup);
      const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ error: refusal });
    });

    it("answers anything unexpected with a generic 500 that quotes nothing", async () => {
      const checkSlackSetup = vi
        .fn()
        .mockRejectedValue(new Error("Authorization: Bearer xoxb-1 wss://wss-primary.slack.com/link/?ticket=abc"));
      const server = await appWith(checkSlackSetup);
      const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("xoxb-1");
      expect(response.body).not.toContain("ticket");
    });

    it("allows 20 checks a minute, then answers 429", async () => {
      const checkSlackSetup = vi.fn(async () => result);
      const server = await appWith(checkSlackSetup, { rateLimited: true });
      for (let index = 0; index < 20; index += 1) {
        const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
        expect(response.statusCode).toBe(200);
      }
      const limited = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(limited.statusCode).toBe(429);
      expect(checkSlackSetup).toHaveBeenCalledTimes(20);
    });
  });

  describe("WhatsApp setup check", () => {
    const url = "/api/v1/channels/whatsapp/setup-check";
    const draftId = "11111111-1111-1111-1111-111111111111";
    const result = {
      number: { displayNumber: "+1 555-078-3881", verifiedName: "Goat Shop" },
      tokenExpiresAt: "2026-01-01T00:00:00.000Z",
      appSubscribed: true,
      addressCheckedAt: "2026-10-29T12:00:00.000Z",
      codeSender: { actorId: "16505551234", displayName: "Sheena" },
    };

    async function appWith(checkWhatsAppSetup: ReturnType<typeof vi.fn>, options: { rateLimited?: true } = {}) {
      app = Fastify();
      decorateIntegrationServices(app, { checkWhatsAppSetup });
      if (options.rateLimited) await app.register(rateLimit, { global: false, allowList: [] });
      await app.register(integrationsRoutes);
      return app;
    }

    it("passes a draft check through, and is never cached", async () => {
      const checkWhatsAppSetup = vi.fn(async () => result);
      const server = await appWith(checkWhatsAppSetup);
      const payload = { draftId, expectedRevision: 3, askMeta: true, setupCode: "Ab3dEf7hJk" };
      const response = await server.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(result);
      expect(checkWhatsAppSetup).toHaveBeenCalledExactlyOnceWith(payload);
      const bare = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(bare.statusCode).toBe(200);
      expect(checkWhatsAppSetup).toHaveBeenLastCalledWith({ draftId, expectedRevision: 3 });
      const listening = await server.inject({
        method: "POST",
        url,
        payload: { draftId, expectedRevision: 3, askMeta: false },
      });
      expect(listening.statusCode).toBe(200);
      expect(checkWhatsAppSetup).toHaveBeenLastCalledWith({ draftId, expectedRevision: 3, askMeta: false });
    });

    it("takes a strict body", async () => {
      const checkWhatsAppSetup = vi.fn(async () => result);
      const server = await appWith(checkWhatsAppSetup);
      for (const payload of [
        { draftId, expectedRevision: 3, accessToken: "EAAG" },
        { draftId, expectedRevision: 3, appSecret: "secret" },
        { draftId, expectedRevision: 3, token: "EAAG" },
        { draftId, expectedRevision: 3, phoneNumberId: "106540352242922" },
        { draftId, expectedRevision: 3, source: "draft" },
        { draftId, expectedRevision: 3, checkAppToken: true },
        { draftId, expectedRevision: 3, askMeta: "yes" },
        { draftId, expectedRevision: 3, askMeta: 1 },
        { draftId, expectedRevision: 3, askMeta: null },
        { draftId: "not-a-guid", expectedRevision: 3 },
        { draftId, expectedRevision: 0 },
        { draftId, expectedRevision: 1.5 },
        { draftId, expectedRevision: "3" },
        { draftId },
        { expectedRevision: 3 },
        {},
      ]) {
        const response = await server.inject({ method: "POST", url, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(checkWhatsAppSetup).not.toHaveBeenCalled();
    });

    it("takes a setup code of 6 to 32 letters and digits", async () => {
      const checkWhatsAppSetup = vi.fn(async () => result);
      const server = await appWith(checkWhatsAppSetup);
      const bad = [
        "Ab3dE",
        "a".repeat(33),
        "Ab3dEf 7hJk",
        "Ab3dEf-7hJk",
        "Ab3dEf7hJk\n",
        " Ab3dEf7hJk",
        "Ab3dEf7hJ_",
        "Ab3dEf7hJé",
        "",
        12345678,
        null,
      ];
      for (const setupCode of bad) {
        const response = await server.inject({
          method: "POST",
          url,
          payload: { draftId, expectedRevision: 3, setupCode },
        });
        expect(response.statusCode, JSON.stringify(setupCode)).toBe(400);
      }
      expect(checkWhatsAppSetup).not.toHaveBeenCalled();
      for (const setupCode of ["a".repeat(6), "Z".repeat(32), "Ab3dEf7hJk"]) {
        const response = await server.inject({
          method: "POST",
          url,
          payload: { draftId, expectedRevision: 3, setupCode },
        });
        expect(response.statusCode, setupCode).toBe(200);
      }
      expect(checkWhatsAppSetup).toHaveBeenCalledTimes(3);
    });

    it("answers a refusal with 400 and its fixed sentence", async () => {
      const refusal = "Meta didn't accept the access token.";
      const checkWhatsAppSetup = vi.fn().mockRejectedValue(new ValidationError({ message: refusal }));
      const server = await appWith(checkWhatsAppSetup);
      const response = await server.inject({
        method: "POST",
        url,
        payload: { draftId, expectedRevision: 3, askMeta: true },
      });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ error: refusal });
    });

    it("answers anything unexpected with a generic 500 that quotes nothing", async () => {
      const checkWhatsAppSetup = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Authorization: Bearer EAAG-access 670843887433847|app-secret https://graph.facebook.com/v23.0/debug_token?input_token=EAAG-access",
          ),
        );
      const server = await appWith(checkWhatsAppSetup);
      const response = await server.inject({
        method: "POST",
        url,
        payload: { draftId, expectedRevision: 3, askMeta: true },
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("EAAG-access");
      expect(response.body).not.toContain("app-secret");
      expect(response.body).not.toContain("input_token");
    });

    it("allows 20 checks a minute, then answers 429", async () => {
      const checkWhatsAppSetup = vi.fn(async () => result);
      const server = await appWith(checkWhatsAppSetup, { rateLimited: true });
      for (let index = 0; index < 20; index += 1) {
        const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
        expect(response.statusCode).toBe(200);
      }
      const limited = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(limited.statusCode).toBe(429);
      expect(checkWhatsAppSetup).toHaveBeenCalledTimes(20);
    });
  });

  describe("WhatsApp setup subscribe", () => {
    const url = "/api/v1/channels/whatsapp/setup-subscribe";
    const draftId = "11111111-1111-1111-1111-111111111111";

    async function appWith(subscribeWhatsAppSetupApp: ReturnType<typeof vi.fn>, options: { rateLimited?: true } = {}) {
      app = Fastify();
      decorateIntegrationServices(app, { subscribeWhatsAppSetupApp });
      if (options.rateLimited) await app.register(rateLimit, { global: false, allowList: [] });
      await app.register(integrationsRoutes);
      return app;
    }

    it("passes a draft through, and is never cached", async () => {
      const subscribeWhatsAppSetupApp = vi.fn(async () => ({ appSubscribed: true }));
      const server = await appWith(subscribeWhatsAppSetupApp);
      const payload = { draftId, expectedRevision: 3 };
      const response = await server.inject({ method: "POST", url, payload });
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual({ appSubscribed: true });
      expect(subscribeWhatsAppSetupApp).toHaveBeenCalledExactlyOnceWith(payload);
    });

    it("takes a strict body", async () => {
      const subscribeWhatsAppSetupApp = vi.fn(async () => ({ appSubscribed: true }));
      const server = await appWith(subscribeWhatsAppSetupApp);
      for (const payload of [
        { draftId, expectedRevision: 3, askMeta: true },
        { draftId, expectedRevision: 3, setupCode: "Ab3dEf7hJk" },
        { draftId, expectedRevision: 3, accessToken: "EAAG" },
        { draftId, expectedRevision: 3, businessAccountId: "102290129340398" },
        { draftId, expectedRevision: 3, source: "draft" },
        { draftId: "not-a-guid", expectedRevision: 3 },
        { draftId, expectedRevision: 0 },
        { draftId, expectedRevision: 1.5 },
        { draftId, expectedRevision: "3" },
        { draftId },
        { expectedRevision: 3 },
        {},
      ]) {
        const response = await server.inject({ method: "POST", url, payload });
        expect(response.statusCode, JSON.stringify(payload)).toBe(400);
        expect(response.headers["cache-control"]).toBe("no-store");
      }
      expect(subscribeWhatsAppSetupApp).not.toHaveBeenCalled();
    });

    it("answers a refusal with 400 and its fixed sentence", async () => {
      const refusal =
        "Meta didn't let this app receive the account's messages. Check that the access token can manage the account.";
      const subscribeWhatsAppSetupApp = vi.fn().mockRejectedValue(new ValidationError({ message: refusal }));
      const server = await appWith(subscribeWhatsAppSetupApp);
      const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(response.statusCode).toBe(400);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({ error: refusal });
    });

    it("records a subscribe Meta may have applied as attempted, and a refusal as a clean failure", async () => {
      const unknown =
        "GoatCitadel couldn't tell whether Meta subscribed the app. Choose Let this app receive your number's messages again; repeating it is safe.";
      const refusal = "Meta refused the request.";
      for (const [error, committed] of [
        [Object.assign(new ValidationError({ message: unknown }), { mutationCommitted: true }), true],
        [new ValidationError({ message: refusal }), false],
      ] as const) {
        const server = await appWith(vi.fn().mockRejectedValue(error));
        let seen: unknown;
        server.addHook("onResponse", async (request) => {
          seen = (request as { mutationCommitted?: boolean }).mutationCommitted === true;
        });
        const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error: error.message });
        expect(seen).toBe(committed);
        await server.close();
      }
    });

    it("answers anything unexpected with a generic 500 that quotes nothing", async () => {
      const subscribeWhatsAppSetupApp = vi
        .fn()
        .mockRejectedValue(new Error("POST /102290129340398/subscribed_apps Authorization: Bearer EAAG-access"));
      const server = await appWith(subscribeWhatsAppSetupApp);
      const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("EAAG-access");
      expect(response.body).not.toContain("subscribed_apps");
    });

    it("allows 20 subscriptions a minute, then answers 429", async () => {
      const subscribeWhatsAppSetupApp = vi.fn(async () => ({ appSubscribed: true }));
      const server = await appWith(subscribeWhatsAppSetupApp, { rateLimited: true });
      for (let index = 0; index < 20; index += 1) {
        const response = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
        expect(response.statusCode).toBe(200);
      }
      const limited = await server.inject({ method: "POST", url, payload: { draftId, expectedRevision: 3 } });
      expect(limited.statusCode).toBe(429);
      expect(subscribeWhatsAppSetupApp).toHaveBeenCalledTimes(20);
    });
  });

  it("puts both WhatsApp setup routes in the operator access class", async () => {
    app = Fastify();
    installRouteAccessTracking(app);
    decorateIntegrationServices(app, { checkWhatsAppSetup: vi.fn(), subscribeWhatsAppSetupApp: vi.fn() });
    await app.register(integrationsRoutes);
    for (const url of ["/api/v1/channels/whatsapp/setup-check", "/api/v1/channels/whatsapp/setup-subscribe"]) {
      expect(app.routeAccessManifest.filter((entry) => entry.url === url)).toEqual([
        { method: "POST", url, accessClass: "operator", classificationSource: "policy", tracked: true },
      ]);
    }
  });
});
