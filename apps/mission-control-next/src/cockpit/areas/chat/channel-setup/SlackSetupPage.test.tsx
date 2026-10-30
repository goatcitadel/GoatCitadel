// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition, ChannelSetupDraft, SlackSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { SETUP_CODE_TTL_MS } from "./setup-code";
import {
  SLACK_APP_TOKEN_FAILED,
  SLACK_BOT_TOKEN_FAILED,
  SLACK_SAY_HI_POLL_MS,
  slackDraftWithPosting,
  slackDraftWithSender,
} from "./slack-setup-model";
import { SlackSetupPage } from "./SlackSetupPage";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkSlackSetup: vi.fn(),
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

const BOT_TOKEN = "xoxb-SECRET-BOT-TOKEN";
const APP_TOKEN = "xapp-1-SECRET-APP-TOKEN";
const TOKENS_STORED = {
  botToken: { configured: true, custody: "temporary" as const },
  appToken: { configured: true, custody: "temporary" as const },
};

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.slack",
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

function checkResult(overrides: Partial<SlackSetupCheckResult> = {}): SlackSetupCheckResult {
  return {
    workspace: { id: "T1", name: "Goat Team" },
    bot: { userId: "U9", name: "goatcitadel" },
    appToken: "ok",
    ...overrides,
  };
}

/** A new draft at version 1, marked as made here at 2 before the tokens are stored; the page counts no further. */
function arrangeCheck(result: SlackSetupCheckResult = checkResult()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1 }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(
    draft({ revision: 2, draft: { setupPage: "messaging" }, secretState: TOKENS_STORED }),
  );
  api.checkSlackSetup.mockResolvedValue(result);
}

/** The catalogue as the gateway sends it: Slack needs `slack.com` reached once it holds a token. */
function slackDefinition(): ChannelSetupDefinition {
  return {
    catalog: { catalogId: "channel.slack", key: "slack", label: "Slack" },
    wizard: {
      estimatedMinutes: 5,
      steps: [],
      requiredHosts: [],
      conditionalHosts: [
        { host: "slack.com", whenAnyFieldSet: ["botToken", "slackInstallId", "appToken", "appTokenEnv"] },
      ],
      hostFields: ["webhookUrl"],
      picker: { group: "quickest", order: 1 },
    },
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
        <SlackSetupPage workspaceId="default" {...props} />
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

async function checkTokens(botToken = BOT_TOKEN, appToken = APP_TOKEN) {
  await type("Bot token", botToken);
  await type("App-level token", appToken);
  await click(button("Check tokens"));
}

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [slackDefinition()] });
  api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  // The gateway keeps whatever draft it is sent, one version on.
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKENS_STORED }),
  );
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  // Unmounted while the fake timers are still installed, so what the page scheduled is cleared from them.
  act(() => root.unmount());
  vi.useRealTimers();
  container.remove();
  client.clear();
  __resetCredentialInputsForTests();
});

