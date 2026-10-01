import { useEffect, useState } from "react";

const COMPOSER_KILL_SWITCH_KEY = "mc-next:composer-v2";
const COMPOSER_KILL_SWITCH_FALSE_VALUES = new Set(["off", "false", "0", "no", "disabled"]);
function readComposerV2(): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    const value = window.localStorage.getItem(COMPOSER_KILL_SWITCH_KEY)?.trim().toLowerCase();
    return !value || !COMPOSER_KILL_SWITCH_FALSE_VALUES.has(value);
  } catch {
    return true;
  }
}

export function useComposerV2Enabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => readComposerV2());
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    const eventTarget = window;
    const handle = () => setEnabled(readComposerV2());
    eventTarget.addEventListener("storage", handle);
    return () => eventTarget.removeEventListener("storage", handle);
  }, []);
  return enabled;
}
