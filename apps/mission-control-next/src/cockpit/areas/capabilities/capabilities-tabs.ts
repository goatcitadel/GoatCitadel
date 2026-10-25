/** The Capabilities tabs. Later phases add Skills, Plugins and Tools here and widen the id type with them. */
export type CapabilitiesTabId = "connectors";

export const CAPABILITIES_TABS: readonly { id: CapabilitiesTabId; label: string; href: string }[] = [
  { id: "connectors", label: "Connectors", href: "/capabilities/connectors" },
];

const DEFAULT_TAB: CapabilitiesTabId = "connectors";

/**
 * Reads the tab from the path segments after `/capabilities`. Plain `/capabilities` and any segment that is not a tab
 * show Connectors, without rewriting the address.
 */
export function readCapabilitiesTab(rest: readonly string[]): CapabilitiesTabId {
  return CAPABILITIES_TABS.find((tab) => tab.id === rest[0])?.id ?? DEFAULT_TAB;
}
