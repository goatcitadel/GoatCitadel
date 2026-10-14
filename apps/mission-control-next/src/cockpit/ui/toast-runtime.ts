import type { toast } from "sonner";
type ToastRuntime = typeof toast;
type Delivery = { show: (runtime: ToastRuntime) => void; current: () => boolean };
let requested = false;
let host: { owner: object; runtime: ToastRuntime } | undefined;
const pending: Delivery[] = [];
const listeners = new Set<() => void>();
function deliver(row: Delivery, runtime: ToastRuntime) {
  try {
    if (row.current()) row.show(runtime);
  } catch {
    /* The retained Inbox record remains available. */ return;
  }
}
export function requestCockpitToast(show: Delivery["show"], current: Delivery["current"]) {
  if (!current()) return;
  const row = { show, current };
  if (host) {
    deliver(row, host.runtime);
    return;
  }
  pending.push(row);
  if (!requested) {
    requested = true;
    for (const listener of listeners) listener();
  }
}
export function subscribeCockpitToastRuntime(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function cockpitToastRuntimeRequested() {
  return requested;
}
/** The host attaches after its child renderer subscribes, so the first notification cannot be lost. */
export function attachCockpitToastHost(runtime: ToastRuntime) {
  const owner = {};
  host = { owner, runtime };
  for (const row of pending.splice(0)) deliver(row, runtime);
  return () => {
    if (host?.owner === owner) host = undefined;
  };
}
export function resetCockpitToastRuntimeForTests() {
  requested = false;
  host = undefined;
  pending.length = 0;
}
