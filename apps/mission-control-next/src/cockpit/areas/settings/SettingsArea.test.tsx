// @vitest-environment happy-dom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsArea } from "./SettingsArea";
import { CockpitNavigationProvider } from "../../app/CockpitNavigationProvider";
import { buildSettingsIndex } from "./settings-index";
import { selectedSettingsSection } from "./SettingsSectionTabs";

const owner = vi.hoisted(() => ({ mounted: vi.fn(), unmounted: vi.fn() }));
const catalog = vi.hoisted(() => ({ read: vi.fn(async () => ({ items: [], issues: [], callableKnown: false })) }));
vi.mock("../library/capability-catalog", () => ({ loadCapabilityCatalog: catalog.read }));
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({
  useUiPreferences: () => ({ activeCitadelId: "citadel-a", activeWorkspaceId: "workspace-a" }),
}));
function OwnerProbe({ name }: { name: string }) {
  const [value, setValue] = useState("");
  useEffect(() => {
    owner.mounted(name);
    return () => owner.unmounted(name);
  }, [name]);
  return (
    <label>
      {name}
      <input aria-label={`${name} retained draft`} value={value} onChange={(event) => setValue(event.target.value)} />
    </label>
  );
}
vi.mock("./AppearanceSettings", () => ({ AppearanceSettings: () => <OwnerProbe name="Appearance owner" /> }));
vi.mock("./PersonalitySettings", () => ({ PersonalitySettings: () => <OwnerProbe name="Personality owner" /> }));
vi.mock("./DeviceAccessSettings", () => ({ DeviceAccessSettings: () => <OwnerProbe name="Access owner" /> }));
vi.mock("./WorkspaceSettings", () => ({ WorkspaceSettings: () => <OwnerProbe name="Workspace owner" /> }));
vi.mock("./IntegrationConnectionsSettings", () => ({
  IntegrationConnectionsSettings: () => <OwnerProbe name="Integration owner" />,
}));
vi.mock("./ManagedRuntimeSettings", () => ({ ManagedRuntimeSettings: () => <OwnerProbe name="Runtime owner" /> }));
vi.mock("./DaemonDiagnostics", () => ({ DaemonDiagnostics: () => <OwnerProbe name="Daemon owner" /> }));
vi.mock("./VoiceRuntimeSettings", () => ({ VoiceRuntimeSettings: () => <OwnerProbe name="Voice owner" /> }));
vi.mock("./LlamaSetupSettings", () => ({ LlamaSetupSettings: () => <OwnerProbe name="Llama owner" /> }));
vi.mock("./CitadelOverviewSettings", () => ({ CitadelOverviewSettings: () => <OwnerProbe name="Overview owner" /> }));
vi.mock("./CitadelMasonSettings", () => ({ CitadelMasonSettings: () => <OwnerProbe name="Mason owner" /> }));
vi.mock("./CitadelWardsSettings", () => ({ CitadelWardsSettings: () => <OwnerProbe name="Wards owner" /> }));
vi.mock("./CitadelCouncilSettings", () => ({ CitadelCouncilSettings: () => <OwnerProbe name="Council owner" /> }));
vi.mock("./CitadelVaultSettings", () => ({ CitadelVaultSettings: () => <OwnerProbe name="Vault owner" /> }));
vi.mock("./CapabilityScopesSettings", () => ({
  CapabilityScopesSettings: ({ scopeKind, scopeId }: { scopeKind: string; scopeId: string }) => (
    <OwnerProbe name={`${scopeKind} capabilities ${scopeId}`} />
  ),
}));
vi.mock("./McpServersSettings", () => ({ McpServersSettings: () => <OwnerProbe name="MCP owner" /> }));
vi.mock("./BudgetModeControl", () => ({ BudgetModeControl: () => <OwnerProbe name="Budget owner" /> }));
vi.mock("./ApprovalModeControl", () => ({ ApprovalModeControl: () => <OwnerProbe name="Approval owner" /> }));
vi.mock("./FilesystemWriteRootsControl", () => ({
  FilesystemWriteRootsControl: () => <OwnerProbe name="Filesystem write roots owner" />,
}));
vi.mock("./ModelsSettings", () => ({ ModelsSettings: () => <OwnerProbe name="Models owner" /> }));
vi.mock("./LocalAiSettings", () => ({ LocalAiSettings: () => <OwnerProbe name="Local AI owner" /> }));
vi.mock("./CitadelBlueprintSettings", () => ({
  CitadelBlueprintSettings: () => <OwnerProbe name="Blueprint owner" />,
}));
vi.mock("./ChannelsSettings", () => ({ ChannelsSettings: () => <OwnerProbe name="Channels owner" /> }));
vi.mock("./ToolGrantSettings", () => ({ ToolGrantSettings: () => <OwnerProbe name="Tool grants owner" /> }));
vi.mock("./PermissionProfileSettings", () => ({
  PermissionProfileSettings: () => <OwnerProbe name="Permission owner" />,
}));
vi.mock("./HooksSettings", () => ({
  HooksSettings: ({ workspaceId }: { workspaceId: string }) => <OwnerProbe name={`Hooks ${workspaceId}`} />,
}));
vi.mock("./AddonsSettings", () => ({ AddonsSettings: () => <OwnerProbe name="Add-ons owner" /> }));
vi.mock("./PortablePacksSettings", () => ({ PortablePacksSettings: () => <OwnerProbe name="Packs owner" /> }));
vi.mock("./TrustPolicySettings", () => ({ TrustPolicySettings: () => <OwnerProbe name="Trust owner" /> }));
vi.mock("./FirstRunArea", () => ({ FirstRunArea: () => <p>First run owner</p> }));
vi.mock("./FirstRunStatus", () => ({ FirstRunStatus: () => <p>First run status</p> }));
let root: Root, container: HTMLDivElement, queryClient: QueryClient;
const settingsView = () => (
  <QueryClientProvider client={queryClient}>
    <CockpitNavigationProvider>
      <SettingsArea />
    </CockpitNavigationProvider>
  </QueryClientProvider>
);
const tab = (label: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === label)!;
const active = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
async function render(url = "/settings/general?shell=cockpit") {
  window.history.replaceState(null, "", url);
  await act(async () => root.render(settingsView()));
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function activate(label: string) {
  await act(async () => {
    const element = tab(label);
    element.focus();
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
  window.history.replaceState(null, "", "/");
});

describe("Settings section tabs", () => {
  // ST-03: Get started shows a compact status with "Open setup"; only /settings/first-run mounts the full stepper.
  it.each(["/settings/onboarding", "/settings/models#onboarding"])(
    "renders the first-run status at %s",
    async (path) => {
      await render(path);
      await vi.waitFor(() => expect(container.textContent).toContain("First run status"));
      expect(container.textContent).not.toContain("First run owner");
      expect(container.textContent).not.toContain("Models owner");
    },
  );
  // ST-09: notification routing lives beside Attention on General, so its deep link is a valid General section.
  it("accepts the notification routing deep link on General", async () => {
    await render("/settings/general?shell=cockpit#notification-routing");
    await vi.waitFor(() => expect(container.textContent).toContain("Appearance owner"));
    expect(container.textContent).not.toContain("does not match a section");
  });
  it("renders the full first run at /settings/first-run", async () => {
    await render("/settings/first-run");
    await vi.waitFor(() => expect(container.textContent).toContain("First run owner"));
    expect(container.textContent).not.toContain("First run status");
  });
  it("keeps Models default on the provider owner and opens the Get started status from its tab", async () => {
    await render("/settings/models");
    await vi.waitFor(() => expect(container.textContent).toContain("Models owner"));
    await activate("Get started");
    await vi.waitFor(() => expect(container.textContent).toContain("First run status"));
    expect(window.location.hash).toBe("#onboarding");
  });
  it("keeps the real read-only Library inspection links in Tools and preserves unknown callability", async () => {
    await render("/settings/safety?shell=cockpit#approval-mode");
    expect(active()).toBe("Tools");
    await vi.waitFor(() =>
      expect(container.querySelector('a[href="/library?shell=cockpit&type=tool"]')).not.toBeNull(),
    );
    const tools = container.querySelector<HTMLAnchorElement>('a[href="/library?shell=cockpit&type=tool"]')!;
    const panel = tools.closest('[role="tabpanel"]')!;
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(tools.textContent).toBe("Open tools in Library");
    expect(panel.querySelector('a[href="/library?shell=cockpit&type=skill"]')?.textContent).toBe(
      "Open skills in Library",
    );
    expect(panel.textContent).toContain("Callability unknown");
    expect(panel.textContent).not.toContain("in the current callable catalog");
    expect(panel.textContent).toContain("does not bypass approvals or grant permission");
    expect(catalog.read).toHaveBeenCalledTimes(1);
    await act(async () => tools.click());
    expect(window.location.pathname + window.location.search).toBe("/library?shell=cockpit&type=tool");
  });
  it("mounts llama.cpp setup and the managed runtime on one owner page each, linking from the other", async () => {
    await render("/settings/models?shell=cockpit#local-ai");
    await vi.waitFor(() => expect(container.textContent).toContain("Local AI owner"));
    expect(container.textContent).toContain("Llama owner");
    expect(container.textContent).not.toContain("Runtime owner");
    expect(container.querySelector('a[href="/settings/advanced#managed-runtime"]')?.textContent).toBe(
      "Advanced › Runtime configuration",
    );
    await render("/settings/advanced?shell=cockpit#managed-runtime");
    await vi.waitFor(() => expect(container.textContent).toContain("Runtime owner"));
    expect(container.textContent).not.toContain("Llama owner");
    expect(container.querySelector('a[href="/settings/models#local-ai"]')?.textContent).toBe("Models › Local AI");
    expect(owner.mounted.mock.calls.filter(([name]) => name === "Llama owner")).toHaveLength(1);
  });
  it("links Trust & policy to the one explanation of how rules combine", async () => {
    await render("/settings/safety?shell=cockpit#trust-policy");
    await vi.waitFor(() => expect(container.textContent).toContain("Trust owner"));
    const link = container.querySelector<HTMLAnchorElement>('a[href="/settings/safety#permission-profile"]')!;
    expect(link.textContent).toBe("See how rules combine in Permissions");
    await act(async () => link.click());
    expect(window.location.hash).toBe("#permission-profile");
    await vi.waitFor(() => expect(container.textContent).toContain("Permission owner"));
  });
  it("withholds hidden capability owners on direct links and routes visible hooks to the active scope", async () => {
    await render("/settings/citadel?shell=cockpit#citadel-capabilities");
    expect(container.querySelector('[aria-label="citadel capabilities citadel-a retained draft"]')).toBeNull();
    expect(container.querySelector('[aria-label="workspace capabilities workspace-a retained draft"]')).toBeNull();
    expect(tab("Workspace capabilities")).toBeUndefined();
    expect(container.textContent).toContain("Settings destination unavailable");
    await render("/settings/citadel?shell=cockpit#workspace-capabilities");
    expect(container.querySelector('[aria-label="workspace capabilities workspace-a retained draft"]')).toBeNull();
    expect(container.textContent).toContain("Technical display preferences do not enable it");
    const entries = buildSettingsIndex().flatMap((page) => page.entries);
    expect(entries.find((entry) => entry.section === "citadel-capabilities")?.href).toBe(
      "/settings/citadel#citadel-capabilities",
    );
    expect(entries.find((entry) => entry.section === "workspace-capabilities")?.href).toBe(
      "/settings/citadel#workspace-capabilities",
    );
    await render("/settings/safety?shell=cockpit#hooks");
    expect(container.querySelector('[aria-label="Hooks workspace-a retained draft"]')).not.toBeNull();
    expect(entries.find((entry) => entry.section === "hooks")?.href).toBe("/settings/safety#hooks");
  });
  it("shows native General tabs without duplicate detailed cards and retains owner state across tabs and search", async () => {
    await render();
    expect(active()).toBe("Appearance");
    expect(container.querySelector('a[href="/settings/general?shell=classic"]')).toBeNull();
    expect(owner.mounted.mock.calls.map(([name]) => name)).toEqual(["Appearance owner"]);
    expect(container.querySelector('[aria-label="Personality owner retained draft"]')).toBeNull();
    await activate("Personalities · Experimental");
    const draft = container.querySelector<HTMLInputElement>('[aria-label="Personality owner retained draft"]')!;
    await fill(draft, "Unsaved voice");
    expect(window.location.hash).toBe("#work-personality");
    expect(window.location.search).toBe("?shell=cockpit");
    await activate("Appearance");
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);
    await activate("Personalities · Experimental");
    expect(draft.value).toBe("Unsaved voice");
    await fill(container.querySelector('input[type="search"]')!, "notifications");
    expect(container.querySelector('a[href="/settings/general#appearance"]')).not.toBeNull();
    await fill(container.querySelector('input[type="search"]')!, "");
    expect(active()).toBe("Personalities · Experimental");
    expect(draft.value).toBe("Unsaved voice");
    expect(owner.mounted.mock.calls.map(([name]) => name)).toEqual(["Appearance owner", "Personality owner"]);
    expect(owner.unmounted).not.toHaveBeenCalled();
  });
  it("moves keyboard focus without implicit activation and binds the panel to its tab", async () => {
    await render();
    await act(async () => {
      tab("Appearance").focus();
      tab("Appearance").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    await vi.waitFor(() => expect(document.activeElement).toBe(tab("Personalities · Experimental")));
    expect(active()).toBe("Appearance");
    expect(owner.mounted.mock.calls.map(([name]) => name)).toEqual(["Appearance owner"]);
    await activate("Personalities · Experimental");
    const panel = document.getElementById(tab("Personalities · Experimental").getAttribute("aria-controls")!)!;
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Personalities · Experimental").id);
    await act(async () =>
      tab("Personalities · Experimental").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })),
    );
    await vi.waitFor(() => expect(document.activeElement).toBe(tab("Appearance")));
    expect(active()).toBe("Personalities · Experimental");
    expect(container.querySelector('[role="tablist"]')?.classList.contains("overflow-x-auto")).toBe(true);
    expect(container.querySelector('[role="tablist"]')?.classList.contains("max-w-full")).toBe(true);
  });
  it("restores exact section on Back and hash changes while supporting existing section routes", async () => {
    await render("/settings/personalities?shell=cockpit");
    expect(active()).toBe("Personalities · Experimental");
    await activate("Appearance");
    await activate("Personalities · Experimental");
    await act(async () => window.history.back());
    await vi.waitFor(() => expect(active()).toBe("Appearance"));
    await act(async () => {
      window.location.hash = "work-personality";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(active()).toBe("Personalities · Experimental");
    expect(owner.unmounted).not.toHaveBeenCalled();
  });
  it("keeps all grouped owner destinations in ordered tabs with native hrefs", async () => {
    const pages = buildSettingsIndex();
    expect(pages.flatMap((page) => page.entries)).toHaveLength(25);
    expect(pages.flatMap((page) => page.entries).every((entry) => !entry.href.includes("shell="))).toBe(true);
    for (const page of pages) {
      window.history.replaceState(null, "", `/settings/${page.id}?shell=cockpit`);
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
      await act(async () => root.render(settingsView()));
      expect([...container.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual(
        page.entries
          .filter((entry) => entry.discoverable)
          .map(
            (entry) =>
              `${entry.tabLabel ?? entry.label}${entry.releaseStatus === "experimental" ? " · Experimental" : ""}`,
          ),
      );
    }
    expect(selectedSettingsSection(pages.find((page) => page.id === "safety")!, "safety", "approval-mode")).toBe(
      "tools",
    );
    expect(
      selectedSettingsSection(pages.find((page) => page.id === "safety")!, "safety", "filesystem-write-roots"),
    ).toBe("tools");
    expect(selectedSettingsSection(pages[0]!, "general", "application-updates")).toBe("general");
  });
});

it.each(["#updates", "#application-updates"])(
  "opens the General appearance owner for the update links' %s anchor",
  async (anchor) => {
    await render(`/settings/general?shell=cockpit${anchor}`);
    await vi.waitFor(() => expect(container.textContent).toContain("Appearance owner"));
    expect(container.textContent).not.toContain("Settings destination unavailable");
    expect(active()).toBe("Appearance");
  },
);

it.each(["/settings/unknown?shell=cockpit", "/settings/general?shell=cockpit#unknown"])(
  "does not silently substitute another panel for %s",
  async (href) => {
    await render(href);
    expect(container.textContent).toContain("Settings destination unavailable");
    expect(container.querySelector('[aria-label="Appearance owner retained draft"]')).toBeNull();
    const home = [...container.querySelectorAll("a")].find((item) => item.textContent === "Open Settings");
    expect(home?.getAttribute("href")).toBe("/settings/general");
    await act(async () => home!.click());
    await vi.waitFor(() => expect(window.location.pathname).toBe("/settings/general"));
    expect(container.textContent).not.toContain("Settings destination unavailable");
  },
);
