import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerChannelSetupIntegrationRoutes } from "./integrations-channel-setup-routes.js";

const DRAFT_ID = "11111111-1111-1111-1111-111111111111";
const CONNECTION_ID = "22222222-2222-2222-2222-222222222222";

describe("channel setup route tails", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("keeps validation and service failure envelopes stable across setup draft endpoints", async () => {
    const channelSetup = {
      listChannelSetupDrafts: vi.fn(() => []),
      listChannelSetupDefinitions: vi.fn(() => []),
      getChannelSetupDefinition: vi.fn(() => {
        throw new Error("definition missing");
      }),
      createChannelSetupDraft: vi.fn(() => {
        throw new Error("create failed");
      }),
      updateChannelSetupDraft: vi.fn(() => {
        throw new Error("update failed");
      }),
      validateChannelSetupDraft: vi.fn(() => {
        throw new Error("validate failed");
      }),
      testChannelSetupDraft: vi.fn(async () => {
        throw new Error("test failed");
      }),
      finalizeChannelSetupDraft: vi.fn(async () => {
        throw new Error("finalize failed");
      }),
      createChannelSetupRepairDraft: vi.fn(() => {
        throw new Error("repair failed");
      }),
      createChannelSetupRotateSecretDraft: vi.fn(() => {
        throw new Error("rotate failed");
      }),
      retestChannelConnection: vi.fn(async () => {
        throw new Error("retest failed");
      }),
    };
    app = buildApp(channelSetup);

    await expectStatus("GET", "/api/v1/channels/drafts?limit=0", 400);
    await expectStatus("GET", "/api/v1/channels/catalog/no/setup-definition", 400);
    await expectError("GET", "/api/v1/channels/catalog/channel.discord/setup-definition", 404, "definition missing");
    await expectStatus("POST", "/api/v1/channels/drafts", 400, {});
    await expectError("POST", "/api/v1/channels/drafts", 400, "create failed", {
      catalogId: "channel.discord",
      lifecycleMode: "create",
    });
    await expectStatus("PATCH", "/api/v1/channels/drafts/not-a-uuid", 400, { label: "" });
    await expectError("PATCH", `/api/v1/channels/drafts/${DRAFT_ID}`, 400, "update failed", {
      enabled: false,
    });
    await expectStatus("POST", "/api/v1/channels/drafts/not-a-uuid/validate", 400);
    await expectError("POST", `/api/v1/channels/drafts/${DRAFT_ID}/validate`, 404, "validate failed");
    await expectStatus("POST", "/api/v1/channels/drafts/not-a-uuid/test", 400);
    await expectError("POST", `/api/v1/channels/drafts/${DRAFT_ID}/test`, 404, "test failed");
    await expectStatus("POST", "/api/v1/channels/drafts/not-a-uuid/finalize", 400);
    await expectError("POST", `/api/v1/channels/drafts/${DRAFT_ID}/finalize`, 400, "finalize failed");
    await expectStatus("POST", "/api/v1/channels/connections/not-a-uuid/repair-draft", 400);
    await expectError("POST", `/api/v1/channels/connections/${CONNECTION_ID}/repair-draft`, 400, "repair failed");
    await expectStatus("POST", "/api/v1/channels/connections/not-a-uuid/rotate-secret-draft", 400);
    await expectError(
      "POST",
      `/api/v1/channels/connections/${CONNECTION_ID}/rotate-secret-draft`,
      400,
      "rotate failed",
    );
    await expectStatus("POST", "/api/v1/channels/connections/not-a-uuid/retest", 400);
    await expectError("POST", `/api/v1/channels/connections/${CONNECTION_ID}/retest`, 400, "retest failed");

    expect(channelSetup.getChannelSetupDefinition).toHaveBeenCalledWith("channel.discord");
    expect(channelSetup.updateChannelSetupDraft).toHaveBeenCalledWith(DRAFT_ID, { enabled: false });
    expect(channelSetup.createChannelSetupRepairDraft).toHaveBeenCalledWith(CONNECTION_ID);
    expect(channelSetup.createChannelSetupRotateSecretDraft).toHaveBeenCalledWith(CONNECTION_ID);
    expect(channelSetup.retestChannelConnection).toHaveBeenCalledWith(CONNECTION_ID);
  });

  async function expectStatus(
    method: "GET" | "POST" | "PATCH",
    url: string,
    statusCode: number,
    payload?: unknown,
  ): Promise<void> {
    const response = await app!.inject({ method, url, payload });
    expect(response.statusCode).toBe(statusCode);
  }

  async function expectError(
    method: "GET" | "POST" | "PATCH",
    url: string,
    statusCode: number,
    error: string,
    payload?: unknown,
  ): Promise<void> {
    const response = await app!.inject({ method, url, payload });
    expect(response.statusCode).toBe(statusCode);
    expect(response.json()).toEqual({ error });
  }
});

function buildApp(channelSetup: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { channelSetup } as never);
  registerChannelSetupIntegrationRoutes(next);
  return next;
}
