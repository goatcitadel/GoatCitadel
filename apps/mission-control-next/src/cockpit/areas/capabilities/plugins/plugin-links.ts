import type { InboxLink } from "../capability-links";

/** The Plugins tab, without a panel open. */
export const PLUGINS_HREF = "/capabilities/plugins";

/** The part of `?item=` that names a plugin: `plugin:<plugin id>`. */
const ITEM_PREFIX = "plugin:";
/** The part of `?item=` that names an install panel: `plugin-install:<inspection id>`. It never reads as a plugin's. */
const INSTALL_ITEM_PREFIX = "plugin-install:";

function itemFromSearch(search: string | undefined, prefix: string): string | undefined {
  const item = new URLSearchParams(search ?? "").get("item");
  const id = item?.startsWith(prefix) ? item.slice(prefix.length) : "";
  return id || undefined;
}

/** The address that opens one plugin's panel: every "From <plugin>" link in the other tabs points here. */
export function pluginItemHref(pluginId: string): string {
  return `${PLUGINS_HREF}?item=${encodeURIComponent(`${ITEM_PREFIX}${pluginId}`)}`;
}

/**
 * The plugin an address names with `?item=plugin:<id>`, or undefined for anything else (an install panel's item and
 * another tab's included). Whether the loaded list holds the plugin is for the list to say.
 */
export function pluginIdFromSearch(search: string | undefined): string | undefined {
  return itemFromSearch(search, ITEM_PREFIX);
}

/** The address that opens the install panel of one inspection. */
export function pluginInstallItemHref(inspectionId: string): string {
  return `${PLUGINS_HREF}?item=${encodeURIComponent(`${INSTALL_ITEM_PREFIX}${inspectionId}`)}`;
}

/** The inspection an address names with `?item=plugin-install:<id>`, or undefined for anything else. */
export function pluginInspectionIdFromSearch(search: string | undefined): string | undefined {
  return itemFromSearch(search, INSTALL_ITEM_PREFIX);
}

/** Where the Plugins tab's source buttons add a plugin from: a Git repository, or a folder on this computer. */
export type PluginSourceFormKind = "git" | "folder";

/** The part of `?item=` that names a source button's form: `plugin-source:git` or `plugin-source:folder`. */
const SOURCE_ITEM_PREFIX = "plugin-source:";

/** The address a source button moves to: the form that asks where to add a plugin from, before anything is checked. */
export function pluginSourceItemHref(kind: PluginSourceFormKind): string {
  return `${PLUGINS_HREF}?item=${encodeURIComponent(`${SOURCE_ITEM_PREFIX}${kind}`)}`;
}

/** The form an address names with `?item=plugin-source:<git|folder>`, or undefined for anything else. */
export function pluginSourceFromSearch(search: string | undefined): PluginSourceFormKind | undefined {
  const kind = itemFromSearch(search, SOURCE_ITEM_PREFIX);
  return kind === "git" || kind === "folder" ? kind : undefined;
}

/**
 * The inspector source of a plugin's panel. It must never start with the Connectors panel's `capabilities:`: the
 * Connectors tab reads every source that does as one of its connectors, and a Plugins panel would be taken for one.
 */
export const PLUGIN_PANEL_SOURCE_PREFIX = "capabilities-plugins:";

/**
 * The inspector source of an install panel. Like a plugin panel's, it must not start with `capabilities:`, and it
 * differs from the plugin panel's own prefix, so neither panel reads the other's.
 */
export const PLUGIN_INSTALL_SOURCE_PREFIX = "capabilities-plugin-install:";

function keyFromSource(source: string | undefined, prefix: string): string | undefined {
  const key = source?.startsWith(prefix) ? source.slice(prefix.length) : "";
  return key || undefined;
}

/** The inspector source of one plugin's panel. */
export function pluginPanelSource(pluginId: string): string {
  return `${PLUGIN_PANEL_SOURCE_PREFIX}${pluginId}`;
}

/** The plugin inside an inspector source, or undefined when the source is another panel's. */
export function pluginIdFromSource(source: string | undefined): string | undefined {
  return keyFromSource(source, PLUGIN_PANEL_SOURCE_PREFIX);
}

/** The inspector source of the install panel that shows `key` (an inspection id, or a check not answered yet). */
export function pluginInstallSource(key: string): string {
  return `${PLUGIN_INSTALL_SOURCE_PREFIX}${key}`;
}

/** The install panel's key inside an inspector source, or undefined for any other panel. */
export function pluginInstallKeyFromSource(source: string | undefined): string | undefined {
  return keyFromSource(source, PLUGIN_INSTALL_SOURCE_PREFIX);
}

/**
 * The Inbox page for one of a plugin's approvals, in the workspace the plugin's plans and its skills' steps were made
 * in (the plugin's `workspaceId`), which isn't always the default one the other tabs' links name.
 */
export const pluginInboxApprovalHref = (approvalId: string, workspaceId: string) =>
  `/inbox?approvalId=${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}`;

/** The link that goes with a sentence pointing to one of a plugin's approvals, named by its destination. */
export const pluginInboxApprovalLink = (approvalId: string, workspaceId: string): InboxLink => ({
  label: "Open in Inbox",
  href: pluginInboxApprovalHref(approvalId, workspaceId),
});
