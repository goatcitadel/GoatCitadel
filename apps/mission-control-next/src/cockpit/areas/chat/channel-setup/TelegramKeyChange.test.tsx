// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  ChannelSetupDefinition,
  ChannelSetupDiscoveryResult,
  ChannelSetupDraft,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { TelegramKeyChange } from "./TelegramKeyChange";

const api = vi.hoisted(() => ({
  fetchIntegrationConnections: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelRotateSecretDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  discoverTelegramSetupTargets: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const turnOnApi = vi.hoisted(() => ({
  turnOnChannelDraft: vi.fn(),
  acknowledgeCleanupAndTurnOn: vi.fn(),
}));
vi.mock("./turn-on-channel", () => turnOnApi);

const TOKEN = "123456:NEW-SECRET-TOKEN";
const KEY_FAILED =
  "Telegram didn't accept that key, or GoatCitadel couldn't reach Telegram. Check the key and try again.";
const OTHER_APP_NOTE = "Another app is reading this bot's messages. Stop it there, or make a new bot for GoatCitadel.";
const SAVED = "Saved. Telegram uses the new key now.";
const KEY_STORED = { botToken: { configured: true, custody: "temporary" as const } };
const CONNECTION_REVISION = "a".repeat(64);

function connection(config: Record<string, unknown> = {}, overrides: Partial<IntegrationConnection> = {}) {
  return {
    connectionId: "conn-1",
    revision: CONNECTION_REVISION,
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config: { botUsername: "@OldBot", receiveMode: "poll", ...config },
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  } as IntegrationConnection;
}

function rotateDraft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "rotate-1",
    revision: 1,
    catalogId: "channel.telegram",
    connectionId: "conn-1",
    connectionRevision: CONNECTION_REVISION,
    lifecycleMode: "rotate_secret",
    enabled: true,
    draft: { botUsername: "@OldBot", receiveMode: "poll", allowedSenders: ["777"] },
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
    warnings: ["Telegram reports another active update consumer."],
    webhookActive: false,
    botIdentity: { id: "42", username: "NewBot", label: "New Bot" },
    ...overrides,
  };
}

function telegramDefinition(requiredHosts: string[] = ["api.telegram.org"]): ChannelSetupDefinition {
  return {
    catalog: { catalogId: "channel.telegram", key: "telegram", label: "Telegram" },
    wizard: { estimatedMinutes: 5, requiredHosts, picker: { group: "quickest", order: 0 } },
  } as unknown as ChannelSetupDefinition;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <TelegramKeyChange connectionId="conn-1" workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const steps = () => [...container.querySelectorAll<HTMLLIElement>("ol > li")];
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

/** Everything the gateway does for a key check, with the draft it keeps one version on after each write. */
function arrangeCheck(result: ChannelSetupDiscoveryResult = discovery()) {
  api.createChannelRotateSecretDraft.mockResolvedValue(rotateDraft());
  api.submitChannelSetupDraftSecrets.mockImplementation(async (_id: string, input: { expectedRevision: number }) =>
    rotateDraft({ revision: input.expectedRevision + 1, secretState: KEY_STORED }),
  );
  api.discoverTelegramSetupTargets.mockResolvedValue(result);
}

async function toKeyChecked(result?: ChannelSetupDiscoveryResult) {
  arrangeCheck(result);
  await mount();
  await checkKey();
}

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(turnOnApi)]) fn.mockReset();
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connection()] });
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [telegramDefinition()] });
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft());
  // The gateway keeps whatever draft it is sent, one version on.
  api.updateChannelSetupDraft.mockImplementation(
    async (_id: string, input: { expectedRevision: number; draft: Record<string, unknown> }) =>
      rotateDraft({ revision: input.expectedRevision + 1, draft: input.draft, secretState: KEY_STORED }),
  );
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

