// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition, IntegrationConnection } from "@goatcitadel/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MessagingView } from "../../app/routes";
import { ChatMainColumn } from "./ChatMainColumn";
import { settingsChannelSetupHref } from "./channel-setup/channel-picker-model";

const api = vi.hoisted(() => ({ fetchChannelSetupDefinitions: vi.fn(), fetchIntegrationConnections: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeWorkspaceId: "workspace-a" }),
}));
vi.mock("./ChannelPage", () => ({
  ChannelPage: ({ connectionId, workspaceId }: { connectionId: string; workspaceId: string }) => (
    <h1>
      Channel page {connectionId} in {workspaceId}
    </h1>
  ),
}));

const DEFINITIONS = [
  {
    catalog: { catalogId: "channel.mattermost", key: "mattermost", label: "Mattermost" },
    wizard: { estimatedMinutes: 10, picker: { group: "quickest", order: 0 } },
  },
] as unknown as ChannelSetupDefinition[];

function connectionOf(key: string, label: string, config?: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: "a".repeat(64),
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label,
    enabled: true,
    status: "connected",
    config: config ?? (key === "telegram" ? { botUsername: "@MyGoatBot", receiveMode: "poll" } : {}),
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
  } as IntegrationConnection;
}

const live = { effects: 0 };
function Conversation() {
  useEffect(() => {
    live.effects += 1;
    return () => {
      live.effects -= 1;
    };
  }, []);
  return <input aria-label="Draft" defaultValue="" />;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function render(messaging: MessagingView | null) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChatMainColumn messaging={messaging}>
          <Conversation />
        </ChatMainColumn>
      </QueryClientProvider>,
    );
  });
  // The views are lazy chunks and the definitions are a query: wait until nothing still says it is loading.
  for (let attempt = 0; attempt < 100 && container.textContent?.includes("Loading channel"); attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

function link(text: string): URL {
  const found = [...container.querySelectorAll<HTMLAnchorElement>("a")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!found) throw new Error(`No link contains "${text}"`);
  return new URL(found.getAttribute("href")!, "http://cockpit.invalid");
}

function conversationHidden() {
  return container.querySelector<HTMLElement>('input[aria-label="Draft"]')?.closest<HTMLElement>("[style]")?.style
    .display;
}

beforeEach(() => {
  live.effects = 0;
  api.fetchChannelSetupDefinitions.mockReset();
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: DEFINITIONS });
  api.fetchIntegrationConnections.mockReset();
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connectionOf("mattermost", "Mattermost")] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
});

