// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition, ChannelSetupDraft, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { DISCORD_INTENT_OFF, DISCORD_NO_MAKERS, DISCORD_TOKEN_FAILED, discordInviteHref } from "./discord-setup-model";
import { DiscordSetupPage } from "./DiscordSetupPage";
import { SAY_HI_POLL_MS, SETUP_CODE_TTL_MS } from "./setup-code";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkDiscordSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
  fetchSettings: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const turnOnApi = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnApi);

const TOKEN = "MTIzNDU2.SECRET.TOKEN";
const TOKEN_STORED = { botToken: { configured: true, custody: "temporary" as const } };

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.discord",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
    ...overrides,
  };
}

function checkResult(overrides: Partial<DiscordSetupCheckResult> = {}): DiscordSetupCheckResult {
  return {
    bot: { id: "111", name: "Goat Bot" },
    applicationId: "222",
    messageContentIntent: true,
    makers: [{ id: "333", name: "Ada" }],
    servers: [],
    ...overrides,
  };
}

function arrangeCheck(result: DiscordSetupCheckResult = checkResult()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1 }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 2, secretState: TOKEN_STORED }));
  api.checkDiscordSetup.mockResolvedValue(result);
}

const ADA = { id: "333", name: "Ada" };
const BO = { id: "334", name: "Bo" };
const SERVER = { id: "900", name: "Goat Server" };
const SIDE_SERVER = { id: "901", name: "Side Server" };
const CHANNELS = [
  { id: "701", name: "general" },
  { id: "702", name: "bots" },
];

/**
 * The gateway once the bot is in its servers: the server's text channels when one is asked about, and the channel
 * Discord opens with the person asked for when a direct message is.
 */
function arrangeServers(overrides: Partial<DiscordSetupCheckResult> = {}) {
  api.checkDiscordSetup.mockImplementation(async (input: { guildId?: string; directMessageWith?: string }) =>
    checkResult({
      servers: [SERVER],
      ...overrides,
      ...(input.guildId ? { channels: CHANNELS } : {}),
      ...(input.directMessageWith ? { directChannelId: `dm-${input.directMessageWith}` } : {}),
    }),
  );
}

/** A setup made on this page whose token is stored, as the page finds it when it comes back to it. */
function savedSetup(values: Record<string, unknown> = {}): ChannelSetupDraft {
  return draft({
    revision: 5,
    draft: { setupPage: "messaging", applicationId: "222", ...values },
    secretState: TOKEN_STORED,
  });
}

