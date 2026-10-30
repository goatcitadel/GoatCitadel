// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeRetiredChannel,
  type ChannelRuntimeStatus,
  type ChatMessagingChannel,
  type ChatMessagingOverview,
  type IntegrationConnection,
} from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { __resetIntegrationConnectionMutationsForTests } from "../../../features/native-routes/settings/integration-connection-mutation";
import {
  __resetChannelMutationStateForTests,
  beginChannelOperation,
} from "../../../features/native-routes/settings/sections/channel-setup-state";
import type { Dialog } from "../../ui/Dialog";
import { ChannelPage } from "./ChannelPage";
import { REMOVE_CONSEQUENCE } from "./channel-remove-copy";

const api = vi.hoisted(() => ({
  fetchIntegrationConnections: vi.fn(),
  fetchIntegrationConnection: vi.fn(),
  updateIntegrationConnection: vi.fn(),
  deleteIntegrationConnection: vi.fn(),
  fetchChannelRuntimeStatus: vi.fn(),
  fetchDiscordPairings: vi.fn(),
  approveDiscordPairing: vi.fn(),
  revokeDiscordPairing: vi.fn(),
  fetchTelegramChannelPairings: vi.fn(),
  approveTelegramChannelPairing: vi.fn(),
  revokeTelegramChannelPairing: vi.fn(),
  fetchChatMessaging: vi.fn(),
}));
const prefs = vi.hoisted(() => ({ showTechnicalDetails: false }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  fetchIntegrationConnections: api.fetchIntegrationConnections,
  fetchIntegrationConnection: api.fetchIntegrationConnection,
  updateIntegrationConnection: api.updateIntegrationConnection,
  deleteIntegrationConnection: api.deleteIntegrationConnection,
  fetchChannelRuntimeStatus: api.fetchChannelRuntimeStatus,
  fetchDiscordPairings: api.fetchDiscordPairings,
  approveDiscordPairing: api.approveDiscordPairing,
  revokeDiscordPairing: api.revokeDiscordPairing,
}));
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", async (original) => ({
  ...(await original<object>()),
  fetchTelegramChannelPairings: api.fetchTelegramChannelPairings,
  approveTelegramChannelPairing: api.approveTelegramChannelPairing,
  revokeTelegramChannelPairing: api.revokeTelegramChannelPairing,
}));
vi.mock("@goatcitadel/mission-control-shared/api/chat", () => ({ fetchChatMessaging: api.fetchChatMessaging }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", async (original) => ({
  ...(await original<object>()),
  useUiPreferences: () => ({
    activeCitadelId: undefined,
    activeWorkspaceId: "default",
    showTechnicalDetails: prefs.showTechnicalDetails,
  }),
}));
// The dialog primitive has its own tests; here it only has to show its title, description and buttons.
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, title, description, children }: ComponentProps<typeof Dialog>) =>
    open ? (
      <section aria-label={title}>
        <p>{description}</p>
        {children}
      </section>
    ) : null,
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

type TelegramItem = { actorId: string; status: "pending" | "approved"; code?: string; displayName?: string };
const ADA: TelegramItem = { actorId: "4242", status: "approved", displayName: "Ada" };
const UNNAMED: TelegramItem = { actorId: "777", status: "approved" };
const EVE: TelegramItem = { actorId: "55", status: "pending", code: "ABC123", displayName: "Eve" };
function telegramList(items: TelegramItem[], overrides: Record<string, unknown> = {}) {
  return {
    connectionId: "conn-1",
    connectionRevision: REVISION,
    inboundAccessMode: "allowlist",
    allowedSenders: items.filter((item) => item.status === "approved").map((item) => item.actorId),
    items,
    ...overrides,
  };
}

const discordConnection = () =>
  connection({
    catalogId: "channel.discord",
    key: "discord",
    label: "Discord",
    config: { defaultChannelId: "1234567890123456789" },
  });
const discordRecord = (overrides: Record<string, unknown>) => ({
  pairingId: "p1",
  connectionId: "conn-1",
  userId: "u-1",
  displayName: "Grace",
  code: "DCODE9",
  status: "approved",
  ...overrides,
});

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

function row(within: ParentNode, text: string): HTMLElement {
  const found = [...within.querySelectorAll("li")].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`No row with "${text}"`);
  return found as HTMLElement;
}

