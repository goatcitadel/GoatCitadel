import { useSyncExternalStore } from "react";

/**
 * Where one plugin's uninstall stands in this app session. `asking` while a request is on its way; `following` once
 * GoatCitadel answered, while the plugin's detail is read until the plugin is gone; `stopped` when the request was
 * refused or its plan ended without uninstalling; `gone` once the detail says the plugin isn't installed.
 */
export type PluginUninstallPhase = "asking" | "following" | "stopped" | "gone";

export interface PluginUninstallEntry {
  readonly phase: PluginUninstallPhase;
  /** The workspace the plugin was installed in, where its plans and approvals live. */
  readonly workspaceId: string;
  /** The plan the last request made, while it is followed. */
  readonly planId?: string;
  /** The approval the last request's plan waits on, as GoatCitadel named it. */
  readonly approvalId?: string;
  /** GoatCitadel's own summary of the last request, shown as written. */
  readonly summary?: string;
  /** Why it stopped, in plain words. */
  readonly message?: string;
  /** The last request's attempt key, sent again only to retry a request whose answer never came. */
  readonly attemptKey?: string;
  /** The last request got no answer at all. */
  readonly lost?: boolean;
}

// One entry per plugin, kept outside any component, so closing the panel, or the install panel handing over to the
// plugin's own, loses nothing. Nothing is stored in the browser.
const entries = new Map<string, PluginUninstallEntry>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readPluginUninstall(pluginId: string): PluginUninstallEntry | undefined {
  return entries.get(pluginId);
}

/** Replaces the plugin's entry; `undefined` forgets it. */
export function setPluginUninstall(pluginId: string, next: PluginUninstallEntry | undefined) {
  if (entries.get(pluginId) === next) return;
  if (next) entries.set(pluginId, next);
  else entries.delete(pluginId);
  for (const listener of listeners) listener();
}

export function usePluginUninstallEntry(pluginId: string | undefined): PluginUninstallEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (pluginId === undefined ? undefined : entries.get(pluginId)),
    () => undefined,
  );
}

export function __resetPluginUninstallsForTests() {
  entries.clear();
  for (const listener of listeners) listener();
}
