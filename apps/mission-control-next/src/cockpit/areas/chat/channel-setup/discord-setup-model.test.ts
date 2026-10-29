import { describe, expect, it } from "vitest";
import {
  DISCORD_CATALOG_ID,
  DISCORD_DEVELOPER_PORTAL,
  DISCORD_INTENT_OFF,
  DISCORD_TOKEN_FAILED,
  discordInviteHref,
  discordTokenWorks,
} from "./discord-setup-model";

describe("discordInviteHref", () => {
  it("adds the bot with its commands and only the three permissions it needs", () => {
    // 68608 = View Channel (1024) + Send Messages (2048) + Read Message History (65536).
    expect(discordInviteHref("222")).toBe(
      "https://discord.com/oauth2/authorize?client_id=222&scope=bot+applications.commands&permissions=68608",
    );
  });

  it("keeps an unexpected id inside its own query value", () => {
    const href = new URL(discordInviteHref("2&permissions=8"));
    expect(href.searchParams.get("client_id")).toBe("2&permissions=8");
    expect(href.searchParams.get("permissions")).toBe("68608");
  });
});

describe("Discord's setup words", () => {
  it("names the catalog entry and the Developer Portal", () => {
    expect(DISCORD_CATALOG_ID).toBe("channel.discord");
    expect(DISCORD_DEVELOPER_PORTAL).toBe("https://discord.com/developers/applications");
  });

  it("fails a token in one sentence that blames neither the token nor the connection alone", () => {
    expect(DISCORD_TOKEN_FAILED).toBe(
      "Discord didn't accept that token, or GoatCitadel couldn't reach Discord. Check the token and try again.",
    );
  });

  it("names the bot when its token works", () => {
    expect(discordTokenWorks("Goat Bot")).toBe("Token works. Your bot is Goat Bot.");
  });

  it("tells how to turn on Message Content Intent", () => {
    expect(DISCORD_INTENT_OFF).toBe(
      "Turn on Message Content Intent: in the Developer Portal, open your app, choose Bot, and switch on Message Content Intent. Then check again.",
    );
  });
});
