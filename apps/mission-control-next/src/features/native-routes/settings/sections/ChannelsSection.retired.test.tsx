// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeRetiredChannel } from "@goatcitadel/contracts";
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { __resetChannelMutationStateForTests } from "./channel-setup-state";
import { ChannelsSection } from "./ChannelsSection";

const api = vi.hoisted(() => ({
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchSettings: vi.fn(),
  fetchAgenticChannelDeliveries: vi.fn(),
}));
// What a selected connection's panel reads about itself; no test here may reach a real Gateway for it.
const operations = vi.hoisted(() => ({ fetchChannelSetupJourney: vi.fn(), fetchTelegramChannelPairings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", async (original) => ({
  ...(await original<object>()),
  ...operations,
}));

let root: Root;
let container: HTMLDivElement;

// Saved as enabled and connected, the way it was left when the channel was retired.
const saved = (key: string, label: string) => ({
  connectionId: `conn-${key}`,
  revision: "r1",
  catalogId: `channel.${key}`,
  kind: "channel",
  key,
  label,
  enabled: true,
  status: "connected",
  config: {},
  createdAt: "2026-10-27T10:00:00.000Z",
  updatedAt: "2026-10-27T10:00:00.000Z",
});

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function show(...connections: ReturnType<typeof saved>[]) {
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [] });
  api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
  api.fetchIntegrationConnections.mockResolvedValue({ items: connections });
  api.fetchAgenticChannelDeliveries.mockResolvedValue({ deliveries: [] });
  api.fetchSettings.mockResolvedValue({ features: {} });
  operations.fetchChannelSetupJourney.mockRejectedValue(new Error("Not under test."));
  operations.fetchTelegramChannelPairings.mockRejectedValue(new Error("Not under test."));
  const props = {
    activeWorkspaceId: "default",
    activeWorkspaceName: "Default",
    setActiveWorkspaceId: vi.fn(),
    navigate: vi.fn(),
    route: { area: "settings", section: "channels", theme: "light" },
    section: "channels",
  } as unknown as React.ComponentProps<typeof ChannelsSection>;
  await act(async () => root.render(<ChannelsSection {...props} />));
  await settle();
}

const rowOf = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button.mc-next-settings-selectable")].find((item) =>
    item.textContent?.includes(label),
  )!;
const buttonNamed = (label: string) =>
  [...container.querySelectorAll("button")].find((candidate) => candidate.textContent?.startsWith(label));

beforeEach(() => {
  vi.resetAllMocks();
  __resetSessionViewStateForTests();
  __resetChannelMutationStateForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("a retired channel's saved connection in the Classic channels page", () => {
  it.each([
    ["signal", "Home Signal"],
    ["imessage", "Home iMessage"],
    ["zalouser", "Home Zalo"],
  ])("lists a saved %s connection as Removed with its reason, not as enabled or connected", async (key, label) => {
    await show(saved(key, label));
    const row = rowOf(label);
    expect(row.textContent).toContain("Removed");
    expect(row.textContent).toContain(describeRetiredChannel(key));
    expect(row.textContent).not.toMatch(/enabled|disabled|connected/i);
  });

  it("keeps a working channel's row as it was, beside a retired one", async () => {
    await show(saved("signal", "Home Signal"), saved("slack", "Team Slack"));
    expect(rowOf("Team Slack").textContent).toContain("connected");
    expect(rowOf("Team Slack").textContent).toContain("slack · enabled");
    expect(rowOf("Team Slack").textContent).not.toContain("Removed");
  });

  it("opens a retired connection with its reason and nothing that implies it can send", async () => {
    await show(saved("signal", "Home Signal"));
    await act(async () => rowOf("Home Signal").click());
    await settle();
    const detail = container.textContent ?? "";
    expect(detail).toContain(describeRetiredChannel("signal"));
    // The old status line, "signal · connected · Enabled", is gone.
    expect(detail).not.toContain("signal · connected");
    expect(buttonNamed("Edit setup")).toBeUndefined();
    expect(container.querySelector('section[aria-label="Channel journey"]')).toBeNull();
    expect(operations.fetchChannelSetupJourney).not.toHaveBeenCalled();
  });

  it("keeps a working connection's status line and Edit setup", async () => {
    await show(saved("slack", "Team Slack"));
    await act(async () => rowOf("Team Slack").click());
    await settle();
    expect(container.textContent).toContain("slack · connected · Enabled");
    expect(buttonNamed("Edit setup")).toBeDefined();
  });
});
