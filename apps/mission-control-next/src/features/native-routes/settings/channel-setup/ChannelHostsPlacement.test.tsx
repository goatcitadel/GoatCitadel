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

const api = vi.hoisted(() => ({ fetchSettings: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goatcitadel/mission-control-shared/api/client")>()),
  fetchSettings: api.fetchSettings,
}));

const hosts = vi.hoisted(() => ({ ensureHostsAllowed: vi.fn() }));
vi.mock("../channel-hosts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channel-hosts")>()),
  ensureHostsAllowed: hosts.ensureHostsAllowed,
}));

const definitions = (await Object.values(runtimeDefinitions)[0]!()).listChannelSetupDefinitions();
const line = definitions.find((item) => item.catalog.catalogId === "channel.line")!;
const testStep = line.wizard.steps.find((step) => step.kind === "test")!;
const teams = definitions.find((item) => item.catalog.catalogId === "channel.teams")!;
const teamsTestStep = teams.wizard.steps.find((step) => step.kind === "test")!;
const unreadableLine = (label: string) =>
  `GoatCitadel can't read the address in ${label} after it's saved, so it can't check its host. Make sure GoatCitadel may reach it.`;

const makeDraft = (definition: ChannelSetupDefinition): ChannelSetupDraft => ({
  draftId: "fixture-draft",
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
});

const WORKFLOW_HOST = "default0123456789abcdef.00.environment.api.powerplatform.com";
/** After a save: the address is a marker in the editor, and the Gateway recorded its host beside the secret. */
const savedInDraft = (definition: ChannelSetupDefinition): ChannelSetupDraft => ({
  ...makeDraft(definition),
  secretState: { webhookUrl: { configured: true, custody: "temporary", source: "operator", host: WORKFLOW_HOST } },
});
/** A draft of a saved connection: the address stays in the connection, which recorded its host when it was saved. */
const savedInConnection = (definition: ChannelSetupDefinition): ChannelSetupDraft => ({
  ...makeDraft(definition),
  lifecycleMode: "edit",
  hydration: {
    status: "opaque-secret",
    fieldState: { webhookUrl: "configured" },
    warnings: [],
    addressHosts: { webhookUrl: WORKFLOW_HOST },
  },
});

