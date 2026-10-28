// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
// This dynamic boundary loads current Gateway definitions for tests without expanding the production app graph.
const runtimeDefinitions = import.meta.glob<{ listChannelSetupDefinitions: () => ChannelSetupDefinition[] }>(
  "../../../../../../gateway/src/services/channel-setup-definitions.ts",
);
import { __resetSessionViewStateForTests } from "../../../../hooks/use-session-view-state";
import { ChannelDraftEditor } from "../../../../cockpit/areas/settings/ChannelDraftEditor";
import { ChannelSetupWizard } from "./ChannelSetupWizard";
import { ChannelsSection } from "../sections/ChannelsSection";

// The hosts check on a test step reads the outbound allowlist; no test here may reach a real Gateway for it.
const api = vi.hoisted(() => ({
  fetchSettings: vi.fn(),
  fetchChannelSetupDefinitions: vi.fn(),
  fetchChannelSetupDrafts: vi.fn(),
  fetchIntegrationConnections: vi.fn(),
  fetchAgenticChannelDeliveries: vi.fn(),
}));
// What a selected connection's panel reads about itself; no test here may reach a real Gateway for it.
const operations = vi.hoisted(() => ({ fetchChannelSetupJourney: vi.fn(), fetchTelegramChannelPairings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  ...api,
}));
vi.mock("@goatcitadel/mission-control-shared/api/channel-setup-operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/channel-setup-operations")>()),
  ...operations,
}));

const definitions = (await Object.values(runtimeDefinitions)[0]!()).listChannelSetupDefinitions();
const byKey = (key: string) => definitions.find((item) => item.catalog.key === key)!;
const WORKS_ONCE_FINISHED = "This address works once you finish and the connection is on.";
const address = (key: string, connectionId: string) =>
  `https://<your public address>/api/v1/integrations/connections/${connectionId}/${key}/webhook`;

const makeDraft = (definition: ChannelSetupDefinition, extra: Partial<ChannelSetupDraft> = {}): ChannelSetupDraft => ({
  draftId: `fixture-${definition.catalog.key}`,
  revision: 1,
  catalogId: definition.catalog.catalogId,
  lifecycleMode: "create",
  label: "Sandbox",
  enabled: true,
  draft: {},
  secretState: {},
  contentVersion: definition.wizard.contentVersion,
  adapterVersion: definition.adapter.adapterVersion,
  validationVersion: definition.validation.validationVersion,
  testVersion: definition.testing.testVersion,
  createdAt: "2026-10-08T10:00:00.000Z",
  updatedAt: "2026-10-08T10:00:00.000Z",
  ...extra,
});

const propsFor = (
  definition: ChannelSetupDefinition,
  draft: Partial<ChannelSetupDraft> = {},
  values: Record<string, unknown> = {},
) => ({
  definition,
  draft: makeDraft(definition, draft),
  values,
  label: "Sandbox",
  enabled: true,
  dirty: false,
  onValuesChange: vi.fn(),
  onLabelChange: vi.fn(),
  onEnabledChange: vi.fn(),
  onDirty: vi.fn(),
  onSave: vi.fn(async () => true),
  onValidate: vi.fn(async () => undefined),
  onTest: vi.fn(async () => undefined),
  onFinalize: vi.fn(async () => undefined),
});

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function show(
  Component: typeof ChannelSetupWizard | typeof ChannelDraftEditor,
  props: ReturnType<typeof propsFor>,
) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Component {...props} />
      </QueryClientProvider>,
    );
  });
  await settle();
}

const stepButtons = () => [...container.querySelectorAll<HTMLButtonElement>('nav[aria-label="Setup steps"] button')];

async function openFirstMessage(definition: ChannelSetupDefinition) {
  const step = definition.wizard.steps.find((item) => item.stage === "first_message")!;
  const target = stepButtons().filter((item) => item.textContent?.includes(step.title));
  expect(target).toHaveLength(1);
  await act(async () => target[0]!.click());
  await settle();
}

