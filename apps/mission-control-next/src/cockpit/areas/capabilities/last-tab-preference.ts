import { CAPABILITIES_TABS, type CapabilitiesTabId } from "./capabilities-tabs";

/**
 * The Capabilities tab opened last, remembered in this browser so plain `/capabilities` returns to it. It is a
 * cockpit-local presentation preference (no shared ui-preferences field fits), so a storage failure falls back to
 * Connectors without an error.
 */
const STORAGE_KEY = "goatcitadel.cockpit.capabilities.last-tab.v1";

/** The remembered tab, or undefined when none was saved, storage is unavailable or the saved value names no tab. */
export function readLastCapabilitiesTab(): CapabilitiesTabId | undefined {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return CAPABILITIES_TABS.find((tab) => tab.id === stored)?.id;
  } catch {
    return undefined;
  }
}

/** Remembers the tab. When storage is unavailable the choice still applies for this visit. */
export function writeLastCapabilitiesTab(tab: CapabilitiesTabId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, tab);
  } catch {
    return;
  }
}
