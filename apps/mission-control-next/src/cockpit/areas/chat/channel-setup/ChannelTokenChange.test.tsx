// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  DiscordSetupCheckResult,
  IntegrationConnection,
  SlackSetupCheckResult,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { ChannelTokenChange } from "./ChannelTokenChange";
import { DISCORD_INTENT_OFF, DISCORD_TOKEN_FAILED } from "./discord-setup-model";
import { SLACK_APP_TOKEN_FAILED } from "./slack-setup-model";

const api = vi.hoisted(() => ({
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelRotateSecretDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkDiscordSetup: vi.fn(),
  checkSlackSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchSettings: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const turnOnApi = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnApi);

const DISCORD_TOKEN = "NEW.DISCORD.SECRET-TOKEN";
const SLACK_BOT_TOKEN = "xoxb-NEW-SECRET-BOT-TOKEN";
const SLACK_APP_TOKEN = "xapp-1-NEW-SECRET-APP-TOKEN";
const CONNECTION_REVISION = "a".repeat(64);
// The only line this page lists beside a missing host, so it names where the message goes ("there" would have no antecedent).
const TEST_MESSAGE = "GoatCitadel sends a test message where your bot posts and then removes it";
const STORED = { botToken: { configured: true, custody: "temporary" as const } };

type Key = "discord" | "slack";

function connection(key: Key, config: Record<string, unknown> = {}): IntegrationConnection {
  const label = key === "discord" ? "Discord" : "Slack";
  return {
    connectionId: "conn-1",
    revision: CONNECTION_REVISION,
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label,
    enabled: true,
    status: "connected",
    config:
      key === "discord"
        ? { runtimeMode: "gateway", applicationId: "1000", ...config }
        : { receiveMode: "socket", slackBotUserId: "UOLD", slackTeamId: "T1", ...config },
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  } as IntegrationConnection;
}

function rotateDraft(key: Key, overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "rotate-1",
    revision: 1,
    catalogId: `channel.${key}`,
    connectionId: "conn-1",
    connectionRevision: CONNECTION_REVISION,
    lifecycleMode: "rotate_secret",
    enabled: true,
    draft: { label: "kept" },
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-26T09:00:00.000Z",
    updatedAt: "2026-10-26T09:00:00.000Z",
    ...overrides,
  };
}

function discordCheck(overrides: Partial<DiscordSetupCheckResult> = {}): DiscordSetupCheckResult {
  return {
    bot: { id: "9", name: "NewBot" },
    applicationId: "2000",
    messageContentIntent: true,
    makers: [{ id: "1", name: "Ada" }],
    servers: [{ id: "900", name: "Goat Server" }],
    ...overrides,
  };
}

function slackCheck(overrides: Partial<SlackSetupCheckResult> = {}): SlackSetupCheckResult {
  return {
    workspace: { id: "T1", name: "Goat Team" },
    bot: { userId: "UNEW", name: "newbot" },
    appToken: "ok",
    ...overrides,
  };
}

function definition(key: Key, requiredHosts: string[]): ChannelSetupDefinition {
  return {
    catalog: { catalogId: `channel.${key}`, key, label: key },
    wizard: { estimatedMinutes: 8, steps: [], requiredHosts, picker: { group: "quickest", order: 1 } },
  } as unknown as ChannelSetupDefinition;
}

const HOSTS: Record<Key, string[]> = { discord: ["discord.com"], slack: ["slack.com"] };

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(saved: IntegrationConnection) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelTokenChange connection={saved} workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li[data-state]")];
const states = () => steps().map((step) => step.getAttribute("data-state"));
const status = () => container.querySelector('[role="status"]')?.textContent;

function button(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

function link(text: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

function field(label: string): HTMLInputElement | null {
  const found = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return found ? container.querySelector<HTMLInputElement>(`#${CSS.escape(found.htmlFor)}`) : null;
}

async function type(label: string, value: string) {
  const input = field(label);
  if (!input) throw new Error(`No ${label} field`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement | undefined) {
  if (!target) throw new Error("Nothing to click");
  await act(async () => {
    target.click();
  });
  await settle();
}

async function checkDiscordToken(token = DISCORD_TOKEN) {
  await type("Bot token", token);
  await click(button("Check token"));
}

async function checkSlackTokens() {
  await type("Bot token", SLACK_BOT_TOKEN);
  await type("App-level token", SLACK_APP_TOKEN);
  await click(button("Check tokens"));
}

/** What the gateway does for Discord: the token stored one version on, the bot read, a draft kept one version on. */
function arrangeDiscord(result: DiscordSetupCheckResult = discordCheck()) {
  api.createChannelRotateSecretDraft.mockResolvedValue(rotateDraft("discord"));
  api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
    rotateDraft("discord", { revision: input.expectedRevision + 1, secretState: STORED }),
  );
  api.checkDiscordSetup.mockResolvedValue(result);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      rotateDraft("discord", { revision: input.expectedRevision + 1, draft: input.draft, secretState: STORED }),
  );
}

function arrangeSlack(result: SlackSetupCheckResult = slackCheck()) {
  api.createChannelRotateSecretDraft.mockResolvedValue(rotateDraft("slack"));
  api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
    rotateDraft("slack", { revision: input.expectedRevision + 1, secretState: STORED }),
  );
  api.checkSlackSetup.mockResolvedValue(result);
}

function runningBot(metadata: Record<string, unknown>) {
  api.fetchChannelRuntimeStatus.mockResolvedValue({
    connectionId: "conn-1",
    channelKey: "discord",
    enabled: true,
    ready: true,
    inboundModes: [],
    runtimePolicy: {},
    metadata,
  });
}

async function toDiscordChecked(saved = connection("discord"), result?: DiscordSetupCheckResult) {
  arrangeDiscord(result);
  await mount(saved);
  await checkDiscordToken();
}

async function toSlackChecked(saved = connection("slack"), result?: SlackSetupCheckResult) {
  arrangeSlack(result);
  await mount(saved);
  await checkSlackTokens();
}

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  api.fetchChannelSetupDefinitions.mockResolvedValue({
    items: [definition("discord", HOSTS.discord), definition("slack", HOSTS.slack)],
  });
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft("discord"));
  api.fetchChannelRuntimeStatus.mockResolvedValue({});
  api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["discord.com", "slack.com"] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetCredentialInputsForTests();
});

