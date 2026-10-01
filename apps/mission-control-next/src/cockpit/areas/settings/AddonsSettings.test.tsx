import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonCatalogEntry, AddonStatusRecord } from "@goatcitadel/contracts";
import { AddonsSettings } from "./AddonsSettings";
import { AddonCommands } from "./AddonEvidence";
import { Dialog } from "../../ui/Dialog";
import { __resetAddonAttemptsForTests } from "../../../features/native-routes/settings/sections/addon-lifecycle";
import { __resetSessionViewStateForTests } from "../../../hooks/use-session-view-state";

const api = vi.hoisted(() => ({
  fetchAddonsCatalog: vi.fn(),
  fetchAddonStatus: vi.fn(),
  fetchInstalledAddons: vi.fn(),
  installAddon: vi.fn(),
  updateAddon: vi.fn(),
  enableAddon: vi.fn(),
  disableAddon: vi.fn(),
  launchAddon: vi.fn(),
  stopAddon: vi.fn(),
  uninstallAddon: vi.fn(),
}));
vi.mock("@goatcitadel/mission-control-shared/api/client", () => api);
vi.mock("../../ui/Dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? <section role="dialog">{children}</section> : null,
}));
vi.mock("@goatcitadel/mission-control-shared/api/client-core", () => ({
  getGatewayApiBaseUrl: () => "http://addon-fixture",
}));
const addon: AddonCatalogEntry = {
  addonId: "arena",
  label: "Fixture Arena",
  description: "Optional host application",
  owner: "fixture-owner",
  repoUrl: "https://fixture.invalid/addon-repository",
  sameOwnerAsGoatCitadel: false,
  trustTier: "community",
  category: "fun_optional",
  runtimeType: "separate_repo_app",
  installCommands: [
    { command: "git", args: ["checkout", "a".repeat(40)], note: "Pinned fixture" },
    { command: "corepack", args: ["pnpm", "install", "--frozen-lockfile"] },
  ],
  webEntryMode: "external_local_url",
  requiresSeparateRepoDownload: true,
  healthChecks: [{ key: "fixture", status: "pass", message: "Catalog fixture" }],
};
const stamp = "2026-09-30T12:00:00.000Z";
function record(state: AddonStatusRecord["status"]): AddonStatusRecord {
  return {
    addon,
    status: state,
    healthChecks: [
      { key: "runtime", status: state === "running" ? "pass" : "warn", message: "Recorded fixture status" },
    ],
    ...(state === "not_installed"
      ? {}
      : {
          installed: {
            addonId: addon.addonId,
            installedPath: "C:\\fixture\\addons\\arena",
            repoUrl: addon.repoUrl,
            owner: addon.owner,
            sameOwnerAsGoatCitadel: addon.sameOwnerAsGoatCitadel,
            trustTier: addon.trustTier,
            runtimeType: addon.runtimeType,
            webEntryMode: addon.webEntryMode,
            installedAt: stamp,
            updatedAt: stamp,
            consentedAt: stamp,
            consentedBy: "fixture-operator",
            installRef: "a".repeat(40),
            enabled: state !== "disabled",
            runtimeStatus: state,
            ...(state === "running" ? { pid: 12345 } : {}),
          },
        }),
  };
}
let root: ReactTestRenderer, current: AddonStatusRecord;
const text = (node: ReactTestInstance): string =>
  node.children.map((child) => (typeof child === "string" ? child : text(child))).join(" ");
