// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { CONVERTED_SETUP_CHANNELS, KEY_CHANGE_CHANNELS } from "./channel-picker-model";
import { ChannelSetupView, KEY_CHANGE_PAGES, SETUP_PAGES } from "./ChannelSetupView";

const api = vi.hoisted(() => ({
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

function definition(key: string, label: string): ChannelSetupDefinition {
  return {
    catalog: { catalogId: `channel.${key}`, key, label },
    wizard: { estimatedMinutes: 10, picker: { group: "quickest", order: 0 } },
  } as unknown as ChannelSetupDefinition;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function mount(channelKey: string) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelSetupView view={{ kind: "setup", channelKey }} workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  api.fetchChannelSetupDefinitions.mockReset();
  api.fetchChannelSetupDrafts.mockReset();
  api.fetchChannelSetupDefinitions.mockResolvedValue({
    items: [
      definition("telegram", "Telegram"),
      definition("discord", "Discord"),
      definition("slack", "Slack"),
      definition("mattermost", "Mattermost"),
    ],
  });
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
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

describe("ChannelSetupView", () => {
  it("opens Telegram's own setup page", async () => {
    await mount("telegram");
    expect(container.querySelector("h1")?.textContent).toBe("Set up Telegram");
    expect(container.textContent).toContain("Paste your bot's key");
    expect(container.textContent).not.toContain("is set up in Advanced channel setup");
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.telegram" });
  });

  it("opens Discord's own setup page", async () => {
    await mount("discord");
    expect(container.querySelector("h1")?.textContent).toBe("Set up Discord");
    expect(container.textContent).toContain("Paste your bot's token");
    expect(container.textContent).not.toContain("is set up in Advanced channel setup");
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.discord" });
  });

  it("opens Slack's own setup page", async () => {
    await mount("slack");
    expect(container.querySelector("h1")?.textContent).toBe("Set up Slack");
    expect(container.textContent).toContain("Install it and copy two tokens");
    expect(container.textContent).not.toContain("is set up in Advanced channel setup");
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.slack" });
  });

  it("still sends a channel without a page of its own to Advanced channel setup", async () => {
    await mount("mattermost");
    expect(container.querySelector("h1")?.textContent).toBe("Add Mattermost");
    expect(container.textContent).toContain("Mattermost is set up in Advanced channel setup.");
    expect(container.textContent).toContain("Set up Mattermost in Advanced channel setup");
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
  });

  it("does not open Telegram's page when the picker does not offer it", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [definition("mattermost", "Mattermost")] });
    await mount("telegram");
    expect(container.textContent).toContain("This channel isn't available.");
    expect(container.textContent).not.toContain("Paste your bot's key");
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
  });
});

describe("the pages ChannelSetupView chooses between", () => {
  it("has a setup page only for a channel the picker opens in Chat", () => {
    for (const key of SETUP_PAGES.keys()) expect(CONVERTED_SETUP_CHANNELS.has(key), key).toBe(true);
    expect(SETUP_PAGES.has("telegram")).toBe(true);
    expect(SETUP_PAGES.has("discord")).toBe(true);
    expect(SETUP_PAGES.has("slack")).toBe(true);
    expect(SETUP_PAGES.has("whatsapp")).toBe(true);
  });

  it("has a key page for exactly the channels the channel page sends there", () => {
    // ChannelManageSection links "Change the key" by KEY_CHANGE_CHANNELS; the view must have a page for each.
    expect([...KEY_CHANGE_PAGES.keys()].sort()).toEqual([...KEY_CHANGE_CHANNELS].sort());
  });

  it("does not take a name from the object prototype for a channel", () => {
    expect(SETUP_PAGES.has("constructor")).toBe(false);
    expect(KEY_CHANGE_PAGES.has("toString")).toBe(false);
  });
});
