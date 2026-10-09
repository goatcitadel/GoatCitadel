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
vi.mock("@goatcitadel/mission-control-shared/state/ui-preferences", () => ({ useUiPreferences: () => ({ activeCitadelId: "citadel-a", activeWorkspaceId: "workspace-a" }) }));
function OwnerProbe({ name }: { name: string }) {
  const [value, setValue] = useState("");
  useEffect(() => { owner.mounted(name); return () => owner.unmounted(name); }, [name]);
  return <label>{name}<input aria-label={`${name} retained draft`} value={value} onChange={(event) => setValue(event.target.value)} /></label>;
}
vi.mock("./AppearanceSettings", () => ({ AppearanceSettings: () => <OwnerProbe name="Appearance owner" /> }));
vi.mock("./PersonalitySettings", () => ({ PersonalitySettings: () => <OwnerProbe name="Personality owner" /> }));
vi.mock("./DeviceAccessSettings", () => ({ DeviceAccessSettings: () => <OwnerProbe name="Access owner" /> }));
vi.mock("./WorkspaceSettings", () => ({ WorkspaceSettings: () => <OwnerProbe name="Workspace owner" /> }));
vi.mock("./IntegrationConnectionsSettings", () => ({ IntegrationConnectionsSettings: () => <OwnerProbe name="Integration owner" /> }));
vi.mock("./ManagedRuntimeSettings", () => ({ ManagedRuntimeSettings: () => <OwnerProbe name="Runtime owner" /> }));
vi.mock("./DaemonDiagnostics", () => ({ DaemonDiagnostics: () => <OwnerProbe name="Daemon owner" /> }));
vi.mock("./VoiceRuntimeSettings", () => ({ VoiceRuntimeSettings: () => <OwnerProbe name="Voice owner" /> }));
vi.mock("./LlamaSetupSettings", () => ({ LlamaSetupSettings: () => <OwnerProbe name="Llama owner" /> }));
vi.mock("./CitadelOverviewSettings", () => ({ CitadelOverviewSettings: () => <OwnerProbe name="Overview owner" /> }));
vi.mock("./CitadelMasonSettings", () => ({ CitadelMasonSettings: () => <OwnerProbe name="Mason owner" /> }));
vi.mock("./CitadelWardsSettings", () => ({ CitadelWardsSettings: () => <OwnerProbe name="Wards owner" /> }));
vi.mock("./CitadelCouncilSettings", () => ({ CitadelCouncilSettings: () => <OwnerProbe name="Council owner" /> }));
vi.mock("./CitadelVaultSettings", () => ({ CitadelVaultSettings: () => <OwnerProbe name="Vault owner" /> }));
vi.mock("./CapabilityScopesSettings", () => ({ CapabilityScopesSettings: ({ scopeKind, scopeId }: { scopeKind: string; scopeId: string }) => <OwnerProbe name={`${scopeKind} capabilities ${scopeId}`} /> }));
vi.mock("./McpServersSettings", () => ({ McpServersSettings: () => <OwnerProbe name="MCP owner" /> }));
vi.mock("./BudgetModeControl", () => ({ BudgetModeControl: () => <OwnerProbe name="Budget owner" /> }));
vi.mock("./ApprovalModeControl", () => ({ ApprovalModeControl: () => <OwnerProbe name="Approval owner" /> }));
vi.mock("./ModelsSettings", () => ({ ModelsSettings: () => <OwnerProbe name="Models owner" /> }));
vi.mock("./LocalAiSettings", () => ({ LocalAiSettings: () => <OwnerProbe name="Local AI owner" /> }));
vi.mock("./CitadelBlueprintSettings", () => ({ CitadelBlueprintSettings: () => <OwnerProbe name="Blueprint owner" /> }));
vi.mock("./ChannelsSettings", () => ({ ChannelsSettings: () => <OwnerProbe name="Channels owner" /> }));
vi.mock("./ToolGrantSettings", () => ({ ToolGrantSettings: () => <OwnerProbe name="Tool grants owner" /> }));
vi.mock("./PermissionProfileSettings", () => ({ PermissionProfileSettings: () => <OwnerProbe name="Permission owner" /> }));
vi.mock("./HooksSettings", () => ({ HooksSettings: ({ workspaceId }: { workspaceId: string }) => <OwnerProbe name={`Hooks ${workspaceId}`} /> }));
vi.mock("./AddonsSettings", () => ({ AddonsSettings: () => <OwnerProbe name="Add-ons owner" /> }));
vi.mock("./PortablePacksSettings", () => ({ PortablePacksSettings: () => <OwnerProbe name="Packs owner" /> }));
vi.mock("./TrustPolicySettings", () => ({ TrustPolicySettings: () => <OwnerProbe name="Trust owner" /> }));
vi.mock("./FirstRunArea", () => ({ FirstRunArea: () => <p>First run owner</p> }));
let root: Root, container: HTMLDivElement, queryClient: QueryClient;
const settingsView = () => <QueryClientProvider client={queryClient}><CockpitNavigationProvider><SettingsArea /></CockpitNavigationProvider></QueryClientProvider>;
const tab = (label: string) => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((item) => item.textContent === label)!;
const active = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
async function render(url = "/settings/general?shell=cockpit") {
  window.history.replaceState(null, "", url);
  await act(async () => root.render(settingsView()));
}
async function fill(input: HTMLInputElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function activate(label: string) {
  await act(async () => { const element = tab(label); element.focus(); element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
}
beforeEach(() => { vi.clearAllMocks(); queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); queryClient.clear(); container.remove(); window.history.replaceState(null, "", "/"); });

describe("Settings section tabs", () => {
  it.each(["/settings/onboarding", "/settings/models#onboarding", "/settings/first-run"])("renders native first run at %s", async (path) => {
    await render(path);
    await vi.waitFor(() => expect(container.textContent).toContain("First run owner"));
    expect(container.textContent).not.toContain("Models owner");
  });
  it("keeps Models default on the provider owner and opens native Get started from its tab", async () => {
    await render("/settings/models");
    await vi.waitFor(() => expect(container.textContent).toContain("Models owner"));
    await activate("Get started");
    await vi.waitFor(() => expect(container.textContent).toContain("First run owner"));
    expect(window.location.hash).toBe("#onboarding");
  });
  it("keeps the real read-only Library inspection links in Tools and preserves unknown callability", async () => {
    await render("/settings/safety?shell=cockpit#approval-mode");
    expect(active()).toBe("Tools");
    await vi.waitFor(() => expect(container.querySelector('a[href="/library?shell=cockpit&type=tool"]')).not.toBeNull());
    const tools = container.querySelector<HTMLAnchorElement>('a[href="/library?shell=cockpit&type=tool"]')!;
    const panel = tools.closest('[role="tabpanel"]')!;
    expect(panel.hasAttribute("hidden")).toBe(false);
    expect(tools.textContent).toBe("Inspect tools");
    expect(panel.querySelector('a[href="/library?shell=cockpit&type=skill"]')?.textContent).toBe("Inspect skills");
    expect(panel.textContent).toContain("Callability unknown");
    expect(panel.textContent).not.toContain("in the current callable catalog");
    expect(panel.textContent).toContain("does not bypass approvals or grant permission");
    expect(catalog.read).toHaveBeenCalledTimes(1);
    await act(async () => tools.click());
    expect(window.location.pathname + window.location.search).toBe("/library?shell=cockpit&type=tool");
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
    expect(entries.find((entry) => entry.section === "citadel-capabilities")?.href).toBe("/settings/citadel#citadel-capabilities");
    expect(entries.find((entry) => entry.section === "workspace-capabilities")?.href).toBe("/settings/citadel#workspace-capabilities");
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
    expect(window.location.hash).toBe("#work-personality"); expect(window.location.search).toBe("?shell=cockpit");
    await activate("Appearance");
    expect(draft.closest('[role="tabpanel"]')?.hasAttribute("hidden")).toBe(true);
    await activate("Personalities · Experimental"); expect(draft.value).toBe("Unsaved voice");
    await fill(container.querySelector('input[type="search"]')!, "notifications");
    expect(container.querySelector('a[href="/settings/general#appearance"]')).not.toBeNull();
    await fill(container.querySelector('input[type="search"]')!, "");
    expect(active()).toBe("Personalities · Experimental"); expect(draft.value).toBe("Unsaved voice");
    expect(owner.mounted.mock.calls.map(([name]) => name)).toEqual(["Appearance owner", "Personality owner"]);
    expect(owner.unmounted).not.toHaveBeenCalled();
  });
  it("moves keyboard focus without implicit activation and binds the panel to its tab", async () => {
    await render();
    await act(async () => { tab("Appearance").focus(); tab("Appearance").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    await vi.waitFor(() => expect(document.activeElement).toBe(tab("Personalities · Experimental")));
    expect(active()).toBe("Appearance");
    expect(owner.mounted.mock.calls.map(([name]) => name)).toEqual(["Appearance owner"]);
    await activate("Personalities · Experimental");
    const panel = document.getElementById(tab("Personalities · Experimental").getAttribute("aria-controls")!)!;
    expect(panel.getAttribute("role")).toBe("tabpanel"); expect(panel.hasAttribute("hidden")).toBe(false);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Personalities · Experimental").id);
    await act(async () => tab("Personalities · Experimental").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    await vi.waitFor(() => expect(document.activeElement).toBe(tab("Appearance")));
    expect(active()).toBe("Personalities · Experimental");
    expect(container.querySelector('[role="tablist"]')?.classList.contains("overflow-x-auto")).toBe(true);
    expect(container.querySelector('[role="tablist"]')?.classList.contains("max-w-full")).toBe(true);
  });
  it("restores exact section on Back and hash changes while supporting existing section routes", async () => {
    await render("/settings/personalities?shell=cockpit"); expect(active()).toBe("Personalities · Experimental");
    await activate("Appearance"); await activate("Personalities · Experimental");
    await act(async () => window.history.back());
    await vi.waitFor(() => expect(active()).toBe("Appearance"));
    await act(async () => { window.location.hash = "work-personality"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    expect(active()).toBe("Personalities · Experimental"); expect(owner.unmounted).not.toHaveBeenCalled();
  });
  it("keeps all grouped owner destinations in ordered tabs and preserves explicit detailed links", async () => {
    const pages = buildSettingsIndex(); expect(pages.flatMap((page) => page.entries)).toHaveLength(25);
    for (const page of pages) {
      window.history.replaceState(null, "", `/settings/${page.id}?shell=cockpit`);
      await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
      await act(async () => root.render(settingsView()));
      expect([...container.querySelectorAll('[role="tab"]')].map((item) => item.textContent)).toEqual(page.entries.filter(entry => entry.discoverable).map((entry) => `${entry.tabLabel ?? entry.label}${entry.releaseStatus === "experimental" ? " · Experimental" : ""}`));
      for (const entry of page.entries.filter((item) => item.destination === "detailed")) expect(container.querySelector(`a[href="${entry.href}"]`)).not.toBeNull();
    }
    expect(selectedSettingsSection(pages.find((page) => page.id === "safety")!, "safety", "approval-mode")).toBe("tools");
    expect(selectedSettingsSection(pages[0]!, "general", "application-updates")).toBe("general");
  });
});

it.each(["/settings/unknown?shell=cockpit", "/settings/general?shell=cockpit#unknown"]) ("does not silently substitute another panel for %s", async (href) => {
 await render(href);
 expect(container.textContent).toContain("Settings destination unavailable");
 expect(container.querySelector('[aria-label="Appearance owner retained draft"]')).toBeNull();
});