describe("ChannelTokenChange for Discord", () => {
  const WARNING = "This token is for NewBot, not OldBot#1234. Saving it switches the bot people message.";

  it("is titled, with two steps and a way back to the channel", async () => {
    await mount(connection("discord"));
    expect(container.querySelector("h1")?.textContent).toBe("Change Discord's token");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Paste the new token",
      "2. Save the new token",
    ]);
    expect(states()).toEqual(["current", "locked"]);
    expect(new URL(link("Back to channel")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/conn-1",
    );
  });

  it("asks for the token in the same masked field, with the same button", async () => {
    await mount(connection("discord"));
    expect(field("Bot token")?.getAttribute("type")).toBe("password");
    expect(field("Bot token")?.getAttribute("autocomplete")).toBe("new-password");
    expect(button("Check token")?.disabled).toBe(true);
    await type("Bot token", DISCORD_TOKEN);
    expect(button("Check token")?.disabled).toBe(false);
  });

  it("makes no draft by being visited", async () => {
    await mount(connection("discord"));
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
    expect(api.createChannelRotateSecretDraft).not.toHaveBeenCalled();
    expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
  });

  it("checks the token through a draft for changing the key, and says whose bot it is", async () => {
    await toDiscordChecked(connection("discord", { applicationId: "2000" }));
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("rotate-1", {
      expectedRevision: 1,
      values: { botToken: DISCORD_TOKEN },
    });
    expect(api.checkDiscordSetup).toHaveBeenCalledWith({ draftId: "rotate-1", expectedRevision: 2 });
    expect(steps()[0]!.textContent).toContain("Token works. Your bot is NewBot.");
    expect(states()).toEqual(["done", "current"]);
    expect(field("Bot token")).toBeNull();
  });

  it("never shows the token back", async () => {
    await toDiscordChecked();
    expect(container.innerHTML).not.toContain("SECRET-TOKEN");
  });

  describe("when the token is for another bot", () => {
    it("warns before saving, naming the bot the channel runs as now", async () => {
      runningBot({ connectedBotTag: "OldBot#1234" });
      await toDiscordChecked();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toBe(WARNING);
      expect(status()).toBe(WARNING);
      expect(button("Save key")?.disabled).toBe(false);
    });

    it("says so without a name when the channel does not say which bot it is running as", async () => {
      runningBot({});
      await toDiscordChecked();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toBe(
        "This token is for NewBot, not the bot this channel uses now. Saving it switches the bot people message.",
      );
    });

    it("says so without a name when the channel cannot be asked", async () => {
      api.fetchChannelRuntimeStatus.mockRejectedValue(new Error("offline"));
      await toDiscordChecked();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toContain(
        "not the bot this channel uses now",
      );
    });

    it("keeps Save key off until it knows what to call the bot it replaces", async () => {
      let answer!: (status: unknown) => void;
      api.fetchChannelRuntimeStatus.mockReturnValue(new Promise((resolve) => (answer = resolve)));
      await toDiscordChecked();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')).toBeNull();
      expect(button("Save key")?.disabled).toBe(true);

      await act(async () => answer({ metadata: { connectedBotTag: "OldBot#1234" } }));
      await settle();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toBe(WARNING);
      expect(button("Save key")?.disabled).toBe(false);
    });

    it("says nothing for the same bot, and asks the channel nothing", async () => {
      await toDiscordChecked(connection("discord", { applicationId: "2000" }));
      expect(container.textContent).not.toContain("Saving it switches the bot");
      expect(status()).toBe("Token works. Your bot is NewBot.");
      expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
    });

    it("says nothing when the channel never recorded which bot it was", async () => {
      await toDiscordChecked(connection("discord", { applicationId: undefined }));
      expect(container.textContent).not.toContain("Saving it switches the bot");
      expect(button("Save key")).toBeDefined();
    });

    it("keeps the new application on the draft either way", async () => {
      await toDiscordChecked();
      expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("rotate-1", {
        expectedRevision: 2,
        draft: { label: "kept", applicationId: "2000" },
      });
    });
  });

  describe("Message Content Intent", () => {
    it("holds the second step back until it is on, and checks the stored token again without a new one", async () => {
      await toDiscordChecked(
        connection("discord", { applicationId: "2000" }),
        discordCheck({ messageContentIntent: false }),
      );
      expect(steps()[0]!.textContent).toContain(DISCORD_INTENT_OFF);
      expect(status()).toBe(`Token works. Your bot is NewBot. ${DISCORD_INTENT_OFF}`);
      expect(states()).toEqual(["current", "locked"]);
      expect(field("Bot token")).toBeNull();
      expect(button("Save key")).toBeUndefined();

      api.checkDiscordSetup.mockResolvedValue(discordCheck());
      await click(button("Check again"));
      expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
      expect(states()).toEqual(["done", "current"]);
      expect(button("Save key")).toBeDefined();
    });
  });

  describe("when the token fails", () => {
    it("says one plain sentence, keeps the field to correct it, and shows no secret", async () => {
      arrangeDiscord();
      api.checkDiscordSetup.mockRejectedValue(new Error(`GET /users/@me with Bot ${DISCORD_TOKEN} failed`));
      await mount(connection("discord"));
      await checkDiscordToken();

      expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
      expect(steps()[0]!.querySelector('[data-tone="error"]')?.textContent).toBe(DISCORD_TOKEN_FAILED);
      expect(status()).toBe(DISCORD_TOKEN_FAILED);
      expect(container.textContent).not.toContain("SECRET-TOKEN");
      expect(states()).toEqual(["current", "locked"]);
      expect(field("Bot token")?.getAttribute("type")).toBe("password");
    });

    it("brings the field back when a check made after a good one fails", async () => {
      await toDiscordChecked(connection("discord"), discordCheck({ messageContentIntent: false }));
      api.checkDiscordSetup.mockRejectedValue(new Error("revoked"));
      await click(button("Check again"));
      expect(steps()[0]!.textContent).toContain(DISCORD_TOKEN_FAILED);
      expect(field("Bot token")).not.toBeNull();
    });
  });

  describe("saving the token", () => {
    const plan = { planId: "plan-1" };

    it("lists the test message, and saves through the same turn-on call for the draft for changing the key", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toDiscordChecked(connection("discord", { applicationId: "2000" }));
      expect([...steps()[1]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([TEST_MESSAGE]);
      // The setup pages say "there", after naming where the bot posts; this page lists nothing before the line.
      expect(container.textContent).not.toContain("test message there");
      expect(button("Turn on")).toBeUndefined();

      await click(button("Save key"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.discord",
        requiredHosts: ["discord.com"],
        // The host is allowed already, so the step listed none to add.
        shownHosts: [],
      });
    });

    it("lists a host that is not allowed yet as a change, and saves with it", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["example.com"] });
      await toDiscordChecked(connection("discord", { applicationId: "2000" }));
      expect([...steps()[1]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
        TEST_MESSAGE,
        "discord.com is added to the hosts GoatCitadel may reach",
      ]);
      await click(button("Save key"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledWith(
        expect.objectContaining({ shownHosts: ["discord.com"] }),
      );
    });

    it("says it is saved in Discord's words and links back to Discord's page", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await toDiscordChecked(connection("discord", { applicationId: "2000" }));
      expect(invalidate).not.toHaveBeenCalled();
      await click(button("Save key"));

      expect(states()).toEqual(["done", "done"]);
      expect(steps()[1]!.textContent).toContain("Saved. Discord uses the new token now.");
      expect(status()).toBe("Saved. Discord uses the new token now.");
      expect(new URL(link("Back to Discord's page")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
        "/chat/messaging/conn-1",
      );
      expect(container.textContent).not.toContain("Discord is on.");
      expect(container.textContent).not.toContain("Telegram");
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings", "integration-connections"] });
    });

    it("says Discord's cleanup sentence when the test message could not be removed, and goes on without testing again", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
      turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
      await toDiscordChecked(connection("discord", { applicationId: "2000" }));
      await click(button("Save key"));
      expect(steps()[1]!.textContent).toContain(
        "GoatCitadel couldn't remove its test message. Delete it in Discord if you like.",
      );
      expect(container.textContent).not.toContain("Delete it in Telegram");
      await click(button("Continue"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);
      expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.discord",
        evidenceId: "proof-1",
      });
      expect(steps()[1]!.textContent).toContain("Saved. Discord uses the new token now.");
    });

    it("shows why it could not save, and lets the operator try again", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Discord said no." });
      await toDiscordChecked(connection("discord", { applicationId: "2000" }));
      await click(button("Save key"));
      expect(steps()[1]!.textContent).toContain("Discord said no.");
      expect(status()).toBe("Discord said no.");
      expect(button("Save key")).toBeDefined();
    });
  });
});

