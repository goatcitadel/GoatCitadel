/** True on Apple platforms, where the command key replaces Ctrl in cockpit shortcuts. */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
  return /mac|iphone|ipad|ipod/i.test(hinted || navigator.platform || "");
}

/** Shortcut text for the operator's platform, for example "⌘K" on macOS and "Ctrl K" elsewhere. */
export function shortcutLabel(key: string): string {
  return isApplePlatform() ? `⌘${key.toUpperCase()}` : `Ctrl ${key.toUpperCase()}`;
}
