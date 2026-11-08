// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CapabilityConnectorItem, CapabilitySkillItem } from "@goatcitadel/contracts";
import { ApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { InspectorProvider } from "../../app/inspector";
import { ConnectorRow } from "./connectors/ConnectorRow";
import { ConnectorServerControls } from "./connectors/ConnectorServerControls";
import { WhatAsksFirst } from "./connectors/WhatAsksFirst";
import { SkillRow } from "./skills/SkillRow";
import { prepareReadyDialogFixture } from "../../../test/ready-dialog-fixture";

prepareReadyDialogFixture();

// The pieces a plugin added, in their own tabs: each says "From <plugin>" with a link to the plugin's panel, and the
// controls GoatCitadel refuses for them (Remove, what asks first) aren't offered.

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const mcp = vi.hoisted(() => ({
  deleteMcpServer: vi.fn(),
  fetchMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  updateMcpServerPolicy: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/mcp-operations", async (original) => ({
  ...(await original<object>()),
  ...mcp,
}));

const BROWSER_CHECKS = { pluginId: "browser-checks", name: "Browser checks" };
const PLUGIN_HREF = "/capabilities/plugins?item=plugin%3Abrowser-checks";

const SKILL: CapabilitySkillItem = {
  skillId: "extra:browser-qa",
  name: "browser-qa",
  description: "Checks pages in a browser.",
  category: "coding",
  origin: "built_in",
  state: "on",
  callable: true,
  revision: 1,
  switchable: true,
  pinned: false,
  tags: [],
  fromPlugin: BROWSER_CHECKS,
};

const CONNECTOR: CapabilityConnectorItem = {
  id: "mcp-server:server-1",
  name: "Playwright Browser",
  description: "Drives a browser.",
  kind: "mcp",
  source: "mcp_server",
  category: "development",
  state: "connected",
  reason: "ready",
  group: "on_this_device",
  auth: "none",
  runsOnThisDevice: true,
  networkHosts: ["registry.npmjs.org"],
  serverId: "server-1",
  serverRevision: "a".repeat(64),
  approvalPosture: "everything_asks",
  chat: { available: true },
  hiddenInWorkspace: false,
  fromPlugin: BROWSER_CHECKS,
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

async function render(node: ReactNode) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>{node}</InspectorProvider>
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const links = () => [...container.querySelectorAll("a")].map((link) => [link.textContent, link.getAttribute("href")]);
const button = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === name);

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  for (const fn of Object.values(mcp)) fn.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  vi.unstubAllGlobals();
});

describe("pieces a plugin added", () => {
  it("shows From Browser checks on its skill and connector, with a link", async () => {
    await render(
      <ul>
        <SkillRow item={SKILL} uses="Not used yet" onView={vi.fn()} />
        <ConnectorRow item={CONNECTOR} onOpen={vi.fn()} />
      </ul>,
    );

    const from = links().filter(([label]) => label === "From Browser checks");
    expect(from).toHaveLength(2);
    for (const [, href] of from) expect(href).toContain(PLUGIN_HREF);
    // A built-in plugin's skill reads Built in, as GoatCitadel says.
    expect(container.textContent).toContain("Built in");
  });

  it("reads a skill removed with its plugin as removed, with no switch", async () => {
    const removed: CapabilitySkillItem = {
      ...SKILL,
      fromPlugin: undefined,
      removedWithPlugin: { name: "Browser checks" },
      callable: false,
      switchable: false,
      lifecycleState: "revoked",
    };
    await render(
      <ul>
        <SkillRow item={removed} uses="Not used yet" onView={vi.fn()} />
      </ul>,
    );

    expect(container.textContent).toContain("Removed with Browser checks");
    expect(container.textContent).toContain("Its plugin was uninstalled, so the AI can't use it");
    expect(container.textContent).not.toContain("Revoked");
    expect(container.textContent).not.toContain("Can't be switched from here");
    expect(container.querySelector('[role="switch"]')).toBeNull();
  });

  it("hides Remove on a plugin's connector", async () => {
    await render(<ConnectorServerControls item={CONNECTOR} />);

    expect(button("Remove")).toBeUndefined();
    expect(container.textContent).toContain("It came with Browser checks. Uninstall the plugin to remove it.");
    expect(links()).toContainEqual(["Open in Plugins", expect.stringContaining(PLUGIN_HREF)]);
    // Its switch stays: GoatCitadel lets the operator turn a plugin's connector on and off.
    expect(container.querySelector('[role="switch"]')).not.toBeNull();
  });

  it("locks what asks first on a plugin's connector, and says why", async () => {
    await render(<WhatAsksFirst item={CONNECTOR} reliefAvailable />);

    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.length).toBeGreaterThan(0);
    expect(radios.every((radio) => radio.disabled)).toBe(true);
    expect(container.textContent).toContain("It came with Browser checks, so it can't be changed here.");
    expect(mcp.updateMcpServerPolicy).not.toHaveBeenCalled();
  });

  it("shows GoatCitadel's sentence when removing a connector a stale list didn't mark is refused", async () => {
    mcp.deleteMcpServer.mockRejectedValue(
      new ApiRequestError("refused", {
        kind: "http",
        method: "DELETE",
        path: "/api/v1/mcp/servers/server-1",
        status: 409,
        body: {
          error: "From Browser checks. Uninstall it to remove this.",
          code: "PLUGIN_OWNED",
          details: { pluginId: "browser-checks" },
        },
      }),
    );
    await render(<ConnectorServerControls item={{ ...CONNECTOR, fromPlugin: undefined }} />);
    await act(async () => button("Remove")?.click());
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent === "Remove Playwright Browser",
    );
    await act(async () => confirm?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "From Browser checks. Uninstall it to remove this.",
    );
    expect(container.textContent).not.toContain("Changed elsewhere");
    expect(button("Reload")).toBeUndefined();
  });
});
