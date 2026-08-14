import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ChannelSetupDraft, ChannelSetupFinalizeResult, IntegrationConnection } from "@goatcitadel/contracts";
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
      expectedRevision: 1,
      enabled: false,
    });
    await expectStatus("POST", "/api/v1/channels/drafts/not-a-uuid/validate", 400);
    await expectError("POST", `/api/v1/channels/drafts/${DRAFT_ID}/validate`, 404, "validate failed", {
      expectedRevision: 1,
    });
    await expectStatus("POST", "/api/v1/channels/drafts/not-a-uuid/test", 400);
    await expectError("POST", `/api/v1/channels/drafts/${DRAFT_ID}/test`, 404, "test failed", { expectedRevision: 1 });
    await expectStatus("POST", "/api/v1/channels/drafts/not-a-uuid/finalize", 400);
    await expectError("POST", `/api/v1/channels/drafts/${DRAFT_ID}/finalize`, 400, "finalize failed", {
      expectedRevision: 1,
    });
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
    expect(channelSetup.updateChannelSetupDraft).toHaveBeenCalledWith(DRAFT_ID, {
      expectedRevision: 1,
      enabled: false,
    });
    expect(channelSetup.createChannelSetupRepairDraft).toHaveBeenCalledWith(CONNECTION_ID);
    expect(channelSetup.createChannelSetupRotateSecretDraft).toHaveBeenCalledWith(CONNECTION_ID);
    expect(channelSetup.retestChannelConnection).toHaveBeenCalledWith(CONNECTION_ID);
  });

  it("projects secret-bearing draft and finalized connection responses without mutating raw setup state", async () => {
    const rawDraft = createSecretBearingDraft();
    const rawFinalizeResult = createSecretBearingFinalizeResult();
    const channelSetup = {
      listChannelSetupDrafts: vi.fn(() => [rawDraft]),
      listChannelSetupDefinitions: vi.fn(() => []),
      getChannelSetupDefinition: vi.fn(() => ({})),
      createChannelSetupDraft: vi.fn(() => rawDraft),
      updateChannelSetupDraft: vi.fn(() => rawDraft),
      validateChannelSetupDraft: vi.fn(() => rawFinalizeResult.validation),
      testChannelSetupDraft: vi.fn(async () => rawFinalizeResult.test),
      finalizeChannelSetupDraft: vi.fn(async () => rawFinalizeResult),
      createChannelSetupRepairDraft: vi.fn(() => rawDraft),
      createChannelSetupRotateSecretDraft: vi.fn(() => rawDraft),
      retestChannelConnection: vi.fn(async () => rawFinalizeResult.test),
    };
    app = buildApp(channelSetup);

    const listed = await app.inject({ method: "GET", url: "/api/v1/channels/drafts" });
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/channels/drafts",
      payload: { catalogId: "channel.slack" },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/channels/drafts/${DRAFT_ID}`,
      payload: {
        expectedRevision: 1,
        draft: {
          botToken: "[REDACTED]",
          webhookUrl: "[REDACTED]",
          channelId: "C-NEXT",
        },
      },
    });
    const repaired = await app.inject({
      method: "POST",
      url: `/api/v1/channels/connections/${CONNECTION_ID}/repair-draft`,
    });
    const rotated = await app.inject({
      method: "POST",
      url: `/api/v1/channels/connections/${CONNECTION_ID}/rotate-secret-draft`,
    });
    const finalized = await app.inject({
      method: "POST",
      url: `/api/v1/channels/drafts/${DRAFT_ID}/finalize`,
      payload: { expectedRevision: 1 },
    });
    const validated = await app.inject({
      method: "POST",
      url: `/api/v1/channels/drafts/${DRAFT_ID}/validate`,
      payload: { expectedRevision: 1 },
    });
    const tested = await app.inject({
      method: "POST",
      url: `/api/v1/channels/drafts/${DRAFT_ID}/test`,
      payload: { expectedRevision: 1 },
    });
    const retested = await app.inject({
      method: "POST",
      url: `/api/v1/channels/connections/${CONNECTION_ID}/retest`,
    });

    const publicDrafts = [listed.json().items[0], created.json(), updated.json(), repaired.json(), rotated.json()];
    for (const draft of publicDrafts) {
      expect(draft.draft).toMatchObject({
        botToken: "[REDACTED]",
        webhookUrl: "[REDACTED]",
        botTokenEnv: "SLACK_BOT_TOKEN",
        channelId: "C-OLD",
      });
      expect(draft.hydration.rawLegacyConfig).toMatchObject({
        botToken: "[REDACTED]",
        DATABASE_PASSWORD: "[REDACTED]",
        botTokenEnv: "SLACK_BOT_TOKEN",
        secretRef: "keychain:slack-bot-token",
        requestCount: 17,
      });
    }
    expect(finalized.json().connection.config).toMatchObject({
      botToken: "[REDACTED]",
      webhookUrl: "[REDACTED]",
      botTokenEnv: "SLACK_BOT_TOKEN",
      channelId: "C-OLD",
    });
    for (const response of [validated, tested, retested]) {
      expect(response.body).not.toContain("probe-short");
      expect(response.body).not.toContain("validation-short");
      expect(response.body).toContain("[REDACTED]");
    }
    expect(finalized.body).not.toContain("validation-short");
    expect(finalized.body).not.toContain("probe-short");
    expect(
      JSON.stringify([
        listed.json(),
        created.json(),
        updated.json(),
        repaired.json(),
        rotated.json(),
        finalized.json(),
      ]),
    ).not.toContain("bot-short");
    expect(rawDraft.draft.botToken).toBe("bot-short");
    expect(rawDraft.hydration?.rawLegacyConfig?.DATABASE_PASSWORD).toBe("db-short");
    expect(rawFinalizeResult.connection.config.botToken).toBe("bot-short");
    expect(rawFinalizeResult.validation.issues[0]?.message).toContain("validation-short");
    expect(rawFinalizeResult.test?.probe?.steps[0]?.message).toContain("probe-short");
  });

  it("turns the legacy finalize route into a Change Plan without mutating when evolution is enabled", async () => {
    const rawDraft = createSecretBearingDraft();
    const finalizeChannelSetupDraft = vi.fn();
    const create = vi.fn(async () => ({
      planId: "plan-channel-finalize",
      revision: 1,
      status: "awaiting_confirmation",
    }));
    app = buildApp(
      {
        listChannelSetupDrafts: vi.fn(async () => [rawDraft]),
        finalizeChannelSetupDraft,
      },
      {
        isEnabled: vi.fn(async () => true),
        create,
      },
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/channels/drafts/${DRAFT_ID}/finalize`,
      payload: { expectedRevision: rawDraft.revision },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      finalized: false,
      draft: { draftId: DRAFT_ID, revision: rawDraft.revision },
      changePlan: { planId: "plan-channel-finalize", status: "awaiting_confirmation" },
    });
    expect(finalizeChannelSetupDraft).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTargetRevision: rawDraft.revision,
        request: { kind: "channel_connection", channelKind: "channel.slack", draftId: DRAFT_ID },
      }),
    );
    expect(response.body).not.toContain("bot-short");
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