it("shows the channel page in place of the conversation, keeping the conversation but suspending it", async () => {
  await render(null);
  const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  draft.value = "Keep this draft";
  expect(live.effects).toBe(1);
  expect(container.querySelector("h1")).toBeNull();

  await render({ kind: "channel", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Channel page conn-1 in workspace-a");
  // Same element, same draft: only hidden and no longer running effects (such as marking messages read).
  expect(container.querySelector('input[aria-label="Draft"]')).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
  expect(draft.closest<HTMLElement>("[style]")?.style.display).toBe("none");
  expect(live.effects).toBe(0);

  await render(null);
  expect(container.querySelector("h1")).toBeNull();
  expect(live.effects).toBe(1);
  expect(draft.value).toBe("Keep this draft");
  expect(draft.closest<HTMLElement>("[style]")?.style.display ?? "").not.toBe("none");
});

it("shows the channel picker in place of the conversation", async () => {
  await render(null);
  const draft = container.querySelector<HTMLInputElement>('input[aria-label="Draft"]')!;
  draft.value = "Keep this draft";

  await render({ kind: "picker" });
  expect(container.querySelector("h1")?.textContent).toBe("Add a channel");
  expect(container.textContent).toContain("Mattermost");
  expect(container.querySelector('input[aria-label="Draft"]')).toBe(draft);
  expect(draft.value).toBe("Keep this draft");
  expect(conversationHidden()).toBe("none");
  expect(live.effects).toBe(0);

  await render(null);
  expect(container.querySelector("h1")).toBeNull();
  expect(live.effects).toBe(1);
});

it("sends a channel without its own setup page to Settings", async () => {
  await render({ kind: "setup", channelKey: "mattermost" });
  expect(container.querySelector("h1")?.textContent).toBe("Add Mattermost");
  expect(container.textContent).toContain("Set up Mattermost in Settings");
  const target = link("Set up Mattermost in Settings");
  const expected = new URL(settingsChannelSetupHref("channel.mattermost"), "http://cockpit.invalid");
  expect(target.pathname).toBe(expected.pathname);
  expect(target.searchParams.get("channel")).toBe("channel.mattermost");
  expect(target.hash).toBe("#channels");
  expect(link("Back to channels").pathname).toBe("/chat/messaging/add");
  expect(conversationHidden()).toBe("none");
});

it("says a channel that is not offered is not available, with a way back to the picker", async () => {
  await render({ kind: "setup", channelKey: "carrier-pigeon" });
  expect(container.textContent).toContain("This channel isn't available.");
  expect(container.textContent).not.toContain("Settings");
  expect(link("Back to channels").pathname).toBe("/chat/messaging/add");
});

it("shows Telegram's own key page for a Telegram channel's key change, with a way back to the channel page", async () => {
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connectionOf("telegram", "Telegram")] });
  await render({ kind: "change_key", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Change Telegram's key");
  expect(container.textContent).toContain("Paste the new key");
  expect(container.textContent).not.toContain("Change the key in Settings");
  expect(link("Back to channel").pathname).toBe("/chat/messaging/conn-1");
  expect(conversationHidden()).toBe("none");
  expect(live.effects).toBe(0);
});

it.each([
  ["discord", "Discord", { runtimeMode: "gateway" }, "Change Discord's token", "Paste the new token"],
  ["slack", "Slack", { receiveMode: "socket" }, "Change Slack's tokens", "Paste the new tokens"],
  [
    "whatsapp",
    "WhatsApp",
    {
      phoneNumberId: "106540352242922",
      businessAccountId: "102290129340398",
      appId: "670843887433847",
      appSecret: "[REDACTED]",
    },
    "Change WhatsApp's access token",
    "Paste the new token",
  ],
])(
  "shows %s's own token page for the key change of a connection that uses a bot, with a way back to the channel page",
  async (key, label, config, title, step) => {
    api.fetchIntegrationConnections.mockResolvedValue({ items: [connectionOf(key, label, config)] });
    await render({ kind: "change_key", connectionId: "conn-1" });
    expect(container.querySelector("h1")?.textContent).toBe(title);
    expect(container.textContent).toContain(step);
    expect(container.textContent).not.toContain("Change the key in Settings");
    expect(link("Back to channel").pathname).toBe("/chat/messaging/conn-1");
    expect(conversationHidden()).toBe("none");
    expect(live.effects).toBe(0);
  },
);

it.each([
  [
    "a Discord webhook-only (bridge) connection",
    "discord",
    "Discord",
    { runtimeMode: "bridge", webhookUrl: "[REDACTED]" },
  ],
  ["a Discord connection with only a webhook", "discord", "Discord", { webhookUrl: "[REDACTED]" }],
  ["a Slack webhook connection", "slack", "Slack", { receiveMode: "webhook", webhookUrl: "[REDACTED]" }],
  ["a Slack OAuth connection", "slack", "Slack", { authMode: "oauth", receiveMode: "webhook", slackTeamId: "T1" }],
])("points the key change of %s at Settings, with no token page", async (_name, key, label, config) => {
  api.fetchIntegrationConnections.mockResolvedValue({ items: [connectionOf(key, label, config)] });
  await render({ kind: "change_key", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Change this channel's key");
  expect(container.textContent).toContain("You can't change a key from Chat yet. Settings has it.");
  expect(link("Change the key in Settings").pathname).toBe("/settings/connections");
  expect(link("Back to channel").pathname).toBe("/chat/messaging/conn-1");
  expect(container.textContent).not.toContain("Paste the new token");
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it("points the key change of a send-only WhatsApp connection at Settings: it has no saved App ID or secret to check the token with", async () => {
  api.fetchIntegrationConnections.mockResolvedValue({
    items: [connectionOf("whatsapp", "WhatsApp", { phoneNumberId: "106540352242922", accessToken: "[REDACTED]" })],
  });
  await render({ kind: "change_key", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Change this channel's key");
  expect(link("Change the key in Settings").pathname).toBe("/settings/connections");
  expect(link("Back to channel").pathname).toBe("/chat/messaging/conn-1");
  expect(container.textContent).not.toContain("Paste the new token");
  expect(container.querySelector('input[type="password"]')).toBeNull();
});

it("points a key change for any other channel at Settings, with a way back to the channel page", async () => {
  await render({ kind: "change_key", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Change this channel's key");
  expect(link("Back to channel").pathname).toBe("/chat/messaging/conn-1");
  expect(link("Change the key in Settings").pathname).toBe("/settings/connections");
  expect(conversationHidden()).toBe("none");
});

it("points a key change at Settings when the channel cannot be read", async () => {
  api.fetchIntegrationConnections.mockRejectedValue(new Error("offline"));
  await render({ kind: "change_key", connectionId: "conn-1" });
  expect(container.querySelector("h1")?.textContent).toBe("Change this channel's key");
  expect(link("Change the key in Settings").pathname).toBe("/settings/connections");
});