describe("SlackSetupPage", () => {
  it("is titled and shows the five steps in order, each saying where it is done", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Set up Slack");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Make your Slack app",
      "2. Install it and copy two tokens",
      "3. Say hi to your bot",
      "4. Choose where it posts",
      "5. Turn it on",
    ]);
    expect(steps().map((step) => step.querySelector("[data-place]")?.textContent)).toEqual([
      "In Slack",
      "In Slack, then on this page",
      "In Slack",
      "On this page",
      "On this page",
    ]);
  });

  it("keeps steps 3 to 5 locked until both tokens work, and says what opens each", async () => {
    arrangeCheck();
    await mount();
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    // Both open steps show what to do, but only the last, where the tokens are pasted, is the current one.
    expect(steps().map((step) => step.getAttribute("aria-current"))).toEqual([null, "step", null, null, null]);
    expect(steps()[2]!.textContent).toContain("Opens when both tokens work.");
    expect(steps()[3]!.textContent).toContain("Opens when you've said hi to your bot.");
    expect(steps()[4]!.textContent).toContain("Opens when you've chosen where it posts.");

    await checkTokens();
    // The first two are done and the bot waits for a hi; where it posts and Turn on open when it comes.
    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);
    expect(steps().map((step) => step.getAttribute("aria-current"))).toEqual([null, null, "step", null, null]);
    expect(steps()[3]!.textContent).toContain("Opens when you've said hi to your bot.");
  });

  it("opens Slack to create the app from a link that carries the manifest", async () => {
    await mount();
    expect(steps()[0]!.textContent).toContain(
      "This opens Slack with GoatCitadel's app settings filled in. Pick your workspace, choose Next, then Create.",
    );
    const create = link("Create the Slack app");
    expect(create?.getAttribute("href")?.startsWith("https://api.slack.com/apps?new_app=1&manifest_json=")).toBe(true);
    expect(create?.getAttribute("target")).toBe("_blank");
    expect(create?.getAttribute("rel")).toContain("noopener");
    expect(steps()[0]!.contains(create ?? null)).toBe(true);
  });

  it("tells how to install the app and which two tokens to copy", async () => {
    await mount();
    const second = steps()[1]!;
    const items = [...second.querySelectorAll("li")].map((item) => item.textContent);
    expect(items).toEqual([
      "Open OAuth & Permissions, choose Install to Workspace, then Allow. Copy the Bot User OAuth Token. It starts with xoxb-.",
      "Open Basic Information. Under App-Level Tokens, choose Generate Token and Scopes, add the connections:write scope, and generate it. Copy the token. It starts with xapp-.",
    ]);
  });

  it("asks for each token in its own masked, labelled field and checks both with one button", async () => {
    await mount();
    for (const label of ["Bot token", "App-level token"]) {
      expect(field(label)?.getAttribute("type")).toBe("password");
      // Browsers ignore "off" on a password field and offer "Save password?" when the form goes away on success.
      expect(field(label)?.getAttribute("autocomplete")).toBe("new-password");
      expect(steps()[1]!.contains(field(label))).toBe(true);
    }
    expect(container.querySelectorAll("button[type=submit]")).toHaveLength(1);
    // The button waits for both.
    expect(button("Check tokens")?.disabled).toBe(true);
    await type("Bot token", BOT_TOKEN);
    expect(button("Check tokens")?.disabled).toBe(true);
    await type("App-level token", APP_TOKEN);
    expect(button("Check tokens")?.disabled).toBe(false);
  });

  it("checks both typed tokens and names the bot and the workspace", async () => {
    arrangeCheck();
    await mount();
    await checkTokens();

    // Stored after the page marked the new draft as its own, with the version the mark returned.
    expect(api.updateChannelSetupDraft).toHaveBeenNthCalledWith(1, "draft-1", {
      expectedRevision: 1,
      draft: { setupPage: "messaging" },
    });
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 2,
      values: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    });
    expect(steps()[1]!.getAttribute("data-state")).toBe("done");
    expect(steps()[1]!.textContent).toContain("Tokens work. Your bot is @goatcitadel in Goat Team.");
    // The status line goes on to what is awaited next; the step keeps saying what was found.
    expect(status()).toBe("Waiting for your hi…");
    expect(steps()[0]!.getAttribute("data-state")).toBe("done");
  });

  it("also checks the tokens when the operator presses Enter in a field", async () => {
    arrangeCheck();
    await mount();
    await type("Bot token", BOT_TOKEN);
    await type("App-level token", APP_TOKEN);
    const form = field("App-level token")!.closest("form");
    expect(form).not.toBeNull();
    expect(form!.contains(field("Bot token"))).toBe(true);
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
  });

  it("never shows either token back, once checked", async () => {
    arrangeCheck();
    await mount();
    await checkTokens();
    expect(container.innerHTML).not.toContain("SECRET");
    expect(field("Bot token")).toBeNull();
    expect(field("App-level token")).toBeNull();
  });

  it("drops half-typed tokens when the page goes", async () => {
    await mount();
    await type("Bot token", BOT_TOKEN);
    await type("App-level token", APP_TOKEN);
    expect(field("Bot token")?.value).toBe(BOT_TOKEN);
    await unmount();
    await mount();
    expect(field("Bot token")?.value).toBe("");
    expect(field("App-level token")?.value).toBe("");
  });

  it("says in one plain sentence when Slack doesn't take the bot token, and keeps what was typed to fix", async () => {
    arrangeCheck();
    api.checkSlackSetup.mockRejectedValue(new Error(`HTTP 401 Authorization: Bearer ${BOT_TOKEN}`));
    await mount();
    await checkTokens();

    const second = steps()[1]!;
    expect(second.textContent).toContain(
      "Slack didn't accept the bot token, or GoatCitadel couldn't reach Slack. Check it and try again.",
    );
    expect(SLACK_BOT_TOKEN_FAILED).toBe(
      "Slack didn't accept the bot token, or GoatCitadel couldn't reach Slack. Check it and try again.",
    );
    expect(container.textContent).not.toContain("HTTP 401");
    expect(container.textContent).not.toContain("SECRET");
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    // Still there to correct, and masked.
    expect(field("Bot token")?.value).toBe(BOT_TOKEN);
    expect(field("App-level token")?.value).toBe(APP_TOKEN);
    expect(status()).toBe(SLACK_BOT_TOKEN_FAILED);
    // Shown once, in the step that has the fields.
    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(second.contains(callouts[0]!)).toBe(true);
  });

  it("says in one plain sentence when Slack doesn't take the app-level token", async () => {
    arrangeCheck(checkResult({ appToken: "rejected" }));
    await mount();
    await checkTokens();

    expect(steps()[1]!.textContent).toContain(
      "Slack didn't accept the app-level token. Check that it has the connections:write scope.",
    );
    expect(SLACK_APP_TOKEN_FAILED).toBe(
      "Slack didn't accept the app-level token. Check that it has the connections:write scope.",
    );
    // The bot is not announced, and nothing is written after the page's mark on the new draft.
    expect(container.textContent).not.toContain("Tokens work");
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    expect(status()).toBe(SLACK_APP_TOKEN_FAILED);
    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("SECRET");

    // A new app-level token goes to the same setup, with the bot token too; the fields go once both work.
    api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 3, secretState: TOKENS_STORED }));
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await type("App-level token", "xapp-1-SECRET-FIXED");
    await click(button("Check tokens"));
    expect(api.createChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("draft-1", {
      expectedRevision: 2,
      values: { botToken: BOT_TOKEN, appToken: "xapp-1-SECRET-FIXED" },
    });
    expect(container.textContent).not.toContain(SLACK_APP_TOKEN_FAILED);
    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);
    expect(container.innerHTML).not.toContain("SECRET");
  });

  it("goes on with a setup made on this page, checking both saved tokens again", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [draft({ revision: 5, draft: { setupPage: "messaging" }, secretState: TOKENS_STORED })],
    });
    api.checkSlackSetup.mockResolvedValue(checkResult());
    await mount();
    expect(api.checkSlackSetup).toHaveBeenCalledWith({ draftId: "draft-1", expectedRevision: 5, checkAppToken: true });
    expect(steps()[1]!.textContent).toContain("Tokens work. Your bot is @goatcitadel in Goat Team.");
    expect(field("Bot token")).toBeNull();
  });

  it("shows the fields again when a saved token has stopped working", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [draft({ revision: 5, draft: { setupPage: "messaging" }, secretState: TOKENS_STORED })],
    });
    api.checkSlackSetup.mockResolvedValue(checkResult({ appToken: "rejected" }));
    await mount();
    expect(steps()[1]!.textContent).toContain(SLACK_APP_TOKEN_FAILED);
    expect(field("Bot token")).not.toBeNull();
    expect(field("App-level token")).not.toBeNull();
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
  });

  it("does not go on with a setup made in Advanced channel setup", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [draft({ revision: 5, draft: {}, secretState: TOKENS_STORED })],
    });
    await mount();
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
    expect(field("Bot token")).not.toBeNull();
  });

  it("starts over: discards the draft and shows the first steps again", async () => {
    arrangeCheck();
    await mount();
    await checkTokens();
    expect(field("Bot token")).toBeNull();

    await click(button("Start over"));
    // Version 3 named the workspace; the code the say-hi step saved made it 4.
    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 4);
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    expect(field("Bot token")?.value).toBe("");
    expect(field("App-level token")?.value).toBe("");
  });

  it("clears what was typed when the operator starts over before checking", async () => {
    await mount();
    await type("Bot token", BOT_TOKEN);
    await type("App-level token", APP_TOKEN);
    await click(button("Start over"));
    // Nothing was made yet, so there is nothing to discard but what was typed.
    expect(api.discardChannelSetupDraft).not.toHaveBeenCalled();
    expect(field("Bot token")?.value).toBe("");
    expect(field("App-level token")?.value).toBe("");
  });

  it("shows why Start over failed once, below the steps, when the tokens step is done", async () => {
    arrangeCheck();
    await mount();
    await checkTokens();
    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await click(button("Start over"));

    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.textContent).toContain("This changed somewhere else.");
    // On the page itself, not in a step's body: that step is done and has none.
    expect(callouts[0]!.closest("li")).toBeNull();
    expect(status()).toBe("This changed somewhere else.");
    expect(steps()[1]!.textContent).toContain("Tokens work. Your bot is @goatcitadel in Goat Team.");
  });

  it("has a way back to the channel list and on to Advanced channel setup's other ways", async () => {
    await mount();
    expect(new URL(link("Back to channels")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/add",
    );
    const more = new URL(
      link("More options in Advanced channel setup")!.getAttribute("href")!,
      "http://cockpit.invalid",
    );
    expect(more.pathname).toBe("/chat/messaging/advanced");
    expect(more.searchParams.get("channel")).toBe("channel.slack");
    expect(more.hash).toBe("");
    expect(button("Start over")).toBeDefined();
  });

  it("adds one live region and no alert, whatever happens", async () => {
    arrangeCheck();
    api.checkSlackSetup.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(liveRegions()).toHaveLength(1);
    await checkTokens();
    expect(liveRegions()).toHaveLength(1);
    api.checkSlackSetup.mockResolvedValueOnce(checkResult({ appToken: "rejected" }));
    await click(button("Check tokens"));
    expect(liveRegions()).toHaveLength(1);
    await click(button("Check tokens"));
    expect(liveRegions()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

const ADA = { actorId: "U777", directChannelId: "D777", displayName: "Ada Lovelace" };
const CHANNELS = [
  { id: "C100", name: "general", private: false },
  { id: "G200", name: "secret", private: true },
];
const DIRECT = "Direct messages with Ada Lovelace";
const GENERAL = "#general, when Ada Lovelace mentions it";
const SECRET_CHANNEL = "#secret, when Ada Lovelace mentions it (private)";
const SAID_HI = "Ada Lovelace said hi. Only they can message your bot for now.";
const HOW = "How it gets messages: GoatCitadel keeps a connection open to Slack, so no public web address is needed";
const TEST_MESSAGE = "GoatCitadel sends a test message there and then removes it";
const HOST = "slack.com is added to the hosts GoatCitadel may reach";
const DONE = "Slack is on. Send your bot a message to try it.";
const UNREACHABLE = "GoatCitadel couldn't reach Slack. Try again.";

function radio(label: string): HTMLInputElement | undefined {
  const found = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === label);
  return found?.querySelector<HTMLInputElement>("input[type=radio]") ?? undefined;
}

async function choose(label: string) {
  const input = radio(label);
  if (!input) throw new Error(`No choice "${label}"`);
  await click(input);
}

/** What turning on lists, line by line. */
const changes = () => [...steps()[4]!.querySelectorAll("li")].map((item) => item.textContent);

/** The code the page last saved on the draft, which is the one it shows. */
const sentCode = () => api.updateChannelSetupDraft.mock.lastCall![1].draft.setupCode as string;

/** Slack once the bot has been said hi to: the code is found with Ada, and the channels come when they are asked for. */
function arrangeSlack(overrides: Partial<SlackSetupCheckResult> = {}) {
  api.checkSlackSetup.mockImplementation(async (input: { setupCode?: string; listChannels?: true }) =>
    checkResult({
      ...(input.setupCode ? { codeSender: ADA } : {}),
      ...(input.listChannels ? { channels: CHANNELS } : {}),
      ...overrides,
    }),
  );
}

/** Both tokens have checked out, under fake time, and the page is waiting for a hi. */
async function mountAtCode() {
  vi.useFakeTimers();
  arrangeCheck();
  await mount();
  await checkTokens();
}

/** The hi has come: Ada is the allowed sender, the channel list has been read, and Turn on is open. */
async function mountAtHi() {
  await mountAtCode();
  arrangeSlack();
  await advance(SLACK_SAY_HI_POLL_MS);
  await settle();
}

describe("SlackSetupPage, saying hi", () => {
  it("opens with a code to send, naming the bot to look for under Apps", async () => {
    await mountAtCode();
    const code = sentCode();
    expect(code).toMatch(/^[A-Za-z0-9]{10}$/);
    const step = steps()[2]!;
    expect(step.getAttribute("data-state")).toBe("current");
    expect(step.querySelector("h2")?.textContent).toBe("3. Say hi to your bot");
    expect(step.querySelector("[data-place]")?.textContent).toBe("In Slack");
    expect(step.textContent).toContain(`In Slack, find @goatcitadel under Apps and send it this code: ${code}`);
    expect(step.textContent).toContain("Waiting for your hi…");
    expect(status()).toBe("Waiting for your hi…");
    // The code is asked for once however often the page draws: one write marked the new draft as this page's, one
    // named the workspace, one saved the code.
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(3);
    expect(container.innerHTML).not.toContain("SECRET");
  });

  it("asks for the code every 6 seconds and for nothing else", async () => {
    await mountAtCode();
    api.checkSlackSetup.mockClear();
    await advance(SLACK_SAY_HI_POLL_MS * 3);
    expect(api.checkSlackSetup).toHaveBeenCalledTimes(3);
    for (const [input] of api.checkSlackSetup.mock.calls) {
      expect(input).toEqual({ draftId: "draft-1", expectedRevision: 4, setupCode: sentCode() });
    }
  });

  it("says who said hi, and that only they can message the bot", async () => {
    await mountAtHi();
    const step = steps()[2]!;
    expect(step.getAttribute("data-state")).toBe("done");
    expect(step.textContent).toContain(SAID_HI);
    expect(step.textContent).not.toContain("Waiting for your hi…");
    expect(status()).toBe(SAID_HI);
    const saved = api.updateChannelSetupDraft.mock.calls.find(([, input]) => input.draft.allowedSenders)![1];
    expect(saved.draft).toMatchObject({
      allowedSenders: ["U777"],
      ownerActorIds: ["U777"],
      inboundAccessMode: "allowlist",
    });
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
  });

  it("calls them Someone when Slack gave no name", async () => {
    await mountAtCode();
    arrangeSlack();
    api.checkSlackSetup.mockImplementation(async (input: { setupCode?: string; listChannels?: true }) =>
      checkResult({
        ...(input.setupCode ? { codeSender: { actorId: "U5", directChannelId: "D5" } } : {}),
        ...(input.listChannels ? { channels: CHANNELS } : {}),
      }),
    );
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(steps()[2]!.textContent).toContain("Someone said hi. Only they can message your bot for now.");
    expect(radio("Direct messages with Someone")?.checked).toBe(true);
  });

  it("offers a new code once the first has expired, and listens for that one", async () => {
    await mountAtCode();
    const first = sentCode();
    await advance(SETUP_CODE_TTL_MS);

    const step = steps()[2]!;
    expect(step.textContent).toContain("This code expired.");
    expect(step.textContent).not.toContain(first);
    expect(status()).toBe("This code expired.");
    expect(states()).toEqual(["done", "done", "current", "locked", "locked"]);

    api.checkSlackSetup.mockClear();
    await click(button("Get a new code"));
    const second = sentCode();
    expect(second).not.toBe(first);
    expect(steps()[2]!.textContent).toContain(`send it this code: ${second}`);
    expect(steps()[2]!.textContent).not.toContain("This code expired.");
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(api.checkSlackSetup).toHaveBeenCalledWith(expect.objectContaining({ setupCode: second }));
  });

  it("says that many conversations were not all looked through, and to send the code again", async () => {
    await mountAtCode();
    api.checkSlackSetup.mockResolvedValue(checkResult({ manyConversations: true }));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(steps()[2]!.textContent).toContain(
      "Your bot has many conversations, so GoatCitadel looked only at the newest ones. Send the code again if your hi doesn't show up.",
    );
    expect(container.querySelectorAll('[data-tone="info"]')).toHaveLength(1);
    // It is a note on the step, not an alert.
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers a button, and says why, when the code could not be saved; it does not try again by itself", async () => {
    vi.useFakeTimers();
    arrangeCheck();
    await mount();
    await type("Bot token", BOT_TOKEN);
    await type("App-level token", APP_TOKEN);
    const kept = async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKENS_STORED });
    // The page's mark and the workspace are saved; the code is not.
    api.updateChannelSetupDraft
      .mockImplementationOnce(kept)
      .mockImplementationOnce(kept)
      .mockRejectedValueOnce(new Error("This changed somewhere else."));
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 3, secretState: TOKENS_STORED }));
    await click(button("Check tokens"));

    expect(steps()[2]!.textContent).toContain("Get a new code");
    expect(steps()[2]!.textContent).not.toContain("Waiting for your hi…");
    expect(container.textContent).toContain("This changed somewhere else.");
    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
    expect(status()).toBe("This changed somewhere else.");
    await advance(SLACK_SAY_HI_POLL_MS * 2);
    expect(api.updateChannelSetupDraft).toHaveBeenCalledTimes(3);

    await click(button("Get a new code"));
    expect(steps()[2]!.textContent).toContain("Waiting for your hi…");
    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(0);
  });
});

