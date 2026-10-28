// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describeRetiredChannel, type ChannelSetupDefinition } from "@goatcitadel/contracts";
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
  fetchAgenticChannelDeliveries: vi.fn(),
}));
// What a selected connection's panel reads about itself; no test here may reach a real Gateway for it.
const operations = vi.hoisted(() => ({ fetchChannelSetupJourney: vi.fn(), fetchTelegramChannelPairings: vi.fn() }));
const route = vi.hoisted(() => ({ search: "", navigate: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (original) => ({
  ...(await original<object>()),
  ...api,
}));
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", async (original) => ({
  ...(await original<object>()),
  ...operations,
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

describe("Telegram is set up in Chat, not here", () => {
  const linkNamed = (label: string) =>
    [...container.querySelectorAll("a")].find((candidate) => candidate.textContent === label);
  const pathOf = (link: HTMLAnchorElement | undefined) =>
    new URL(link!.getAttribute("href")!, "http://cockpit.invalid").pathname;
  function draft(catalogId: string, label: string, extra: Record<string, unknown> = {}) {
    return { draftId: `${catalogId}:${label}`, catalogId, label, revision: 1, lifecycleMode: "create", ...extra };
  }

  beforeEach(() => {
    api.fetchChannelSetupDefinitions.mockResolvedValue({
      items: [definition("telegram", "Telegram"), definition("slack", "Slack")],
    });
  });

  it("offers Telegram's Chat page in place of the guided setup", async () => {
    await mount("?channel=channel.telegram");
    expect(picker()?.value).toBe("channel.telegram");
    expect(buttonNamed("Start guided setup")).toBeUndefined();
    const link = linkNamed("Set up Telegram in Chat");
    expect(pathOf(link)).toBe("/chat/messaging/add/telegram");
    expect(api.createChannelSetupDraft).not.toHaveBeenCalled();
  });

  it("keeps the guided setup for a channel Chat doesn't set up", async () => {
    await mount("?channel=channel.slack");
    expect(buttonNamed("Start guided setup")?.disabled).toBe(false);
    expect(linkNamed("Set up Telegram in Chat")).toBeUndefined();
  });

  it("continues an unfinished Telegram setup in Chat, and edits the rest here", async () => {
    api.fetchChannelSetupDrafts.mockResolvedValue({
      items: [
        draft("channel.telegram", "New bot"),
        draft("channel.telegram", "Home bot", { lifecycleMode: "edit", connectionId: "conn-1" }),
        draft("channel.slack", "Team"),
      ],
    });
    await mount("");
    expect(buttonNamed("Edit New bot")).toBeUndefined();
    const resume = linkNamed("Continue New bot in Chat");
    expect(pathOf(resume)).toBe("/chat/messaging/add/telegram");
    // The page picks up this very setup, not whichever unfinished one is newest.
    expect(new URL(resume!.getAttribute("href")!, "http://cockpit.invalid").searchParams.get("draft")).toBe(
      "channel.telegram:New bot",
    );
    expect(buttonNamed("Edit Home bot")).toBeDefined();
    expect(buttonNamed("Edit Team")).toBeDefined();
  });
});

describe("a saved connection shows where its vendor sends messages", () => {
  const SLACK_ADDRESS = "https://<your public address>/api/v1/integrations/connections/conn-1/slack/webhook";
  function webhookDefinition(key: string, label: string): ChannelSetupDefinition {
    const base = definition(key, label);
    const telegram = key === "telegram";
    return {
      ...base,
      wizard: {
        ...base.wizard,
        // Telegram receives on a webhook only when its receive mode is webhook; this fixture's mode defaults to poll.
        steps: telegram ? [{ id: "values", fields: [{ key: "receiveMode", defaultValue: "poll" }] }] : [],
        inboundWebhook: {
          pathTemplate: `/api/v1/integrations/connections/{connectionId}/${key}/webhook`,
          ...(telegram ? { whenFieldEquals: { fieldKey: "receiveMode", value: "webhook" } } : {}),
        },
      },
    } as unknown as ChannelSetupDefinition;
  }
  const connection = (key: string, connectionId: string, config: Record<string, unknown> = {}) => ({
    connectionId,
    revision: "r1",
    catalogId: `channel.${key}`,
    kind: "channel",
    key,
    label: `${key} connection`,
    enabled: true,
    status: "connected",
    config,
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T10:00:00.000Z",
  });
  async function inspect(connections: ReturnType<typeof connection>[], label: string) {
    api.fetchChannelSetupDefinitions.mockResolvedValue({
      items: [webhookDefinition("slack", "Slack"), webhookDefinition("telegram", "Telegram")],
    });
    api.fetchIntegrationConnections.mockResolvedValue({ items: connections });
    api.fetchAgenticChannelDeliveries.mockResolvedValue({ deliveries: [] });
    operations.fetchChannelSetupJourney.mockRejectedValue(new Error("Not under test."));
    operations.fetchTelegramChannelPairings.mockRejectedValue(new Error("Not under test."));
    await mount("");
    await act(async () => buttonNamed(`Inspect ${label}`)!.click());
    await settle();
  }
  const webhookSection = () => container.querySelector('section[aria-label="Webhook address"]');
  const selected = () => container.querySelector('section[aria-label="Selected channel connection"]');

  it("shows a saved Slack connection's address above its identity", async () => {
    await inspect([connection("slack", "conn-1")], "slack connection");

    expect(webhookSection()?.querySelector("code")?.textContent).toBe(SLACK_ADDRESS);
    const identity = [...container.querySelectorAll("summary")].find(
      (item) => item.textContent === "Connection identity",
    )!;
    expect(webhookSection()!.compareDocumentPosition(identity) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The identity stays collapsed; the address is not hidden in it.
    expect(identity.parentElement?.contains(webhookSection())).toBe(false);
  });

  it("shows no address for a Telegram connection that polls", async () => {
    await inspect([connection("telegram", "conn-2", { receiveMode: "poll" })], "telegram connection");
    expect(selected()).not.toBeNull();
    expect(webhookSection()).toBeNull();
  });

  it("shows no address for a Telegram connection whose config sets no receive mode, under a definition that defaults it to poll", async () => {
    await inspect([connection("telegram", "conn-2")], "telegram connection");
    expect(selected()).not.toBeNull();
    expect(webhookSection()).toBeNull();
  });

  it("shows the address of a Telegram connection that receives on a webhook", async () => {
    await inspect([connection("telegram", "conn-2", { receiveMode: "webhook" })], "telegram connection");
    expect(webhookSection()?.querySelector("code")?.textContent).toBe(
      "https://<your public address>/api/v1/integrations/connections/conn-2/telegram/webhook",
    );
  });

  it("shows no address for a connection whose channel has no definition", async () => {
    await inspect([connection("carrier-pigeon", "conn-3")], "carrier-pigeon connection");
    expect(selected()).not.toBeNull();
    expect(webhookSection()).toBeNull();
  });
});

describe("a retired channel's saved connection never reads as working", () => {
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
  const rows = () => [...container.querySelectorAll('section[aria-label="Saved channel connections"] li')];
  const rowOf = (label: string) => rows().find((item) => item.textContent?.includes(label))!;
  const selected = () => container.querySelector('section[aria-label="Selected channel connection"]');

  async function show(...connections: ReturnType<typeof saved>[]) {
    api.fetchIntegrationConnections.mockResolvedValue({ items: connections });
    api.fetchAgenticChannelDeliveries.mockResolvedValue({ deliveries: [] });
    operations.fetchChannelSetupJourney.mockRejectedValue(new Error("Not under test."));
    operations.fetchTelegramChannelPairings.mockRejectedValue(new Error("Not under test."));
    await mount("");
  }

  it.each([
    ["signal", "Home Signal"],
    ["imessage", "Home iMessage"],
    ["zalouser", "Home Zalo"],
  ])("lists a saved %s connection as Removed with its reason, not as enabled or connected", async (key, label) => {
    await show(saved(key, label));
    const row = rowOf(label);
    expect(row.textContent).toContain("Removed");
    expect(row.textContent).toContain(describeRetiredChannel(key));
    expect(row.textContent).not.toMatch(/enabled|disabled|connected|observed/i);
    // It stays inspectable, so the operator can still remove it.
    expect(buttonNamed(`Inspect ${label}`)).toBeDefined();
  });

  it("keeps a working channel's row as it was, beside a retired one", async () => {
    await show(saved("signal", "Home Signal"), saved("slack", "Team Slack"));
    expect(rowOf("Team Slack").textContent).toContain("slack · Enabled · observed connected");
    expect(rowOf("Team Slack").textContent).not.toContain("Removed");
  });

  it("opens a retired connection with its reason and only the controls that still make sense", async () => {
    await show(saved("signal", "Home Signal"));
    await act(async () => buttonNamed("Inspect Home Signal")!.click());
    await settle();
    const panel = selected()!;
    expect(panel).not.toBeNull();
    expect(panel.textContent).toContain(describeRetiredChannel("signal"));
    expect(panel.textContent).not.toContain("No last error recorded");
    // Nothing that implies it can send, be checked or be switched on.
    expect(buttonNamed("Edit channel setup")).toBeUndefined();
    expect(panel.querySelector('section[aria-label="Channel journey"]')).toBeNull();
    expect(operations.fetchChannelSetupJourney).not.toHaveBeenCalled();
    expect(buttonNamed("Review disable channel")).toBeUndefined();
    expect(buttonNamed("Review enable channel")).toBeUndefined();
    // Removing it is still offered.
    expect(buttonNamed("Remove channel connection")).toBeDefined();
  });

  it("keeps a working connection's controls", async () => {
    await show(saved("slack", "Team Slack"));
    await act(async () => buttonNamed("Inspect Team Slack")!.click());
    await settle();
    expect(buttonNamed("Edit channel setup")).toBeDefined();
    expect(buttonNamed("Review disable channel")).toBeDefined();
  });
});