beforeEach(() => {
  __resetSessionViewStateForTests();
  api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
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

describe.each([
  ["Classic guide", ChannelSetupWizard],
  ["Cockpit guide", ChannelDraftEditor],
] as const)("the webhook address in the %s", (_name, Component) => {
  const codeText = () => container.querySelector("code")?.textContent;

  it("shows a new Slack setup its real address, built from the draft's id, before it is finished", async () => {
    await show(Component, propsFor(byKey("slack")));
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);

    await openFirstMessage(byKey("slack"));

    expect(codeText()).toBe(address("slack", "fixture-slack"));
    expect(container.textContent).toContain("Webhook address");
    expect(container.textContent).toContain(WORKS_ONCE_FINISHED);
    expect(container.textContent).not.toContain("after you finish");
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Copy")).toBe(true);
  });

  it("says nothing on a channel that doesn't receive on a webhook", async () => {
    expect(byKey("discord").wizard.inboundWebhook).toBeUndefined();
    await show(Component, propsFor(byKey("discord")));
    await openFirstMessage(byKey("discord"));
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);
    expect(container.textContent).not.toContain("Webhook address");
  });

  it("follows Telegram's receive mode: poll shows no address, webhook shows the draft's", async () => {
    await show(Component, propsFor(byKey("telegram")));
    await openFirstMessage(byKey("telegram"));
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);

    await show(Component, propsFor(byKey("telegram"), {}, { receiveMode: "poll" }));
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);

    await show(Component, propsFor(byKey("telegram"), {}, { receiveMode: "webhook" }));
    expect(codeText()).toBe(address("telegram", "fixture-telegram"));
    expect(container.textContent).toContain(WORKS_ONCE_FINISHED);
  });

  it("shows a new Google Chat setup the address only in Chat app mode, not in webhook mode", async () => {
    const googleChat = byKey("google-chat");
    await show(Component, propsFor(googleChat, {}, { webhookUrl: "https://chat.googleapis.com/v1/spaces/x" }));
    await openFirstMessage(googleChat);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);

    await show(Component, propsFor(googleChat, {}, { serviceAccountKeyEnv: "GOOGLE_CHAT_KEY" }));
    expect(codeText()).toBe(address("google-chat", "fixture-google-chat"));
    expect(container.textContent).toContain(WORKS_ONCE_FINISHED);
  });

  it("shows a new Nextcloud Talk setup its address before it is finished: the bot is installed with it", async () => {
    await show(Component, propsFor(byKey("nextcloud-talk")));
    await openFirstMessage(byKey("nextcloud-talk"));

    expect(codeText()).toBe(address("nextcloud-talk", "fixture-nextcloud-talk"));
    expect(container.textContent).toContain(WORKS_ONCE_FINISHED);
  });

  it("shows a saved Google Chat connection's address only in Chat app mode", async () => {
    const googleChat = byKey("google-chat");
    const edit = { lifecycleMode: "edit", connectionId: "conn-4" } as const;
    await show(Component, propsFor(googleChat, edit, { webhookUrl: "[REDACTED]" }));
    await openFirstMessage(googleChat);
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).not.toContain("Webhook address");

    await show(Component, propsFor(googleChat, edit, { serviceAccountKeyEnv: "GOOGLE_CHAT_KEY" }));
    expect(codeText()).toBe(address("google-chat", "conn-4"));
  });

  it("shows the real address of a saved Slack connection that is being changed", async () => {
    await show(Component, propsFor(byKey("slack"), { lifecycleMode: "edit", connectionId: "conn-1" }));
    await openFirstMessage(byKey("slack"));

    expect(codeText()).toBe(address("slack", "conn-1"));
    expect(container.textContent).toContain("Webhook address");
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);
    expect([...container.querySelectorAll("button")].some((item) => item.textContent === "Copy")).toBe(true);
  });

  it("shows a saved Telegram connection's address only while it is on a webhook", async () => {
    const edit = { lifecycleMode: "edit", connectionId: "conn-7" } as const;
    await show(Component, propsFor(byKey("telegram"), edit, { receiveMode: "poll" }));
    await openFirstMessage(byKey("telegram"));
    expect(container.querySelector("code")).toBeNull();

    await show(Component, propsFor(byKey("telegram"), edit, {}));
    expect(container.querySelector("code")).toBeNull();

    await show(Component, propsFor(byKey("telegram"), edit, { receiveMode: "webhook" }));
    expect(codeText()).toBe(address("telegram", "conn-7"));
  });

  it("keeps it to the first-message step", async () => {
    await show(Component, propsFor(byKey("slack"), { lifecycleMode: "edit", connectionId: "conn-1" }));
    expect(container.querySelector("code")).toBeNull();
    expect(container.textContent).not.toContain(WORKS_ONCE_FINISHED);
  });
});

describe("the webhook address on a saved connection in the Classic page", () => {
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

  async function inspect(saved: ReturnType<typeof connection>) {
    api.fetchChannelSetupDefinitions.mockResolvedValue({
      items: [byKey("slack"), byKey("telegram"), byKey("google-chat")],
    });
    api.fetchChannelSetupDrafts.mockResolvedValue({ items: [] });
    api.fetchIntegrationConnections.mockResolvedValue({ items: [saved] });
    api.fetchAgenticChannelDeliveries.mockResolvedValue({ deliveries: [] });
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
    await settle();
    const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) =>
      item.textContent?.includes(saved.label),
    )!;
    await act(async () => row.click());
    await settle();
  }
  const section = () => container.querySelector('section[aria-label="Webhook address"]');

  it("shows a saved Slack connection's address, above the collapsed connection operations", async () => {
    await inspect(connection("slack", "conn-1"));

    expect(section()?.querySelector("code")?.textContent).toBe(address("slack", "conn-1"));
    const operations = container.querySelector("#channel-operations")!;
    expect(operations).not.toBeNull();
    expect(operations.contains(section())).toBe(false);
    expect(section()!.compareDocumentPosition(operations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows no address for a Telegram connection that polls", async () => {
    await inspect(connection("telegram", "conn-2", { receiveMode: "poll" }));
    expect(container.querySelector("#channel-operations")).not.toBeNull();
    expect(section()).toBeNull();
  });

  it("shows the address of a Telegram connection that receives on a webhook", async () => {
    await inspect(connection("telegram", "conn-2", { receiveMode: "webhook" }));
    expect(section()?.querySelector("code")?.textContent).toBe(address("telegram", "conn-2"));
  });

  it("shows no address for a Google Chat connection in webhook mode", async () => {
    await inspect(connection("google-chat", "conn-3", { webhookUrl: "https://chat.googleapis.com/v1/spaces/x" }));
    expect(container.querySelector("#channel-operations")).not.toBeNull();
    expect(section()).toBeNull();
  });

  it("shows the address of a Google Chat connection in Chat app mode", async () => {
    await inspect(connection("google-chat", "conn-3", { serviceAccountKeyEnv: "GOOGLE_CHAT_KEY" }));
    expect(section()?.querySelector("code")?.textContent).toBe(address("google-chat", "conn-3"));
  });

  it("shows the address of a Google Chat connection whose service-account key is saved rather than named", async () => {
    // A saved key comes back redacted in the connection's public config; it still means Chat app mode.
    await inspect(connection("google-chat", "conn-3", { serviceAccountKey: "[REDACTED]" }));
    expect(section()?.querySelector("code")?.textContent).toBe(address("google-chat", "conn-3"));
  });
});
