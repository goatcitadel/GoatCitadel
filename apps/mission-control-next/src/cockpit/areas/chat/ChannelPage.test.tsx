// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChannelRuntimeStatus,
  ChatMessagingChannel,
  ChatMessagingOverview,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";
import { ChannelPage } from "./ChannelPage";

const api = vi.hoisted(() => ({
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  updateIntegrationConnection: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchDiscordPairings: vi.fn(),
  fetchTelegramChannelPairings: vi.fn(),
  fetchChatMessaging: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  fetchIntegrationConnections: api.fetchIntegrationConnections,
  fetchIntegrationConnection: api.fetchIntegrationConnection,
  updateIntegrationConnection: api.updateIntegrationConnection,
  fetchChannelRuntimeStatus: api.fetchChannelRuntimeStatus,
  fetchDiscordPairings: api.fetchDiscordPairings,
}));
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", async (original) => ({
  ...(await original<object>()),
  fetchTelegramChannelPairings: api.fetchTelegramChannelPairings,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));
// The pairing review and lifecycle dialogs have their own tests; the page only has to place them.
vi.mock("../settings/ChannelOperations", () => ({
  ChannelOperations: ({ connection }: { connection: IntegrationConnection }): ReactNode => (
    <p>Pending requests for {connection.label}</p>
  ),
}));
vi.mock("../settings/ChannelLifecycleControls", () => ({
  ChannelLifecycleControls: ({
    workspaceId,
    selection,
  }: {
    workspaceId: string;
    selection: { connection?: IntegrationConnection };
  }): ReactNode => (
    <button type="button" data-workspace={workspaceId}>
      Remove {selection.connection?.label}
    </button>
  ),
}));

const REVISION = "a".repeat(64);
const SAVED_REVISION = "b".repeat(64);
const NOW = Date.parse("2026-10-25T10:00:00.000Z");

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    revision: REVISION,
    catalogId: "channel.telegram",
    kind: "channel",
    key: "telegram",
    label: "Telegram",
    enabled: true,
    status: "connected",
    config: {
      botUsername: "@MyGoatBot",
      targets: [
        { label: "Ops", chatId: "-1001234567890", default: true },
        { label: "Family", chatId: "5550123" },
      ],
    },
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    ...overrides,
  };
}

function runtime(overrides: Partial<ChannelRuntimeStatus> = {}): ChannelRuntimeStatus {
  return {
    connectionId: "conn-1",
    channelKey: "telegram",
    enabled: true,
    ready: true,
    inboundModes: [],
    runtimePolicy: {} as ChannelRuntimeStatus["runtimePolicy"],
    lastInboundAt: "2026-10-25T09:55:00.000Z",
    ...overrides,
  };
}

function channel(overrides: Partial<ChatMessagingChannel> = {}): ChatMessagingChannel {
  return {
    connectionId: "conn-1",
    channelKey: "telegram",
    label: "Telegram",
    status: "on",
    conversations: [],
    ...overrides,
  };
}

function overviewOf(...channels: ChatMessagingChannel[]): ChatMessagingOverview {
  return { workspaceId: "default", channels };
}

const telegramPairings = {
  connectionId: "conn-1",
  connectionRevision: REVISION,
  inboundAccessMode: "allowlist",
  allowedSenders: ["4242", "777"],
  items: [
    { actorId: "4242", status: "approved", displayName: "Ada" },
    { actorId: "777", status: "approved" },
    { actorId: "55", status: "pending", code: "ABC123", displayName: "Eve" },
  ],
};

