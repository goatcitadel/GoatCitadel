import { describe, expect, it, vi } from "vitest";
import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { runDiscordBotLiveChecks } from "../channel-bot-live-probes.js";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";

const discord = requireChannelSetupDefinition("channel.discord");

function connection(config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label: "Discord",
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

function draftOf(draft: Record<string, unknown>): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
    revision: 1,
    catalogId: "channel.discord",
    lifecycleMode: "create",
    enabled: true,
    draft,
    secretState: {},
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-10-28T00:00:00.000Z",
    updatedAt: "2026-10-28T00:00:00.000Z",
  };
}

const DM_CHANNEL_ID = "555555555555555555";

describe("Discord setup keeps who made the bot", () => {
  it("keeps who made the bot and the application", () => {
    const config = discord.normalize(
      draftOf({
        runtimeMode: "gateway",
        botToken: "test-token",
        defaultChannelId: "444444444444444444",
        defaultGuildId: "666666666666666666",
        ownerActorIds: ["333"],
        applicationId: "222",
      }),
    );

    expect(config.ownerActorIds).toEqual(["333"]);
    expect(config.applicationId).toBe("222");

    const hydrated = discord.hydrate(
      connection({ runtimeMode: "gateway", ownerActorIds: ["333"], applicationId: "222" }),
    );
    expect(hydrated.draft.ownerActorIds).toEqual(["333"]);
    expect(hydrated.draft.applicationId).toBe("222");
    expect(hydrated.hydration.fieldState.ownerActorIds).toBe("configured");
    expect(hydrated.hydration.fieldState.applicationId).toBe("configured");

    // Editing a saved connection carries both through the draft and back into the config.
    const edited = discord.normalize(draftOf({ ...hydrated.draft, defaultChannelId: "444444444444444444" }));
    expect(edited.ownerActorIds).toEqual(["333"]);
    expect(edited.applicationId).toBe("222");
  });

  it("cleans the ids the way the runtime reads them", () => {
    const config = discord.normalize(
      draftOf({ runtimeMode: "gateway", ownerActorIds: [" 333 ", "333", "", 7], applicationId: " 222 " }),
    );

    expect(config.ownerActorIds).toEqual(["333"]);
    expect(config.applicationId).toBe("222");
  });

  it("leaves them out when the draft has none", () => {
    const config = discord.normalize(draftOf({ runtimeMode: "gateway", botToken: "test-token" }));

    // A key left out keeps the saved connection's own value on edit.
    expect(config).not.toHaveProperty("ownerActorIds");
    expect(config).not.toHaveProperty("applicationId");

    const emptied = discord.normalize(draftOf({ runtimeMode: "gateway", ownerActorIds: [], applicationId: "  " }));
    expect(emptied).not.toHaveProperty("ownerActorIds");
    expect(emptied).not.toHaveProperty("applicationId");

    const hydrated = discord.hydrate(connection({ runtimeMode: "gateway" }));
    expect(hydrated.draft).not.toHaveProperty("ownerActorIds");
    expect(hydrated.draft).not.toHaveProperty("applicationId");
    expect(hydrated.hydration.fieldState.ownerActorIds).toBe("unknown");
    expect(hydrated.hydration.fieldState.applicationId).toBe("unknown");
  });

  it("keeps who may message the bot and the access mode the page chose", () => {
    const config = discord.normalize(
      draftOf({
        runtimeMode: "gateway",
        inboundAccessMode: "allowlist",
        allowedSenders: [" 333 ", "333", ""],
        ownerActorIds: ["333"],
      }),
    );

    expect(config.inboundAccessMode).toBe("allowlist");
    expect(config.allowedSenders).toEqual(["333"]);

    const hydrated = discord.hydrate(
      connection({
        runtimeMode: "gateway",
        inboundAccessMode: "allowlist",
        allowedSenders: ["333"],
        ownerActorIds: ["333"],
      }),
    );
    expect(hydrated.draft.inboundAccessMode).toBe("allowlist");
    expect(hydrated.draft.allowedSenders).toEqual(["333"]);
    expect(hydrated.hydration.fieldState.inboundAccessMode).toBe("configured");
    expect(hydrated.hydration.fieldState.allowedSenders).toBe("configured");

    // Editing a saved connection carries both back into the config.
    const edited = discord.normalize(draftOf({ ...hydrated.draft, defaultChannelId: "444444444444444444" }));
    expect(edited.inboundAccessMode).toBe("allowlist");
    expect(edited.allowedSenders).toEqual(["333"]);
    expect(edited.ownerActorIds).toEqual(["333"]);
  });

  it("leaves the sender list and access mode out when the draft has none", () => {
    for (const values of [
      { runtimeMode: "gateway" },
      { runtimeMode: "gateway", allowedSenders: [], inboundAccessMode: "  " },
      // A mode Discord does not know is not saved, and the test says so.
      { runtimeMode: "gateway", inboundAccessMode: "carrier-pigeon" },
    ]) {
      const config = discord.normalize(draftOf(values));

      // A key left out keeps the saved connection's own value on edit.
      expect(config).not.toHaveProperty("allowedSenders");
      expect(config).not.toHaveProperty("inboundAccessMode");
    }

    const hydrated = discord.hydrate(connection({ runtimeMode: "gateway", ownerActorIds: ["333"] }));
    expect(hydrated.draft).not.toHaveProperty("allowedSenders");
    expect(hydrated.draft).not.toHaveProperty("inboundAccessMode");
    expect(hydrated.hydration.fieldState.allowedSenders).toBe("unknown");
    expect(hydrated.hydration.fieldState.inboundAccessMode).toBe("unknown");
  });

  it("flags an access mode or sender list it cannot save", () => {
    const base = { runtimeMode: "gateway", botToken: "test-token", guildPolicy: "off" };

    expect(discord.validate(draftOf({ ...base, inboundAccessMode: "allowlist", allowedSenders: ["333"] }))).toEqual([]);
    expect(discord.validate(draftOf({ ...base, inboundAccessMode: "carrier-pigeon" }))).toEqual([
      expect.objectContaining({ fieldKey: "inboundAccessMode", level: "error" }),
    ]);
    expect(discord.validate(draftOf({ ...base, allowedSenders: "333" }))).toEqual([
      expect.objectContaining({ fieldKey: "allowedSenders", level: "error" }),
    ]);
  });

  it("passes the setup test with a DM channel as the default", async () => {
    const draft = draftOf({
      runtimeMode: "gateway",
      botToken: "test-token",
      guildPolicy: "off",
      defaultChannelId: DM_CHANNEL_ID,
    });
    const config = discord.normalize(draft);

    expect(discord.validate(draft).filter((issue) => issue.level === "error")).toEqual([]);
    expect(config).not.toHaveProperty("defaultGuildId");

    const fetcher = vi.fn(async (url: string) => {
      if (url === "https://discord.com/api/v10/users/@me") {
        return new Response(JSON.stringify({ id: "222", username: "goat-bot" }), { status: 200 });
      }
      if (url === `https://discord.com/api/v10/channels/${DM_CHANNEL_ID}`) {
        // Discord reports a DM channel as type 1 with no server.
        return new Response(JSON.stringify({ id: DM_CHANNEL_ID, type: 1 }), { status: 200 });
      }
      throw new Error(`unexpected probe call: ${url}`);
    });

    const result = await runDiscordBotLiveChecks({
      token: "test-token",
      channelId: config.defaultChannelId as string | undefined,
      guildId: config.defaultGuildId as string | undefined,
      runtimeMode: "gateway",
      runtimeReadiness: "deferred",
      includeSandboxSend: false,
      fetcher,
    });

    const failed = result.probe.steps.filter((probeStep) => probeStep.status === "fail");
    expect(failed).toEqual([]);
    expect(result.probe.steps.find((probeStep) => probeStep.key === "discord_channel_access")?.status).toBe("pass");
    expect(
      result.probe.steps.find((probeStep) => probeStep.key === "discord_channel_access_guild_match")?.status,
    ).not.toBe("fail");
  });
});