function buildApp(channelSetup: Record<string, unknown>, evolution?: Record<string, unknown>): FastifyInstance {
  const next = Fastify();
  next.decorate("services", { channelSetup, ...(evolution ? { evolution } : {}) } as never);
  registerChannelSetupIntegrationRoutes(next);
  return next;
}

function createSecretBearingDraft(): ChannelSetupDraft {
  return {
    draftId: DRAFT_ID,
    revision: 1,
    catalogId: "channel.slack",
    connectionId: CONNECTION_ID,
    lifecycleMode: "repair",
    label: "Slack",
    enabled: true,
    draft: {
      botToken: "bot-short",
      webhookUrl: "https://hooks.example.test/events?token=hook-short&mode=events",
      botTokenEnv: "SLACK_BOT_TOKEN",
      channelId: "C-OLD",
    },
    hydration: {
      status: "opaque-secret",
      fieldState: { botToken: "configured" },
      warnings: [],
      rawLegacyConfig: {
        botToken: "bot-short",
        DATABASE_PASSWORD: "db-short",
        botTokenEnv: "SLACK_BOT_TOKEN",
        secretRef: "keychain:slack-bot-token",
        requestCount: 17,
      },
    },
    contentVersion: "1",
    adapterVersion: "1",
    validationVersion: "1",
    testVersion: "1",
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function createSecretBearingFinalizeResult(): ChannelSetupFinalizeResult {
  const draft = createSecretBearingDraft();
  const connection: IntegrationConnection = {
    connectionId: CONNECTION_ID,
    catalogId: draft.catalogId,
    kind: "channel",
    key: "slack",
    label: "Slack",
    enabled: true,
    status: "connected",
    config: structuredClone(draft.draft),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
  return {
    draftRevision: draft.revision,
    connection,
    validation: {
      draftId: draft.draftId,
      draftRevision: draft.revision,
      status: "warn",
      levels: ["structural"],
      issues: [
        {
          key: "remote_validation",
          level: "warn",
          message: "Authorization: Bearer validation-short",
          detail: "https://remote.example.test/check?token=validation-short",
        },
      ],
      checkedAt: draft.updatedAt,
    },
    test: {
      draftId: draft.draftId,
      draftRevision: draft.revision,
      status: "ok",
      levels: ["live_auth"],
      issues: [],
      checkedAt: draft.updatedAt,
      probe: {
        kind: "slack",
        checkedAt: draft.updatedAt,
        steps: [
          {
            key: "remote_body",
            label: "Remote response",
            status: "warn",
            message: 'Remote body: {"token":"probe-short"}',
          },
        ],
      },
    },
  };
}
