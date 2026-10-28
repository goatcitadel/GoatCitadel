import { describe, expect, it, vi } from "vitest";
import type {
  ChannelSetupDraft,
  ChannelSetupFieldDefinition,
  ChannelSetupRichBlock,
  ChannelSetupStepDefinition,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { runDiscordBotLiveChecks } from "../channel-bot-live-probes.js";
import { requireChannelSetupDefinition } from "../channel-setup-definitions.js";
import { guideFinish } from "./guide-finish.test-support.js";

function guide() {
  return requireChannelSetupDefinition("channel.discord");
}

function step(id: string): ChannelSetupStepDefinition {
  const found = guide().definition.wizard.steps.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Discord guide has no step ${id}`);
  return found;
}

function field(key: string): ChannelSetupFieldDefinition {
  const found = guide()
    .definition.wizard.steps.flatMap((candidate) => candidate.fields ?? [])
    .find((candidate) => candidate.key === key);
  if (!found) throw new Error(`Discord guide has no field ${key}`);
  return found;
}

function fieldKeys(id: string): string[] {
  return (step(id).fields ?? []).map((candidate) => candidate.key);
}

function textOf(blocks: readonly ChannelSetupRichBlock[] | undefined): string {
  return (blocks ?? []).map((block) => JSON.stringify(block)).join("\n");
}

function paragraphs(id: string): string[] {
  return (step(id).body ?? []).flatMap((block) => (block.kind === "paragraph" ? [block.text] : []));
}

function draftOf(
  values: Record<string, unknown>,
  lifecycleMode: ChannelSetupDraft["lifecycleMode"] = "create",
): ChannelSetupDraft {
  return {
    draftId: "22222222-2222-2222-2222-222222222222",
    catalogId: "channel.discord",
    lifecycleMode,
    enabled: true,
    draft: values,
    revision: 1,
    secretState: {},
    contentVersion: "content.v1",
    adapterVersion: "adapter.v1",
    validationVersion: "validation.v1",
    testVersion: "test.v1",
    createdAt: "2026-03-29T00:00:00.000Z",
    updatedAt: "2026-03-29T00:00:00.000Z",
  };
}

const CHANNEL_ID = "123456789012345678";
const GUILD_ID = "987654321098765432";

describe("Discord setup guide: what it says up front", () => {
  it("opens with the intro, prerequisites and first message from the audit", () => {
    const wizard = guide().definition.wizard;

    expect(wizard.introSummary).toBe(
      "Chat with your Discord bot in direct messages, or let it answer in one server channel when mentioned. No public web address is needed.",
    );
    expect(wizard.prerequisites).toEqual([
      "A Discord application with a bot. Turn on Message Content Intent on its Bot page.",
      "To use it in a server: permission to add the bot, and View Channel, Send Messages and Read Message History in that channel.",
    ]);
    expect(paragraphs("first-message")).toEqual([
      "Wait until the connection shows ready. In a server, mention the bot in the chosen channel. For a direct message, send one, approve the pairing request in Settings › Channels › this connection › Connection operations, then send another and check the reply.",
    ]);
  });

  it("keeps the title that covers who may message the bot on the destinations step", () => {
    expect(step("collect-values-destinations").title).toBe("Choose destinations and access");
  });

  it("uses no words the operator copy rules ban anywhere in the guide", () => {
    const text = JSON.stringify(guide().definition.wizard);

    expect(text).not.toMatch(/posture|provenance|ingress|egress|sandbox message|activation plan/iu);
  });
});

describe("Discord setup guide: the bot token (item 1)", () => {
  it("lists the pasted token before the variable name that holds it", () => {
    const keys = fieldKeys("collect-values-identity");

    expect(keys.indexOf("botToken")).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf("botToken")).toBeLessThan(keys.indexOf("botTokenEnv"));
  });

  it("makes pasting the token the main choice, with the shared storage wording", () => {
    const token = field("botToken");

    expect(token.label).toBe("Bot token");
    // Ruling R39: the shared builder's wording wins over the audit's "Paste the bot token." sentence.
    expect(token.explanation).toBe("Paste it here. GoatCitadel keeps it in this computer's secure storage.");
    expect(token.whyNeeded).toBeUndefined();
    expect(token.placeholder).toBeUndefined();
    expect(token.advanced).not.toBe(true);
    expect(token.required).toBe(false);
  });

  it("makes the variable name an expert option that says how to name it", () => {
    const variable = field("botTokenEnv");

    expect(variable.label).toBe("Bot token from an environment variable (advanced)");
    expect(variable.advanced).toBe(true);
    expect(variable.explanation).toBe(
      "Name of the environment variable that holds your Discord bot token. The variable's name must start with DISCORD_ (for example DISCORD_BOT_TOKEN). Set it where GoatCitadel starts, then restart GoatCitadel.",
    );
  });

  it("says where to find the token the way Discord's own quick start does", () => {
    expect(textOf(field("botToken").whereToFind)).toContain("Reset Token");
  });

  it("tells a person who set a variable to check its name when the test cannot find the token", async () => {
    const fetcher = vi.fn();
    const result = await runDiscordBotLiveChecks({ runtimeMode: "gateway", includeSandboxSend: false, fetcher });

    expect(result.probe.steps.find((probeStep) => probeStep.key === "discord_token_auth")).toMatchObject({
      status: "fail",
      message:
        "Discord bot token not found. If you used an environment variable, check its name starts with DISCORD_ and restart GoatCitadel.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends a missing-token error to the token field, not to the expert variable field", () => {
    const issues = guide().validate(
      draftOf({ runtimeMode: "gateway", guildPolicy: "off", defaultChannelId: CHANNEL_ID }),
    );

    expect(issues).toEqual([
      expect.objectContaining({
        key: "botTokenEnv_required",
        fieldKey: "botToken",
        message: "Paste the bot token.",
        level: "error",
      }),
    ]);
  });

  it("asks a webhook-only setup for a token or a webhook, on the token field", () => {
    const issues = guide().validate(draftOf({ runtimeMode: "bridge", defaultChannelId: CHANNEL_ID }));

    expect(issues).toEqual([
      expect.objectContaining({
        key: "discord_bridge_auth_missing",
        fieldKey: "botToken",
        message: "Paste the bot token, or a webhook URL for send-only.",
      }),
    ]);
  });
});

describe("Discord setup guide: where the bot listens (item 2)", () => {
  it("asks where the bot listens, then who may message it, before the two ids", () => {
    expect(fieldKeys("collect-values-destinations")).toEqual([
      "guildPolicy",
      "inboundDmPolicy",
      "defaultChannelId",
      "defaultGuildId",
    ]);
  });

  it("words the listening choice as what the bot will do", () => {
    const policy = field("guildPolicy");

    expect(policy.label).toBe("Where should the bot listen?");
    expect(policy.options?.map((option) => [option.value, option.label])).toEqual([
      ["allowlist", "In one server channel, when mentioned"],
      ["off", "Direct messages only"],
    ]);
    expect(policy.defaultValue).toBe("allowlist");
  });

  it("marks both ids required, shown only while the bot listens in a server channel", () => {
    for (const key of ["defaultChannelId", "defaultGuildId"]) {
      expect(field(key).required, key).toBe(true);
      expect(field(key).visibleWhenFieldEquals, key).toEqual({ fieldKey: "guildPolicy", value: "allowlist" });
    }
  });

  it("asks a server setup for the server id, and a direct-message setup for nothing more", () => {
    const base = { runtimeMode: "gateway", botTokenEnv: "DISCORD_BOT_TOKEN", defaultChannelId: CHANNEL_ID };

    expect(guide().validate(draftOf(base))).toEqual([
      expect.objectContaining({ key: "defaultGuildId_required", fieldKey: "defaultGuildId" }),
    ]);
    expect(guide().validate(draftOf({ ...base, defaultGuildId: GUILD_ID }))).toEqual([]);
    expect(
      guide().validate(draftOf({ runtimeMode: "gateway", botTokenEnv: "DISCORD_BOT_TOKEN", guildPolicy: "off" })),
    ).toEqual([]);
  });

  it("does not make a saved connection with its own server rules fill in a server id again", () => {
    const connection: IntegrationConnection = {
      connectionId: "11111111-1111-1111-1111-111111111111",
      catalogId: "channel.discord",
      kind: "channel",
      key: "discord",
      label: "Discord",
      revision: "1",
      enabled: true,
      status: "connected",
      config: {
        botTokenEnv: "DISCORD_BOT_TOKEN",
        runtimeMode: "gateway",
        defaultChannelId: CHANNEL_ID,
        guilds: { [GUILD_ID]: { channels: { [CHANNEL_ID]: { allow: true } } } },
      },
      createdAt: "2026-03-29T00:00:00.000Z",
      updatedAt: "2026-03-29T00:00:00.000Z",
    };

    // The wizard counts a field as filled when the saved connection already has it.
    expect(guide().hydrate(connection).hydration.fieldState.defaultGuildId).toBe("configured");
  });
});

describe("Discord setup guide: the test note (item 4)", () => {
  it("says the webhook-only path posts a visible message that stays", () => {
    expect(textOf(step("test").body)).toContain(
      "The webhook-only path sends one visible test post. A webhook can't delete it, so it stays in the channel.",
    );
  });

  it("no longer says the webhook-only path gets no live send", () => {
    expect(textOf(step("test").body)).not.toContain("does not receive an automatic live webhook send");
  });
});

describe("Discord setup guide: the webhook path (item 5)", () => {
  it("drops the legacy bridge step from the main flow", () => {
    expect(guide().definition.wizard.steps.map((candidate) => candidate.id)).not.toContain("webhook-path");
  });

  it("offers the webhook URL as a send-only expert option that still needs a channel", () => {
    const webhook = field("webhookUrl");

    expect(webhook.label).toBe("Webhook URL (send-only, advanced)");
    expect(webhook.advanced).toBe(true);
    expect(webhook.explanation).toContain("Default channel ID");
  });

  it("keeps the webhook URL a real field the host list can read", () => {
    expect(guide().definition.wizard.hostFields).toEqual(["webhookUrl"]);
  });
});

describe("Discord setup guide: the vendor steps (item 6)", () => {
  it("says a new application already has a bot and where its token is", () => {
    const text = paragraphs("create-bot").join("\n");

    expect(text).toContain(
      "A new application already has a bot. Open Bot › Reset Token and copy the token now; Discord shows it once. On the same page, turn on Message Content Intent.",
    );
    expect(text).not.toContain("add a bot user");
  });

  it("tells a person to copy the token and turn on Message Content Intent in the steps, not as boxes (R50)", () => {
    const text = paragraphs("create-bot").join("\n");

    expect(text).toContain("Open Bot › Reset Token and copy the token now");
    expect(text).toContain("turn on Message Content Intent");
    expect(text).not.toContain("add a bot user");
    expect(step("create-bot").checklist).toBeUndefined();
  });

  it("walks through the Installation page with the scopes and permissions", () => {
    expect(paragraphs("install-bot")[0]).toBe(
      "Open Installation. Set Install Link to Discord Provided Link. Under Default Install Settings › Guild Install, add the scopes applications.commands and bot, and the permissions View Channels, Send Messages, Read Message History. Open the install link and choose Add to server.",
    );
  });

  it("links Discord's quick start for both steps", () => {
    for (const id of ["create-bot", "install-bot"]) {
      expect(textOf(step(id).body), id).toContain("https://docs.discord.com/developers/quick-start/getting-started");
    }
  });
});

describe("Discord setup guide: asks each path to tick only what it needs (R50)", () => {
  const { continueBlockers } = guideFinish("channel.discord");
  // The shared helper doesn't model checklists, so assert the boxes directly. Continue is blocked until each box on
  // the step is ticked, and a direct-messages-only setup and a webhook-only setup are both supported paths.
  const boxes = () =>
    guide().definition.wizard.steps.flatMap((candidate) =>
      (candidate.checklist ?? []).map((item) => `${candidate.id}: ${item.label}`),
    );

  it("keeps only the boxes every path needs: a Discord account and access to a server", () => {
    expect(boxes()).toEqual(["prerequisites: Discord account signed in", "prerequisites: Access to the target server"]);
  });

  it("asks a direct-messages-only setup to tick nothing about a channel", () => {
    expect(continueBlockers({ botToken: "bot-token", guildPolicy: "off" })).toEqual([]);
    expect(boxes().join("\n")).not.toMatch(/channel|permission|message history/iu);
  });

  it("asks a webhook-only setup to tick nothing about a bot, an application or an install", () => {
    expect(
      continueBlockers({
        webhookUrl: "https://discord.com/api/webhooks/1/token",
        defaultChannelId: CHANNEL_ID,
        defaultGuildId: GUILD_ID,
      }),
    ).toEqual([]);
    expect(boxes().join("\n")).not.toMatch(/bot|application|intent|scope|install/iu);
  });

  it("makes the test channel plain guidance that says which paths need one", () => {
    expect(step("prerequisites").checklist?.map((item) => item.id)).not.toContain("sandbox-channel");
    expect(paragraphs("prerequisites")).toEqual([
      "A test channel you can safely post in is needed if the bot will answer in a server channel, or if you use a webhook. Direct messages only needs no channel.",
    ]);
  });

  it("makes the bot steps plain guidance, and says a webhook-only setup skips them", () => {
    expect(step("create-bot").checklist).toBeUndefined();
    expect(step("install-bot").checklist).toBeUndefined();
    expect(paragraphs("create-bot")[0]).toBe(
      "This step and the next are for a bot token. A webhook-only setup (send-only, advanced) has no bot, so skip both.",
    );
  });

  it("makes the channel permissions plain guidance that only a server channel needs", () => {
    expect(paragraphs("install-bot")).toContain(
      "To have the bot answer in a server channel, check that it can View Channel, Send Messages and Read Message History in that channel. A bot for direct messages only doesn't need that.",
    );
  });
});

describe("Discord setup guide: finishing (item 7)", () => {
  it("says where to approve a direct-message pairing and that no public address is needed", () => {
    expect(paragraphs("finish")).toContain(
      "Approve DM pairing requests in Settings › Channels › this connection › Connection operations. No public web address is needed.",
    );
  });

  it("keeps the note that a first direct message creates a pending code", () => {
    expect(JSON.stringify(step("finish"))).toContain("pending code");
  });
});

describe("Discord setup guide: when the test fails (A13)", () => {
  it("lists the failures a Discord setup really hits, on the test step", () => {
    const ids = (step("test").troubleshooting ?? []).map((item) => item.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "token-credential_rejected",
        "token-permission_mismatch",
        "token-not-found",
        "message-content-intent-disabled",
      ]),
    );
  });

  it("tells a person who set a variable to check its name and restart", () => {
    const notFound = (step("test").troubleshooting ?? []).find((item) => item.id === "token-not-found");

    expect(notFound?.body).toContain("starts with DISCORD_");
    expect(notFound?.body).toContain("restart GoatCitadel");
  });
});

describe("Discord setup guide: steps for setting up only (A4)", () => {
  it("hides the creation steps when a saved connection is changed", () => {
    expect(
      guide()
        .definition.wizard.steps.filter((candidate) => candidate.createOnly)
        .map((candidate) => candidate.id),
    ).toEqual(["overview", "prerequisites", "create-bot", "install-bot"]);
  });
});
