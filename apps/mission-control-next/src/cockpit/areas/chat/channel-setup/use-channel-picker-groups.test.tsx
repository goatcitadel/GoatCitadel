// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChannelSetupHosts } from "./use-channel-picker-groups";

const api = vi.hoisted(() => ({ fetchChannelSetupDefinitions: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);

const SLACK = {
  catalog: { catalogId: "channel.slack", key: "slack", label: "Slack" },
  wizard: {
    estimatedMinutes: 5,
    steps: [],
    conditionalHosts: [{ host: "slack.com", whenAnyFieldSet: ["botToken", "appToken"] }],
  },
} as unknown as ChannelSetupDefinition;

const DISCORD = {
  catalog: { catalogId: "channel.discord", key: "discord", label: "Discord" },
  wizard: { estimatedMinutes: 5, steps: [], requiredHosts: ["discord.com"] },
} as unknown as ChannelSetupDefinition;

function draft(overrides: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft {
  return {
    draftId: "draft-1",
    revision: 1,
    catalogId: "channel.slack",
    lifecycleMode: "create",
    enabled: true,
    draft: {},
    secretState: {},
    contentVersion: "content",
    adapterVersion: "adapter",
    validationVersion: "validation",
    testVersion: "test",
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let hosts: readonly string[] | undefined;

function Probe({ catalogId, setup }: { catalogId: string; setup: ChannelSetupDraft | null }) {
  hosts = useChannelSetupHosts(catalogId, setup);
  return null;
}

async function show(catalogId: string, setup: ChannelSetupDraft | null) {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe, { catalogId, setup })));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  hosts = undefined;
  api.fetchChannelSetupDefinitions.mockReset();
  api.fetchChannelSetupDefinitions.mockResolvedValue({ items: [SLACK, DISCORD] });
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

describe("useChannelSetupHosts", () => {
  it("says nothing until the catalogue has loaded", async () => {
    api.fetchChannelSetupDefinitions.mockReturnValue(new Promise(() => undefined));
    await show("channel.discord", draft({ catalogId: "channel.discord" }));
    expect(hosts).toBeUndefined();
  });

  it("says nothing until there is a draft", async () => {
    await show("channel.discord", null);
    expect(hosts).toBeUndefined();
  });

  it("lists a channel's fixed hosts once both are there", async () => {
    await show("channel.discord", draft({ catalogId: "channel.discord" }));
    expect(hosts).toEqual(["discord.com"]);
  });

  it("adds a host only when the draft meets its condition, including a saved secret", async () => {
    await show("channel.slack", draft());
    expect(hosts).toEqual([]);
    await show("channel.slack", draft({ secretState: { botToken: { configured: true, custody: "temporary" } } }));
    expect(hosts).toEqual(["slack.com"]);
    await show("channel.slack", draft({ secretState: { appToken: { configured: true, custody: "temporary" } } }));
    expect(hosts).toEqual(["slack.com"]);
  });

  it("says nothing for a channel the catalogue doesn't have, because it cannot say what it hasn't seen", async () => {
    await show("channel.gone", draft({ catalogId: "channel.gone" }));
    expect(hosts).toBeUndefined();
  });

  it("keeps the same list while neither the catalogue nor the draft changes", async () => {
    const setup = draft({ catalogId: "channel.discord" });
    await show("channel.discord", setup);
    const first = hosts;
    await show("channel.discord", setup);
    expect(hosts).toBe(first);
  });
});
