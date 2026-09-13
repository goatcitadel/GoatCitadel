import { useCallback, useEffect, useSyncExternalStore, type SetStateAction } from "react";
import { setRetainedDraftDirty, useFormDirty } from "./use-form-dirty";

type Revision = number | string | undefined;
type DraftEntry<T> = { value: T; baseline: T; baseRevision: Revision; observedSource: string; dirty: boolean };
// Editor input only, for this app lifetime. Never serialize this store to browser storage.
const drafts = new Map<string, DraftEntry<unknown>>();
const listeners = new Set<() => void>();
let version = 0;
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => version;
const signature = (value: unknown, revision: Revision) => JSON.stringify([revision, value]);
function notify() { version += 1; for (const listener of listeners) listener(); }

export function hasSessionDraft(key: string): boolean { return drafts.get(key)?.dirty ?? false; }
export function useSessionDraftVersion(): number { return useSyncExternalStore(subscribe, snapshot, snapshot); }
export function discardSessionDraft(key: string): void {
  drafts.delete(key);
  setRetainedDraftDirty(key, false);
  notify();
}

export function useSessionDraft<T>(
  key: string,
  canonical: T,
  revision: Revision,
  options: { label: string; active?: boolean; available?: boolean; onSave?: () => Promise<boolean> },
) {
  useSessionDraftVersion();
  const entry = drafts.get(key) as DraftEntry<T> | undefined;
  const source = signature(canonical, revision);
  const available = options.available !== false;
  useEffect(() => {
    const current = drafts.get(key);
    // Saved input bridges the interval before its refreshed canonical snapshot arrives.
    // Dirty input keeps its original comparison revision through every refresh.
    if (available && current && !current.dirty && current.observedSource !== source) discardSessionDraft(key);
  }, [available, key, source]);
  const setValue = useCallback((update: SetStateAction<T>) => {
    const current = drafts.get(key) as DraftEntry<T> | undefined;
    const previous = current?.value ?? canonical;
    const value = typeof update === "function" ? (update as (value: T) => T)(previous) : update;
    const baseline = current?.baseline ?? canonical;
    const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
    if (!dirty && current && current.observedSource !== source) drafts.delete(key);
    else drafts.set(key, { value, baseline, baseRevision: current?.baseRevision ?? revision, observedSource: current?.observedSource ?? source, dirty });
    setRetainedDraftDirty(key, dirty);
    notify();
  }, [canonical, key, revision, source]);
  const discard = useCallback(() => discardSessionDraft(key), [key]);
  const acceptSaved = useCallback((value: T, savedRevision?: Revision, submitted: T = value): boolean => {
    const current = drafts.get(key) as DraftEntry<T> | undefined;
    // A response acknowledges its submitted snapshot, never text typed after it.
    const newerInput = current && JSON.stringify(current.value) !== JSON.stringify(submitted);
    const nextValue = newerInput ? current.value : value;
    const dirty = JSON.stringify(nextValue) !== JSON.stringify(value);
    drafts.set(key, { value: nextValue, baseline: value, baseRevision: savedRevision, observedSource: source, dirty });
    setRetainedDraftDirty(key, dirty);
    notify();
    return !dirty;
  }, [key, source]);
  const acceptSavedAs = useCallback((nextKey: string, value: T, savedRevision: Revision, submitted: T): boolean => {
    if (nextKey === key) return acceptSaved(value, savedRevision, submitted);
    if (drafts.get(nextKey)?.dirty) throw new Error("The saved version already has a retained draft. Both drafts are preserved; review them before continuing.");
    const current = drafts.get(key) as DraftEntry<T> | undefined;
    const nextValue = current && JSON.stringify(current.value) !== JSON.stringify(submitted) ? current.value : value;
    const dirty = JSON.stringify(nextValue) !== JSON.stringify(value);
    drafts.delete(key); setRetainedDraftDirty(key, false);
    drafts.set(nextKey, { value: nextValue, baseline: value, baseRevision: savedRevision, observedSource: signature(value, savedRevision), dirty });
    setRetainedDraftDirty(nextKey, dirty); notify();
    return !dirty;
  }, [acceptSaved, key]);
  const rebaseToCurrent = useCallback(() => {
    const current = drafts.get(key) as DraftEntry<T> | undefined;
    if (!available || !current) return;
    const dirty = JSON.stringify(current.value) !== JSON.stringify(canonical);
    drafts.set(key, { ...current, baseline: canonical, baseRevision: revision, observedSource: source, dirty });
    setRetainedDraftDirty(key, dirty); notify();
  }, [available, canonical, key, revision, source]);
  useFormDirty(key, options.active !== false && Boolean(entry?.dirty), {
    label: options.label, keepDraft: true, onDiscard: discard, onSave: options.onSave,
  });
  return {
    key, value: entry?.value ?? canonical, setValue, isDirty: entry?.dirty ?? false,
    baseRevision: entry?.baseRevision ?? revision,
    hasRemoteChanges: Boolean(entry?.dirty && available && entry.baseRevision !== revision),
    discard, acceptSaved, acceptSavedAs, rebaseToCurrent,
  };
}

export function __resetSessionDraftsForTests(): void {
  for (const key of drafts.keys()) setRetainedDraftDirty(key, false);
  drafts.clear();
  notify();
}
