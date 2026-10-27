// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDiscoveryResult, ChannelSetupDraft } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { TelegramSetupPage } from "./TelegramSetupPage";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  discoverTelegramSetupTargets: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

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

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  await act(async () => {
    root.render(<TelegramSetupPage workspaceId="default" />);
  });
  await settle();
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li")];
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
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.discardChannelSetupDraft.mockResolvedValue({ draftId: "draft-1", deleted: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetCredentialInputsForTests();
});

describe("TelegramSetupPage", () => {
  it("is titled and shows the four steps in order", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Set up Telegram");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Make your bot",
      "2. Paste the key BotFather sent you",
      "3. Say hi to your bot",
      "4. Turn it on",
    ]);
  });

  it("opens BotFather from a code and from a link", async () => {
    await mount();
    const first = steps()[0]!;
    expect(first.textContent).toContain(
      "Scan this with your phone to open BotFather in Telegram. Send /newbot and pick a name.",
    );
    expect(first.querySelector("svg")?.getAttribute("aria-label")).toBe("QR code that opens BotFather");
    const botFather = link("Open BotFather");
    expect(botFather?.getAttribute("href")).toBe("https://t.me/BotFather");
    expect(botFather?.getAttribute("target")).toBe("_blank");
    expect(botFather?.getAttribute("rel")).toContain("noopener");
  });

  it("asks for the key in a labelled field and checks it with a button", async () => {
    await mount();
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
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Key works. Your bot is @MyGoatBot.");
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
    expect(api.discardChannelSetupDraft).toHaveBeenCalledWith("draft-1", 3);
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

  it("points to Settings for more options", async () => {
    await mount();
    const more = link("More options in Settings");
    expect(more).toBeDefined();
    const target = new URL(more!.getAttribute("href")!, "http://cockpit.invalid");
    expect(target.pathname).toBe("/settings/connections");
    expect(target.searchParams.get("channel")).toBe("channel.telegram");
    expect(target.hash).toBe("#channels");
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
