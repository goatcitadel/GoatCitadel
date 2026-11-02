import { describe, expect, it } from "vitest";
import { inboxApprovalHref } from "../capability-links";
import { connectorIdFromSource, connectorPanelSource } from "../connectors/connector-links";
import {
  installIdFromSearch,
  installKeyFromSource,
  skillIdFromSearch,
  skillIdFromSource,
  skillInstallSource,
  skillPanelSource,
} from "../skills/skill-links";
import { toolGroupIdFromSearch, toolGroupIdFromSource, toolPanelSource } from "../tools/tool-links";
import {
  PLUGIN_INSTALL_SOURCE_PREFIX,
  PLUGIN_PANEL_SOURCE_PREFIX,
  PLUGINS_HREF,
  pluginIdFromSearch,
  pluginIdFromSource,
  pluginInboxApprovalHref,
  pluginInboxApprovalLink,
  pluginInspectionIdFromSearch,
  pluginInstallItemHref,
  pluginInstallKeyFromSource,
  pluginInstallSource,
  pluginItemHref,
  pluginPanelSource,
  pluginSourceFromSearch,
  pluginSourceItemHref,
} from "./plugin-links";

const searchOf = (href: string) => href.slice(href.indexOf("?"));

describe("plugin addresses", () => {
  it("builds plugin addresses that never use the Connectors prefix", () => {
    expect(PLUGINS_HREF).toBe("/capabilities/plugins");
    // A plugin's panel and an install panel each have an `?item=` part and an inspector source of their own.
    expect(pluginItemHref("browser-checks")).toBe("/capabilities/plugins?item=plugin%3Abrowser-checks");
    expect(pluginInstallItemHref("4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f")).toBe(
      "/capabilities/plugins?item=plugin-install%3A4b5c3a3e-6f0e-4c1d-9a7e-2f1b0c9d8e7f",
    );
    expect(PLUGIN_PANEL_SOURCE_PREFIX).toBe("capabilities-plugins:");
    expect(PLUGIN_INSTALL_SOURCE_PREFIX).toBe("capabilities-plugin-install:");
    // The Connectors tab reads every source that starts with `capabilities:` as one of its connectors.
    for (const prefix of [PLUGIN_PANEL_SOURCE_PREFIX, PLUGIN_INSTALL_SOURCE_PREFIX]) {
      expect(prefix.startsWith("capabilities:"), prefix).toBe(false);
      expect(connectorIdFromSource(`${prefix}browser-checks`), prefix).toBeNull();
    }
    expect(connectorIdFromSource(pluginPanelSource("browser-checks"))).toBeNull();
    expect(connectorIdFromSource(pluginInstallSource("browser-checks"))).toBeNull();
    // Nor does a plugin source read as a skill's, an install's or a tool group's, or the other way round.
    for (const source of [pluginPanelSource("files"), pluginInstallSource("files")]) {
      expect(skillIdFromSource(source), source).toBeUndefined();
      expect(installKeyFromSource(source), source).toBeUndefined();
      expect(toolGroupIdFromSource(source), source).toBeUndefined();
    }
    for (const source of [
      connectorPanelSource("files"),
      skillPanelSource("files"),
      skillInstallSource("files"),
      toolPanelSource("files"),
    ]) {
      expect(pluginIdFromSource(source), source).toBeUndefined();
      expect(pluginInstallKeyFromSource(source), source).toBeUndefined();
    }
  });

  it("reads each item back, and never one for the other", () => {
    expect(pluginIdFromSearch(searchOf(pluginItemHref("browser-checks")))).toBe("browser-checks");
    expect(pluginIdFromSearch("?workspaceId=w&item=plugin:browser-checks&shell=cockpit")).toBe("browser-checks");
    const install = searchOf(pluginInstallItemHref("i-1"));
    expect(pluginInspectionIdFromSearch(install)).toBe("i-1");
    // `plugin:` and `plugin-install:` never read as each other.
    expect(pluginIdFromSearch(install)).toBeUndefined();
    expect(pluginInspectionIdFromSearch(searchOf(pluginItemHref("browser-checks")))).toBeUndefined();
    // Nor as another tab's item.
    for (const item of [searchOf(pluginItemHref("files")), install]) {
      expect(skillIdFromSearch(item), item).toBeUndefined();
      expect(installIdFromSearch(item), item).toBeUndefined();
      expect(toolGroupIdFromSearch(item), item).toBeUndefined();
    }
    expect(pluginIdFromSearch("?item=skill%3Afiles")).toBeUndefined();
    expect(pluginIdFromSearch("?item=group%3Afiles")).toBeUndefined();
  });

  it("encodes an id that is not safe in an address, and reads it back", () => {
    const href = pluginItemHref("a b/c&d");
    expect(href).toBe("/capabilities/plugins?item=plugin%3Aa%20b%2Fc%26d");
    expect(pluginIdFromSearch(searchOf(href))).toBe("a b/c&d");
    expect(pluginInspectionIdFromSearch(searchOf(pluginInstallItemHref("x&y")))).toBe("x&y");
  });

  it("names the form each source button opens, and never reads it as a plugin or an install", () => {
    expect(pluginSourceItemHref("git")).toBe("/capabilities/plugins?item=plugin-source%3Agit");
    expect(pluginSourceItemHref("folder")).toBe("/capabilities/plugins?item=plugin-source%3Afolder");
    expect(pluginSourceFromSearch(searchOf(pluginSourceItemHref("git")))).toBe("git");
    expect(pluginSourceFromSearch("?workspaceId=w&item=plugin-source:folder")).toBe("folder");
    for (const kind of ["git", "folder"] as const) {
      const search = searchOf(pluginSourceItemHref(kind));
      expect(pluginIdFromSearch(search), kind).toBeUndefined();
      expect(pluginInspectionIdFromSearch(search), kind).toBeUndefined();
      expect(skillIdFromSearch(search), kind).toBeUndefined();
      expect(installIdFromSearch(search), kind).toBeUndefined();
      expect(toolGroupIdFromSearch(search), kind).toBeUndefined();
    }
    // Only the two forms there are; a plugin's or an install's item is neither.
    expect(pluginSourceFromSearch("?item=plugin-source%3Azip")).toBeUndefined();
    expect(pluginSourceFromSearch(searchOf(pluginItemHref("git")))).toBeUndefined();
    expect(pluginSourceFromSearch(searchOf(pluginInstallItemHref("git")))).toBeUndefined();
  });

  it.each([
    [undefined],
    [""],
    ["?item="],
    ["?item=plugin%3A"],
    ["?item=plugin-install%3A"],
    ["?item=plugin-source%3A"],
    ["?view=x"],
  ])("reads no item from %j", (search) => {
    expect(pluginIdFromSearch(search)).toBeUndefined();
    expect(pluginInspectionIdFromSearch(search)).toBeUndefined();
    expect(pluginSourceFromSearch(search)).toBeUndefined();
  });

  it("names each panel behind its prefix and reads it back", () => {
    expect(pluginPanelSource("browser-checks")).toBe("capabilities-plugins:browser-checks");
    expect(pluginIdFromSource(pluginPanelSource("browser-checks"))).toBe("browser-checks");
    expect(pluginInstallSource("draft:git")).toBe("capabilities-plugin-install:draft:git");
    expect(pluginInstallKeyFromSource(pluginInstallSource("draft:git"))).toBe("draft:git");
    // The two prefixes share their start but neither reads the other's.
    expect(pluginIdFromSource(pluginInstallSource("browser-checks"))).toBeUndefined();
    expect(pluginInstallKeyFromSource(pluginPanelSource("browser-checks"))).toBeUndefined();
  });

  it.each([[undefined], [""], ["capabilities-plugins:"], ["capabilities-plugin-install:"], ["browser-checks"]])(
    "reads no panel from %j",
    (source) => {
      expect(pluginIdFromSource(source)).toBeUndefined();
      expect(pluginInstallKeyFromSource(source)).toBeUndefined();
    },
  );
});

describe("a plugin's Inbox link", () => {
  it("opens the approval in the workspace the plugin's plan was made in, not always the default one", () => {
    const target = new URL(pluginInboxApprovalHref("approval-1", "lab"), "http://localhost");
    expect(target.pathname).toBe("/inbox");
    expect(target.searchParams.get("approvalId")).toBe("approval-1");
    expect(target.searchParams.get("workspaceId")).toBe("lab");
    expect(pluginInboxApprovalHref("a b&c", "w x")).toBe("/inbox?approvalId=a%20b%26c&workspaceId=w%20x");
    // In the default workspace it is the same link the other tabs use.
    expect(pluginInboxApprovalHref("approval-1", "default")).toBe(inboxApprovalHref("approval-1"));
  });

  it("names the link by its destination", () => {
    expect(pluginInboxApprovalLink("approval-1", "lab")).toEqual({
      label: "Open in Inbox",
      href: "/inbox?approvalId=approval-1&workspaceId=lab",
    });
  });
});
