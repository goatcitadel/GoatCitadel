// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChannelSetupCodeSender,
  ChannelSetupDefinition,
  ChannelSetupDiscoveryResult,
  ChannelSetupDraft,
} from "@goatcitadel/contracts";
import type { IntegrationConnection } from "@goatcitadel/mission-control-shared/api/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { SAY_HI_POLL_MS, SETUP_CODE_TTL_MS } from "./setup-code";
import { TelegramSetupPage } from "./TelegramSetupPage";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  discoverTelegramSetupTargets: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
  fetchSettings: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const turnOnApi = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnApi);

const TOKEN = "123456:SECRET-TOKEN";
const KEY_FAILED =
  "Telegram didn't accept that key, or GoatCitadel couldn't reach Telegram. Check the key and try again.";
const WEBHOOK_NOTE =
  "This bot sends its messages to a web address, so GoatCitadel can't read them here. If another app uses that address, it stops getting messages.";
const CONFLICT_NOTE = "Another app is reading this bot's messages. Stop it there, or make a new bot for GoatCitadel.";
const KEY_STORED = { botToken: { configured: true, custody: "temporary" as const } };

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.telegram",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
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

function discovery(overrides: Partial<ChannelSetupDiscoveryResult> = {}): ChannelSetupDiscoveryResult {
  return {
    items: [],
    warnings: ["Telegram update polling is unavailable while a webhook is active."],
    webhookActive: false,
    botIdentity: { id: "42", username: "MyGoatBot", label: "My Goat Bot" },
    ...overrides,
  };
}

function arrangeCheck(result: ChannelSetupDiscoveryResult = discovery()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1 }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 2, secretState: KEY_STORED }));
  api.discoverTelegramSetupTargets.mockResolvedValue(result);
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: KEY_STORED }),
  );
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

/** The catalogue as the gateway sends it: Telegram needs one host reached. */
function telegramDefinition(requiredHosts: string[] = ["api.telegram.org"]): ChannelSetupDefinition {
  return {
    catalog: { catalogId: "channel.telegram", key: "telegram", label: "Telegram" },
    wizard: { estimatedMinutes: 5, requiredHosts, picker: { group: "quickest", order: 0 } },
  } as unknown as ChannelSetupDefinition;
}

async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    else await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TelegramSetupPage workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li[data-state]")];
const buttons = () => [...container.querySelectorAll<HTMLButtonElement>("button")];

function button(text: string): HTMLButtonElement | undefined {
  return buttons().find((candidate) => candidate.textContent?.trim() === text);
}

function link(text: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
}

