// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDraft, SlackSetupCheckResult } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { SLACK_APP_TOKEN_FAILED, SLACK_BOT_TOKEN_FAILED } from "./slack-setup-model";
import { SlackSetupPage } from "./SlackSetupPage";

const api = vi.hoisted(() => ({
  fetchChannelSetupDrafts: vi.fn(),
  fetchChannelSetupDraft: vi.fn(),
  createChannelSetupDraft: vi.fn(),
  submitChannelSetupDraftSecrets: vi.fn(),
  checkSlackSetup: vi.fn(),
  updateChannelSetupDraft: vi.fn(),
  discardChannelSetupDraft: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

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

function arrangeCheck(result: SlackSetupCheckResult = checkResult()) {
  api.createChannelSetupDraft.mockResolvedValue(draft({ revision: 1 }));
  api.submitChannelSetupDraftSecrets.mockResolvedValue(draft({ revision: 2, secretState: TOKENS_STORED }));
  api.checkSlackSetup.mockResolvedValue(result);
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
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDraft.mockResolvedValue(draft());
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
  act(() => root.unmount());
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
    // The first two are done. The rest are not built yet in this task, so they stay shut.
    expect(states()).toEqual(["done", "done", "locked", "locked", "locked"]);
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

    expect(api.submitChannelSetupDraftSecrets).toHaveBeenCalledExactlyOnceWith("draft-1", {
      expectedRevision: 1,
      values: { botToken: BOT_TOKEN, appToken: APP_TOKEN },
    });
    expect(steps()[1]!.getAttribute("data-state")).toBe("done");
    expect(steps()[1]!.textContent).toContain("Tokens work. Your bot is @goatcitadel in Goat Team.");
    expect(status()).toBe("Tokens work. Your bot is @goatcitadel in Goat Team.");
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
    // The bot is not announced, and the draft is not marked as this page's.
    expect(container.textContent).not.toContain("Tokens work");
    expect(api.updateChannelSetupDraft).not.toHaveBeenCalled();
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
    expect(states()).toEqual(["done", "done", "locked", "locked", "locked"]);
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

  it("does not go on with a setup made in Settings", async () => {
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
    expect(api.discardChannelSetupDraft).toHaveBeenCalledExactlyOnceWith("draft-1", 3);
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

  it("has a way back to the channel list and on to Settings' other ways", async () => {
    await mount();
    expect(new URL(link("Back to channels")!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe(
      "/chat/messaging/add",
    );
    const more = new URL(link("More options in Settings")!.getAttribute("href")!, "http://cockpit.invalid");
    expect(more.pathname).toBe("/settings/connections");
    expect(more.searchParams.get("channel")).toBe("channel.slack");
    expect(more.hash).toBe("#channels");
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
