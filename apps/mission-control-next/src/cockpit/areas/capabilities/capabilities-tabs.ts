/** The Capabilities tabs. Later phases add Skills and Plugins here and widen the id type with them. */
export type CapabilitiesTabId = "connectors" | "tools";

export const CAPABILITIES_TABS: readonly { id: CapabilitiesTabId; label: string; href: string }[] = [
  { id: "connectors", label: "Connectors", href: "/capabilities/connectors" },
  { id: "tools", label: "Tools", href: "/capabilities/tools" },
];

/** The tab plain `/capabilities` opens on a first visit, before any tab has been remembered. */
export const DEFAULT_TAB: CapabilitiesTabId = "connectors";

/** The tab the path segments after `/capabilities` name, or undefined for plain `/capabilities` and for a segment that is not a tab. */
export function namedCapabilitiesTab(rest: readonly string[]): CapabilitiesTabId | undefined {
  return CAPABILITIES_TABS.find((tab) => tab.id === rest[0])?.id;
}

/**
 * Reads the tab from the path segments after `/capabilities`. Plain `/capabilities` and any segment that is not a tab
 * read as Connectors. This only reads the path: the area decides whether a remembered tab replaces that default, and
 * rewrites the address when it does.
 */
export function readCapabilitiesTab(rest: readonly string[]): CapabilitiesTabId {
  return namedCapabilitiesTab(rest) ?? DEFAULT_TAB;
}

export function capabilitiesTabHref(id: CapabilitiesTabId): string {
  return CAPABILITIES_TABS.find((tab) => tab.id === id)?.href ?? "/capabilities";
}
