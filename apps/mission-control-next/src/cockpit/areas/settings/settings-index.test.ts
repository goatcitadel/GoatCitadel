import { describe, expect, it } from "vitest";
import { RAIL_GROUPS, RAIL_ITEMS, getRouteReleaseScope, isPrimaryRailRoute } from "../../../app/route-model";
import { buildSettingsIndex, searchSettingsPages } from "./settings-index";
import { buildSettingsDestinations } from "./settings-destinations";

describe("cockpit settings index", () => {
  it("names Citadel pages plain name first, with unchanged slugs", () => {
    const citadel = buildSettingsIndex().find((page) => page.id === "citadel")!;
    const labels = Object.fromEntries(citadel.entries.map((entry) => [entry.section, entry.label]));
    expect(labels).toMatchObject({
      "citadel-overview": "Citadel overview",
      citadel: "Guided setup · Mason",
      "citadel-wards": "Rules · Wards",
      "citadel-council": "Agents · Council",
      "citadel-vault": "Secrets · Vault",
      "citadel-blueprint": "Export/import · Blueprint",
    });
    expect(citadel.entries.find((entry) => entry.section === "citadel-wards")?.href).toBe(
      "/settings/citadel#citadel-wards",
    );
  });
  it("keeps the seven route groups and every grouped setting reachable", () => {
    const pages = buildSettingsIndex({ discovery: true });
    expect(pages.map((page) => page.label)).toEqual([
      "General",
      "Models",
      "Connections",
      "Safety",
      "Citadel",
      "Access",
      "Advanced",
    ]);
    expect(pages.every((page) => page.entries.length > 0)).toBe(true);
    expect(pages.flatMap((page) => page.entries)).toHaveLength(
      (RAIL_GROUPS.settings ?? []).reduce(
        (total, group) =>
          total +
          group.sections.filter((section) =>
            isPrimaryRailRoute(
              (RAIL_ITEMS.settings.find((item) => item.section === section) ??
                RAIL_ITEMS.library.find((item) => item.section === section))!,
            ),
          ).length,
        0,
      ),
    );
    expect(pages.flatMap((page) => page.entries).find((entry) => entry.section === "providers")).toMatchObject({
      href: "/settings/models#providers",
      completeNative: true,
    });
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/first-run")).toBe(true);
    expect(
      pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/safety#permission-profile"),
    ).toBe(true);
    expect(
      pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/general#work-personality"),
    ).toBe(true);
    expect(pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/access#device-access")).toBe(
      true,
    );
    expect(
      pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/citadel#workspace-directory"),
    ).toBe(true);
    expect(
      pages
        .flatMap((page) => page.entries)
        .some((entry) => entry.href === "/settings/connections#integration-connections"),
    ).toBe(true);
    expect(
      pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/connections#mcp-servers"),
    ).toBe(true);
    expect(pages.flatMap((page) => page.entries).find((entry) => entry.section === "channels")).toMatchObject({
      href: "/settings/connections#channels",
    });
    expect(pages.flatMap((page) => page.entries).find((entry) => entry.section === "citadel-blueprint")).toMatchObject({
      href: "/settings/citadel#citadel-blueprint",
      completeNative: true,
    });
    expect(
      pages.flatMap((page) => page.entries).some((entry) => entry.href === "/settings/advanced#managed-runtime"),
    ).toBe(true);
    expect(pages.flatMap((page) => page.entries).find((entry) => entry.section === "citadel-overview")).toMatchObject({
      href: "/settings/citadel#citadel-overview",
      completeNative: true,
    });
  });

  it("finds a setting by label or description across groups", () => {
    const pages = buildSettingsIndex();
    expect(searchSettingsPages(pages, "provider").map((page) => page.label)).toEqual(["Models"]);
    // ST-09: notification routing lives beside General › Attention, so search sends it there and only there.
    expect(searchSettingsPages(pages, "notification routing").map((page) => page.label)).toEqual(["General"]);
    expect(
      searchSettingsPages(pages, "routing").flatMap((page) => page.entries.map((entry) => entry.section)),
    ).not.toContain("integrations");
    expect(
      searchSettingsPages(pages, "scoped allow")
        .flatMap((page) => page.entries)
        .map((entry) => entry.label),
    ).toEqual(["Tools"]);
  });

  it.each([
    ["desktop system permission", "General"],
    ["archive restore", "Workspaces"],
    ["operator actions", "Integrations"],
    ["select activate chat", "Permissions"],
    ["signing", "Hooks"],
    ["basic password", "Access & devices"],
    ["voice transcription", "Runtime configuration"],
    ["write root", "Tools"],
    ["temp cleanup", "Tools"],
    ["fs.delete", "Tools"],
  ])("finds actual control terms %s on their native Cockpit owner", (term, label) => {
    const entries = searchSettingsPages(buildSettingsIndex(), term).flatMap((page) => page.entries);
    expect(entries.find((entry) => entry.label === label)?.href).toMatch(/^\/settings\/[a-z-]+(#[a-z-]+)?$/u);
  });
});

it("keeps hidden destinations direct-only and labels the discoverable experimental exception", () => {
  const direct = buildSettingsIndex();
  const entries = buildSettingsIndex({ discovery: true }).flatMap((page) => page.entries);
  expect(direct.flatMap((page) => page.entries).some((entry) => entry.section === "workspace-capabilities")).toBe(true);
  expect(
    entries.some((entry) => entry.section === "workspace-capabilities" || entry.section === "citadel-capabilities"),
  ).toBe(false);
  expect(entries.find((entry) => entry.section === "personalities")?.releaseStatus).toBe("experimental");
  expect(searchSettingsPages(buildSettingsIndex({ discovery: true }), "workspace skills")).toEqual([]);
});

describe("cold Settings destination projection", () => {
  it.each([false, true])("matches every full index destination with discovery=%s", (discovery) => {
    const destinations = buildSettingsDestinations({ discovery });
    const fullPages = buildSettingsIndex({ discovery });
    expect(destinations.map((page) => page.label)).toEqual([
      "General",
      "Models",
      "Connections",
      "Safety",
      "Citadel",
      "Access",
      "Advanced",
    ]);
    expect(destinations.flatMap((page) => page.entries)).toHaveLength(discovery ? 22 : 25);
    expect(
      fullPages.map((page) => ({
        ...page,
        entries: page.entries.map(
          ({ searchTerms: _searchTerms, releaseNote: _releaseNote, ...destination }) => destination,
        ),
      })),
    ).toStrictEqual(destinations);

    for (const page of fullPages) {
      for (const entry of page.entries) {
        const item =
          RAIL_ITEMS.settings.find((candidate) => candidate.section === entry.section) ??
          RAIL_ITEMS.library.find((candidate) => candidate.section === entry.section);
        expect(item, entry.section).toBeDefined();
        expect(entry.releaseNote, entry.section).toBe(getRouteReleaseScope(item!).note);
        expect(typeof entry.searchTerms, entry.section).toBe("string");
      }
    }
    for (const entry of destinations.flatMap((page) => page.entries)) {
      expect(entry).not.toHaveProperty("searchTerms");
      expect(entry).not.toHaveProperty("releaseNote");
    }
  });
});
