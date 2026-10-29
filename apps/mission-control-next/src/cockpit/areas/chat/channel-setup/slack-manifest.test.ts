import { describe, expect, it } from "vitest";
import { SLACK_APP_MANIFEST, slackCreateAppHref } from "./slack-manifest";

const PREFIX = "https://api.slack.com/apps?new_app=1&manifest_json=";

/** The manifest the link carries, read back the way Slack reads it. */
function manifestInLink(): Record<string, unknown> {
  const href = slackCreateAppHref();
  expect(href.startsWith(PREFIX)).toBe(true);
  return JSON.parse(decodeURIComponent(href.slice(PREFIX.length))) as Record<string, unknown>;
}

const section = (name: string): Record<string, unknown> => SLACK_APP_MANIFEST[name] as Record<string, unknown>;

describe("slackCreateAppHref", () => {
  it("opens Slack's create-an-app page with the manifest in the link", () => {
    expect(manifestInLink()).toEqual(SLACK_APP_MANIFEST);
  });

  it("encodes the whole manifest, so no raw JSON punctuation reaches the query", () => {
    const query = slackCreateAppHref().slice(PREFIX.length);
    expect(query).toBe(encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST)));
    expect(query).not.toMatch(/[{}"&# ]/);
    // The address still parses as Slack's, with the two parameters Slack reads.
    const url = new URL(slackCreateAppHref());
    expect(url.origin + url.pathname).toBe("https://api.slack.com/apps");
    expect(url.searchParams.get("new_app")).toBe("1");
  });
});

describe("SLACK_APP_MANIFEST", () => {
  it("names the app GoatCitadel within Slack's limits", () => {
    const info = section("display_information");
    expect(info.name).toBe("GoatCitadel");
    // Slack allows 35 characters.
    expect((info.name as string).length).toBeLessThanOrEqual(35);
    expect(info.description).toBe("Talk to GoatCitadel from Slack.");
    const features = section("features");
    const botUser = features.bot_user as { display_name: string; always_online: boolean };
    // Slack allows lower-case letters, digits and . _ - only.
    expect(botUser.display_name).toMatch(/^[a-z0-9._-]+$/);
    expect(botUser).toEqual({ display_name: "goatcitadel", always_online: true });
  });

  it("opens the Messages tab for direct messages and leaves the Home tab off", () => {
    expect(section("features").app_home).toEqual({
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
  });

  it("asks for exactly the bot scopes the setup and the connection use", () => {
    const scopes = (section("oauth_config").scopes as { bot: string[] }).bot;
    expect(scopes).toEqual([
      "app_mentions:read",
      "channels:read",
      "chat:write",
      "groups:read",
      "im:history",
      "im:read",
      "users:read",
    ]);
  });

  it("listens for mentions and direct messages, each with the scope Slack needs for it", () => {
    const settings = section("settings");
    const events = (settings.event_subscriptions as { bot_events: string[] }).bot_events;
    expect(events).toEqual(["app_mention", "message.im"]);
    const scopes = (section("oauth_config").scopes as { bot: string[] }).bot;
    expect(scopes).toContain("app_mentions:read");
    expect(scopes).toContain("im:history");
  });

  it("connects over Socket Mode, so no public web address is needed", () => {
    expect(section("settings")).toMatchObject({
      socket_mode_enabled: true,
      interactivity: { is_enabled: false },
      org_deploy_enabled: false,
      token_rotation_enabled: false,
    });
    expect(SLACK_APP_MANIFEST._metadata).toEqual({ major_version: 2, minor_version: 1 });
  });
});
