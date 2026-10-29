// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelPickerGroup, ChannelSetupDefinition, ChannelSetupPickerHint } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelPicker } from "./ChannelPicker";

const api = vi.hoisted(() => ({ fetchChannelSetupDefinitions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

function definition(
  key: string,
  label: string,
  group: ChannelPickerGroup,
  order: number,
  extra: Partial<ChannelSetupPickerHint> = {},
  estimatedMinutes = 10,
): ChannelSetupDefinition {
  return {
    catalog: { catalogId: `channel.${key}`, key, label },
    wizard: { estimatedMinutes, picker: { group, order, ...extra } },
  } as unknown as ChannelSetupDefinition;
}

const DEFINITIONS: ChannelSetupDefinition[] = [
  definition("slack", "Slack", "quickest", 1, { note: "Receiving needs a public web address" }),
  definition("telegram", "Telegram", "quickest", 0, { minutes: 3 }, 8),
  definition("matrix", "Matrix", "team_chat", 0, { note: "Needs a Matrix bot account" }, 15),
  definition("whatsapp", "WhatsApp", "phone_apps", 0, { note: "Business account + public web address" }, 25),
  {
    catalog: { catalogId: "channel.zalouser", key: "zalouser", label: "Zalo personal" },
    wizard: { estimatedMinutes: 5 },
  } as unknown as ChannelSetupDefinition,
];

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
        <ChannelPicker workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function tile(label: string): HTMLAnchorElement {
  const found = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((link) =>
    link.textContent?.includes(label),
  );
  if (!found) throw new Error(`No link contains "${label}"`);
  return found;
}

function pathOf(link: HTMLAnchorElement) {
  const url = new URL(link.getAttribute("href")!, "http://cockpit.invalid");
  return url.pathname + url.search + url.hash;
}

beforeEach(() => {
  api.fetchChannelSetupDefinitions.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe("ChannelPicker", () => {
  it("shows the heading, the three groups and a tile for each channel", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Add a channel");
    expect([...container.querySelectorAll("h2")].map((heading) => heading.textContent)).toEqual([
      "Quickest",
      "Team and self-hosted chat",
      "Phone apps",
    ]);
    // Within a group, tiles follow the picker order, not the list order; a channel without a hint has no tile.
    expect([...container.querySelectorAll("li a")].map((link) => link.querySelector("span")?.textContent)).toEqual([
      "Telegram",
      "Slack",
      "Matrix",
      "WhatsApp",
    ]);
    expect(container.textContent).not.toContain("Zalo personal");
  });

  it("reads each tile as a name, a time and what the channel needs", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
    await mount();
    expect(tile("Telegram").textContent).toContain("Telegram");
    expect(tile("Telegram").textContent).toContain("About 3 min");
    // Slack has no minutes of its own, so its wizard's estimate shows.
    expect(tile("Slack").textContent).toContain("About 10 min");
    expect(tile("Slack").textContent).toContain("Receiving needs a public web address");
    expect(tile("Telegram").textContent).not.toContain("public web address");
  });

  it("opens Telegram's and Slack's own setup pages and sends the rest to Settings", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
    await mount();
    expect(pathOf(tile("Telegram"))).toMatch(/^\/chat\/messaging\/add\/telegram\?/);
    expect(pathOf(tile("Slack"))).toMatch(/^\/chat\/messaging\/add\/slack\?/);
    expect(pathOf(tile("Matrix"))).toBe("/settings/connections?channel=channel.matrix&shell=cockpit#channels");
  });

  it("reads the definitions once and keeps them for the session", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
    await mount();
    expect(api.fetchChannelSetupDefinitions).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(api.fetchChannelSetupDefinitions).toHaveBeenCalledTimes(1);
  });

  it("says it is loading, in plain text", async () => {
    api.fetchChannelSetupDefinitions.mockReturnValue(new Promise(() => undefined));
    await mount();
    expect(container.querySelector("h1")?.textContent).toBe("Add a channel");
    expect(container.textContent).toContain("Loading channels…");
    expect(container.querySelector("li a")).toBeNull();
  });

  it("says what happened when the channels cannot be read, and tries again", async () => {
    api.fetchChannelSetupDefinitions.mockRejectedValue(new Error("offline"));
    await mount();
    expect(container.textContent).toContain("Couldn't load the channels.");
    expect(container.textContent).not.toContain("offline");
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
    const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Try again")!;
    await act(async () => retry.click());
    await settle();
    expect(container.textContent).toContain("Telegram");
    expect(container.textContent).not.toContain("Couldn't load the channels.");
  });

  it("says so when no channel can be offered", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [] });
    await mount();
    expect(container.textContent).toContain("No channels are available to add.");
  });

  it("adds no live regions", async () => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
    await mount();
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });

  it("adds no live region when the channels cannot be read", async () => {
    api.fetchChannelSetupDefinitions.mockRejectedValue(new Error("offline"));
    await mount();
    expect(container.textContent).toContain("Couldn't load the channels.");
    expect(container.querySelector('[role="status"], [role="alert"], [aria-live]')).toBeNull();
  });
});