function keyField(): HTMLInputElement | null {
  const label = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent === "Bot key");
  return label ? container.querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`) : null;
}

async function type(value: string) {
  const field = keyField();
  if (!field) throw new Error("No Bot key field");
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

async function checkKey(token = TOKEN) {
  await type(token);
  await click(button("Check key"));
}

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [telegramDefinition()] });
  api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  // The gateway keeps whatever draft it is sent, one version on.
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      draft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: KEY_STORED }),
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

describe("TelegramSetupPage", () => {
  it("is titled and shows the four steps in order, each saying where it is done", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Set up Telegram");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Make your bot",
      "2. Paste your bot's key",
      "3. Say hi to your bot",
      "4. Turn it on",
    ]);
    expect(steps().map((step) => step.querySelector("[data-place]")?.textContent)).toEqual([
      "In Telegram",
      "On this page",
      "In Telegram",
      "On this page",
    ]);
  });

  it("says what opens each locked step", async () => {
    await mount();
    expect(steps()[2]!.textContent).toContain("Opens when your key works.");
    expect(steps()[3]!.textContent).toContain("Opens when your hi arrives.");
  });

  it("walks through BotFather's questions, down to the key to copy", async () => {
    await mount();
    const answers = [...steps()[0]!.querySelectorAll("ol > li")].map((item) => item.textContent);
    expect(answers).toEqual([
      "Send /newbot.",
      "Send a name for your bot. Any name works.",
      'Send a username for it. It has to end in "bot", like goat_helper_bot.',
      "BotFather replies with your bot's key, a long line like 123456789:AAH… Copy it.",
    ]);
  });

  it("opens BotFather from a code and from a link", async () => {
    await mount();
    const first = steps()[0]!;
    expect(first.textContent).toContain(
      "Scan this code with your phone to open BotFather, Telegram's bot for making bots, or open it on this computer.",
    );
    expect(first.querySelector("svg")?.getAttribute("aria-label")).toBe("QR code that opens BotFather");
    const botFather = link("Open BotFather");
    expect(botFather?.getAttribute("href")).toBe("https://t.me/BotFather");
    expect(botFather?.getAttribute("target")).toBe("_blank");
    expect(botFather?.getAttribute("rel")).toContain("noopener");
  });

  it("asks for the key in a labelled field and checks it with a button", async () => {
    await mount();
    expect(steps()[1]!.textContent).toContain(
      "Paste the key from BotFather's reply. It's not your bot's name or username.",
    );
    expect(steps()[1]!.textContent).toContain("Bot key");
    expect(keyField()?.getAttribute("type")).toBe("password");
    expect(button("Check key")).toBeDefined();
  });

  it("asks the browser not to offer to save the bot key", async () => {
    await mount();
    // Browsers ignore "off" on a password field and offer "Save password?" when the form goes away on success.
    expect(keyField()?.getAttribute("autocomplete")).toBe("new-password");
  });

  it("keeps steps 3 and 4 locked until the key works", async () => {
    arrangeCheck();
    await mount();
    // Steps 1 and 2 are both open, but only the last open step, where the key is pasted, is the current one.
    expect(steps().map((step) => step.getAttribute("data-state"))).toEqual(["current", "current", "locked", "locked"]);
    expect(steps().map((step) => step.getAttribute("aria-current"))).toEqual([null, "step", null, null]);
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
    expect(steps()[3]!.getAttribute("data-state")).toBe("locked");

    await checkKey();
    expect(steps().map((step) => step.getAttribute("data-state"))).toEqual(["done", "done", "current", "locked"]);
    expect(steps()[2]!.getAttribute("aria-current")).toBe("step");
    expect(steps()[3]!.getAttribute("aria-current")).toBeNull();
  });

  it("checks a typed key and names the bot", async () => {
    arrangeCheck();
    await mount();
    expect(button("Check key")?.disabled).toBe(true);
    await type(TOKEN);
    expect(button("Check key")?.disabled).toBe(false);
    await click(button("Check key"));

    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: TOKEN },
    });
    expect(steps()[1]!.textContent).toContain("Key works. Your bot is @MyGoatBot.");
    // The status line moves on to the latest thing: step 3 is already waiting to hear hi.
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waiting for your hi…");
  });

  it("never shows the key back, once checked", async () => {
    arrangeCheck();
    await mount();
    await checkKey();
    expect(container.innerHTML).not.toContain("SECRET-TOKEN");
    expect(keyField()).toBeNull();
  });

  it("also checks the key when the operator presses Enter in the field", async () => {
    arrangeCheck();
    await mount();
    await type(TOKEN);
    const form = keyField()!.closest("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledTimes(1);
  });

  it("says in one plain sentence when the key fails, and keeps what was typed to fix", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValue(new Error(`HTTP 401 for bot${TOKEN}`));
    await mount();
    await checkKey();
    expect(steps()[1]!.textContent).toContain(KEY_FAILED);
    expect(container.textContent).not.toContain("HTTP 401");
    expect(container.textContent).not.toContain("SECRET-TOKEN");
    expect(steps()[1]!.getAttribute("data-state")).toBe("current");
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
    // Still there to correct, and masked.
    expect(keyField()?.value).toBe(TOKEN);
    expect(container.querySelector('[role="status"]')?.textContent).toBe(KEY_FAILED);
    // Shown once, in the step that has the field.
    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(steps()[1]!.contains(callouts[0]!)).toBe(true);
  });

  it("offers to stop sending to the web address when the bot has one, and goes on once it is stopped", async () => {
    arrangeCheck(discovery({ webhookActive: true }));
    await mount();
    await checkKey();

    expect(steps()[1]!.textContent).toContain("Key works. Your bot is @MyGoatBot.");
    expect(steps()[1]!.textContent).toContain(WEBHOOK_NOTE);
    expect(button("Stop sending to that address")).toBeDefined();
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
    expect(container.textContent).not.toContain("Telegram update polling");

    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ webhookActive: false }));
    await click(button("Stop sending to that address"));
    expect(api.discoverTelegramSetupTargets).toHaveBeenLastCalledWith({
      source: "draft",
      draftId: "draft-1",
      expectedRevision: 3,
      clearWebhook: true,
    });
    expect(button("Stop sending to that address")).toBeUndefined();
    expect(container.textContent).not.toContain(WEBHOOK_NOTE);
    expect(steps()[1]!.getAttribute("data-state")).toBe("done");
    expect(steps()[2]!.getAttribute("data-state")).toBe("current");
  });

  it("says another app holds the bot, with no button that would take it", async () => {
    arrangeCheck(discovery({ updatesConflict: true }));
    await mount();
    await checkKey();

    expect(steps()[1]!.textContent).toContain(CONFLICT_NOTE);
    expect(button("Stop sending to that address")).toBeUndefined();
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
    // The key can be checked again once the other app is stopped, or another bot's key pasted.
    expect(keyField()).not.toBeNull();
    expect(button("Check key")).toBeDefined();
    expect(container.textContent).not.toContain("Telegram update polling");
  });

  it("resumes an unfinished draft whose key is already stored", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [draft({ revision: 3, secretState: KEY_STORED })] });
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
    await mount();
    expect(steps()[1]!.textContent).toContain("Key works. Your bot is @MyGoatBot.");
    expect(steps()[2]!.getAttribute("data-state")).toBe("current");
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("starts over: discards the draft and shows the first steps again", async () => {
    arrangeCheck();
    await mount();
    await checkKey();
    expect(keyField()).toBeNull();

    await click(button("Start over"));
    // Version 3 after the check, 4 once the code for saying hi was saved.
    expect(api.discardChannelSetupDraft).toHaveBeenCalledWith("draft-1", 4);
    expect(container.textContent).not.toContain("Key works.");
    expect(keyField()).not.toBeNull();
    expect(steps()[0]!.querySelector("svg")).not.toBeNull();
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
  });

  it("shows on screen why Start over failed, even once the key has checked out", async () => {
    arrangeCheck();
    await mount();
    await checkKey();
    // Step 2 is done now, so its body (where a check's failure shows) is not on the page.
    expect(steps()[1]!.getAttribute("data-state")).toBe("done");
    expect(keyField()).toBeNull();

    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await click(button("Start over"));

    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.textContent).toContain("This changed somewhere else.");
    // On the page itself, not in a step's body, so it is there whichever step is open.
    expect(callouts[0]!.closest("li")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("This changed somewhere else.");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // Nothing was discarded: the bot is still named and the draft still there.
    expect(steps()[1]!.textContent).toContain("Key works. Your bot is @MyGoatBot.");

    // The message goes once the operator tries again and it works.
    api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
    await click(button("Start over"));
    expect(container.querySelector('[data-tone="error"]')).toBeNull();
    expect(keyField()).not.toBeNull();
  });

  it("shows why Start over failed once, not twice, while the key step is open", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValue(new Error("offline"));
    await mount();
    await checkKey();
    expect(steps()[1]!.getAttribute("data-state")).toBe("current");

    api.discardChannelSetupDraft.mockRejectedValue(new Error("This changed somewhere else."));
    await click(button("Start over"));

    const callouts = container.querySelectorAll('[data-tone="error"]');
    expect(callouts).toHaveLength(1);
    expect(callouts[0]!.textContent).toContain("This changed somewhere else.");
    expect(steps()[1]!.contains(callouts[0]!)).toBe(true);
  });

  it("doesn't send a setup in progress to Settings, which would only send it back here", async () => {
    await mount();
    expect([...container.querySelectorAll("a")].some((anchor) => anchor.textContent?.includes("Settings"))).toBe(false);
  });

  it("has a way back to the channel list", async () => {
    await mount();
    expect(new URL(link("Back to channels")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/add",
    );
  });

  it("adds one live region and no alert, whatever happens", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error("offline"));
    await mount();
    const live = () => container.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length;
    expect(live()).toBe(1);
    await checkKey();
    expect(live()).toBe(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await checkKey();
    expect(live()).toBe(1);
  });

  it("adds one live region and no alert when the bot has a web address or a rival", async () => {
    arrangeCheck(discovery({ webhookActive: true }));
    await mount();
    await checkKey();
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(1);
  });
});

describe("TelegramSetupPage: say hi, turn on, done", () => {
  const ADA: ChannelSetupCodeSender = { actorId: "777", chatId: "777", displayName: "Ada Lovelace", username: "ada" };
  const CODE = /^[A-HJ-NP-Za-km-z2-9]{10}$/;
  const DONE = "Telegram is on. Send your bot a message to try it.";
  const plan = { planId: "plan-1" };
  const status = () => container.querySelector('[role="status"]')?.textContent;
  const liveRegions = () => container.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length;

  /** Checks the key with the clock stopped, so the listening can be moved on by hand. */
  async function toSayHi(result: ChannelSetupDiscoveryResult = discovery()) {
    vi.useFakeTimers();
    arrangeCheck(result);
    await mount();
    await checkKey();
    await settle();
  }

  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /** The code the page saved on the draft for the operator to send. */
  function savedCode(): string | undefined {
    const withCode = api.updateChannelSetupDraft.mock.calls.filter(
      ([, input]) => (input as { draft: Record<string, unknown> }).draft.setupCode,
    );
    return (withCode.at(-1)?.[1] as { draft: { setupCode: string } } | undefined)?.draft.setupCode;
  }

  async function someoneSaysHi(sender: ChannelSetupCodeSender = ADA) {
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ codeSender: sender }));
    await advance(SAY_HI_POLL_MS);
    await settle();
  }

  function connection(overrides: Partial<IntegrationConnection> & { botUsername?: string }): IntegrationConnection {
    const { botUsername, ...rest } = overrides;
    return {
      connectionId: "conn-1",
      revision: "1",
      catalogId: "channel.telegram",
      kind: "channel",
      key: "telegram",
      label: "Telegram",
      enabled: true,
      status: "connected",
      config: botUsername ? { botUsername } : {},
      createdAt: "2026-10-26T10:00:00.000Z",
      updatedAt: "2026-10-26T10:00:00.000Z",
      ...rest,
    } as IntegrationConnection;
  }

  it("shows how to say hi once the key works: a code to scan, a link to open, and the code to send", async () => {
    await toSayHi();
    const code = savedCode();
    expect(code).toMatch(CODE);
    const hi = steps()[2]!;
    expect(hi.getAttribute("data-state")).toBe("current");
    expect(hi.textContent).toContain(
      "Scan this code with your phone, or open your bot on this computer. Telegram opens a chat with it: tap Start.",
    );
    expect(hi.textContent).toContain("This step ticks itself when it arrives.");
    expect(hi.querySelector("svg")?.getAttribute("aria-label")).toBe("QR code that opens your bot");
    const open = link("Open @MyGoatBot");
    expect(open?.getAttribute("href")).toBe(`https://t.me/MyGoatBot?start=${code}`);
    expect(open?.getAttribute("target")).toBe("_blank");
    expect(open?.getAttribute("rel")).toContain("noopener");
    expect(hi.textContent).toContain(`Can't see Start? Send your bot this code: ${code}`);
    expect(hi.textContent).toContain("Waiting for your hi…");
    expect(status()).toBe("Waiting for your hi…");
    // Not yet: nothing to turn on until someone has said hi.
    expect(steps()[3]!.getAttribute("data-state")).toBe("locked");
    expect(button("Turn on")).toBeUndefined();
  });

  it("makes no code while the bot still sends its messages to a web address, and makes one once that is stopped", async () => {
    await toSayHi(discovery({ webhookActive: true }));
    expect(savedCode()).toBeUndefined();
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");

    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ webhookActive: false }));
    await click(button("Stop sending to that address"));
    await settle();
    expect(savedCode()).toMatch(CODE);
    expect(steps()[2]!.getAttribute("data-state")).toBe("current");
  });

  it("makes one code, however often the page draws", async () => {
    await toSayHi();
    await advance(SAY_HI_POLL_MS * 3);
    const withCode = api.updateChannelSetupDraft.mock.calls.filter(
      ([, input]) => (input as { draft: Record<string, unknown> }).draft.setupCode,
    );
    expect(withCode).toHaveLength(1);
  });

  it("says who said hi, and that only they can message the bot for now", async () => {
    await toSayHi();
    await someoneSaysHi();
    const hi = steps()[2]!;
    expect(hi.getAttribute("data-state")).toBe("done");
    expect(hi.textContent).toContain("Ada Lovelace said hi. Only they can message your bot for now.");
    // The code to scan is gone (the check mark in the heading is the only drawing left).
    expect(hi.querySelector('[role="img"]')).toBeNull();
    expect(container.textContent).not.toContain("Waiting for your hi…");
    expect(container.textContent).not.toContain("Can't see Start?");
    expect(status()).toBe("Ada Lovelace said hi. Only they can message your bot for now.");
    expect(steps()[3]!.getAttribute("data-state")).toBe("current");
    expect(steps()[3]!.getAttribute("aria-current")).toBe("step");
    expect(steps()[2]!.getAttribute("aria-current")).toBeNull();
  });

  it.each([
    [{ actorId: "5", chatId: "5", username: "grace" }, "@grace"],
    [{ actorId: "5", chatId: "5" }, "Someone"],
  ])("names a sender with no name as %j: %s", async (sender, name) => {
    await toSayHi();
    await someoneSaysHi(sender);
    expect(steps()[2]!.textContent).toContain(`${name} said hi. Only they can message your bot for now.`);
    expect(steps()[3]!.textContent).toContain(`Who can message your bot: ${name}`);
  });

  it("lists what turning on will do, with a line for the host that has to be added", async () => {
    await toSayHi();
    expect(api.fetchSettings).not.toHaveBeenCalled();
    await someoneSaysHi();
    expect([...steps()[3]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Who can message your bot: Ada Lovelace",
      "Where it posts: your chat with @MyGoatBot",
      "How it gets messages: GoatCitadel asks Telegram for new ones, so no public web address is needed",
      "GoatCitadel sends a test message to your chat and then removes it",
      "api.telegram.org is added to the hosts GoatCitadel may reach",
    ]);
  });

  it.each([["api.telegram.org"], ["*.telegram.org"]])("leaves out the host line when %s is allowed", async (entry) => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [entry] });
    await toSayHi();
    await someoneSaysHi();
    expect([...steps()[3]!.querySelectorAll("li")]).toHaveLength(4);
    expect(container.textContent).not.toContain("hosts GoatCitadel may reach");
  });

  it("keeps Turn on off until it knows which hosts it would add", async () => {
    let answer!: (settings: unknown) => void;
    api.fetchSettings.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    await toSayHi();
    await someoneSaysHi();
    expect(button("Turn on")?.disabled).toBe(true);
    expect(container.textContent).not.toContain("hosts GoatCitadel may reach");

    await act(async () => {
      answer({ revision: 1, networkAllowlist: [] });
    });
    await settle();
    expect(button("Turn on")?.disabled).toBe(false);
    expect(container.textContent).toContain("api.telegram.org is added to the hosts GoatCitadel may reach");
  });

  it("says it couldn't check the hosts when the settings cannot be read, keeps Turn on off, and tries again", async () => {
    api.fetchSettings.mockRejectedValue(new Error("offline"));
    await toSayHi();
    await someoneSaysHi();
    expect(steps()[3]!.textContent).toContain("GoatCitadel couldn't check which hosts it may reach. Try again.");
    expect(status()).toBe("GoatCitadel couldn't check which hosts it may reach. Try again.");
    expect([...steps()[3]!.querySelectorAll("li")]).toHaveLength(4);
    expect(button("Turn on")?.disabled).toBe(true);
    await click(button("Turn on"));
    expect(turnOnApi.turnOnChannelDraft).not.toHaveBeenCalled();

    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    await click(button("Try again"));
    await settle();
    expect(container.textContent).not.toContain("couldn't check which hosts");
    expect(container.textContent).toContain("api.telegram.org is added to the hosts GoatCitadel may reach");
    expect(button("Turn on")?.disabled).toBe(false);
  });

  it("turns on with the channel and the hosts it needs, and says what it is doing", async () => {
    let finish!: (outcome: unknown) => void;
    turnOnApi.turnOnChannelDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));

    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);
    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.telegram",
      requiredHosts: ["api.telegram.org"],
      // The host the step listed, so Turn on adds no host the operator never saw.
      shownHosts: ["api.telegram.org"],
    });
    expect(button("Turning on…")).toBeDefined();
    expect(status()).toBe("Turning on…");
    // A second click while it works does nothing.
    await click(button("Turning on…"));
    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);

    await act(async () => {
      finish({ kind: "completed", plan });
    });
    await settle();
    expect(steps()[3]!.getAttribute("data-state")).toBe("done");
  });

  it("links to the new channel's page, picking the newest Telegram connection for this bot", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await toSayHi();
    await someoneSaysHi();
    // The bot's channels exist once it is on.
    api.fetchIntegrationConnections.mockResolvedValue({
      items: [
        connection({ connectionId: "older", botUsername: "@MyGoatBot", createdAt: "2026-10-01T10:00:00.000Z" }),
        connection({ connectionId: "other-bot", botUsername: "@SomeoneElse", createdAt: "2026-10-26T13:00:00.000Z" }),
        connection({ connectionId: "mine", botUsername: "@mygoatbot", createdAt: "2026-10-26T12:00:00.000Z" }),
        connection({
          connectionId: "discord",
          key: "discord",
          botUsername: "@MyGoatBot",
          createdAt: "2026-10-27T00:00:00.000Z",
        }),
      ],
    });
    await click(button("Turn on"));
    await settle();

    expect(api.fetchIntegrationConnections).toHaveBeenCalledWith("channel");
    const done = steps()[3]!;
    expect(done.textContent).toContain(DONE);
    const page = link("Open Telegram's page");
    expect(new URL(page!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/mine");
    expect(status()).toBe(DONE);
    // Nothing to start over from once it is on.
    expect(button("Start over")).toBeUndefined();
    // Once it is on, Settings is where groups, formatting and voice replies are added.
    const more = link("Add groups, formatting or voice replies in Settings");
    const target = new URL(more!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/settings/connections");
    // Settings' channel list, not its new-setup panel: that would send a Telegram setup back here.
    expect(target.searchParams.get("channel")).toBeNull();
    expect(target.hash).toBe("#channels");
  });

  it("matches a bot name with or without the @, whatever the case", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await toSayHi();
    await someoneSaysHi();
    api.fetchIntegrationConnections.mockResolvedValue({
      items: [connection({ connectionId: "plain", botUsername: "MYGOATBOT" })],
    });
    await click(button("Turn on"));
    await settle();
    expect(link("Open Telegram's page")?.getAttribute("href")).toContain("/chat/messaging/plain");
  });

  it("says Telegram is on without a link when no connection for this bot is found", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    api.fetchIntegrationConnections.mockResolvedValue({
      items: [connection({ connectionId: "other-bot", botUsername: "@SomeoneElse" })],
    });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    await settle();
    expect(steps()[3]!.textContent).toContain(DONE);
    expect(link("Open Telegram's page")).toBeUndefined();
  });

  it("says Telegram is on without a link when the connections cannot be read", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    api.fetchIntegrationConnections.mockRejectedValue(new Error("offline"));
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    await settle();
    expect(steps()[3]!.textContent).toContain(DONE);
    expect(link("Open Telegram's page")).toBeUndefined();
  });

  it("looks for the bot among the channels once, after the key works, and not again before it is on", async () => {
    await toSayHi();
    expect(api.fetchIntegrationConnections).toHaveBeenCalledExactlyOnceWith("channel");
    await someoneSaysHi();
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.fetchIntegrationConnections).toHaveBeenCalledTimes(1);
  });

  it("says when the bot is already connected, links to its page, and keeps step 3 locked", async () => {
    api.fetchIntegrationConnections.mockResolvedValue({
      items: [
        connection({ connectionId: "other-bot", botUsername: "@SomeoneElse" }),
        connection({ connectionId: "existing", botUsername: "@mygoatbot" }),
      ],
    });
    await toSayHi();

    const key = steps()[1]!;
    expect(key.getAttribute("data-state")).toBe("current");
    expect(key.textContent).toContain("This bot is already connected to GoatCitadel.");
    const page = link("Open its page");
    expect(new URL(page!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/existing");
    expect(status()).toBe("This bot is already connected to GoatCitadel.");
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
    expect(steps()[3]!.getAttribute("data-state")).toBe("locked");
    // No code is saved and nothing listens for one.
    expect(savedCode()).toBeUndefined();
    const asked = api.discoverTelegramSetupTargets.mock.calls.length;
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked);
  });

  it("goes on to say hi when the channels cannot be read, claiming nothing", async () => {
    api.fetchIntegrationConnections.mockRejectedValue(new Error("offline"));
    await toSayHi();
    expect(container.textContent).not.toContain("already connected");
    expect(steps()[2]!.getAttribute("data-state")).toBe("current");
    expect(savedCode()).toMatch(CODE);
  });

  it("sends the operator to the approval in Inbox when this sign-in cannot give it", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan, approvalId: "approval-9" });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    const inbox = link("Approve it in Inbox");
    const target = new URL(inbox!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-9");
    expect(button("Turn on")).toBeDefined();
  });

  it("sends the operator to the change's review in Chat when the next step is not an approval", async () => {
    const setupPlan = {
      planId: "plan-1",
      revision: 2,
      request: { kind: "channel_connection", channelKind: "channel.telegram", draftId: "draft-1" },
      origin: { workspaceId: "default", surface: "settings" },
      target: { ownerId: "channel_setup_draft", resourceId: "draft-1" },
    };
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan: setupPlan });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    const review = new URL(link("Finish it in Chat")!.getAttribute("href")!, "http://cockpit.invalid");
    expect(review.pathname).toBe("/chat");
    expect(review.searchParams.get("channelPlan")).toBe("plan-1");
  });

  it("shows why it could not turn on, and says so once in the status line", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Telegram said no." });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    expect(steps()[3]!.textContent).toContain("Telegram said no.");
    expect(status()).toBe("Telegram said no.");
    expect(steps()[3]!.getAttribute("data-state")).toBe("current");
  });

  it("lists what blocks turning on, one reason to a line", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "blocked", reasons: ["Add a chat.", "Check the key."] });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    const reasons = [...steps()[3]!.querySelectorAll('[data-tone="warning"] p')].map((line) => line.textContent);
    expect(reasons).toEqual(["Add a chat.", "Check the key."]);
  });

  it("asks whether to carry on when the test message could not be removed, and carries on", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    expect(steps()[3]!.textContent).toContain(
      "GoatCitadel couldn't remove its test message. Delete it in Telegram if you like.",
    );
    expect(status()).toBe("GoatCitadel couldn't remove its test message. Delete it in Telegram if you like.");

    await click(button("Continue"));
    expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
      workspaceId: "default",
      draftId: "draft-1",
      catalogId: "channel.telegram",
      evidenceId: "proof-1",
    });
    expect(steps()[3]!.getAttribute("data-state")).toBe("done");
  });

  it("comes back to a setup someone said hi to: says so, writes nothing, listens for nothing, and can turn on", async () => {
    vi.useFakeTimers();
    const saidHi = draft({
      revision: 7,
      secretState: KEY_STORED,
      draft: {
        botUsername: "MyGoatBot",
        receiveMode: "poll",
        setupCode: "OLDCODE234",
        allowedSenders: ["777"],
        ownerActorIds: ["777"],
        inboundAccessMode: "allowlist",
        targets: [
          {
            id: "telegram:777",
            label: "Ada Lovelace",
            chatId: "777",
            kind: "private",
            source: "recent_update",
            setupCodeMatched: true,
            default: true,
          },
        ],
      },
    });
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [saidHi] });
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await mount();
    await settle();

    expect(steps()[2]!.getAttribute("data-state")).toBe("done");
    expect(steps()[2]!.textContent).toContain("Ada Lovelace said hi. Only they can message your bot for now.");
    expect(status()).toBe("Ada Lovelace said hi. Only they can message your bot for now.");
    expect(steps()[3]!.getAttribute("data-state")).toBe("current");
    expect(steps()[3]!.textContent).toContain("Who can message your bot: Ada Lovelace");

    await advance(SAY_HI_POLL_MS * 3);
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
    // One look at the bot, and no listening for a code.
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
    expect(api.discoverTelegramSetupTargets.mock.calls.some(([input]) => "setupCode" in input)).toBe(false);

    expect(button("Turn on")?.disabled).toBe(false);
    await click(button("Turn on"));
    expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledWith(expect.objectContaining({ draftId: "draft-1" }));
  });

  it("stops listening for good once someone has said hi", async () => {
    await toSayHi();
    await someoneSaysHi();
    const asked = api.discoverTelegramSetupTargets.mock.calls.length;
    await advance(SETUP_CODE_TTL_MS);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked);
  });

  it("offers a new code when this one expires, and the new code works", async () => {
    await toSayHi();
    const first = savedCode()!;
    await advance(SETUP_CODE_TTL_MS);

    const hi = steps()[2]!;
    expect(hi.textContent).toContain("This code expired.");
    expect(hi.querySelector("svg")).toBeNull();
    expect(hi.textContent).not.toContain(first);
    expect(link("Open @MyGoatBot")).toBeUndefined();
    expect(hi.textContent).not.toContain("Waiting for your hi…");
    expect(status()).toBe("This code expired.");

    await click(button("Get a new code"));
    const second = savedCode()!;
    expect(second).toMatch(CODE);
    expect(second).not.toBe(first);
    expect(link("Open @MyGoatBot")?.getAttribute("href")).toBe(`https://t.me/MyGoatBot?start=${second}`);
    expect(steps()[2]!.textContent).not.toContain("This code expired.");
    expect(steps()[2]!.textContent).toContain("Waiting for your hi…");

    await someoneSaysHi();
    expect(steps()[2]!.getAttribute("data-state")).toBe("done");
  });

  describe("when the bot has more waiting messages than can be looked through", () => {
    const WAITING_NOTE =
      "Your bot has more waiting messages than GoatCitadel can look through, so it can't see your hi yet. Clear them to continue. GoatCitadel skips them when it turns on anyway.";

    async function toAFullPage() {
      await toSayHi();
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ updatesTruncated: true }));
      await advance(SAY_HI_POLL_MS);
      await settle();
    }

    it("says it cannot see the hi yet and offers to clear them, until the answer is no longer a full page", async () => {
      await toAFullPage();
      expect(steps()[2]!.textContent).toContain(WAITING_NOTE);
      expect(steps()[2]!.contains(button("Clear waiting messages")!)).toBe(true);
      expect(container.textContent).not.toContain("hi may take a while");

      api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
      await advance(SAY_HI_POLL_MS);
      await settle();
      expect(container.textContent).not.toContain("more waiting messages than");
      expect(button("Clear waiting messages")).toBeUndefined();
    });

    it("has no button, and no note, when the bot's waiting messages fit", async () => {
      await toSayHi();
      expect(button("Clear waiting messages")).toBeUndefined();
      expect(container.textContent).not.toContain("waiting messages");
    });

    it("clears them with the current code on a click, and keeps waiting for the hi", async () => {
      await toAFullPage();
      const code = savedCode()!;
      api.discoverTelegramSetupTargets.mockClear();
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
      await click(button("Clear waiting messages"));

      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledWith({
        source: "draft",
        draftId: "draft-1",
        expectedRevision: 4,
        setupCode: code,
        skipWaiting: true,
      });
      expect(button("Clear waiting messages")).toBeUndefined();
      expect(container.textContent).not.toContain("waiting messages");
      expect(steps()[2]!.getAttribute("data-state")).toBe("current");
      expect(steps()[2]!.textContent).toContain("Waiting for your hi…");
    });

    it("completes the hi when the code is found in that same answer", async () => {
      await toAFullPage();
      api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ codeSender: ADA }));
      await click(button("Clear waiting messages"));

      expect(steps()[2]!.getAttribute("data-state")).toBe("done");
      expect(status()).toBe("Ada Lovelace said hi. Only they can message your bot for now.");
      expect(button("Clear waiting messages")).toBeUndefined();
      expect(button("Turn on")).toBeDefined();
    });

    it("says the key-check sentence, not Telegram's words, when clearing fails, and offers it again", async () => {
      await toAFullPage();
      api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error(`HTTP 502 for bot${TOKEN}`));
      await click(button("Clear waiting messages"));

      expect(container.textContent).toContain(KEY_FAILED);
      expect(container.textContent).not.toContain("HTTP 502");
      expect(container.textContent).not.toContain("SECRET-TOKEN");
      expect(button("Clear waiting messages")?.disabled).toBe(false);
    });

    it("styles the button as a plain secondary action, in no alert, adding no live region", async () => {
      await toAFullPage();
      const clear = button("Clear waiting messages")!;
      expect(clear.className).toContain("border-line-control");
      expect(clear.className).not.toContain("text-status-failed");
      expect(liveRegions()).toBe(1);
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it("offers a new code, and says why, when the code could not be saved", async () => {
    vi.useFakeTimers();
    arrangeCheck();
    // The key check writes the draft once; the second write, for the code, fails.
    const savesDraft = api.updateChannelSetupDraft.getMockImplementation()!;
    let writes = 0;
    api.updateChannelSetupDraft.mockImplementation(async (...args: unknown[]) => {
      writes += 1;
      if (writes === 2) throw new Error("This changed somewhere else.");
      return savesDraft(...args);
    });
    api.fetchChannelSetupDraft.mockResolvedValue(draft({ revision: 3, secretState: KEY_STORED }));
    await mount();
    await checkKey();
    await settle();

    // The key's own write succeeded; the one for the code did not. One message, beside the steps.
    expect(steps()[2]!.textContent).toContain("Say hi to your bot");
    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
    expect(container.textContent).toContain("This changed somewhere else.");
    expect(steps()[2]!.textContent).not.toContain("Waiting for your hi…");

    await click(button("Get a new code"));
    expect(savedCode()).toMatch(CODE);
    expect(container.querySelector('[data-tone="error"]')).toBeNull();
  });

  it("stops listening, and goes back to the first steps, when the operator starts over", async () => {
    await toSayHi();
    await click(button("Start over"));
    expect(api.discardChannelSetupDraft).toHaveBeenCalledTimes(1);
    expect(keyField()).not.toBeNull();
    expect(steps()[2]!.getAttribute("data-state")).toBe("locked");
    expect(container.textContent).not.toContain("Waiting for your hi…");
    const asked = api.discoverTelegramSetupTargets.mock.calls.length;
    await advance(SAY_HI_POLL_MS * 3);
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(asked);
  });

  it("adds no live region beyond the one status line, whatever happens", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
    turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "failed", message: "Telegram said no." });
    await toSayHi();
    expect(liveRegions()).toBe(1);
    await advance(SETUP_CODE_TTL_MS);
    expect(liveRegions()).toBe(1);
    await click(button("Get a new code"));
    expect(liveRegions()).toBe(1);
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery({ updatesTruncated: true }));
    await advance(SAY_HI_POLL_MS);
    expect(liveRegions()).toBe(1);
    await someoneSaysHi();
    expect(liveRegions()).toBe(1);
    await click(button("Turn on"));
    expect(liveRegions()).toBe(1);
    await click(button("Continue"));
    expect(liveRegions()).toBe(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows no key and no id in any step", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
    await toSayHi();
    await someoneSaysHi();
    await click(button("Turn on"));
    await settle();
    expect(container.innerHTML).not.toContain("SECRET-TOKEN");
    expect(container.textContent).not.toContain("draft-1");
    expect(container.textContent).not.toContain("777");
  });
});
