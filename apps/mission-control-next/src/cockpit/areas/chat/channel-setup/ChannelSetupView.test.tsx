// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetCredentialInputsForTests } from "../../../../features/native-routes/settings/credential-input-owner";
import { ChannelSetupView } from "./ChannelSetupView";

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
    items: [definition("telegram", "Telegram"), definition("slack", "Slack")],
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
    expect(container.textContent).not.toContain("Its steps are in Settings");
    expect(api.fetchChannelSetupDrafts).toHaveBeenCalledWith({ catalogId: "channel.telegram" });
  });

  it("still sends a channel without a page of its own to Settings", async () => {
    await mount("slack");
    expect(container.querySelector("h1")?.textContent).toBe("Add Slack");
    expect(container.textContent).toContain("Set up Slack in Settings");
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
  });

  it("does not open Telegram's page when the picker does not offer it", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [definition("slack", "Slack")] });
    await mount("telegram");
    expect(container.textContent).toContain("This channel isn't available.");
    expect(container.textContent).not.toContain("Paste your bot's key");
    expect(api.fetchChannelSetupDrafts).not.toHaveBeenCalled();
  });
});