/** The catalogue as the gateway sends it: Discord needs one host reached. */
function discordDefinition(requiredHosts: string[] = ["discord.com"]): ChannelSetupDefinition {
  return {
    catalog: { catalogId: "channel.discord", key: "discord", label: "Discord" },
    wizard: { estimatedMinutes: 8, steps: [], requiredHosts, picker: { group: "quickest", order: 1 } },
  } as unknown as ChannelSetupDefinition;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Lets fake time pass, with every question that falls due asked and answered. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

async function mount(props: { resumeDraftId?: string } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <DiscordSetupPage workspaceId="default" {...props} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function unmount() {
  await act(async () => {
    root.render(<QueryClientProvider client={client} />);
  });
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li[data-state]")];
const states = () => steps().map((step) => step.getAttribute("data-state"));
const liveRegions = () => container.querySelectorAll('[role="status"], [role="alert"], [aria-live]');
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

function tokenField(): HTMLInputElement | null {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === "Bot token");
  return label ? container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`) : null;
}

async function type(value: string) {
  const field = tokenField();
  if (!field) throw new Error("No Bot token field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function click(target: HTMLElement | undefined) {
  if (!target) throw new Error("Nothing to click");
  await act(async () => {
    target.click();
  });
  await settle();
}

async function checkToken(token = TOKEN) {
  await type(token);
  await click(button("Check token"));
}

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [discordDefinition()] });
  api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  // The gateway keeps whatever draft it is sent, one version on.
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKEN_STORED }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.useRealTimers();
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetCredentialInputsForTests();
});

describe("DiscordSetupPage", () => {
  it("is titled and shows the five steps in order, each saying where it is done", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Set up Discord");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Make your bot",
      "2. Paste your bot's token",
      "3. Invite your bot to a server",
      "4. Choose where it posts",
      "5. Turn it on",
    ]);
    expect(steps()[0]!.querySelector("[data-place]")?.textContent).toBe("In Discord's Developer Portal");
    expect(steps()[1]!.querySelector("[data-place]")?.textContent).toBe("On this page");
    expect(steps()[2]!.querySelector("[data-place]")?.textContent).toBe("In Discord");
  });

  it("keeps steps 3 to 5 locked until the token works and Message Content Intent is on", async () => {
    arrangeCheck(checkResult({ messageContentIntent: false }));
    await mount();
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    // Both open steps show what to do, but only the last, where the token is pasted, is the current one.
    expect(steps().map((step) => step.getAttribute("aria-current"))).toEqual([null, "step", null, null, null]);

    await checkToken();
    // The token works, and the intent is off: the second step stays open and the rest wait.
    expect(states()).toEqual(["done", "current", "locked", "locked", "locked"]);
    expect(steps()[1]!.getAttribute("aria-current")).toBe("step");

    // With the intent on, step 2 is done and the invite opens. The bot is in no server yet, so the rest wait.
    api.checkDiscordSetup.mockResolvedValue(checkResult());
    await click(button("Check again"));
    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);
    expect(steps()[2]!.getAttribute("aria-current")).toBe("step");
  });

  it("says what opens each locked step", async () => {
    await mount();
    expect(steps()[2]!.textContent).toContain("Opens when your token works and Message Content Intent is on.");
    expect(steps()[3]!.textContent).toContain("Opens when your bot is in a server.");
    expect(steps()[4]!.textContent).toContain("Opens when you've chosen where it posts.");
  });

  it("opens the Developer Portal from a link in the first step", async () => {
    await mount();
    expect(steps()[0]!.textContent).toContain(
      "Open the Developer Portal and choose New Application. Name it, then open Bot and choose Reset Token. Copy the token it shows.",
    );
    const portal = link("Open the Developer Portal");
    expect(portal?.getAttribute("href")).toBe("https://discord.com/developers/applications");
    expect(portal?.getAttribute("target")).toBe("_blank");
    expect(portal?.getAttribute("rel")).toContain("noopener");
  });

  it("asks for the token in a masked, labelled field and checks it with a button", async () => {
    await mount();
    expect(tokenField()?.getAttribute("type")).toBe("password");
    // Browsers ignore "off" on a password field and offer "Save password?" when the form goes away on success.
    expect(tokenField()?.getAttribute("autocomplete")).toBe("new-password");
    expect(steps()[1]!.contains(tokenField())).toBe(true);
    expect(button("Check token")?.disabled).toBe(true);
    await type(TOKEN);
    expect(button("Check token")?.disabled).toBe(false);
  });

  it("checks a typed token and names the bot", async () => {
    arrangeCheck();
    await mount();
    await checkToken();

    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: TOKEN },
    });
    expect(steps()[1]!.getAttribute("data-state")).toBe("done");
    expect(steps()[1]!.textContent).toContain("Token works. Your bot is Goat Bot.");
    // The status line moves on to the latest thing: step 3 is already waiting for the bot to join a server.
    expect(status()).toBe("Waiting for your bot to join a server…");
    expect(button("Check again")).toBeUndefined();
  });

  it("also checks the token when the operator presses Enter in the field", async () => {
    arrangeCheck();
    await mount();
    await type(TOKEN);
    const form = tokenField()!.closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
  });

  it("never shows the token back, once checked", async () => {
    arrangeCheck();
    await mount();
    await checkToken();
    expect(container.innerHTML).not.toContain("SECRET");
    expect(tokenField()).toBeNull();
  });

  it("drops a half-typed token when the page goes", async () => {
    await mount();
    await type(TOKEN);
    expect(tokenField()?.value).toBe(TOKEN);
    await unmount();
    await mount();
    expect(tokenField()?.value).toBe("");
  });

  it("says in one plain sentence when the token fails, and keeps what was typed to fix", async () => {
    arrangeCheck();
    api.checkDiscordSetup.mockRejectedValue(new Error(`HTTP 401 Authorization: Bot ${TOKEN}`));
    await mount();
    await checkToken();

    expect(steps()[1]!.textContent).toContain(DISCORD_TOKEN_FAILED);
    expect(container.textContent).not.toContain("HTTP 401");
    expect(container.textContent).not.toContain("SECRET");
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    // Still there to correct, and masked.
    expect(tokenField()?.value).toBe(TOKEN);
    expect(status()).toBe(DISCORD_TOKEN_FAILED);
    // Shown once, in the step that has the field.
    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(steps()[1]!.contains(callouts[0]!)).toBe(true);
  });

  it("asks to turn on Message Content Intent when it is off, and checks again from a button", async () => {
    arrangeCheck(checkResult({ messageContentIntent: false }));
    await mount();
    await checkToken();

    const second = steps()[1]!;
    expect(second.textContent).toContain("Token works. Your bot is Goat Bot.");
    expect(second.textContent).toContain(DISCORD_INTENT_OFF);
    // Said once, in the status line, whole: the token works and the next thing to do.
    expect(status()).toBe(`Token works. Your bot is Goat Bot. ${DISCORD_INTENT_OFF}`);
    // The token is stored, so the field is gone and checking again needs nothing typed.
    expect(tokenField()).toBeNull();
    expect(container.innerHTML).not.toContain("SECRET");
    // The sentence points at the Developer Portal, so it links there.
    expect(second.contains(link("Open the Developer Portal") ?? null)).toBe(true);
    expect(second.querySelectorAll('[data-tone="error"]')).toHaveLength(0);

    const submits = api.submitChannelSetupDraftSecrets.mock.calls.length;
    api.checkDiscordSetup.mockResolvedValue(checkResult({ messageContentIntent: true }));
    await click(button("Check again"));

    expect(api.checkDiscordSetup).toHaveBeenLastCalledWith({ draftId: "draft-1", expectedRevision: 3 });
    expect(api.submitChannelSetupDraftSecrets.mock.calls).toHaveLength(submits);
    expect(steps()[1]!.getAttribute("data-state")).toBe("done");
    expect(container.textContent).not.toContain(DISCORD_INTENT_OFF);
    expect(button("Check again")).toBeUndefined();
  });

  it("says the intent is still off when checking again finds it so", async () => {
    arrangeCheck(checkResult({ messageContentIntent: false }));
    await mount();
    await checkToken();
    await click(button("Check again"));
    expect(steps()[1]!.getAttribute("data-state")).toBe("current");
    expect(steps()[1]!.textContent).toContain(DISCORD_INTENT_OFF);
    expect(button("Check again")?.disabled).toBe(false);
  });

  it("asks for the token again, with the plain sentence, when checking again fails", async () => {
    arrangeCheck(checkResult({ messageContentIntent: false }));
    await mount();
    await checkToken();
    expect(tokenField()).toBeNull();

    // The token was reset in the Developer Portal in the meantime.
    api.checkDiscordSetup.mockRejectedValue(new Error(`Bot ${TOKEN}`));
    await click(button("Check again"));
    expect(steps()[1]!.textContent).toContain(DISCORD_TOKEN_FAILED);
    expect(container.textContent).not.toContain("SECRET");
    expect(container.innerHTML).not.toContain("SECRET");
    expect(button("Check again")).toBeUndefined();
    expect(tokenField()).not.toBeNull();
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    expect(status()).toBe(DISCORD_TOKEN_FAILED);

    // A new token goes to the same setup, and the field goes again once it works.
    api.checkDiscordSetup.mockResolvedValue(checkResult());
    await checkToken("MTIzNDU2.NEW.TOKEN");
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 3,
      values: { botToken: "MTIzNDU2.NEW.TOKEN" },
    });
    expect(tokenField()).toBeNull();
    expect(container.textContent).not.toContain(DISCORD_TOKEN_FAILED);
    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);
    expect(container.innerHTML).not.toContain("NEW.TOKEN");
  });

  it("goes on with a setup made on this page, checking its saved token again", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [draft({ revision: 5, draft: { setupPage: "messaging" }, secretState: TOKEN_STORED })],
    });
    api.checkDiscordSetup.mockResolvedValue(checkResult({ messageContentIntent: false }));
    await mount();
    expect(api.checkDiscordSetup).toHaveBeenCalledWith({ draftId: "draft-1", expectedRevision: 5 });
    expect(steps()[1]!.textContent).toContain("Token works. Your bot is Goat Bot.");
    expect(steps()[1]!.textContent).toContain(DISCORD_INTENT_OFF);
    expect(tokenField()).toBeNull();
  });

  it("does not go on with a setup made in Settings", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [draft({ revision: 5, draft: {}, secretState: TOKEN_STORED })],
    });
    await mount();
    expect(api.checkDiscordSetup).not.toHaveBeenCalled();
    expect(tokenField()).not.toBeNull();
  });

  it("starts over: discards the draft and shows the first steps again", async () => {
    arrangeCheck();
    await mount();
    await checkToken();
    expect(tokenField()).toBeNull();

    await click(button("Start over"));
    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 3);
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    expect(tokenField()?.value).toBe("");
  });

  it("shows why Start over failed once, below the steps, when the token step is done", async () => {
    arrangeCheck();
    await mount();
    await checkToken();
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await click(button("Start over"));

    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.textContent).toContain("This changed somewhere else.");
    // On the page itself, not in a step's body: that step is done and has none.
    expect(callouts[0]!.closest("li")).toBeNull();
    expect(status()).toBe("This changed somewhere else.");
    expect(steps()[1]!.textContent).toContain("Token works. Your bot is Goat Bot.");
  });

  it("has a way back to the channel list and on to Settings' other ways", async () => {
    await mount();
    expect(new URL(link("Back to channels")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/add",
    );
    const more = new URL(link("More options in Settings")!.getAttribute("href")!, "http://cockpit.invalid");
    expect(more.pathname).toBe("/settings/connections");
    expect(more.searchParams.get("channel")).toBe("channel.discord");
    expect(more.hash).toBe("#channels");
    expect(button("Start over")).toBeDefined();
  });

  it("adds one live region and no alert, whatever happens", async () => {
    arrangeCheck(checkResult({ messageContentIntent: false }));
    api.checkDiscordSetup.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(liveRegions()).toHaveLength(1);
    await checkToken();
    expect(liveRegions()).toHaveLength(1);
    await checkToken();
    expect(liveRegions()).toHaveLength(1);
    await click(button("Check again"));
    expect(liveRegions()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

const radios = () => [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
const legends = () => [...container.querySelectorAll("legend")].map((legend) => legend.textContent);
const radioLabels = () => [...container.querySelectorAll("label")].map((label) => label.textContent);
const errors = () => container.querySelectorAll('[data-tone="error"]');
/** What turning on will change, one line each. */
const changes = () => [...steps()[4]!.querySelectorAll("li")].map((item) => item.textContent);

function radio(label: string): HTMLInputElement | undefined {
  const match = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return match?.querySelector<HTMLInputElement>('input[type="radio"]') ?? undefined;
}

async function choose(label: string) {
  await click(radio(label));
}

/** The page coming back to a setup whose bot is already in its server. */
async function mountAtServer(overrides: Partial<DiscordSetupCheckResult> = {}, values: Record<string, unknown> = {}) {
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup(values)] });
  arrangeServers(overrides);
  await mount();
}

const DIRECT = "Direct messages with Ada";
const WAITING = "Waiting for your bot to join a server…";
const STILL_WAITING = "Still waiting? Open the invite link again.";
const DONE = "Discord is on. Send your bot a direct message to try it.";
const STAYS_CONNECTED =
  "How it gets messages: GoatCitadel stays connected to Discord, so no public web address is needed";
const TEST_MESSAGE = "GoatCitadel sends a test message there and then removes it";

describe("DiscordSetupPage, inviting the bot", () => {
  it("opens the invite once the token works, with a link for this bot, and waits", async () => {
    arrangeCheck();
    await mount();
    await checkToken();

    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);
    const invite = steps()[2]!;
    expect(invite.querySelector("[data-place]")?.textContent).toBe("In Discord");
    expect(invite.textContent).toContain(
      "Open the invite link, pick a server, and choose Authorize. You need permission to add apps to that server. A server of your own works.",
    );
    const anchor = link("Invite your bot");
    expect(invite.contains(anchor ?? null)).toBe(true);
    expect(anchor?.getAttribute("href")).toBe(discordInviteHref("222"));
    expect(anchor?.getAttribute("href")).toBe(
      "https://discord.com/oauth2/authorize?client_id=222&scope=bot+applications.commands&permissions=68608",
    );
    expect(anchor?.getAttribute("target")).toBe("_blank");
    expect(anchor?.getAttribute("rel")).toContain("noopener");
    expect(invite.textContent).toContain(WAITING);
    expect(status()).toBe(WAITING);
    // The steps after it say what opens them.
    expect(steps()[3]!.textContent).toContain("Opens when your bot is in a server.");
    expect(steps()[4]!.textContent).toContain("Opens when you've chosen where it posts.");
    expect(container.innerHTML).not.toContain("SECRET");
  });

  it("ticks the invite when the bot joins a server, and opens the last two steps with direct messages chosen", async () => {
    vi.useFakeTimers();
    arrangeCheck();
    await mount();
    await checkToken();
    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);

    arrangeServers();
    await advance(SAY_HI_POLL_MS);
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
    expect(steps()[2]!.textContent).toContain("Your bot is in Goat Server.");
    expect(steps()[2]!.textContent).not.toContain(WAITING);
    expect(link("Invite your bot")).toBeUndefined();
    // The last open step is the one the reader is told about.
    expect(steps()[4]!.getAttribute("aria-current")).toBe("step");
    expect(radio(DIRECT)?.checked).toBe(true);
    expect(container.innerHTML).not.toContain("SECRET");
  });

  it("says it is still waiting after 10 minutes, and waits again from a button", async () => {
    vi.useFakeTimers();
    arrangeCheck();
    await mount();
    await checkToken();

    await advance(SETUP_CODE_TTL_MS);
    expect(steps()[2]!.textContent).toContain(STILL_WAITING);
    expect(steps()[2]!.textContent).not.toContain(WAITING);
    expect(status()).toBe(STILL_WAITING);
    // The link is still there to open again.
    expect(link("Invite your bot")).toBeDefined();
    expect(button("Check again")?.disabled).toBe(false);
    const asked = api.checkDiscordSetup.mock.calls.length;
    await advance(SAY_HI_POLL_MS * 5);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked);

    await click(button("Check again"));
    expect(steps()[2]!.textContent).toContain(WAITING);
    expect(steps()[2]!.textContent).not.toContain(STILL_WAITING);
    expect(button("Check again")).toBeUndefined();

    arrangeServers();
    await advance(SAY_HI_POLL_MS);
    expect(steps()[2]!.getAttribute("data-state")).toBe("done");
  });

  it("stops waiting for a server when the operator starts over", async () => {
    vi.useFakeTimers();
    arrangeCheck();
    await mount();
    await checkToken();
    await click(button("Start over"));
    const asked = api.checkDiscordSetup.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkDiscordSetup).toHaveBeenCalledTimes(asked);
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
  });

  it("goes on with the invite when the bot is already in a server", async () => {
    await mountAtServer();
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
    expect(steps()[2]!.textContent).toContain("Your bot is in Goat Server.");
  });
});

describe("DiscordSetupPage, choosing where it posts", () => {
  it("offers direct messages, chosen, and then each text channel as a mention", async () => {
    await mountAtServer();
    expect(steps()[3]!.querySelector("[data-place]")?.textContent).toBe("On this page");
    expect(legends()).toEqual(["Where should it post?"]);
    expect(radioLabels()).toEqual([DIRECT, "#general, when Ada mentions it", "#bots, when Ada mentions it"]);
    expect(radios().map((input) => input.checked)).toEqual([true, false, false]);
    // One person made the bot, so nobody is asked who.
    expect(container.textContent).not.toContain("Who can message it?");
    // And nothing here shows an id.
    expect(steps()[3]!.textContent).not.toMatch(/\d{3}/u);
  });

  it("lists what turning on will change, with the host it adds", async () => {
    await mountAtServer();
    expect(changes()).toEqual([
      "Who can message your bot: Ada, who made it",
      "Where it posts: direct messages with Ada",
      STAYS_CONNECTED,
      TEST_MESSAGE,
      "discord.com is added to the hosts GoatCitadel may reach",
    ]);
  });

  it("posts in a channel when the operator chooses one, and says so in the change", async () => {
    await mountAtServer();
    await choose("#bots, when Ada mentions it");

    expect(radio("#bots, when Ada mentions it")?.checked).toBe(true);
    expect(api.updateChannelSetupDraft).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 6,
      draft: expect.objectContaining({
        ownerActorIds: ["333"],
        allowedSenders: ["333"],
        inboundAccessMode: "allowlist",
        guildPolicy: "allowlist",
        defaultGuildId: "900",
        defaultChannelId: "702",
      }),
    });
    expect(changes()[1]).toBe("Where it posts: #bots in Goat Server, and it answers Ada there when they mention it");
    // Back to direct messages.
    await choose(DIRECT);
    expect(changes()[1]).toBe("Where it posts: direct messages with Ada");
    expect(radio(DIRECT)?.checked).toBe(true);
  });

  it("counts the servers, and asks which before it lists channels", async () => {
    await mountAtServer({ servers: [SERVER, SIDE_SERVER] });
    expect(steps()[2]!.textContent).toContain("Your bot is in 2 servers.");
    expect(legends()).toEqual(["Which server?", "Where should it post?"]);
    expect(radioLabels()).toEqual(["Goat Server", "Side Server", DIRECT]);
    expect(radios().map((input) => input.checked)).toEqual([false, false, true]);

    await choose("Side Server");
    expect(api.checkDiscordSetup).toHaveBeenLastCalledWith({ draftId: "draft-1", expectedRevision: 6, guildId: "901" });
    expect(radio("Side Server")?.checked).toBe(true);
    expect(radioLabels()).toEqual([
      "Goat Server",
      "Side Server",
      DIRECT,
      "#general, when Ada mentions it",
      "#bots, when Ada mentions it",
    ]);

    await choose("#general, when Ada mentions it");
    expect(changes()[1]).toBe("Where it posts: #general in Side Server, and it answers Ada there when they mention it");
  });

  it("asks who may message it when a team made the bot, before anything else", async () => {
    await mountAtServer({ makers: [ADA, BO] });
    expect(legends()).toEqual(["Your bot belongs to a team. Who can message it?"]);
    expect(radioLabels()).toEqual(["Ada", "Bo"]);
    expect(radios().map((input) => input.checked)).toEqual([false, false]);
    // Nothing is posted until someone is chosen, so turning on waits.
    expect(states()).toEqual(["done", "done", "done", "current", "locked"]);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();

    await choose("Bo");
    expect(legends()).toEqual(["Your bot belongs to a team. Who can message it?", "Where should it post?"]);
    expect(radio("Bo")?.checked).toBe(true);
    expect(radio("Direct messages with Bo")?.checked).toBe(true);
    expect(radioLabels()).toContain("#general, when Bo mentions it");
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
    expect(changes()[0]).toBe("Who can message your bot: Bo, who made it");
    expect(changes()[1]).toBe("Where it posts: direct messages with Bo");
  });

  it("says Discord didn't say who made the bot, and keeps the last two steps locked", async () => {
    await mountAtServer({ makers: [] });
    expect(states()).toEqual(["done", "done", "done", "locked", "locked"]);
    expect(steps()[3]!.textContent).toContain(DISCORD_NO_MAKERS);
    expect(status()).toBe(DISCORD_NO_MAKERS);
    expect(radios()).toHaveLength(0);
    // The way out it names is on the page.
    expect(link("More options in Settings")).toBeDefined();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("goes on with what was saved, without writing it again", async () => {
    await mountAtServer(
      {},
      {
        ownerActorIds: ["333"],
        allowedSenders: ["333"],
        inboundAccessMode: "allowlist",
        guildPolicy: "allowlist",
        defaultGuildId: "900",
        defaultChannelId: "702",
      },
    );
    expect(radio("#bots, when Ada mentions it")?.checked).toBe(true);
    expect(changes()[1]).toBe("Where it posts: #bots in Goat Server, and it answers Ada there when they mention it");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("keeps a saved channel, says why once, and loads the channels again from a button", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [
        savedSetup({
          ownerActorIds: ["333"],
          allowedSenders: ["333"],
          inboundAccessMode: "allowlist",
          guildPolicy: "allowlist",
          defaultGuildId: "900",
          defaultChannelId: "702",
        }),
      ],
    });
    api.checkDiscordSetup.mockImplementation(async (input: { guildId?: string }) => {
      if (input.guildId) throw new Error(`HTTP 429 Authorization: Bot ${TOKEN}`);
      return checkResult({ servers: [SERVER] });
    });
    await mount();

    // Nothing is named without the list, so Turn on waits; nothing was written, and the sentence is said once.
    expect(states()).toEqual(["done", "done", "done", "current", "locked"]);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.textContent).toBe("GoatCitadel couldn't reach Discord. Try again.");
    expect(status()).toBe("GoatCitadel couldn't reach Discord. Try again.");
    expect(button("Turn on")).toBeUndefined();
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain("SECRET");
    expect(steps()[3]!.contains(button("Load channels again") ?? null)).toBe(true);

    arrangeServers();
    await click(button("Load channels again"));
    expect(button("Load channels again")).toBeUndefined();
    expect(errors()).toHaveLength(0);
    expect(radio("#bots, when Ada mentions it")?.checked).toBe(true);
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
    expect(changes()[1]).toBe("Where it posts: #bots in Goat Server, and it answers Ada there when they mention it");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("says one plain sentence, once, when Discord won't open the direct-message channel, and tries again on a click", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup()] });
    api.checkDiscordSetup.mockImplementation(async (input: { guildId?: string; directMessageWith?: string }) => {
      if (input.directMessageWith) throw new Error(`Authorization: Bot ${TOKEN}`);
      return checkResult({ servers: [SERVER], ...(input.guildId ? { channels: CHANNELS } : {}) });
    });
    await mount();

    expect(states()).toEqual(["done", "done", "done", "current", "locked"]);
    expect(errors()).toHaveLength(1);
    expect(errors()[0]!.textContent).toBe("GoatCitadel couldn't reach Discord. Try again.");
    expect(status()).toBe("GoatCitadel couldn't reach Discord. Try again.");
    expect(container.innerHTML).not.toContain("SECRET");
    expect(radio(DIRECT)?.checked).toBe(false);

    arrangeServers();
    await choose(DIRECT);
    expect(errors()).toHaveLength(0);
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
  });
});

describe("DiscordSetupPage, turning it on", () => {
  const plan = { planId: "plan-1" };

  it("keeps Turn on off until it knows which hosts it would add", async () => {
    let answer!: (settings: unknown) => void;
    api.fetchSettings.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mountAtServer();
    expect(button("Turn on")?.disabled).toBe(true);
    expect(changes()).toHaveLength(4);

    await act(async () => {
      answer({ revision: 1, networkAllowlist: [] });
    });
    await settle();
    expect(button("Turn on")?.disabled).toBe(false);
    expect(changes()).toHaveLength(5);
  });

  it("names no host when Discord's is already allowed", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["discord.com"] });
    await mountAtServer();
    expect(changes()).toEqual([
      "Who can message your bot: Ada, who made it",
      "Where it posts: direct messages with Ada",
      STAYS_CONNECTED,
      TEST_MESSAGE,
    ]);
    expect(button("Turn on")?.disabled).toBe(false);
  });

  it("says it couldn't check the hosts when the settings cannot be read, and tries again", async () => {
    api.fetchSettings.mockRejectedValue(new Error("offline"));
    await mountAtServer();
    expect(steps()[4]!.textContent).toContain("GoatCitadel couldn't check which hosts it may reach. Try again.");
    expect(button("Turn on")?.disabled).toBe(true);
    await click(button("Turn on"));
    expect(turnOnApi.turnOnChannelDraft).not.toHaveBeenCalled();

    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    await click(button("Try again"));
    expect(button("Turn on")?.disabled).toBe(false);
  });

  it("turns on with Discord and the hosts it needs, and says what it is doing", async () => {
    let finish!: (outcome: unknown) => void;
    turnOnApi.turnOnChannelDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mountAtServer();
    await click(button("Turn on"));

    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.discord",
      requiredHosts: ["discord.com"],
      // The host the step listed, so Turn on adds no host the operator never saw.
      shownHosts: ["discord.com"],
    });
    expect(button("Turning on…")).toBeDefined();
    expect(status()).toBe("Turning on…");
    // Where it posts cannot change under a click that is working, and Start over waits.
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(button("Start over")?.disabled).toBe(true);

    await act(async () => {
      finish({ kind: "completed", plan });
    });
    await settle();
    expect(steps()[4]!.getAttribute("data-state")).toBe("done");
  });

  it("says Discord is on and links to its page, which the draft's id names", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mountAtServer();
    await click(button("Turn on"));

    expect(states()).toEqual(["done", "done", "done", "done", "done"]);
    expect(steps()[4]!.textContent).toContain(DONE);
    expect(status()).toBe(DONE);
    const page = link("Open Discord's page");
    expect(new URL(page!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/draft-1");
    // The finished steps say what was chosen, and nothing is left to start over from.
    expect(steps()[3]!.textContent).toContain(DIRECT);
    expect(button("Start over")).toBeUndefined();
    expect(button("Turn on")).toBeUndefined();
    expect(link("More options in Settings")).toBeDefined();
  });

  it("asks whether to carry on when the test message could not be removed, in Discord's words", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
    await mountAtServer();
    await click(button("Turn on"));

    const cleanup = "GoatCitadel couldn't remove its test message. Delete it in Discord if you like.";
    expect(steps()[4]!.textContent).toContain(cleanup);
    expect(status()).toBe(cleanup);
    expect(container.textContent).not.toContain("Delete it in Telegram");

    await click(button("Continue"));
    expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.discord",
      evidenceId: "proof-1",
    });
    expect(steps()[4]!.getAttribute("data-state")).toBe("done");
  });

  it("shows where it ended up when the change waits on an approval", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan, approvalId: "approval-9" });
    await mountAtServer();
    await click(button("Turn on"));
    expect(link("Approve it in Inbox")).toBeDefined();
    expect(steps()[4]!.getAttribute("data-state")).toBe("current");
    expect(button("Turn on")).toBeDefined();
  });

  it("adds one live region and no alert, whatever happens", async () => {
    vi.useFakeTimers();
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Discord said no." });
    arrangeCheck();
    await mount();
    await checkToken();
    expect(liveRegions()).toHaveLength(1);
    await advance(SETUP_CODE_TTL_MS);
    expect(liveRegions()).toHaveLength(1);
    await click(button("Check again"));
    arrangeServers({ servers: [SERVER, SIDE_SERVER], makers: [ADA, BO] });
    await advance(SAY_HI_POLL_MS);
    expect(liveRegions()).toHaveLength(1);
    await choose("Ada");
    await choose("Side Server");
    await choose("#bots, when Ada mentions it");
    expect(liveRegions()).toHaveLength(1);
    await click(button("Turn on"));
    expect(status()).toBe("Discord said no.");
    expect(liveRegions()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