function button(label: string) {
  const found = root.root.findAllByType("button").find((item) => text(item).replace(/\s+/g, " ").trim() === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
function reviewDialog() {
  const found = root.root.findAllByType(Dialog).find((item) => item.props.open);
  if (!found) throw new Error("No open review");
  return found;
}
async function mountSelected() {
  await act(async () => {
    root = create(<AddonsSettings />);
  });
  await act(async () => button(addon.label).props.onClick());
}
beforeEach(() => {
  vi.resetAllMocks();
  __resetAddonAttemptsForTests();
  __resetSessionViewStateForTests();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No live add-on transport");
    }),
  );
  current = record("not_installed");
  api.fetchAddonsCatalog.mockResolvedValue({ items: [addon] });
  api.fetchInstalledAddons.mockImplementation(async () => ({
    items: current.installed ? [structuredClone(current.installed)] : [],
  }));
  api.fetchAddonStatus.mockImplementation(async () => structuredClone(current));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  vi.unstubAllGlobals();
});
describe("native add-on owner presentation", () => {
  it("shows exact catalog/status evidence and installation review including every repository command", async () => {
    await mountSelected();
    expect(text(root.root)).toContain("not installed");
    expect(text(root.root)).toContain("Recorded fixture status");
    expect(button("Review install").props.disabled).toBe(false);
    for (const action of ["enable", "disable", "launch", "stop", "update", "uninstall"])
      expect(button(`Review ${action}`).props.disabled).toBe(true);
    await act(async () => button("Review install").props.onClick());
    const review = reviewDialog();
    expect(review.props.title).toBe("Review install: Fixture Arena");
    expect(review.props.description).toContain(addon.repoUrl);
    expect(review.props.description).toContain("install dependencies, and run its build commands");
    expect(review.props.description).toContain("starts disabled");
    expect(review.findByType(AddonCommands).props.addon).toEqual(addon);
    expect(api.installAddon).not.toHaveBeenCalled();
    await act(async () => review.props.onOpenChange(false));
    expect(api.installAddon).not.toHaveBeenCalled();
  });
  it("retains an unknown host action lock across native remount instead of offering another installation", async () => {
    await mountSelected();
    await act(async () => button("Review install").props.onClick());
    api.installAddon.mockRejectedValueOnce(new Error("Transport result unavailable"));
    await act(async () => button("Apply reviewed add-on action").props.onClick());
    expect(api.installAddon).toHaveBeenCalledExactlyOnceWith("arena", {
      confirmRepoDownload: true,
      actorId: "operator",
    });
    expect(text(root.root)).toContain("outcome is uncertain");
    await act(async () => root.unmount());
    await act(async () => {
      root = create(<AddonsSettings />);
    });
    expect(button("Review install").props.disabled).toBe(true);
    await act(async () => button("Refresh add-on evidence").props.onClick());
    expect(button("Review install").props.disabled).toBe(true);
    expect(api.installAddon).toHaveBeenCalledOnce();
  });
  it("uses owner lifecycle eligibility for installed disabled and running records", async () => {
    current = record("disabled");
    await mountSelected();
    for (const action of ["enable", "update", "uninstall"])
      expect(button(`Review ${action}`).props.disabled).toBe(false);
    for (const action of ["install", "disable", "launch", "stop"])
      expect(button(`Review ${action}`).props.disabled).toBe(true);
    current = record("running");
    await act(async () => button("Refresh add-on evidence").props.onClick());
    for (const action of ["disable", "stop", "uninstall"])
      expect(button(`Review ${action}`).props.disabled).toBe(false);
    for (const action of ["install", "enable", "launch", "update"])
      expect(button(`Review ${action}`).props.disabled).toBe(true);
    expect(api.launchAddon).not.toHaveBeenCalled();
  });
  it("renders confirmed enable only after the real shared owner's receipt and independent readback", async () => {
    current = record("disabled");
    await mountSelected();
    api.enableAddon.mockImplementation(async () => {
      current = record("stopped");
      return { status: structuredClone(current) };
    });
    await act(async () => button("Review enable").props.onClick());
    expect(api.enableAddon).not.toHaveBeenCalled();
    await act(async () => button("Apply reviewed add-on action").props.onClick());
    expect(api.enableAddon).toHaveBeenCalledExactlyOnceWith("arena");
    expect(text(root.root)).toContain("enable confirmed by the Gateway receipt and independent readback");
    expect(button("Review launch").props.disabled).toBe(false);
    expect(button("Review enable").props.disabled).toBe(true);
    expect(api.launchAddon).not.toHaveBeenCalled();
  });
  it("does not offer actions when selected owner status cannot be read", async () => {
    api.fetchAddonStatus.mockRejectedValue(new Error("Owner unavailable"));
    await mountSelected();
    expect(text(root.root)).toContain("Selected add-on status unavailable");
    expect(root.root.findAllByType("button").some((item) => text(item).includes("Review install"))).toBe(false);
  });
});