describe("SlackSetupPage, choosing where it posts", () => {
  it("opens with direct messages chosen, and reads the channel list once", async () => {
    await mountAtHi();
    const step = steps()[3]!;
    expect(step.getAttribute("data-state")).toBe("current");
    expect(step.querySelector("h2")?.textContent).toBe("4. Choose where it posts");
    expect(step.querySelector("[data-place]")?.textContent).toBe("On this page");
    expect(step.querySelector("legend")?.textContent).toBe("Where should it post?");
    expect([...step.querySelectorAll("label")].map((label) => label.textContent)).toEqual([
      DIRECT,
      GENERAL,
      SECRET_CHANNEL,
    ]);
    expect(radio(DIRECT)?.checked).toBe(true);
    expect(radio(GENERAL)?.checked).toBe(false);

    const lists = api.checkSlackSetup.mock.calls.filter(([input]) => input.listChannels);
    expect(lists).toHaveLength(1);
    expect(lists[0]![0]).toEqual({ draftId: "draft-1", expectedRevision: 5, listChannels: true });
    // However long it waits, the channel list is not asked for again, and nobody is asked for the code.
    api.checkSlackSetup.mockClear();
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
  });

  it("tells how to add the bot to a channel, and lists the channels again on Refresh channels", async () => {
    await mountAtHi();
    expect(steps()[3]!.textContent).toContain(
      "To post in a channel, add your bot there first: in the channel, type /invite @goatcitadel. Then choose Refresh channels.",
    );
    api.checkSlackSetup.mockClear();
    arrangeSlack({ channels: [CHANNELS[0]!, { id: "C300", name: "ops", private: false }] });
    await click(button("Refresh channels"));
    expect(api.checkSlackSetup).toHaveBeenCalledExactlyOnceWith({
      draftId: "draft-1",
      expectedRevision: 5,
      listChannels: true,
    });
    expect([...steps()[3]!.querySelectorAll("label")].map((label) => label.textContent)).toEqual([
      DIRECT,
      GENERAL,
      "#ops, when Ada Lovelace mentions it",
    ]);
  });

  it("saves a chosen channel at once, and Turn on says where it will post and who it answers", async () => {
    await mountAtHi();
    expect(changes()).toEqual([
      "Who can message your bot: Ada Lovelace",
      `Where it posts: direct messages with Ada Lovelace`,
      HOW,
      TEST_MESSAGE,
      HOST,
    ]);

    await choose(GENERAL);
    const saved = api.updateChannelSetupDraft.mock.lastCall![1];
    expect(saved.draft.targets).toEqual([
      expect.objectContaining({ channel: "D777", default: false }),
      {
        id: "slack:C100",
        label: "#general",
        channel: "C100",
        kind: "channel",
        source: "connection_config",
        default: true,
      },
    ]);
    expect(radio(GENERAL)?.checked).toBe(true);
    expect(changes()).toEqual([
      "Who can message your bot: Ada Lovelace",
      "Where it posts: #general, and it answers Ada Lovelace there when they mention it",
      HOW,
      TEST_MESSAGE,
      HOST,
    ]);

    await choose(DIRECT);
    expect(radio(DIRECT)?.checked).toBe(true);
    expect(api.updateChannelSetupDraft.mock.lastCall![1].draft.targets).toEqual([
      expect.objectContaining({ channel: "D777", default: true }),
    ]);
  });

  it("says one plain sentence when the channels cannot be listed, and tries again on Refresh channels", async () => {
    await mountAtCode();
    api.checkSlackSetup.mockImplementation(async (input: { setupCode?: string; listChannels?: true }) => {
      if (input.listChannels) throw new Error(`HTTP 429 Authorization: Bearer ${BOT_TOKEN}`);
      return checkResult({ codeSender: ADA });
    });
    await advance(SLACK_SAY_HI_POLL_MS);

    expect(container.textContent).toContain(UNREACHABLE);
    expect(container.textContent).not.toContain("HTTP 429");
    expect(container.textContent).not.toContain("SECRET");
    expect(status()).toBe(UNREACHABLE);
    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
    // Direct messages still stand, and the rest of the setup is open.
    expect(radio(DIRECT)?.checked).toBe(true);
    expect(states()).toEqual(["done", "done", "done", "current", "current"]);

    arrangeSlack();
    await click(button("Refresh channels"));
    expect(container.textContent).not.toContain(UNREACHABLE);
    expect(radio(GENERAL)).toBeDefined();
  });

  it("keeps the choice from changing while a save is going on", async () => {
    await mountAtHi();
    let finish!: (saved: ChannelSetupDraft) => void;
    api.updateChannelSetupDraft.mockReturnValueOnce(new Promise<ChannelSetupDraft>((resolve) => (finish = resolve)));
    await choose(GENERAL);
    expect(container.querySelector("fieldset")!.disabled).toBe(true);
    expect(button("Refresh channels")?.disabled).toBe(true);
    await act(async () => {
      finish(draft({ revision: 7, secretState: TOKENS_STORED }));
    });
    await settle();
    expect(container.querySelector("fieldset")!.disabled).toBe(false);
    expect(button("Refresh channels")?.disabled).toBe(false);
  });
});