const propsFor = (
  definition: ChannelSetupDefinition,
  scopeId?: string,
  values: Record<string, unknown> = {},
  draft: ChannelSetupDraft = makeDraft(definition),
) => ({
  ...(scopeId ? { scopeId } : {}),
  definition,
  draft,
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

/** Cockpit has the query client the check reads through; the Classic guide brings its own. */
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
const buttonNamed = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === label);

async function openStep(title: string) {
  const target = stepButtons().filter((item) => item.textContent?.includes(title));
  expect(target).toHaveLength(1);
  await act(async () => target[0]!.click());
  await settle();
}

beforeEach(() => {
  __resetSessionViewStateForTests();
  api.fetchSettings.mockReset();
  hosts.ensureHostsAllowed.mockReset();
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
  ["Classic guide", ChannelSetupWizard, "Validate"],
  ["Cockpit guide", ChannelDraftEditor, "Validate"],
] as const)("the hosts check in the %s", (_name, Component, validate) => {
  it("names LINE's host on the test step, above the buttons that test it", async () => {
    expect(line.wizard.requiredHosts).toEqual(["api.line.me"]);
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["api.line.me"] });
    await show(Component, propsFor(line));

    await openStep(testStep.title);

    expect(container.textContent).toContain("GoatCitadel may reach api.line.me.");
    const hostsLine = [...container.querySelectorAll("p")].find((item) => item.textContent?.includes("may reach"))!;
    expect(hostsLine.compareDocumentPosition(buttonNamed(validate)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers to allow a host that is missing, in the workspace the guide was given", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "failed", message: "Stopped." });
    await show(Component, propsFor(line, "w-9"));
    await openStep(testStep.title);
    expect(container.textContent).toContain("GoatCitadel can't reach these yet: api.line.me.");
    expect(hosts.ensureHostsAllowed).not.toHaveBeenCalled();

    await act(async () => buttonNamed("Allow these hosts")!.click());

    expect(hosts.ensureHostsAllowed).toHaveBeenCalledExactlyOnceWith(["api.line.me"], "w-9", ["api.line.me"]);
  });

  it("falls back to the default workspace when the guide was given none", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    hosts.ensureHostsAllowed.mockResolvedValue({ kind: "failed", message: "Stopped." });
    await show(Component, propsFor(line));
    await openStep(testStep.title);

    await act(async () => buttonNamed("Allow these hosts")!.click());

    expect(hosts.ensureHostsAllowed).toHaveBeenCalledExactlyOnceWith(["api.line.me"], "default", ["api.line.me"]);
  });

  it("says Teams' saved webhook address can't be read, since a saved secret is only a marker and Teams has no other host", async () => {
    expect(teams.wizard.requiredHosts).toBeUndefined();
    expect(teams.wizard.hostFields).toEqual(["webhookUrl"]);
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    await show(Component, propsFor(teams, undefined, { webhookUrl: "[REDACTED]" }));

    await openStep(teamsTestStep.title);

    expect(container.textContent).toContain(unreadableLine("Webhook URL"));
    expect(container.textContent).not.toContain("can't reach these yet");
    const lines = [...container.querySelectorAll("p")].map((item) => item.textContent ?? "");
    expect(lines.some((item) => item.startsWith("GoatCitadel may reach"))).toBe(false);
    expect(buttonNamed("Allow these hosts")).toBeUndefined();
    expect(hosts.ensureHostsAllowed).not.toHaveBeenCalled();
    expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live="polite"]')).toHaveLength(0);
  });

  it("reads Teams' webhook address while it is still typed, and says nothing about an unset one", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: ["prod-1.westus.logic.azure.com"] });
    await show(Component, propsFor(teams, undefined, { webhookUrl: "https://prod-1.westus.logic.azure.com/x?sig=1" }));
    await openStep(teamsTestStep.title);
    expect(container.textContent).toContain("GoatCitadel may reach prod-1.westus.logic.azure.com.");
    expect(container.textContent).not.toContain("can't read the address");

    await show(Component, propsFor(teams, undefined, {}));
    await openStep(teamsTestStep.title);
    expect(container.textContent).not.toContain("can't read the address");
  });

  it("never offers to allow a wildcard typed into an address; it asks for an address with a host", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    await show(Component, propsFor(teams, undefined, { webhookUrl: "https://*/" }));

    await openStep(teamsTestStep.title);

    expect(container.textContent).toContain(
      "GoatCitadel can't find a host in Webhook URL. Use an address like https://example.com.",
    );
    expect(container.textContent).not.toContain("after it's saved");
    expect(container.textContent).not.toContain("*");
    expect(buttonNamed("Allow these hosts")).toBeUndefined();
  });

  it.each([
    ["saved in this draft", { webhookUrl: "[REDACTED]" }, savedInDraft],
    ["saved in the connection being changed", {}, savedInConnection],
  ] as const)(
    "offers to allow the host the Gateway recorded for Teams' webhook address %s",
    async (_case, values, draftOf) => {
      api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
      hosts.ensureHostsAllowed.mockResolvedValue({ kind: "failed", message: "Stopped." });
      await show(Component, propsFor(teams, "w-2", values, draftOf(teams)));

      await openStep(teamsTestStep.title);

      expect(container.textContent).toContain(`GoatCitadel can't reach these yet: ${WORKFLOW_HOST}.`);
      expect(container.textContent).not.toContain("can't read the address");
      expect(hosts.ensureHostsAllowed).not.toHaveBeenCalled();
      await act(async () => buttonNamed("Allow these hosts")!.click());
      expect(hosts.ensureHostsAllowed).toHaveBeenCalledExactlyOnceWith([WORKFLOW_HOST], "w-2", [WORKFLOW_HOST]);
      expect(container.querySelectorAll('[role="status"], [role="alert"], [aria-live="polite"]')).toHaveLength(0);
    },
  );

  it("checks nothing before the test step, and nothing for a channel that needs no host", async () => {
    api.fetchSettings.mockResolvedValue({ revision: 1, networkAllowlist: [] });
    await show(Component, propsFor(line));
    expect(container.textContent).not.toContain("GoatCitadel may reach");
    expect(container.textContent).not.toContain("can't reach these yet");
    expect(api.fetchSettings).not.toHaveBeenCalled();

    const noHosts: ChannelSetupDefinition = {
      ...line,
      wizard: { ...line.wizard, requiredHosts: [], conditionalHosts: [], hostFields: [] },
    };
    await show(Component, propsFor(noHosts));
    await openStep(testStep.title);

    expect(container.textContent).not.toContain("GoatCitadel may reach");
    expect(container.textContent).not.toContain("can't reach these yet");
    expect(api.fetchSettings).not.toHaveBeenCalled();
  });
});
