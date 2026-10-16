import { useCallback, useState } from "react";

/**
 * Whether the Inbox's single-letter shortcuts are on, remembered in this browser. It is a cockpit-local presentation
 * preference (no shared ui-preferences field fits), so storage failures fall back to the default without an error.
 */
const STORAGE_KEY = "goatcitadel.cockpit.inbox.letter-shortcuts.v1";

function readStored(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Returns whether the choice was saved; when storage is unavailable it still applies for this visit. */
function writeStored(enabled: boolean): boolean {
  try {
    if (enabled) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, "off");
    return true;
  } catch {
    return false;
  }
}

export function useInboxShortcutsPreference() {
  const [enabled, setEnabledState] = useState(readStored);
  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeStored(next);
  }, []);
  return [enabled, setEnabled] as const;
}
