// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  CapabilityPluginInstalledItem,
  CapabilityPluginListItem,
  CapabilityPluginListResponse,
  CapabilitySkillOperationRequest,
} from "@goatcitadel/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CockpitNavigationProvider } from "../../../app/CockpitNavigationProvider";
import { InspectorPanel, InspectorProvider } from "../../../app/inspector";
import { __resetSettingsApprovalDialogsForTests } from "../../settings/SettingsApprovalDialog";
import { PluginsTab } from "./PluginsTab";
import {
  INSPECTION_ID,
  PLUGIN_ID,
  fakeGateway,
  httpError,
  install,
  readDetail,
  readPlan,
  step,
  type FakeGateway,
} from "./plugin-install.test-support";
import { __resetPluginInstallsForTests } from "./use-plugin-install";

const prefs = vi.hoisted(() => ({
  activeCitadelId: "default",
  activeWorkspaceId: "ws-1",
  showTechnicalDetails: false,
}));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => prefs }));
const api = vi.hoisted(() => ({
  inspectCapabilityPlugin: vi.fn(),
  installCapabilityPlugin: vi.fn(),
  fetchCapabilityPluginDetail: vi.fn(),
  fetchCapabilityPluginInspection: vi.fn(),
  fetchCapabilityPlugins: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-plugins", () => api);
const skills = vi.hoisted(() => ({
  requestCapabilitySkillOperation: vi.fn(),
  fetchCapabilitySkillInstalls: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/capability-skills", () => skills);
const plans = vi.hoisted(() => ({ fetchChangePlan: vi.fn() }));
vi.mock("@goatcitadel/mission-control-shared/api/chat", async (original) => ({
  ...(await original<object>()),
  ...plans,
}));

const MEETING_TOOLS: CapabilityPluginListItem = {
  pluginId: PLUGIN_ID,
  name: "Meeting tools",
  description: "Notes and agendas for meetings.",
  version: "1.2.0",
  trust: "built_in",
  sourceDisplay: "Ships with GoatCitadel",
  state: "available",
  pieceCounts: { connector: 1, skill: 1 },
};
const HALF_DONE: CapabilityPluginInstalledItem = {
  ...MEETING_TOOLS,
  state: "install_not_finished",
  workspaceId: "ws-plugin",
  sourceKind: "built_in",
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let gateway: FakeGateway;
let list: CapabilityPluginListResponse;

const address = () => window.location.pathname + window.location.search;
const inspectorNamed = (name: string) => document.body.querySelector(`[aria-label="Inspector: ${name}"]`);
const body = () => document.body.querySelector<HTMLElement>('[data-inspector-body="true"]');
const button = (name: string, within: ParentNode | null = document.body) =>
  [...(within?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (entry) => entry.textContent?.trim() === name || entry.getAttribute("aria-label") === name,
  );

async function settle() {
  await act(async () => {
    for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderTab(at: string) {
  window.history.replaceState(null, "", at);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <CockpitNavigationProvider>
          <InspectorProvider>
            <PluginsTab />
            <InspectorPanel />
          </InspectorProvider>
        </CockpitNavigationProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

async function press(element: HTMLElement | undefined | null) {
  if (!element) throw new Error("nothing to press");
  element.focus();
  await act(async () => element.click());
  await settle();
}

async function type(value: string) {
  const field = body()?.querySelector<HTMLInputElement>("form input");
  if (!field) throw new Error("no field");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  gateway = fakeGateway();
  list = {
    installed: [],
    builtIn: [MEETING_TOOLS],
    operatorApprovalSkip: true,
    folderSourcesAllowed: true,
    issues: [],
  };
  api.fetchCapabilityPlugins.mockReset().mockImplementation(async () => list);
  api.inspectCapabilityPlugin.mockReset().mockImplementation(async () => gateway.inspection);
  api.fetchCapabilityPluginInspection.mockReset().mockImplementation(async () => gateway.inspection);
  api.installCapabilityPlugin.mockReset().mockImplementation(async () => install(gateway));
  api.fetchCapabilityPluginDetail.mockReset().mockImplementation(async () => {
    if (!gateway.installed) throw httpError(404, { error: "This plugin isn't installed." });
    return readDetail(gateway);
  });
  plans.fetchChangePlan.mockReset().mockImplementation(async () => readPlan(gateway));
  skills.requestCapabilitySkillOperation
    .mockReset()
    .mockImplementation(async (request: CapabilitySkillOperationRequest) => step(gateway, request));
  skills.fetchCapabilitySkillInstalls.mockReset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  __resetPluginInstallsForTests();
  __resetSettingsApprovalDialogsForTests();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("Plugins tab install panel", () => {
  it("checks a built-in plugin from its row's Install, then names the check in the address", async () => {
    await renderTab("/capabilities/plugins?shell=cockpit");
    await press(button("Install Meeting tools"));

    expect(api.inspectCapabilityPlugin).toHaveBeenCalledExactlyOnceWith(
      { workspaceId: "ws-1", source: { kind: "built_in", pluginId: PLUGIN_ID } },
      { attemptKey: expect.any(String) },
    );
    // The check answered: its own address, which a reload opens again.
    expect(new URLSearchParams(window.location.search).get("item")).toBe(`plugin-install:${INSPECTION_ID}`);
    expect(inspectorNamed("Meeting tools")).not.toBeNull();
    expect(button("Install", body())).toBeDefined();
  });

  it("opens the Git form from Install from Git, and the folder form from Add from folder", async () => {
    await renderTab("/capabilities/plugins?shell=cockpit");
    await press(button("Install from Git"));
    expect(new URLSearchParams(window.location.search).get("item")).toBe("plugin-source:git");
    expect(inspectorNamed("Install from Git")).not.toBeNull();
    expect(body()?.textContent).toContain("Git repository address");

    await type("https://github.com/acme/meeting-tools");
    await press(button("Check", body()));
    expect(api.inspectCapabilityPlugin).toHaveBeenCalledWith(
      { workspaceId: "ws-1", source: { kind: "git", url: "https://github.com/acme/meeting-tools" } },
      { attemptKey: expect.any(String) },
    );
    expect(new URLSearchParams(window.location.search).get("item")).toBe(`plugin-install:${INSPECTION_ID}`);

    // Closing the panel clears the address.
    await press(button("Close inspector"));
    expect(address()).toBe("/capabilities/plugins?shell=cockpit");

    await press(button("Add from folder"));
    expect(inspectorNamed("Add from folder")).not.toBeNull();
    expect(body()?.textContent).toContain("A folder on the computer GoatCitadel runs on.");
  });

  it("hands an install to the plugin's own address once its plan applied", async () => {
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin-install%3A${INSPECTION_ID}`);
    expect(inspectorNamed("Meeting tools")).not.toBeNull();
    await press(button("Install", body()));

    expect(new URLSearchParams(window.location.search).get("item")).toBe(`plugin:${PLUGIN_ID}`);
    expect(inspectorNamed("Meeting tools")).not.toBeNull();
    for (let read = 0; read < 10 && !body()?.textContent?.includes("is installed"); read += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      });
      await settle();
    }
    expect(body()?.textContent).toContain("Meeting tools is installed.");
  }, 20_000);

  it("opens an unfinished install from its row's Continue, in the workspace it was installed in", async () => {
    gateway.installed = true;
    gateway.workspaceId = "ws-plugin";
    gateway.pieces = { calendar: "added", notes: "installed_off" };
    list = { ...list, installed: [HALF_DONE], builtIn: [] };
    await renderTab("/capabilities/plugins?shell=cockpit");
    await press(button("Continue Meeting tools"));

    expect(new URLSearchParams(window.location.search).get("item")).toBe(`plugin:${PLUGIN_ID}`);
    expect(inspectorNamed("Meeting tools")).not.toBeNull();
    expect(api.fetchCapabilityPluginDetail).toHaveBeenCalledWith("ws-plugin", PLUGIN_ID, expect.anything());
    expect(body()?.textContent).toContain("Meeting notes is installed, not switched on.");
    await press(button("Continue", body()));
    expect(skills.requestCapabilitySkillOperation).toHaveBeenCalledExactlyOnceWith({
      workspaceId: "ws-plugin",
      snapshotId: "snap-notes",
      operationKind: "activate",
    });
  });

  it("leaves an installed plugin's address to its own panel", async () => {
    list = { ...list, installed: [{ ...HALF_DONE, state: "installed" }], builtIn: [] };
    await renderTab(`/capabilities/plugins?shell=cockpit&item=plugin%3A${PLUGIN_ID}`);
    expect(body()).toBeNull();
    expect(api.fetchCapabilityPluginDetail).not.toHaveBeenCalled();
  });
});
