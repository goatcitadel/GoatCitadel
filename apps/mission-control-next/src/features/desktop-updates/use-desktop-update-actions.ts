import { useSyncExternalStore } from "react";
import type { DesktopUpdateChannel, DesktopUpdateRequest, DesktopUpdateStatus } from "@goatcitadel/contracts";
import { requestDesktopUpdate } from "./desktop-update-bridge";

const listeners = new Set<() => void>();
let state = { pending: false, uncertain: false, error: null as string | null };
function update(next: typeof state) {
  state = next;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Shared app-session presentation lock; installed-host status remains authoritative. */
export function useDesktopUpdateActions(status: DesktopUpdateStatus | null) {
  const snapshot = useSyncExternalStore(subscribe, () => state, () => state);
  const busy = snapshot.pending || status?.phase === "checking" || status?.phase === "downloading";
  async function act(action: DesktopUpdateRequest["action"], channel?: DesktopUpdateChannel) {
    if (state.pending || busy || !status || (state.uncertain && action !== "check")) return;
    update({ ...state, pending: true, error: null });
    try {
      await requestDesktopUpdate(action, { channel, releaseTag: status.availableRelease?.tag });
      update({ pending: false, uncertain: false, error: null });
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "The update action failed.";
      update({ pending: false, uncertain: true,
        error: `${detail} Check for updates to refresh host status before another action.` });
    }
  }
  return { act, busy, error: snapshot.error, uncertain: snapshot.uncertain };
}

export function __resetDesktopUpdateActionsForTests() {
  update({ pending: false, uncertain: false, error: null });
}
