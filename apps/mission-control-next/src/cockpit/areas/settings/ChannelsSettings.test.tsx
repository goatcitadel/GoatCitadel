// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";
import { __resetChannelMutationStateForTests } from "../../../features/native-routes/settings/sections/channel-setup-state";
import { ChannelsSettings } from "./ChannelsSettings";

const api = vi.hoisted(() => ({
  createChannelSetupDraft: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchSettings: vi.fn(),
}));
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("../../app/use-cockpit-route", () => ({
  useCockpitRoute: () => ({ navigate: route.navigate, search: route.search }),
}));

let root: Root;
let container: HTMLDivElement;

/** Only what the create panel reads: the catalog entry and the wizard's estimate. */
function definition(key: string, label: string): ChannelSetupDefinition {
  return {
    catalog: { catalogId: `channel.${key}`, key, label, description: `Connect GoatCitadel to ${label}.` },
    wizard: { difficulty: "easy", estimatedMinutes: 10 },
  } as unknown as ChannelSetupDefinition;
}

async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(search: string) {
  route.search = search;
  await act(async () => {
    root.render(<ChannelsSettings workspaceId="default" />);
  });
  await settle();
}

const createPanel = () => container.querySelector('section[aria-label="New channel setup"]');
const picker = () => container.querySelector<HTMLSelectElement>('select[aria-label="Channel definition"]');
const buttonNamed = (label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionViewStateForTests();
  __resetChannelMutationStateForTests();
  route.search = "";
  api.fetchChannelSetupDefinitions.mockResolvedValue({
    items: [definition("slack", "Slack"), definition("discord", "Discord")],
  });
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
  api.fetchSettings.mockResolvedValue({ features: {} });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("Settings channels point to Messaging", () => {
  it("opens with a plain pointer to Messaging above the existing intro", async () => {
    await mount("");
    const intro = container.querySelector("header");
    const pointer = intro?.querySelector("p");
    expect(pointer?.textContent).toBe("Add and manage channels from Messaging in Chat. Open Messaging");
    expect(intro?.querySelectorAll("p")).toHaveLength(2);
    expect(intro?.querySelectorAll("p")[1]?.textContent).toContain("Connections and setup drafts belong");
    // Not a live region: the shell's live-region budget has no room for this line.
    expect(intro?.querySelector("[role], [aria-live]")).toBeNull();
    const link = pointer?.querySelector("a");
    expect(link?.textContent).toBe("Open Messaging");
    expect(new URL(link!.getAttribute("href")!, "http://cockpit.invalid").pathname).toBe("/chat/messaging/add");
  });

  it("opens the create panel with the named channel selected, without creating a draft", async () => {
    await mount("?channel=channel.slack");
    expect(createPanel()).not.toBeNull();
    expect(picker()?.value).toBe("channel.slack");
    expect(container.textContent).toContain("Connect GoatCitadel to Slack.");
    expect(buttonNamed("Start guided setup")?.disabled).toBe(false);
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("waits for the definitions before it opens anything", async () => {
    let release!: (value: { items: ChannelSetupDefinition[] }) => void;
    api.fetchChannelSetupDefinitions.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mount("?channel=channel.slack");
    expect(createPanel()).toBeNull();
    await act(async () => release({ items: [definition("slack", "Slack")] }));
    await settle();
    expect(picker()?.value).toBe("channel.slack");
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("changes nothing for a channel it has no definition for", async () => {
    await mount("?channel=channel.carrier-pigeon");
    expect(createPanel()).toBeNull();
    expect(picker()).toBeNull();
    expect(buttonNamed("Back to channels")).toBeUndefined();
    expect(container.querySelector('input[aria-label="Search channels"]')).not.toBeNull();
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("changes nothing when no channel is named", async () => {
    await mount("");
    expect(createPanel()).toBeNull();
    expect(container.querySelector('input[aria-label="Search channels"]')).not.toBeNull();
  });

  it("applies once: a later choice or a refresh does not snap back to the linked channel", async () => {
    await mount("?channel=channel.slack");
    const select = picker()!;
    await act(async () => {
      select.value = "channel.discord";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(picker()?.value).toBe("channel.discord");

    await act(async () => buttonNamed("Refresh channels")!.click());
    await settle();
    expect(picker()?.value).toBe("channel.discord");

    await act(async () => buttonNamed("Back to channels")!.click());
    await settle();
    expect(createPanel()).toBeNull();
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });
});