describe("SlackSetupPage, turning it on", () => {
  const plan = { planId: "plan-1" };

  it("keeps Turn on off until it knows which hosts it would add", async () => {
    let answer!: (settings: unknown) => void;
    api.fetchSettings.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await mountAtHi();
    expect(button("Turn on")?.disabled).toBe(true);
    expect(changes()).toHaveLength(4);

    await act(async () => {
      answer({ revision: 1, networkAllowlist: [] });
    });
    await settle();
    expect(button("Turn on")?.disabled).toBe(false);
    expect(changes()).toHaveLength(5);
  });

  it("names no host when Slack's is already allowed", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["slack.com"] });
    await mountAtHi();
    expect(changes()).toEqual([
      "Who can message your bot: Ada Lovelace",
      "Where it posts: direct messages with Ada Lovelace",
      HOW,
      TEST_MESSAGE,
    ]);
    expect(button("Turn on")?.disabled).toBe(false);
  });

  it("says it couldn't check the hosts when the settings cannot be read, and tries again", async () => {
    api.fetchSettings.mockRejectedValue(new Error("offline"));
    await mountAtHi();
    expect(steps()[4]!.textContent).toContain("GoatCitadel couldn't check which hosts it may reach. Try again.");
    expect(button("Turn on")?.disabled).toBe(true);
    await click(button("Turn on"));
    expect(turnOnApi.turnOnChannelDraft).not.toHaveBeenCalled();

    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    await click(button("Try again"));
    expect(button("Turn on")?.disabled).toBe(false);
  });

  it("turns on with Slack and the host it needs, and says what it is doing", async () => {
    let finish!: (outcome: unknown) => void;
    turnOnApi.turnOnChannelDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mountAtHi();
    await click(button("Turn on"));

    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.slack",
      // A draft with a bot token reaches slack.com.
      requiredHosts: ["slack.com"],
      // The host the step listed, so Turn on adds no host the operator never saw.
      shownHosts: ["slack.com"],
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

  it("is not asked about the code or the channels once turning on has started", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await click(button("Turn on"));
    api.checkSlackSetup.mockClear();
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says Slack is on and links to its page, which the draft's id names", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await click(button("Turn on"));

    expect(states()).toEqual(["done", "done", "done", "done", "done"]);
    expect(steps()[4]!.textContent).toContain(DONE);
    expect(status()).toBe(DONE);
    const page = link("Open Slack's page");
    expect(new URL(page!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/draft-1");
    // The finished steps say what was chosen, and nothing is left to start over from.
    expect(steps()[3]!.textContent).toContain(DIRECT);
    expect(button("Start over")).toBeUndefined();
    expect(button("Turn on")).toBeUndefined();
    expect(link("More options in Advanced channel setup")).toBeDefined();
  });

  it("turns on for a chosen channel, and says which when it is done", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await choose(SECRET_CHANNEL);
    expect(changes()[1]).toBe("Where it posts: #secret, and it answers Ada Lovelace there when they mention it");
    await click(button("Turn on"));
    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);
    expect(steps()[3]!.textContent).toContain(SECRET_CHANNEL);
  });

  it("asks whether to carry on when the test message could not be removed, in Slack's words", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
    await mountAtHi();
    await click(button("Turn on"));

    const cleanup = "GoatCitadel couldn't remove its test message. Delete it in Slack if you like.";
    expect(steps()[4]!.textContent).toContain(cleanup);
    expect(status()).toBe(cleanup);
    expect(container.textContent).not.toContain("Delete it in Telegram");

    await click(button("Continue"));
    expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.slack",
      evidenceId: "proof-1",
    });
    expect(steps()[4]!.getAttribute("data-state")).toBe("done");
  });

  it("shows where it ended up when the change waits on an approval", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan, approvalId: "approval-9" });
    await mountAtHi();
    await click(button("Turn on"));
    expect(link("Approve it in Inbox")).toBeDefined();
    expect(steps()[4]!.getAttribute("data-state")).toBe("current");
    expect(button("Turn on")).toBeDefined();
  });

  it("adds one live region and no alert, whatever happens", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Slack said no." });
    await mountAtCode();
    expect(liveRegions()).toHaveLength(1);
    api.checkSlackSetup.mockResolvedValue(checkResult({ manyConversations: true }));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(liveRegions()).toHaveLength(1);
    await advance(SETUP_CODE_TTL_MS);
    expect(liveRegions()).toHaveLength(1);
    arrangeSlack();
    await click(button("Get a new code"));
    await advance(SLACK_SAY_HI_POLL_MS);
    expect(liveRegions()).toHaveLength(1);
    await choose(GENERAL);
    await click(button("Refresh channels"));
    expect(liveRegions()).toHaveLength(1);
    await click(button("Turn on"));
    expect(status()).toBe("Slack said no.");
    expect(liveRegions()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.innerHTML).not.toContain("SECRET");
  });
});

