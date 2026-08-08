// @vitest-environment happy-dom
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { DiscordPairingRecord, DiscordRuntimeStatus, IntegrationConnection } from "@goatcitadel/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordConnectionOperationsPanel } from "./DiscordConnectionOperationsPanel";

const discordApiMocks = vi.hoisted(() => ({
  approveDiscordPairing: vi.fn(),
  fetchDiscordPairings: vi.fn(),
  reconnectDiscordRuntime: vi.fn(),
  revokeDiscordPairing: vi.fn(),
}));

vi.mock("@goatcitadel/mission-control-shared/api/integrations", () => discordApiMocks);

const runtime: DiscordRuntimeStatus = {
  connectionId: "discord-1",
  runtimeMode: "gateway",
  enabled: true,
  ready: true,
  connectedBotId: "bot-1",
  connectedBotTag: "GoatBot#1234",
  guildIds: ["guild-1", "guild-2"],
};

const pendingPairing: DiscordPairingRecord = {
  pairingId: "pairing-pending",
  connectionId: "discord-1",
  userId: "user-pending",
  displayName: "Pending User",
  code: "GOAT-1234",
  status: "pending",
  createdAt: "2026-08-07T12:00:00.000Z",
  updatedAt: "2026-08-07T12:00:00.000Z",
};

const approvedPairing: DiscordPairingRecord = {
  pairingId: "pairing-approved",
  connectionId: "discord-1",
  userId: "user-approved",
  displayName: "Approved User",
  code: "GOAT-5678",
  status: "approved",
  createdAt: "2026-08-07T12:00:00.000Z",
  updatedAt: "2026-08-07T12:10:00.000Z",
  approvedAt: "2026-08-07T12:10:00.000Z",
};

function connection(
  connectionId: string,
  label: string,
  overrides: Partial<IntegrationConnection> = {},
): IntegrationConnection {
  return {
    connectionId,
    catalogId: "channel.discord",
    kind: "channel",
    key: "discord",
    label,
    enabled: true,
    status: "connected",
    config: {},
    createdAt: "2026-08-07T12:00:00.000Z",
    updatedAt: "2026-08-07T12:00:00.000Z",
    ...overrides,
  };
}

function textOf(node: ReactTestInstance): string {
  return node.children
    .map((child) => (typeof child === "string" ? child : textOf(child)))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}

function findButton(root: ReactTestInstance, label: string): ReactTestInstance {
  const button = root.findAllByType("button").find((candidate) => textOf(candidate) === label);
  if (!button) {
    throw new Error(`Button not found: ${label}. Available: ${root.findAllByType("button").map(textOf).join(" | ")}`);
  }
  return button;
}

async function flushWork(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function renderPanel(connections: IntegrationConnection[]): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<DiscordConnectionOperationsPanel connections={connections} />);
    await Promise.resolve();
  });
  await flushWork();
  return renderer;
}

async function click(node: ReactTestInstance): Promise<void> {
  await act(async () => {
    node.props.onClick?.();
    await Promise.resolve();
  });
  await flushWork();
}

beforeEach(() => {
  vi.clearAllMocks();
  discordApiMocks.fetchDiscordPairings.mockResolvedValue({
    runtime,
    items: [pendingPairing, approvedPairing],
  });
  discordApiMocks.approveDiscordPairing.mockResolvedValue({ ...pendingPairing, status: "approved" });
  discordApiMocks.revokeDiscordPairing.mockResolvedValue({ ...approvedPairing, status: "revoked" });
  discordApiMocks.reconnectDiscordRuntime.mockResolvedValue(runtime);
});

describe("DiscordConnectionOperationsPanel", () => {
  it("is a no-op when there are no finalized Discord connections", async () => {
    const renderer = await renderPanel([
      connection("telegram-1", "Telegram", { catalogId: "channel.telegram", key: "telegram" }),
    ]);

    expect(renderer.toJSON()).toBeNull();
    expect(discordApiMocks.fetchDiscordPairings).not.toHaveBeenCalled();
  });

  it("shows the selected runtime and operates pending and approved pairings", async () => {
    const renderer = await renderPanel([connection("discord-1", "Discord Ops")]);
    const text = textOf(renderer.root);

    expect(discordApiMocks.fetchDiscordPairings).toHaveBeenCalledWith("discord-1");
    expect(text).toContain("Discord runtime & pairing");
    expect(text).toContain("Ready");
    expect(text).toContain("GoatBot#1234");
    expect(text).toContain("guild-1, guild-2");
    expect(text).toContain("Pending User");
    expect(text).toContain("Approved User");

    await click(findButton(renderer.root, "Approve"));
    expect(discordApiMocks.approveDiscordPairing).toHaveBeenCalledWith("discord-1", "pairing-pending");

    await click(findButton(renderer.root, "Revoke"));
    expect(discordApiMocks.revokeDiscordPairing).toHaveBeenCalledWith("discord-1", "pairing-approved");

    await click(findButton(renderer.root, "Reconnect"));
    expect(discordApiMocks.reconnectDiscordRuntime).toHaveBeenCalledWith("discord-1");
    expect(textOf(renderer.root)).toContain("Discord reconnected and reports ready.");

    const fetchCount = discordApiMocks.fetchDiscordPairings.mock.calls.length;
    await click(findButton(renderer.root, "Refresh"));
    expect(discordApiMocks.fetchDiscordPairings).toHaveBeenCalledTimes(fetchCount + 1);
    expect(textOf(renderer.root)).toContain("Discord runtime and pairing state refreshed.");
  });

  it("refreshes runtime and pairing state when another Discord connection is selected", async () => {
    discordApiMocks.fetchDiscordPairings.mockImplementation(async (connectionId: string) => ({
      runtime: {
        ...runtime,
        connectionId,
        connectedBotTag: connectionId === "discord-2" ? "SecondBot#2222" : "GoatBot#1234",
      },
      items: connectionId === "discord-2" ? [] : [pendingPairing],
    }));
    const renderer = await renderPanel([
      connection("discord-1", "Discord Ops"),
      connection("discord-2", "Discord Community"),
    ]);
    const selector = renderer.root.findByType("select");

    await act(async () => {
      selector.props.onChange({ target: { value: "discord-2" } });
      await Promise.resolve();
    });
    await flushWork();

    expect(discordApiMocks.fetchDiscordPairings).toHaveBeenLastCalledWith("discord-2");
    expect(textOf(renderer.root)).toContain("SecondBot#2222");
    expect(textOf(renderer.root)).toContain("No pending Discord pairings.");
  });
});