describe("ChannelTokenChange for Slack", () => {
  const WARNING =
    "These tokens are for @newbot, not the bot this channel uses now. Saving them switches the bot people message.";

  it("is titled, with two steps and both token fields", async () => {
    await mount(connection("slack"));
    expect(container.querySelector("h1")?.textContent).toBe("Change Slack's tokens");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Paste the new tokens",
      "2. Save the new tokens",
    ]);
    expect(states()).toEqual(["current", "locked"]);
    for (const label of ["Bot token", "App-level token"]) {
      expect(field(label)?.getAttribute("type")).toBe("password");
    }
  });

  it("checks both tokens with one button, once both are typed", async () => {
    await mount(connection("slack"));
    expect(button("Check tokens")?.disabled).toBe(true);
    await type("Bot token", SLACK_BOT_TOKEN);
    expect(button("Check tokens")?.disabled).toBe(true);
    await type("App-level token", SLACK_APP_TOKEN);
    expect(button("Check tokens")?.disabled).toBe(false);
  });

  it("stores both tokens in one call, checks them, and says whose bot it is", async () => {
    await toSlackChecked(connection("slack", { slackBotUserId: "UNEW" }));
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("rotate-1", {
      expectedRevision: 1,
      values: { botToken: SLACK_BOT_TOKEN, appToken: SLACK_APP_TOKEN },
    });
    expect(api.checkSlackSetup).toHaveBeenCalledWith({ draftId: "rotate-1", expectedRevision: 2, checkAppToken: true });
    expect(steps()[0]!.textContent).toContain("Tokens work. Your bot is @newbot in Goat Team.");
    expect(states()).toEqual(["done", "current"]);
    expect(container.innerHTML).not.toContain("SECRET");
  });

  it("writes nothing about the bot to the draft", async () => {
    await toSlackChecked();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  describe("when the tokens are for another bot", () => {
    it("warns before saving, in the words of several tokens", async () => {
      await toSlackChecked();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toBe(WARNING);
      expect(status()).toBe(WARNING);
      expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
    });

    it.each([
      ["the same bot", { slackBotUserId: "UNEW" }],
      ["a channel that never recorded one", { slackBotUserId: undefined }],
    ])("says nothing for %s", async (_name, config) => {
      await toSlackChecked(connection("slack", config));
      expect(container.textContent).not.toContain("switches the bot");
      expect(status()).toBe("Tokens work. Your bot is @newbot in Goat Team.");
      expect(button("Save key")?.disabled).toBe(false);
    });
  });

  describe("when a token fails", () => {
    it.each(["rejected", "missing"] as const)(
      "says the app-level token is not accepted when Slack answers %s, and keeps both fields",
      async (answer) => {
        await toSlackChecked(connection("slack"), slackCheck({ appToken: answer }));
        expect(steps()[0]!.querySelector('[data-tone="error"]')?.textContent).toBe(SLACK_APP_TOKEN_FAILED);
        expect(status()).toBe(SLACK_APP_TOKEN_FAILED);
        expect(states()).toEqual(["current", "locked"]);
        expect(field("Bot token")).not.toBeNull();
        expect(field("App-level token")).not.toBeNull();
        expect(container.textContent).not.toContain("SECRET");
      },
    );

    it("says one plain sentence when Slack does not take the bot token, never quoting either", async () => {
      arrangeSlack();
      api.checkSlackSetup.mockRejectedValue(new Error(`auth.test ${SLACK_BOT_TOKEN} ${SLACK_APP_TOKEN}`));
      await mount(connection("slack"));
      await checkSlackTokens();
      expect(steps()[0]!.querySelector('[data-tone="error"]')?.textContent).toBe(
        "Slack didn't accept the bot token, or GoatCitadel couldn't reach Slack. Check it and try again.",
      );
      expect(container.textContent).not.toContain("SECRET");
    });
  });

  describe("saving the tokens", () => {
    const plan = { planId: "plan-1" };

    it("saves through the same turn-on call for the draft for changing the key", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toSlackChecked(connection("slack", { slackBotUserId: "UNEW" }));
      expect([...steps()[1]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([TEST_MESSAGE]);
      await click(button("Save key"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.slack",
        requiredHosts: ["slack.com"],
        shownHosts: [],
      });
    });

    it("says it is saved in Slack's words and links back to Slack's page", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toSlackChecked();
      await click(button("Save key"));
      expect(states()).toEqual(["done", "done"]);
      expect(steps()[1]!.textContent).toContain("Saved. Slack uses the new tokens now.");
      expect(link("Back to Slack's page")).toBeDefined();
      expect(container.textContent).not.toContain("Slack is on.");
      // The warning has done its job: it is not left beside the saved step.
      expect(container.querySelector('[data-tone="warning"]')).toBeNull();
    });

    it("says Slack's cleanup sentence when the test message could not be removed", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
      await toSlackChecked();
      await click(button("Save key"));
      expect(steps()[1]!.textContent).toContain(
        "GoatCitadel couldn't remove its test message. Delete it in Slack if you like.",
      );
      expect(container.textContent).not.toContain("Delete it in Telegram");
    });
  });
});