function button(label: string, within: ParentNode = container): HTMLButtonElement {
  const found = [...within.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await settle();
}

/** Where each "Change the key" link on the page goes, as a path and hash (the shell parameter is the link's own). */
function keyLinks(): string[] {
  return [...container.querySelectorAll<HTMLAnchorElement>("a")]
    .filter((candidate) => candidate.textContent === "Change the key")
    .map((candidate) => {
      const target = new URL(candidate.getAttribute("href")!, "http://cockpit.invalid");
      return `${target.pathname}${target.hash}`;
    });
}

/** Page text with every Technical details disclosure taken out: what an operator sees by default. */
function primaryText(): string {
  const copy = container.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("details").forEach((details) => details.remove());
  return copy.textContent ?? "";
}

const notFound = () =>
  new ApiRequestError("Missing", {
    kind: "http",
    method: "GET",
    path: "/api/v1/integrations/connections/conn-1",
    status: 404,
    body: { code: "ENTITY_NOT_FOUND" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  prefs.showTechnicalDetails = false;
  __resetIntegrationConnectionMutationsForTests();
  __resetChannelMutationStateForTests();
  api.fetchTelegramChannelPairings.mockResolvedValue(telegramList([ADA, UNNAMED, EVE]));
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
    expect(row(who, "Ada")).toBeDefined();
    expect(row(who, "Someone on Telegram")).toBeDefined();
    // A request that is still pending is waiting for an answer, not yet someone who can message it.
    const waiting = who.querySelector('ul[aria-label="People asking to message it"]')!;
    expect(row(waiting, "Eve")).toBeDefined();
    expect(who.querySelector('ul[aria-label="People who can message it"]')!.textContent).not.toContain("Eve");

    const posts = section("Where it posts");
    expect([...posts.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["Ops · Default", "Family"]);

    expect(button("Turn off")).toBeDefined();
    expect(button("Remove")).toBeDefined();
    // Telegram's key is changed here, in Chat, on its own page.
    expect(keyLinks()).toEqual(["/chat/messaging/conn-1/key"]);
  });

  it.each([
    ["discord", "Discord", { runtimeMode: "gateway" }],
    ["slack", "Slack", { receiveMode: "socket" }],
    [
      "whatsapp",
      "WhatsApp",
      {
        phoneNumberId: "106540352242922",
        businessAccountId: "102290129340398",
        appId: "670843887433847",
        appSecret: "[REDACTED]",
      },
    ],
  ])("changes %s's key here, in Chat, on its own page, when it uses a bot", async (key, label, config) => {
    load({
      connection: connection({ catalogId: `channel.${key}`, key, label, config }),
      overview: overviewOf(channel({ channelKey: key, label })),
    });
    await mount();
    expect(keyLinks()).toEqual(["/chat/messaging/conn-1/key"]);
  });

  it.each([
    ["a Discord webhook-only (bridge) connection", "discord", { runtimeMode: "bridge", webhookUrl: "[REDACTED]" }],
    ["a Discord connection with only a webhook", "discord", { webhookUrl: "[REDACTED]" }],
    ["a Slack webhook connection", "slack", { receiveMode: "webhook", webhookUrl: "[REDACTED]" }],
    ["a Slack OAuth connection", "slack", { authMode: "oauth", receiveMode: "webhook", slackTeamId: "T1" }],
  ])("keeps the key of %s in Settings: it has no bot token for Chat's page to change", async (_name, key, config) => {
    load({
      connection: connection({ catalogId: `channel.${key}`, key, label: key, config }),
      overview: overviewOf(channel({ channelKey: key, label: key })),
    });
    await mount();
    expect(keyLinks()).toEqual(["/settings/connections#channels"]);
  });

  it("keeps the key of a send-only WhatsApp connection in Settings: Chat's page has no saved App ID or secret to check the new token with", async () => {
    load({
      connection: connection({
        catalogId: "channel.whatsapp",
        key: "whatsapp",
        label: "WhatsApp",
        config: { phoneNumberId: "106540352242922", accessToken: "[REDACTED]" },
      }),
      overview: overviewOf(channel({ channelKey: "whatsapp", label: "WhatsApp" })),
    });
    await mount();
    expect(keyLinks()).toEqual(["/settings/connections#channels"]);
  });

  it("sends a channel without its own key page to Settings to change the key", async () => {
    load({
      connection: connection({ catalogId: "channel.mattermost", key: "mattermost", label: "Mattermost", config: {} }),
      overview: overviewOf(channel({ channelKey: "mattermost", label: "Mattermost" })),
    });
    await mount();
    expect(keyLinks()).toEqual(["/settings/connections#channels"]);
  });

  it("shows no provider id, pairing code or version hash outside Technical details", async () => {
    load({});
    await mount();
    await click(button("Remove"));
    const text = primaryText();
    for (const hidden of ["4242", "777", "55", "ABC123", REVISION, "-1001234567890", "5550123"])
      expect(text).not.toContain(hidden);
    expect(text).not.toContain("version");
    expect(text).not.toContain("Review");
  });

  it("keeps ids and codes in Technical details when they are switched on", async () => {
    prefs.showTechnicalDetails = true;
    load({});
    await mount();
    const details = [...container.querySelectorAll("details")].map((item) => item.textContent).join("\n");
    for (const shown of ["4242", "777", "55", "ABC123"]) expect(details).toContain(shown);
    const text = primaryText();
    for (const hidden of ["4242", "777", "ABC123", REVISION]) expect(text).not.toContain(hidden);
  });

  it("checks the channel again on Check now", async () => {
    load({});
    await mount();
    expect(api.fetchChannelRuntimeStatus).toHaveBeenCalledTimes(1);
    api.fetchChannelRuntimeStatus.mockResolvedValue(runtime({ lastInboundAt: "2026-10-25T09:59:00.000Z" }));
    await click(button("Check now", section("Whether it's working")));
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

  it("says when anyone can message the channel, since approving someone does not close it", async () => {
    load({});
    api.fetchTelegramChannelPairings.mockResolvedValue(
      telegramList([ADA], { inboundAccessMode: "open_legacy", allowedSenders: [] }),
    );
    await mount();
    expect(section("Who can message it").textContent).toContain("Anyone can message this channel right now.");
  });
});

describe("ChannelPage who can message it", () => {
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

    const adaRow = row(section("Who can message it"), "Ada");
    expect(button("This is you", adaRow)).toBeDefined();
    await click(button("This is you", adaRow));

    expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", {
      expectedRevision: REVISION,
      config: { ...connection().config, ownerActorIds: ["4242"] },
    });
    const savedRow = row(section("Who can message it"), "Ada");
    expect(savedRow.textContent).toContain("You");
    expect(button("Not you", savedRow)).toBeDefined();
    // The Messaging overview marks "own" conversations from this setting, so it is read again.
    expect(api.fetchChatMessaging.mock.calls.length).toBeGreaterThan(1);
  });

  it("clears the mark when you choose Not you, keeping any other saved account", async () => {
    const owned = connection({ config: { ...connection().config, ownerActorIds: ["4242", "other"] } });
    load({ connection: owned });
    await mount();
    const saved = connection({ revision: SAVED_REVISION, config: { ...owned.config, ownerActorIds: ["other"] } });
    api.updateIntegrationConnection.mockResolvedValue(saved);
    api.fetchIntegrationConnection.mockResolvedValue(saved);

    await click(button("Not you", row(section("Who can message it"), "Ada")));
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
    await click(button("This is you", row(section("Who can message it"), "Ada")));
    expect(api.updateIntegrationConnection).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(
      "The connection changed or was deleted. Review its current saved state before retrying.",
    );
    expect(api.fetchIntegrationConnections.mock.calls.length).toBeGreaterThan(before);
  });

  it("locks changes to the channel once, with a check, when a save's answer is lost", async () => {
    load({});
    await mount();
    api.updateIntegrationConnection.mockRejectedValue(new Error("socket closed"));

    await click(button("This is you", row(section("Who can message it"), "Ada")));

    expect(container.textContent).toContain("The connection change outcome is unconfirmed.");
    // One lock note for the whole page, and every change to this channel waits on it.
    expect(container.textContent?.match(/outcome is unconfirmed/g)).toHaveLength(1);
    expect(button("Check what was saved")).toBeDefined();
    expect(button("Turn off").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    expect(button("This is you", row(section("Who can message it"), "Someone on Telegram")).disabled).toBe(true);
  });

  it("asks for approval by name, with Approve as the main action and Deny as a plain one", async () => {
    api.fetchTelegramChannelPairings.mockResolvedValue(
      telegramList([ADA, EVE, { actorId: "66", status: "pending", code: "ZZZ999" }]),
    );
    load({});
    await mount();
    const waiting = section("Who can message it").querySelector('ul[aria-label="People asking to message it"]')!;
    const eve = row(waiting, "Eve");
    const unnamed = row(waiting, "Someone on Telegram");
    expect(button("Approve", eve).className).toContain("bg-accent");
    for (const deny of [button("Deny", eve), button("Deny", unnamed)]) {
      expect(deny.className).not.toContain("status-failed");
      expect(deny.className).toContain("bg-raised");
    }
    expect(button("Approve", eve).getAttribute("aria-label")).toBe("Approve: Eve");
    expect(button("Deny", unnamed).getAttribute("aria-label")).toBe("Deny: Someone on Telegram");
  });

  it("approves a Telegram request with its code and the connection version, then lists the person", async () => {
    load({});
    await mount();
    const approved: TelegramItem = { actorId: "55", status: "approved", displayName: "Eve" };
    api.fetchTelegramChannelPairings
      .mockResolvedValueOnce(telegramList([ADA, UNNAMED, EVE]))
      .mockResolvedValue(telegramList([ADA, UNNAMED, approved]));
    api.approveTelegramChannelPairing.mockResolvedValue(telegramList([ADA, UNNAMED, approved]));

    await click(button("Approve", row(section("Who can message it"), "Eve")));

    expect(api.approveTelegramChannelPairing).toHaveBeenCalledExactlyOnceWith("conn-1", {
      code: "ABC123",
      expectedConnectionRevision: REVISION,
    });
    const who = section("Who can message it");
    expect(who.querySelector('ul[aria-label="People asking to message it"]')).toBeNull();
    expect(row(who.querySelector('ul[aria-label="People who can message it"]')!, "Eve")).toBeDefined();
  });

  it("denies a Telegram request through the revoke route on the pending request", async () => {
    load({});
    await mount();
    api.fetchTelegramChannelPairings
      .mockResolvedValueOnce(telegramList([ADA, UNNAMED, EVE]))
      .mockResolvedValue(telegramList([ADA, UNNAMED]));
    api.revokeTelegramChannelPairing.mockResolvedValue(telegramList([ADA, UNNAMED]));

    await click(button("Deny", row(section("Who can message it"), "Eve")));

    expect(api.revokeTelegramChannelPairing).toHaveBeenCalledExactlyOnceWith("conn-1", "55", {
      expectedConnectionRevision: REVISION,
    });
    expect(api.approveTelegramChannelPairing).not.toHaveBeenCalled();
    expect(section("Who can message it").textContent).not.toContain("Eve");
  });

  it("sends nothing and says so when the request is no longer the one shown", async () => {
    load({});
    await mount();
    api.fetchTelegramChannelPairings.mockResolvedValue(telegramList([ADA, UNNAMED]));

    await click(button("Approve", row(section("Who can message it"), "Eve")));

    expect(api.approveTelegramChannelPairing).not.toHaveBeenCalled();
    expect(container.textContent).toContain("That request changed, so nothing was sent.");
    // Nothing was sent, so nothing is locked: the page can act again.
    expect(button("Turn off").disabled).toBe(false);
  });

  it("locks channel changes and offers a check when an answer is lost", async () => {
    load({});
    await mount();
    api.approveTelegramChannelPairing.mockRejectedValue(new Error("socket closed"));

    await click(button("Approve", row(section("Who can message it"), "Eve")));

    expect(container.textContent).toContain("Couldn't approve that request.");
    expect(container.textContent).toContain("Outcome uncertain. Channel changes are locked in this app session.");
    expect(button("Approve", row(section("Who can message it"), "Eve")).disabled).toBe(true);
    // The lock is installation-wide, as in Settings: turning off, removing and marking you wait on it too.
    expect(button("Turn off").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    expect(button("This is you", row(section("Who can message it"), "Ada")).disabled).toBe(true);
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
  });

  it("holds Turn off, Remove and This is you while a pairing answer is in flight, then frees them", async () => {
    load({});
    await mount();
    const approved: TelegramItem = { actorId: "55", status: "approved", displayName: "Eve" };
    let answer!: (value: ReturnType<typeof telegramList>) => void;
    api.approveTelegramChannelPairing.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    api.fetchTelegramChannelPairings
      .mockResolvedValueOnce(telegramList([ADA, UNNAMED, EVE]))
      .mockResolvedValue(telegramList([ADA, UNNAMED, approved]));
    expect(button("Turn off").disabled).toBe(false);

    await click(button("Approve", row(section("Who can message it"), "Eve")));

    expect(api.approveTelegramChannelPairing).toHaveBeenCalledOnce();
    expect(button("Turn off").disabled).toBe(true);
    expect(button("Remove").disabled).toBe(true);
    expect(button("This is you", row(section("Who can message it"), "Ada")).disabled).toBe(true);

    await act(async () => answer(telegramList([ADA, UNNAMED, approved])));
    await settle();

    expect(button("Turn off").disabled).toBe(false);
    expect(button("Remove").disabled).toBe(false);
    expect(button("This is you", row(section("Who can message it"), "Ada")).disabled).toBe(false);
  });

  it("shows a Discord approval in who can message it although the connection did not change", async () => {
    const discord = discordConnection();
    load({
      connection: discord,
      overview: overviewOf(channel({ channelKey: "discord", label: "Discord" })),
      runtime: runtime({ channelKey: "discord", metadata: { connectedBotTag: "Goat#1234" } }),
    });
    api.fetchDiscordPairings.mockResolvedValue({
      items: [
        discordRecord({}),
        discordRecord({ pairingId: "p2", userId: "u-2", displayName: "Eve", status: "pending" }),
      ],
    });
    await mount();
    expect(container.textContent).toContain("Bot Goat#1234");
    const before = section("Who can message it");
    expect(row(before.querySelector('ul[aria-label="People who can message it"]')!, "Grace")).toBeDefined();
    expect(before.querySelector('ul[aria-label="People who can message it"]')!.textContent).not.toContain("Eve");

    const eveApproved = discordRecord({ pairingId: "p2", userId: "u-2", displayName: "Eve", status: "approved" });
    api.fetchDiscordPairings
      .mockResolvedValueOnce({
        items: [
          discordRecord({}),
          discordRecord({ pairingId: "p2", userId: "u-2", displayName: "Eve", status: "pending" }),
        ],
      })
      .mockResolvedValue({ items: [discordRecord({}), eveApproved] });
    api.approveDiscordPairing.mockResolvedValue(eveApproved);

    await click(button("Approve", row(section("Who can message it"), "Eve")));

    expect(api.approveDiscordPairing).toHaveBeenCalledExactlyOnceWith("conn-1", "p2");
    const after = section("Who can message it");
    expect(after.querySelector('ul[aria-label="People asking to message it"]')).toBeNull();
    expect(row(after.querySelector('ul[aria-label="People who can message it"]')!, "Eve")).toBeDefined();
    // The connection itself never changed, so only the page's own re-read could have shown this.
    expect(api.updateIntegrationConnection).not.toHaveBeenCalled();
    expect(primaryText()).not.toContain("DCODE9");
    expect(primaryText()).not.toContain("u-2");
  });

  it("denies a Discord request through the revoke route", async () => {
    load({
      connection: discordConnection(),
      overview: overviewOf(channel({ channelKey: "discord", label: "Discord" })),
    });
    const pending = discordRecord({ pairingId: "p2", userId: "u-2", displayName: "Eve", status: "pending" });
    api.fetchDiscordPairings.mockResolvedValue({ items: [pending] });
    await mount();
    api.fetchDiscordPairings.mockResolvedValueOnce({ items: [pending] }).mockResolvedValue({ items: [] });
    api.revokeDiscordPairing.mockResolvedValue({ ...pending, status: "revoked" });

    await click(button("Deny", row(section("Who can message it"), "Eve")));

    expect(api.revokeDiscordPairing).toHaveBeenCalledExactlyOnceWith("conn-1", "p2");
    expect(api.approveDiscordPairing).not.toHaveBeenCalled();
    expect(section("Who can message it").textContent).not.toContain("Eve");
  });
});

describe("ChannelPage turning off and removing", () => {
  it("turns the channel off with a plain button, then offers to turn it on", async () => {
    load({});
    await mount();
    const turnOff = button("Turn off");
    expect(turnOff.className).not.toContain("status-failed");
    const off = connection({ enabled: false, revision: SAVED_REVISION });
    api.updateIntegrationConnection.mockResolvedValue(off);
    api.fetchIntegrationConnection.mockResolvedValue(off);
    api.fetchIntegrationConnections.mockResolvedValue({ items: [off] });

    await click(turnOff);

    expect(api.updateIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", {
      expectedRevision: REVISION,
      enabled: false,
    });
    expect(button("Turn on").className).not.toContain("status-failed");
  });

  it("makes Remove the only red action and says what it does before the button", async () => {
    load({});
    await mount();
    const red = [...container.querySelectorAll("button")].filter((item) => item.className.includes("status-failed"));
    expect(red.map((item) => item.textContent)).toEqual(["Remove"]);

    await click(button("Remove"));
    const dialog = container.querySelector('section[aria-label="Remove Telegram?"]')!;
    expect(dialog.textContent).toContain(REMOVE_CONSEQUENCE);
    expect(dialog.textContent).toContain(
      "This disconnects the bot and deletes its keys. Its conversations stay readable under Messaging until you delete them.",
    );
    expect(dialog.textContent).not.toContain(REVISION);
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
    const confirm = button("Remove channel", dialog);
    expect(confirm.className).toContain("status-failed");
    expect(button("Keep channel", dialog).className).not.toContain("status-failed");

    await click(button("Keep channel", dialog));
    expect(container.querySelector('section[aria-label="Remove Telegram?"]')).toBeNull();
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
  });

  it("removes the channel after confirmation and then shows it as removed", async () => {
    load({});
    await mount();
    api.fetchIntegrationConnection.mockResolvedValueOnce(connection()).mockRejectedValueOnce(notFound());
    api.deleteIntegrationConnection.mockResolvedValue({ deleted: true });
    api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
    api.fetchChatMessaging.mockResolvedValue(overviewOf(channel({ status: "removed" })));

    await click(button("Remove"));
    await click(button("Remove channel"));

    expect(api.deleteIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", REVISION);
    expect(container.textContent).toContain(
      "This channel was removed. Its conversations stay readable under Messaging.",
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });

  it("keeps the Remove dialog open and says why when a channel change starts just before confirming", async () => {
    load({});
    await mount();
    await click(button("Remove"));
    const confirm = button("Remove channel", container.querySelector('section[aria-label="Remove Telegram?"]')!);

    // A pairing answer starts after the dialog last rendered, so the confirm button is still enabled when clicked.
    let operation: ReturnType<typeof beginChannelOperation>;
    await act(async () => {
      operation = beginChannelOperation();
      confirm.click();
    });
    await settle();

    const dialog = container.querySelector('section[aria-label="Remove Telegram?"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(
      "Another channel change is still being sent, so nothing was removed. Try again once it finishes.",
    );
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
    // The note is said once, in the dialog that is open, not again behind it.
    expect(container.textContent?.split("nothing was removed").length).toBe(2);

    // Once the other change finishes, the same dialog can remove the channel.
    await act(async () => operation?.finish());
    api.fetchIntegrationConnection.mockResolvedValueOnce(connection()).mockRejectedValueOnce(notFound());
    api.deleteIntegrationConnection.mockResolvedValue({ deleted: true });
    await click(button("Remove channel", container.querySelector('section[aria-label="Remove Telegram?"]')!));
    expect(api.deleteIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", REVISION);
    expect(container.querySelector('section[aria-label="Remove Telegram?"]')).toBeNull();
  });

  it("does not remove a channel that changed since it was shown", async () => {
    load({});
    await mount();
    api.fetchIntegrationConnection.mockResolvedValue(connection({ revision: SAVED_REVISION }));

    await click(button("Remove"));
    await click(button("Remove channel"));

    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();
    expect(container.textContent).toContain(
      "The connection changed or was deleted. Review its current saved state before retrying.",
    );
  });
});

describe("ChannelPage for a retired channel's saved connection", () => {
  // Saved as enabled and connected, the way it was left when the channel was retired.
  const retiredConnection = (key: string, label: string) =>
    connection({
      catalogId: `channel.${key}`,
      key,
      label,
      config: { targets: [{ label: "Family", target: "+15550123", default: true }], allowFrom: ["+15550123"] },
    });
  function loadRetired(key: string, label: string) {
    load({
      connection: retiredConnection(key, label),
      overview: overviewOf(channel({ channelKey: key, label, status: "removed" })),
      runtime: runtime({ channelKey: key }),
    });
  }
  const headings = () => [...container.querySelectorAll("h2")].map((item) => item.textContent);
  const linkNamed = (label: string) =>
    [...container.querySelectorAll("a")].find((candidate) => candidate.textContent === label);

  it.each([
    ["signal", "Home Signal"],
    ["imessage", "Home iMessage"],
    ["zalouser", "Home Zalo"],
  ])(
    "shows a saved %s connection as Removed, with its reason, and nothing that implies it works",
    async (key, label) => {
      loadRetired(key, label);
      await mount();

      expect(container.querySelector("h1")?.textContent).toBe(label);
      expect(container.querySelector('[data-tone="neutral"]')?.textContent).toBe("Removed");
      expect(container.textContent).toContain(describeRetiredChannel(key));
      expect(container.textContent).toContain("Its conversations stay readable under Messaging.");
      expect(linkNamed("Messaging")).toBeDefined();

      // No runtime check, people, posting places, or switch that implies it can send.
      expect(headings()).not.toContain("Whether it's working");
      expect(headings()).not.toContain("Who can message it");
      expect(headings()).not.toContain("Where it posts");
      expect(container.textContent).not.toContain("GoatCitadel is connected to");
      expect(container.textContent).not.toContain("Checking this channel");
      expect(container.textContent).not.toContain("Family");
      expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
      const names = [...container.querySelectorAll("button")].map((item) => item.textContent);
      expect(names).not.toContain("Check now");
      expect(names).not.toContain("Turn off");
      expect(names).not.toContain("Turn on");
      expect(keyLinks()).toEqual([]);
    },
  );

  it("still offers Remove, the only red action, and removes the connection after confirmation", async () => {
    loadRetired("signal", "Home Signal");
    await mount();
    const red = [...container.querySelectorAll("button")].filter((item) => item.className.includes("status-failed"));
    expect(red.map((item) => item.textContent)).toEqual(["Remove"]);

    await click(button("Remove"));
    const dialog = container.querySelector('section[aria-label="Remove Home Signal?"]')!;
    expect(dialog.textContent).toContain(REMOVE_CONSEQUENCE);
    expect(api.deleteIntegrationConnection).not.toHaveBeenCalled();

    api.fetchIntegrationConnection.mockResolvedValueOnce(retiredConnection("signal", "Home Signal"));
    api.deleteIntegrationConnection.mockResolvedValue({ deleted: true });
    api.fetchIntegrationConnection.mockRejectedValue(notFound());
    api.fetchIntegrationConnections.mockResolvedValue({ items: [] });
    await click(button("Remove channel", dialog));
    expect(api.deleteIntegrationConnection).toHaveBeenCalledExactlyOnceWith("conn-1", REVISION);
  });

  it("shows the reason even before the overview has caught up", async () => {
    load({
      connection: retiredConnection("imessage", "Home iMessage"),
      overview: overviewOf(),
    });
    await mount();
    expect(container.querySelector('[data-tone="neutral"]')?.textContent).toBe("Removed");
    expect(container.textContent).toContain(describeRetiredChannel("imessage"));
    expect(headings()).not.toContain("Whether it's working");
    expect(api.fetchChannelRuntimeStatus).not.toHaveBeenCalled();
  });

  it("keeps the full page for a working channel beside it", async () => {
    load({});
    await mount();
    expect(headings()).toContain("Whether it's working");
    expect(headings()).toContain("Where it posts");
    expect(container.textContent).not.toContain("not supported anymore");
  });
});

describe("ChannelPage states", () => {
  it("names Discord's bot from its runtime and where it posts without showing its id", async () => {
    load({
      connection: discordConnection(),
      overview: overviewOf(channel({ channelKey: "discord", label: "Discord" })),
      runtime: runtime({ channelKey: "discord", metadata: { connectedBotTag: "Goat#1234" } }),
    });
    await mount();
    expect(container.textContent).toContain("Bot Goat#1234");
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
    await click(button("Try again"));
    expect(container.querySelector("h1")?.textContent).toBe("Telegram");
  });
});
