// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDraft, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { DISCORD_INTENT_OFF, DISCORD_TOKEN_FAILED } from "./discord-setup-model";
import { DiscordSetupPage } from "./DiscordSetupPage";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkDiscordSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

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

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
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

    // With the intent on, step 2 is done. Steps 3 to 5 have nothing to do yet, so they stay locked.
    api.checkDiscordSetup.mockResolvedValue(checkResult());
    await click(button("Check again"));
    expect(states()).toEqual(["done", "done", "locked", "locked", "locked"]);
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
    expect(status()).toBe("Token works. Your bot is Goat Bot.");
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

  it("says the plain sentence beside Check again when it cannot reach Discord", async () => {
    arrangeCheck(checkResult({ messageContentIntent: false }));
    await mount();
    await checkToken();
    api.checkDiscordSetup.mockRejectedValue(new Error(`Bot ${TOKEN}`));
    await click(button("Check again"));
    expect(steps()[1]!.textContent).toContain(DISCORD_TOKEN_FAILED);
    expect(steps()[1]!.textContent).toContain(DISCORD_INTENT_OFF);
    expect(button("Check again")).toBeDefined();
    expect(container.innerHTML).not.toContain("SECRET");
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