describe("TelegramKeyChange", () => {
  it("is titled, with two steps and a way back to the channel", async () => {
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Change Telegram's key");
    expect(steps().map((step) => step.querySelector("h2")?.textContent)).toEqual([
      "1. Paste the new key",
      "2. Save the new key",
    ]);
    expect(states()).toEqual(["current", "locked"]);
    expect(new URL(link("Back to channel")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/conn-1",
    );
  });

  it("asks for the key in the same masked field, with the same button", async () => {
    await mount();
    expect(keyField()?.getAttribute("type")).toBe("password");
    expect(keyField()?.getAttribute("autocomplete")).toBe("new-password");
    expect(button("Check key")?.disabled).toBe(true);
    await type(TOKEN);
    expect(button("Check key")?.disabled).toBe(false);
  });

  it("makes no draft by being visited", async () => {
    await mount();
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
    expect(api.createChannelRotateSecretDraft).not.toHaveBeenCalled();
  });

  it("makes a draft for changing the key on the first check, then checks the key through it", async () => {
    arrangeCheck();
    await mount();
    await checkKey();

    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ connectionId: "conn-1" });
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("rotate-1", {
      expectedRevision: 1,
      values: { botToken: TOKEN },
    });
    expect(api.discoverTelegramSetupTargets).toHaveBeenCalledWith({
      source: "draft",
      draftId: "rotate-1",
      expectedRevision: 2,
    });
    expect(steps()[0]!.textContent).toContain("Key works. Your bot is @NewBot.");
    expect(states()).toEqual(["done", "current"]);
  });

  it("saves the new bot on the draft and keeps the channel's own receive mode", async () => {
    await toKeyChecked();
    expect(api.updateChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("rotate-1", {
      expectedRevision: 2,
      draft: { botUsername: "NewBot", receiveMode: "poll", allowedSenders: ["777"] },
    });
    const patch = (api.updateChannelSetupDraft.mock.calls[0]![1] as { draft: Record<string, unknown> }).draft;
    expect(patch).not.toHaveProperty("botToken");
  });

  it("leaves a webhook channel's receive mode as it was", async () => {
    api.fetchIntegrationConnections.mockResolvedValue({ items: [connection({ receiveMode: "webhook" })] });
    arrangeCheck();
    api.createChannelRotateSecretDraft.mockResolvedValue(rotateDraft({ draft: { receiveMode: "webhook" } }));
    await mount();
    await checkKey();
    expect((api.updateChannelSetupDraft.mock.calls[0]![1] as { draft: unknown }).draft).toEqual({
      botUsername: "NewBot",
      receiveMode: "webhook",
    });
  });

  it("reuses the newest draft for changing this channel's key instead of making another", async () => {
    arrangeCheck();
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [
        rotateDraft({ draftId: "older", updatedAt: "2026-10-20T09:00:00.000Z" }),
        rotateDraft({ draftId: "newest", revision: 4, updatedAt: "2026-10-26T09:00:00.000Z" }),
        rotateDraft({ draftId: "newer-but-an-edit", lifecycleMode: "edit", updatedAt: "2026-10-27T09:00:00.000Z" }),
        rotateDraft({ draftId: "another-channel", connectionId: "conn-2", updatedAt: "2026-10-28T09:00:00.000Z" }),
        // Made when the channel was another version: the gateway would refuse to check it.
        rotateDraft({
          draftId: "out-of-date",
          connectionRevision: "b".repeat(64),
          updatedAt: "2026-10-29T09:00:00.000Z",
        }),
      ],
    });
    await mount();
    await checkKey();

    expect(api.createChannelRotateSecretDraft).not.toHaveBeenCalled();
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("newest", {
      expectedRevision: 4,
      values: { botToken: TOKEN },
    });
  });

  it("makes a new draft when the only one is for an older version of the channel", async () => {
    arrangeCheck();
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [rotateDraft({ draftId: "out-of-date", connectionRevision: "b".repeat(64) })],
    });
    await mount();
    await checkKey();
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledExactlyOnceWith("conn-1");
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledWith("rotate-1", expect.anything());
  });

  it("starts another draft on the next try when the channel changed under the one it held", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValueOnce(new Error("The channel connection changed."));
    // What the gateway holds now: a draft from before the channel changed.
    api.fetchChannelSetupDraft.mockResolvedValue(rotateDraft({ connectionRevision: "b".repeat(64) }));
    await mount();
    await checkKey();
    expect(steps()[0]!.textContent).toContain(KEY_FAILED);

    api.createChannelRotateSecretDraft.mockResolvedValue(rotateDraft({ draftId: "rotate-2" }));
    await checkKey();
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledTimes(2);
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("rotate-2", expect.anything());
    expect(states()).toEqual(["done", "current"]);
  });

  it("keeps the same draft when the key is checked again", async () => {
    // A key whose bot sends to a web address leaves the field open to try another.
    await toKeyChecked(discovery({ webhookActive: true }));
    api.discoverTelegramSetupTargets.mockResolvedValue(discovery());
    await checkKey("999:ANOTHER");
    expect(states()).toEqual(["done", "current"]);
    expect(api.createChannelRotateSecretDraft).toHaveBeenCalledTimes(1);
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledTimes(1);
    // The second check carries the version the draft was left at: 3 after the bot was saved.
    expect(api.submitChannelSetupDraftSecrets).toHaveBeenLastCalledWith("rotate-1", {
      expectedRevision: 3,
      values: { botToken: "999:ANOTHER" },
    });
  });

  it("never shows the key back", async () => {
    await toKeyChecked();
    expect(container.innerHTML).not.toContain("NEW-SECRET-TOKEN");
    expect(keyField()).toBeNull();
  });

  it("says in one plain sentence when the key fails, and keeps the field to correct it", async () => {
    arrangeCheck();
    api.discoverTelegramSetupTargets.mockRejectedValue(new Error(`https://api.telegram.org/bot${TOKEN}/getMe failed`));
    await mount();
    await checkKey();

    expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(1);
    expect(steps()[0]!.querySelector('[data-tone="error"]')?.textContent).toBe(KEY_FAILED);
    expect(status()).toBe(KEY_FAILED);
    // The masked field keeps what was typed, to correct it; nothing the page says repeats it or the address it forms.
    expect(container.textContent).not.toContain("NEW-SECRET-TOKEN");
    expect(container.textContent).not.toContain("api.telegram.org/bot");
    expect(states()).toEqual(["current", "locked"]);
    expect(keyField()?.getAttribute("type")).toBe("password");
    // The draft is read again after a failure: storing the key moved its version on.
    expect(api.fetchChannelSetupDraft).toHaveBeenCalledWith("rotate-1");
  });

  it("says so when a draft for changing the key cannot be made", async () => {
    api.createChannelRotateSecretDraft.mockRejectedValue(new Error("nope"));
    await mount();
    await checkKey();
    expect(steps()[0]!.textContent).toContain(KEY_FAILED);
    expect(api.submitChannelSetupDraftSecrets).not.toHaveBeenCalled();
  });

  describe("when the key is for another bot", () => {
    const WARNING = "This key is for @NewBot, not @OldBot. Saving it switches the bot people message.";

    it("warns before saving that the bot people message changes", async () => {
      await toKeyChecked();
      expect(steps()[1]!.querySelector('[data-tone="warning"]')?.textContent).toBe(WARNING);
      expect(status()).toBe(WARNING);
      expect(button("Save key")).toBeDefined();
    });

    it.each([
      ["the same bot", "OldBot"],
      ["the same bot in another case", "oldbot"],
    ])("says nothing for %s", async (_name, username) => {
      await toKeyChecked(discovery({ botIdentity: { id: "42", username } }));
      expect(container.textContent).not.toContain("Saving it switches the bot");
      expect(status()).toBe(`Key works. Your bot is @${username}.`);
      expect(button("Save key")).toBeDefined();
    });

    it("says nothing when the channel never recorded which bot it was", async () => {
      api.fetchIntegrationConnections.mockResolvedValue({
        items: [connection({ botUsername: undefined })],
      });
      await toKeyChecked();
      expect(container.textContent).not.toContain("Saving it switches the bot");
      expect(button("Save key")).toBeDefined();
    });
  });

  describe("what stands in the way of reading the new bot's messages", () => {
    it("ignores a conflict when the channel reads by asking Telegram: that is its own reader", async () => {
      await toKeyChecked(discovery({ updatesConflict: true }));
      expect(container.textContent).not.toContain(OTHER_APP_NOTE);
      expect(container.textContent).not.toContain("Another app is reading");
      expect(states()).toEqual(["done", "current"]);
      expect(button("Save key")?.disabled).toBe(false);
    });

    it("ignores a conflict on a channel whose receive mode has stray spaces around poll", async () => {
      api.fetchIntegrationConnections.mockResolvedValue({ items: [connection({ receiveMode: " poll " })] });
      await toKeyChecked(discovery({ updatesConflict: true }));
      expect(container.textContent).not.toContain("Another app is reading");
      expect(states()).toEqual(["done", "current"]);
    });

    it("says the new bot's messages go to a web address, and offers no way to stop that from here", async () => {
      await toKeyChecked(discovery({ webhookActive: true }));
      const note = steps()[0]!.querySelector('[data-tone="warning"]');
      expect(note?.textContent).toContain("This bot sends its messages to a web address");
      expect(container.textContent).not.toContain("Stop sending to that address");
      expect(button("Stop sending to that address")).toBeUndefined();
      // The key is checked, but the step stays open, with the field to try another key.
      expect(states()).toEqual(["current", "locked"]);
      expect(keyField()).not.toBeNull();
      expect(button("Save key")).toBeUndefined();
    });

    it("never asks Telegram to stop sending to a web address", async () => {
      await toKeyChecked(discovery({ webhookActive: true }));
      for (const [call] of api.discoverTelegramSetupTargets.mock.calls) {
        expect(call).not.toHaveProperty("clearWebhook");
      }
      expect(api.discoverTelegramSetupTargets).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["webhook", { receiveMode: "webhook" }],
      ["no receive mode (saved before the setting)", { receiveMode: undefined }],
    ])("expects a web address on a channel with %s", async (_name, config) => {
      api.fetchIntegrationConnections.mockResolvedValue({ items: [connection(config)] });
      await toKeyChecked(discovery({ webhookActive: true }));
      expect(container.textContent).not.toContain("sends its messages to a web address");
      expect(states()).toEqual(["done", "current"]);
      expect(button("Save key")?.disabled).toBe(false);
    });

    it("says another app is reading the bot when a channel that does not poll finds one", async () => {
      api.fetchIntegrationConnections.mockResolvedValue({ items: [connection({ receiveMode: "webhook" })] });
      await toKeyChecked(discovery({ updatesConflict: true }));
      expect(steps()[0]!.textContent).toContain(OTHER_APP_NOTE);
      expect(states()).toEqual(["current", "locked"]);
    });
  });

  describe("saving the key", () => {
    const plan = { planId: "plan-1" };

    it("lists the one thing it does and saves through the same turn-on call, for this draft", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toKeyChecked();
      expect(states()).toEqual(["done", "current"]);
      expect([...steps()[1]!.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
        "GoatCitadel sends a test message to your chat and then removes it",
      ]);
      expect(button("Turn on")).toBeUndefined();

      await click(button("Save key"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledExactlyOnceWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.telegram",
        requiredHosts: ["api.telegram.org"],
      });
    });

    it("waits for the hosts Telegram needs before it can save", async () => {
      let release!: (value: unknown) => void;
      api.fetchChannelSetupDefinitions.mockReturnValue(new Promise((resolve) => (release = resolve)));
      await toKeyChecked();
      expect(button("Save key")?.disabled).toBe(true);
      await act(async () => release({ items: [telegramDefinition()] }));
      await settle();
      expect(button("Save key")?.disabled).toBe(false);
    });

    it("says what it is doing while it works, and ignores a second click", async () => {
      let finish!: (outcome: unknown) => void;
      turnOnApi.turnOnChannelDraft.mockReturnValue(new Promise((resolve) => (finish = resolve)));
      await toKeyChecked();
      await click(button("Save key"));
      expect(button("Saving…")).toBeDefined();
      expect(status()).toBe("Saving…");
      await click(button("Saving…"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);
      await act(async () => finish({ kind: "completed", plan }));
      await settle();
    });

    it("says it is saved and links back to Telegram's page", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      await toKeyChecked();
      await click(button("Save key"));

      expect(states()).toEqual(["done", "done"]);
      expect(steps()[1]!.textContent).toContain(SAVED);
      expect(status()).toBe(SAVED);
      const back = link("Back to Telegram's page");
      expect(new URL(back!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/conn-1");
      // Not the words of turning a new channel on.
      expect(container.textContent).not.toContain("Telegram is on.");
      expect(link("Open Telegram's page")).toBeUndefined();
    });

    it("reads the channel's details again so its page shows the new bot", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan });
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await toKeyChecked();
      expect(invalidate).not.toHaveBeenCalled();
      await click(button("Save key"));
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["settings", "integration-connections"] });
    });

    it("shows why it could not save, once, and lets the operator try again", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "failed", message: "Telegram said no." });
      await toKeyChecked();
      await click(button("Save key"));
      expect(steps()[1]!.textContent).toContain("Telegram said no.");
      expect(status()).toBe("Telegram said no.");
      expect(states()).toEqual(["done", "current"]);
      expect(button("Save key")).toBeDefined();
    });

    it("sends an approval it cannot make for the operator to Inbox", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan, approvalId: "approval-9" });
      await toKeyChecked();
      await click(button("Save key"));
      const inbox = link("Approve it in Inbox");
      expect(inbox?.getAttribute("href")).toContain("approvalId=approval-9");
    });

    it("sends other cases to the channel's setup in Settings", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "elsewhere", plan });
      await toKeyChecked();
      await click(button("Save key"));
      const settings = link("Finish this in Settings");
      expect(new URL(settings!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/settings/connections");
    });

    it("carries on after a test message that could not be removed, without testing again", async () => {
      turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "needs_cleanup_ack", evidenceId: "proof-1" });
      turnOnApi.acknowledgeCleanupAndTurnOn.mockResolvedValue({ kind: "completed", plan });
      await toKeyChecked();
      await click(button("Save key"));
      expect(button("Save key")).toBeUndefined();
      await click(button("Continue"));
      expect(turnOnApi.turnOnChannelDraft).toHaveBeenCalledTimes(1);
      expect(turnOnApi.acknowledgeCleanupAndTurnOn).toHaveBeenCalledWith({
        workspaceId: "default",
        draftId: "rotate-1",
        catalogId: "channel.telegram",
        evidenceId: "proof-1",
      });
      expect(steps()[1]!.textContent).toContain(SAVED);
    });
  });

  describe("when the channel cannot be shown", () => {
    it("says it is loading", async () => {
      api.fetchIntegrationConnections.mockReturnValue(new Promise(() => undefined));
      await mount();
      expect(container.textContent).toContain("Loading channel…");
      expect(keyField()).toBeNull();
    });

    it("says it could not be loaded and tries again", async () => {
      api.fetchIntegrationConnections.mockRejectedValueOnce(new Error("offline"));
      await mount();
      expect(container.textContent).toContain("Couldn't load this channel.");
      expect(keyField()).toBeNull();
      await click(button("Try again"));
      expect(keyField()).not.toBeNull();
    });

    it.each([
      ["is not there", []],
      ["is not Telegram", [connection({}, { key: "discord", catalogId: "channel.discord" })]],
    ])("says it cannot find a Telegram channel when the channel %s", async (_name, items) => {
      api.fetchIntegrationConnections.mockResolvedValue({ items });
      await mount();
      expect(container.textContent).toContain("We couldn't find this Telegram channel.");
      expect(keyField()).toBeNull();
      expect(link("Back to channel")).toBeDefined();
    });
  });

  it("has one live region and never an alert, through the whole change", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan: { planId: "plan-1" } });
    const live = () => container.querySelectorAll('[role="status"], [role="alert"], [aria-live]').length;
    arrangeCheck();
    await mount();
    expect(live()).toBe(1);
    await checkKey();
    expect(live()).toBe(1);
    await click(button("Save key"));
    expect(live()).toBe(1);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows no id or version of the draft or channel", async () => {
    turnOnApi.turnOnChannelDraft.mockResolvedValue({ kind: "completed", plan: { planId: "plan-1" } });
    await toKeyChecked();
    await click(button("Save key"));
    for (const hidden of ["rotate-1", "plan-1", "a".repeat(64), "conn-1"]) {
      expect(container.textContent).not.toContain(hidden);
    }
  });
});
