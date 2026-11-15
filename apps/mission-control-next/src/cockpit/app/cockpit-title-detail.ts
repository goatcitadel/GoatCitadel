import { useEffect, useSyncExternalStore } from "react";

/**
 * The name of the record the page has open (a conversation, a run, a task), for the browser tab title. A page
 * registers it while it is mounted; the newest registration wins, and a page that unmounts removes only its own.
 */
interface DetailEntry {
  readonly detail: string;
}

let entries: readonly DetailEntry[] = [];
const listeners = new Set<() => void>();

function update(next: readonly DetailEntry[]) {
  entries = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = () => entries.at(-1)?.detail;

export function useCockpitTitleDetail(detail: string | undefined): void {
  useEffect(() => {
    const name = detail?.trim();
    if (!name) return;
    const entry: DetailEntry = { detail: name };
    update([...entries, entry]);
    return () => update(entries.filter((candidate) => candidate !== entry));
  }, [detail]);
}

export function useCockpitTitleDetailValue(): string | undefined {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
