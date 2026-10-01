import { useSyncExternalStore } from "react";
import type { DemoBootstrapResponse } from "@goatcitadel/contracts";
// Public sample-data receipt only. Preserve partial notes across shell/navigation changes.
const receipts = new Map<string, DemoBootstrapResponse>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useDemoReceipt(base: string) {
  return useSyncExternalStore(
    subscribe,
    () => receipts.get(base),
    () => undefined,
  );
}
export function recordDemoReceipt(base: string, receipt: DemoBootstrapResponse) {
  receipts.set(base, structuredClone(receipt));
  for (const listener of listeners) listener();
}
export function __resetDemoReceiptsForTests() {
  receipts.clear();
  for (const listener of listeners) listener();
}