async function settle() {
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(props: { connectionId?: string } = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ChannelPage connectionId={props.connectionId ?? "conn-1"} workspaceId="default" />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function load(options: {
  connection?: IntegrationConnection | null;
  overview?: ChatMessagingOverview;
  runtime?: ChannelRuntimeStatus;
}) {
  const saved = options.connection === undefined ? connection() : options.connection;
  api.fetchIntegrationConnections.mockResolvedValue({ items: saved ? [saved] : [] });
  api.fetchChatMessaging.mockResolvedValue(options.overview ?? overviewOf(channel()));
  api.fetchChannelRuntimeStatus.mockResolvedValue(options.runtime ?? runtime());
}

function section(name: string): HTMLElement {
  const found = [...container.querySelectorAll("section")].find(
    (candidate) => candidate.querySelector("h2")?.textContent === name,
  );
  if (!found) throw new Error(`No section named "${name}"`);
  return found;
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  __resetIntegrationConnectionMutationsForTests();
  api.fetchTelegramChannelPairings.mockResolvedValue(telegramPairings);
  api.fetchDiscordPairings.mockResolvedValue({ items: [] });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  client.clear();
  vi.restoreAllMocks();
});

describe("ChannelPage", () => {
  it("shows status, last message, who can message it and where it posts", async () => {
    load({});
    await mount();

    expect(container.querySelector("h1")?.textContent).toBe("Telegram");
    expect(container.textContent).toContain("Bot @MyGoatBot");
    expect(container.querySelector('[data-tone="done"]')?.textContent).toBe("On");

    const working = section("Whether it's working");
    expect(working.querySelector("time[datetime='2026-10-25T09:55:00.000Z']")).not.toBeNull();
    expect(working.textContent).toContain("Last message");
    expect(button("Check now", working)).toBeDefined();

    const who = section("Who can message it");
    expect(who.textContent).toContain("Ada");
    expect(who.textContent).toContain("Someone on Telegram");
    expect(who.textContent).toContain("Pending requests for Telegram");
    // A request that is still pending is not someone who can message it yet.
    expect(who.textContent).not.toContain("Eve");

    const posts = section("Where it posts");
    expect([...posts.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Ops · Default", "Family"]);

    // Names, never the provider's ids.
    for (const id of ["4242", "777", "-1001234567890", "5550123"]) expect(container.textContent).not.toContain(id);

    expect(button("Remove Telegram").dataset.workspace).toBe("default");
    const keyLink = container.querySelector<HTMLAnchorElement>('a[href^="/settings/connections"]');
    expect(keyLink?.textContent).toBe("Change the key");
    expect(keyLink?.getAttribute("href")).toMatch(/#channels$/);
  });

  it("checks the channel again on Check now", async () => {
    load({});
    await mount();
    expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledTimes(1);
    api.fetchChannelRuntimeStatus.mockResolvedValue(runtime({ lastInboundAt: "2026-10-25T09:59:00.000Z" }));
    await act(async () => button("Check now", section("Whether it's working")).click());
    await settle();
    expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledTimes(2);
    expect(container.querySelector("time[datetime='2026-10-25T09:59:00.000Z']")).not.toBeNull();
  });

  it("says plainly when no message has arrived yet and when the channel is not connected", async () => {
    load({ runtime: runtime({ lastInboundAt: undefined, ready: false }) });
    await mount();
    const working = section("Whether it's working");
    expect(working.textContent).toContain("No messages yet");
    expect(working.textContent).toContain("Not connected right now");
  });

  it("marks an approved sender as you", async () => {
    load({});
    await mount();
    const saved = connection({
      revision: SAVED_REVISION,
      config: { ...connection().config, ownerActorIds: ["4242"] },
    });
    api.updateIntegrationConnection.mockResolvedValue(saved);
    api.fetchIntegrationConnection.mockResolvedValue(saved);
    api.fetchIntegrationConnections.mockResolvedValue({ items: [saved] });

    const adaRow = [...section("Who can message it").querySelectorAll("li")].find((item) =>
      item.textContent?.includes("Ada"),
    )!;
    expect(button("This is you", adaRow)).toBeDefined();
    await act(async () => button("This is you", adaRow).click());
    await settle();

    expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", {
      expectedRevision: REVISION,
      config: { ...connection().config, ownerActorIds: ["4242"] },
    });
    const savedRow = [...section("Who can message it").querySelectorAll("li")].find((item) =>
      item.textContent?.includes("Ada"),
    )!;
    expect(savedRow.textContent).toContain("You");
    expect(button("Not you", savedRow)).toBeDefined();
    // The Messaging overview marks "own" conversations from this setting, so it is read again.
    expect(api.fetchChatMessaging.mock.calls.length).toBeGreaterThan(1);
  });

  it("clears the mark when you choose Not you, keeping any other saved account", async () => {
    const owned = connection({ config: { ...connection().config, ownerActorIds: ["4242", "other"] } });
    load({ connection: owned });
    await mount();
    const saved = connection({
      revision: SAVED_REVISION,
      config: { ...owned.config, ownerActorIds: ["other"] },
    });
    api.updateIntegrationConnection.mockResolvedValue(saved);
    api.fetchIntegrationConnection.mockResolvedValue(saved);

    const adaRow = [...section("Who can message it").querySelectorAll("li")].find((item) =>
      item.textContent?.includes("Ada"),
    )!;
    await act(async () => button("Not you", adaRow).click());
    await settle();
    expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", {
      expectedRevision: REVISION,
      config: { ...owned.config, ownerActorIds: ["other"] },
    });
  });

  it("reads the channel again and shows the settings conflict note instead of overwriting", async () => {
    load({});
    await mount();
    api.updateIntegrationConnection.mockRejectedValue(
      new ApiRequestError("Conflict", {
        kind: "http",
        method: "PATCH",
        path: "/api/v1/integrations/connections/conn-1",
        status: 409,
        body: { code: "WRITE_CONFLICT", details: { reason: "INTEGRATION_CONNECTION_REVISION_CONFLICT" } },
      }),
    );
    const before = api.fetchIntegrationConnections.mock.calls.length;
    const adaRow = [...section("Who can message it").querySelectorAll("li")].find((item) =>
      item.textContent?.includes("Ada"),
    )!;
    await act(async () => button("This is you", adaRow).click());
    await settle();
    expect(api.updateIntegrationConnection).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "The connection changed or was deleted. Review its current saved state before retrying.",
    );
    expect(api.fetchIntegrationConnections.mock.calls.length).toBeGreaterThan(before);
  });

  it("names Discord's bot from its runtime and lists approved Discord users", async () => {
    const discord = connection({
      catalogId: "channel.discord",
      key: "discord",
      label: "Discord",
      config: { defaultChannelId: "1234567890123456789" },
    });
    load({
      connection: discord,
      overview: overviewOf(channel({ channelKey: "discord", label: "Discord" })),
      runtime: runtime({ channelKey: "discord", metadata: { connectedBotTag: "Goat#1234" } }),
    });
    api.fetchDiscordPairings.mockResolvedValue({
      items: [
        { pairingId: "p1", connectionId: "conn-1", userId: "u-1", displayName: "Grace", status: "approved" },
        { pairingId: "p2", connectionId: "conn-1", userId: "u-2", displayName: "Eve", status: "pending" },
      ],
    });
    await mount();
    expect(container.textContent).toContain("Bot Goat#1234");
    expect(section("Who can message it").textContent).toContain("Grace");
    expect(section("Where it posts").textContent).toContain("Default channel");
    expect(container.textContent).not.toContain("1234567890123456789");
    expect(api.fetchTelegramChannelPairings).not.toHaveBeenCalled();
  });

  it("shows a removed channel without actions", async () => {
    load({
      connection: null,
      overview: overviewOf(channel({ status: "removed", label: "Telegram" })),
    });
    await mount();
    expect(container.textContent).toContain(
      "This channel was removed. Its conversations stay readable under Messaging.",
    );
    expect(container.querySelector("h1")?.textContent).toBe("Telegram");
    expect(container.querySelector('[data-tone="neutral"]')?.textContent).toBe("Removed");
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("Who can message it");
    expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
  });

  it("says the channel is not here when nothing knows it", async () => {
    load({ connection: null, overview: overviewOf() });
    await mount({ connectionId: "gone" });
    expect(container.textContent).toContain("We couldn't find this channel");
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("offers a retry when the channel list cannot be read", async () => {
    load({});
    api.fetchIntegrationConnections.mockRejectedValueOnce(new Error("offline"));
    await mount();
    expect(container.textContent).toContain("Couldn't load this channel");
    await act(async () => button("Try again").click());
    await settle();
    expect(container.querySelector("h1")?.textContent).toBe("Telegram");
  });
});
