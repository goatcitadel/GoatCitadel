import { describe, expect, it } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { requireChannelSetupDefinition } from "./channel-setup-definitions.js";

describe("channel setup definition loop28 tails", () => {
  it("preserves LINE legacy token aliases while keeping saved secrets opaque", () => {
    const definition = requireChannelSetupDefinition("channel.line");
    const hydrated = definition.hydrate(
      connection("channel.line", "line", {
        accessToken: "line-token",
        secretEnv: "LINE_CHANNEL_SECRET",
        defaultTarget: "Utarget",
      }),
    );

    expect(hydrated.hydration).toMatchObject({
      status: "opaque-secret",
      fieldState: {
        channelAccessToken: "configured",
        channelAccessTokenEnv: "unknown",
        channelSecret: "configured",
        channelSecretEnv: "configured",
        defaultTarget: "configured",
      },
    });
    expect(hydrated.draft).toEqual({
      channelAccessTokenEnv: undefined,
      channelSecretEnv: "LINE_CHANNEL_SECRET",
      defaultTarget: "Utarget",
    });
    expect(
      definition.normalize({
        ...draft("channel.line", hydrated.draft, "edit"),
        hydration: hydrated.hydration,
      }),
    ).toEqual({
      channelAccessToken: "line-token",
      channelSecretEnv: "LINE_CHANNEL_SECRET",
      defaultTarget: "Utarget",
    });
    expect(definition.validate(draft("channel.line", {})).map((issue) => issue.key)).toEqual([
      "line_auth_missing",
      "defaultTarget_required",
    ]);
  });

  it("normalizes secret alias families for WhatsApp, iMessage, Mattermost, Nextcloud Talk, and Zalo user", () => {
    const cases = [
      {
        catalogId: "channel.whatsapp",
        key: "whatsapp",
        config: {
          tokenEnv: "WHATSAPP_TOKEN",
          webhookSecretEnv: "WHATSAPP_APP_SECRET",
          verifyTokenEnv: "WHATSAPP_VERIFY_TOKEN",
          phoneNumberId: "123456789",
          defaultTarget: "+15555550123",
        },
        expected: {
          accessTokenEnv: "WHATSAPP_TOKEN",
          appSecretEnv: "WHATSAPP_APP_SECRET",
          webhookVerifyTokenEnv: "WHATSAPP_VERIFY_TOKEN",
          phoneNumberId: "123456789",
          defaultTarget: "+15555550123",
        },
      },
      {
        catalogId: "channel.imessage",
        key: "imessage",
        config: {
          serverUrl: "http://mac-mini.local:1234",
          apiPasswordEnv: "BLUBBLES_PASSWORD",
          defaultHandle: "+15555550123",
        },
        expected: {
          bridgeProvider: "bluebubbles",
          bridgeUrl: "http://mac-mini.local:1234",
          passwordEnv: "BLUBBLES_PASSWORD",
          defaultHandle: "+15555550123",
        },
      },
      {
        catalogId: "channel.mattermost",
        key: "mattermost",
        config: {
          serverUrl: "https://mattermost.local",
          tokenEnv: "MATTERMOST_TOKEN",
          defaultChannel: "town-square",
          defaultTeam: "ops",
        },
        expected: {
          serverUrl: "https://mattermost.local",
          botTokenEnv: "MATTERMOST_TOKEN",
          defaultChannel: "town-square",
          defaultTeam: "ops",
        },
      },
      {
        catalogId: "channel.nextcloud-talk",
        key: "nextcloud-talk",
        config: {
          baseUrl: "https://nextcloud.local",
          botSecretEnv: "NEXTCLOUD_BOT_SECRET",
          defaultRoomId: "room-1",
        },
        expected: {
          baseUrl: "https://nextcloud.local",
          tokenEnv: "NEXTCLOUD_BOT_SECRET",
          defaultRoomId: "room-1",
        },
      },
      {
        catalogId: "channel.zalouser",
        key: "zalouser",
        config: {
          bridgeUrl: "http://zalo-bridge.local",
          authorizationEnv: "ZALO_AUTH",
          profile: "default",
          defaultTarget: "zalo-recipient",
        },
        expected: {
          baseUrl: "http://zalo-bridge.local",
          authTokenEnv: "ZALO_AUTH",
          profile: "default",
          defaultTarget: "zalo-recipient",
        },
      },
    ] as const;

    for (const item of cases) {
      const definition = requireChannelSetupDefinition(item.catalogId);
      const hydrated = definition.hydrate(connection(item.catalogId, item.key, item.config));
      expect(hydrated.hydration.status).toBe("opaque-secret");
      expect(
        definition.normalize({
          ...draft(item.catalogId, hydrated.draft, "edit"),
          hydration: hydrated.hydration,
        }),
      ).toEqual(item.expected);
      expect(
        definition.validate({
          ...draft(item.catalogId, hydrated.draft, "retest"),
          hydration: hydrated.hydration,
        }),
      ).toEqual([]);
    }
  });

  it("reports malformed URLs and missing required targets without treating opaque secrets as user input", () => {
    const expectations = [
      {
        catalogId: "channel.whatsapp",
        draft: { accessTokenEnv: "WHATSAPP_TOKEN", phoneNumberId: "abc", defaultTarget: "" },
        keys: ["phoneNumberId_malformed", "defaultTarget_required"],
      },
      {
        catalogId: "channel.imessage",
        draft: { bridgeUrl: "mac-mini.local", passwordEnv: "IMESSAGE_PASSWORD" },
        keys: ["bridgeUrl_malformed", "defaultHandle_required"],
      },
      {
        catalogId: "channel.mattermost",
        draft: { serverUrl: "mattermost.local", botTokenEnv: "MATTERMOST_TOKEN" },
        keys: ["serverUrl_malformed", "defaultChannel_required"],
      },
      {
        catalogId: "channel.nextcloud-talk",
        draft: { baseUrl: "nextcloud.local", tokenEnv: "NEXTCLOUD_TOKEN" },
        keys: ["baseUrl_malformed", "defaultRoomId_required"],
      },
      {
        catalogId: "channel.zalouser",
        draft: { baseUrl: "zalo-bridge.local" },
        keys: ["baseUrl_malformed", "defaultTarget_required"],
      },
    ];

    for (const item of expectations) {
      const definition = requireChannelSetupDefinition(item.catalogId);
      expect(definition.validate(draft(item.catalogId, item.draft)).map((issue) => issue.key)).toEqual(item.keys);
    }
  });

  it("keeps Discord gateway and bridge validation explicit", () => {
    const definition = requireChannelSetupDefinition("channel.discord");

    expect(
      definition.validate(
        draft("channel.discord", {
          runtimeMode: "gateway",
          defaultChannelId: "not-a-channel",
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "defaultChannelId_malformed" }),
        expect.objectContaining({ key: "botTokenEnv_required" }),
      ]),
    );

    expect(
      definition.validate(
        draft("channel.discord", {
          runtimeMode: "bridge",
          defaultChannelId: "123456789012345678",
          webhookUrl: "https://example.com/not-discord",
        }),
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ key: "webhookUrl_malformed" })]));
  });
});

function connection(catalogId: string, key: string, config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "33333333-3333-3333-3333-333333333333",
    catalogId,
    kind: "channel",
    key,
    label: `${key} primary`,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  } as IntegrationConnection;
}

function draft(
  catalogId: string,
  values: Record<string, unknown>,
  lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create",
): ChannelSetupDraft {
  return {
    draftId: "44444444-4444-4444-4444-444444444444",
    catalogId,
    lifecycleMode,
    enabled: true,
    draft: values,
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}