describe("SlackSetupPage, coming back to a setup", () => {
  /** A setup made on this page whose two tokens are stored, and where someone has said hi, as the page finds it. */
  function savedSetup(values: Record<string, unknown>) {
    return draft({
      revision: 5,
      draft: { setupPage: "messaging", receiveMode: "socket", ...values },
      secretState: TOKENS_STORED,
    });
  }

  it("goes on from the hi already said, with no new code and Turn on open", async () => {
    vi.useFakeTimers();
    const values = slackDraftWithSender({}, ADA);
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup(values)] });
    arrangeSlack();
    await mount();
    await settle();

    expect(states()).toEqual(["done", "done", "done", "current", "current"]);
    expect(steps()[2]!.textContent).toContain(SAID_HI);
    expect(radio(DIRECT)?.checked).toBe(true);
    expect(changes()).toContain("Who can message your bot: Ada Lovelace");
    // Nothing was written, no code was asked for, and the only listing is the channel list.
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.checkSlackSetup.mock.calls.filter(([input]) => input.setupCode)).toHaveLength(0);
    expect(api.checkSlackSetup.mock.calls.filter(([input]) => input.listChannels)).toHaveLength(1);
  });

  it("keeps a saved channel, and waits for its name before Turn on says where it posts", async () => {
    vi.useFakeTimers();
    let answer!: (result: SlackSetupCheckResult) => void;
    const values = slackDraftWithPosting(
      slackDraftWithSender({}, ADA),
      { kind: "channel", channelId: "C100" },
      CHANNELS,
    );
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [savedSetup(values)] });
    api.checkSlackSetup.mockImplementation((input: { listChannels?: true }) =>
      input.listChannels
        ? new Promise<SlackSetupCheckResult>((resolve) => (answer = resolve))
        : Promise.resolve(checkResult()),
    );
    await mount();
    await settle();
    // The channel is known only by its id until the list is read, so nothing is said about it yet.
    expect(steps()[4]!.getAttribute("data-state")).toBe("locked");
    expect(container.textContent).not.toContain("C100");

    await act(async () => {
      answer(checkResult({ channels: CHANNELS }));
    });
    await settle();
    expect(radio(GENERAL)?.checked).toBe(true);
    expect(changes()[1]).toBe("Where it posts: #general, and it answers Ada Lovelace there when they mention it");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("starts the code again from nothing after Start over", async () => {
    await mountAtHi();
    await click(button("Start over"));
    expect(states()).toEqual(["current", "current", "locked", "locked", "locked"]);
    api.checkSlackSetup.mockClear();
    await advance(SETUP_CODE_TTL_MS);
    expect(api.checkSlackSetup).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("SlackSetupPage, installation identity", () => {
  /**
   * The keys the gateway refuses on any Slack draft update: installation identity is authored only by a bound OAuth
   * adoption (`CHANNEL_SLACK_OAUTH_METADATA_KEYS` in the gateway's channel-oauth-draft-metadata.ts).
   */
  const RESERVED = [
    "authMode",
    "slackInstallId",
    "slackTeamId",
    "slackTeamName",
    "slackAppId",
    "slackBotUserId",
    "slackScopes",
    "slackInstallerUserId",
    "oauthConnectedAt",
  ];

  it("goes through the whole setup against a gateway that refuses those keys, and never sends one", async () => {
    api.updateChannelSetupDraft.mockImplementation(
      async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) => {
        const reserved = RESERVED.find((key) => Object.hasOwn(input.draft, key));
        if (reserved)
          throw new Error(`Slack installation metadata belongs to its authorization receipt (${reserved}).`);
        return draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: TOKENS_STORED });
      },
    );
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan: { planId: "plan-1" } });
    await mountAtHi();
    // The token check got through, so the workspace and the bot are named from its answer.
    expect(steps()[1]!.textContent).toContain("Tokens work. Your bot is @goatcitadel in Goat Team.");
    await choose(GENERAL);
    await choose(DIRECT);
    await click(button("Turn on"));

    expect(states()).toEqual(["done", "done", "done", "done", "done"]);
    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(0);
    // The token check, the code, the hi and two choices were all saved.
    expect(api.updateChannelSetupDraft.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [, input] of api.updateChannelSetupDraft.mock.calls) {
      for (const key of RESERVED) expect(input.draft).not.toHaveProperty(key);
    }
  });
});