describe("ChannelTokenChange", () => {
  it.each(["discord", "slack"] as const)(
    "has one live region and never an alert for %s, through the whole change",
    async (key) => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan: { planId: "plan-1" } });
      const live = () => container.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length;
      if (key === "discord") arrangeDiscord();
      else arrangeSlack();
      await mount(connection(key));
      expect(live()).toBe(1);
      if (key === "discord") await checkDiscordToken();
      else await checkSlackTokens();
      expect(live()).toBe(1);
      await click(button("Save key"));
      expect(live()).toBe(1);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    },
  );

  it.each(["discord", "slack"] as const)("shows no id or version of the draft or channel for %s", async (key) => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan: { planId: "plan-1" } });
    if (key === "discord") await toDiscordChecked();
    else await toSlackChecked();
    await click(button("Save key"));
    for (const hidden of ["rotate-1", "plan-1", CONNECTION_REVISION, "conn-1", "2000", "UNEW", "UOLD"]) {
      expect(container.textContent).not.toContain(hidden);
    }
  });

  it.each(["owner", "owners", "Gateway", "evidence", "revision", "snapshot", "replay"])(
    "does not use the word %s anywhere it speaks",
    async (word) => {
      await toDiscordChecked(connection("discord"), discordCheck({ messageContentIntent: false }));
      const spoken = `${container.textContent} ${status()}`;
      expect(new RegExp(`\\b${word}\\b`, "i").test(spoken)).toBe(false);
    },
  );

  it("sends a channel it has no tokens for to Advanced channel setup", async () => {
    await mount({
      ...connection("discord"),
      key: "mattermost",
      catalogId: "channel.mattermost",
    } as IntegrationConnection);
    expect(container.querySelector("h1")?.textContent).toBe("Change this channel's key");
    expect(
      new URL(link("Change the key in Advanced channel setup")!.getAttribute("href")!, "http://cockpit.invalid")
        .pathname,
    ).toBe("/chat/messaging/advanced");
    expect(field("Bot token")).toBeNull();
  });
});
