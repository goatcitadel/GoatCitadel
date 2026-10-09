import { describe, expect, it } from "vitest";
import { RAIL_GROUPS, RAIL_ITEMS, isPrimaryRailRoute } from "../../../app/route-model";
import { buildSettingsIndex, searchSettingsPages } from "./settings-index";

describe("cockpit settings index", () => {
  it("keeps the seven route groups and every grouped setting reachable", () => {
    const pages = buildSettingsIndex({ discovery: true });
    expect(pages.map((page) => page.label)).toEqual([
      "General", "Models", "Connections", "Safety", "Citadel", "Access", "Advanced",
    ]);
    expect(pages.every((page) => page.entries.length > 0)).toBe(true);
    expect(pages.flatMap((page) => page.entries)).toHaveLength(
      (RAIL_GROUPS.settings ?? []).reduce((total, group) => total + group.sections.filter(section => isPrimaryRailRoute((RAIL_ITEMS.settings.find(item => item.section === section) ?? RAIL_ITEMS.library.find(item => item.section === section))!)).length, 0),
    );
    expect(pages.flatMap((page) => page.entries).find((entry) => entry.section === "providers")).toMatchObject({ href: "/settings/models#providers", destination: "cockpit", completeNative: true });
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/first-run")).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/safety#permission-profile")).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/general#work-personality")).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/access#device-access")).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/citadel#workspace-directory")).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/connections#integration-connections")).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/connections#mcp-servers")).toBe(true);
    expect(pages.flatMap((page) => page.entries).find(entry => entry.section === "channels")).toMatchObject({ href: "/settings/connections#channels", destination: "cockpit" });
    expect(pages.flatMap((page) => page.entries).find(entry => entry.section === "citadel-blueprint")).toMatchObject({ href: "/settings/citadel#citadel-blueprint", destination: "cockpit", completeNative: true });
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/advanced#managed-runtime")).toBe(true);
    expect(pages.flatMap((page) => page.entries).find(entry => entry.section === "citadel-overview")).toMatchObject({ href: "/settings/citadel#citadel-overview", destination: "cockpit", completeNative: true });
  });

  it("finds a setting by label or description across groups", () => {
    const pages = buildSettingsIndex();
    expect(searchSettingsPages(pages, "provider").map((page) => page.label)).toEqual(["Models"]);
    expect(searchSettingsPages(pages, "scoped allow").flatMap((page) => page.entries).map((entry) => entry.label)).toEqual(["Tools"]);
  });

  it.each([
    ["desktop system permission", "General", "cockpit"],
    ["archive restore", "Workspaces", "cockpit"],
    ["operator actions", "Integrations", "cockpit"],
    ["select activate chat", "Permissions", "cockpit"],
    ["signing", "Hooks", "cockpit"],
    ["basic password", "Access & devices", "cockpit"],
    ["voice transcription", "Runtime configuration", "cockpit"],
  ])("finds actual control terms %s with an honest destination", (term, label, destination) => {
    const entries = searchSettingsPages(buildSettingsIndex(), term).flatMap((page) => page.entries);
    expect(entries.find((entry) => entry.label === label)?.destination).toBe(destination);
  });
});

it("keeps hidden destinations direct-only and labels the discoverable experimental exception", () => {
  const direct = buildSettingsIndex();
  const entries = buildSettingsIndex({ discovery: true }).flatMap(page => page.entries);
  expect(direct.flatMap(page => page.entries).some(entry => entry.section === "workspace-capabilities")).toBe(true);
  expect(entries.some(entry => entry.section === "workspace-capabilities" || entry.section === "citadel-capabilities")).toBe(false);
  expect(entries.find(entry => entry.section === "personalities")?.releaseStatus).toBe("experimental");
  expect(searchSettingsPages(buildSettingsIndex({ discovery: true }), "workspace skills")).toEqual([]);
});
