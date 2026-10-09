import {
  getGatewayCallerScope,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { useCallback, useEffect, useSyncExternalStore, type SetStateAction } from "react";
import { setRetainedDraftDirty, useFormDirty } from "./use-form-dirty";

const scopedDraftKey = (key: string, caller = getGatewayCallerScope()) =>
  key.startsWith("caller-scope:") || !caller ? key : `caller-scope:${JSON.stringify([caller, key])}`;
/** Dirty-section classification only. Never use this unscoped name to read draft values. */
export function sessionDraftSectionKey(key: string): string {
  if (!key.startsWith("caller-scope:")) return key;
  try {
    const parts: unknown = JSON.parse(key.slice("caller-scope:".length));
    return Array.isArray(parts) && typeof parts[1] === "string" ? parts[1] : key;
  } catch {
    return key;
  }
}
type Revision = number | string | undefined;
type DraftEntry<T> = {
  value: T;
  baseline: T;
  baseRevision: Revision;
  observedSource: string;
  dirty: boolean;
  inputVersion?: number;
};

/** Independent transient input owner; values never leave its private store. */
export function createTransientInputOwner(allowUnattributedRecovery = false) {
  // Editor input only, for this app lifetime. Never serialize this store to browser storage.
  const drafts = new Map<string, DraftEntry<unknown>>();
  const listeners = new Set<() => void>();
  let version = 0;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const snapshot = () => version;
  const signature = (value: unknown, revision: Revision) => JSON.stringify([revision, value]);
  function notify() {
    version += 1;
    for (const listener of listeners) listener();
  }

  function hasSessionDraft(key: string): boolean {
    return drafts.get(scopedDraftKey(key))?.dirty ?? false;
  }
  function useSessionDraftVersion(): number {
    return useSyncExternalStore(subscribe, snapshot, snapshot);
  }
  function discardSessionDraft(key: string): void {
    key = scopedDraftKey(key);
    drafts.delete(key);
    setRetainedDraftDirty(key, false);
    notify();
  }

  function useSessionDraft<T>(
    key: string,
    canonical: T,
    revision: Revision,
    options: { label: string; active?: boolean; available?: boolean; onSave?: () => Promise<boolean> },
  ) {
    const caller = useSyncExternalStore(subscribeGatewayCallerScope, getGatewayCallerScope, () => "");
    const unscopedKey = key;
    key = scopedDraftKey(key, caller);
    useSessionDraftVersion();
    const entry = drafts.get(key) as DraftEntry<T> | undefined;
    const source = signature(canonical, revision);
    const available = options.available !== false;
    const hasUnattributedDraft = Boolean(
      allowUnattributedRecovery && caller && key !== unscopedKey && drafts.get(unscopedKey)?.dirty,
    );
    const recoverUnattributedDraft = useCallback(() => {
      if (
        !allowUnattributedRecovery ||
        !caller ||
        getGatewayCallerScope() !== caller ||
        key === unscopedKey ||
        drafts.get(key)?.dirty
      )
        return;
      const unattributed = drafts.get(unscopedKey);
      if (!unattributed?.dirty) return;
      // Explicitly claimed input is copied. The original bytes remain for their original session.
      drafts.set(key, { ...unattributed });
      setRetainedDraftDirty(key, true);
      notify();
    }, [caller, key, unscopedKey]);
    useEffect(() => {
      const current = drafts.get(key);
      // Saved input bridges the interval before its refreshed canonical snapshot arrives.
      // Dirty input keeps its original comparison revision through every refresh.
      if (available && current && !current.dirty && current.observedSource !== source) discardSessionDraft(key);
    }, [available, key, source]);
    const setValue = useCallback(
      (update: SetStateAction<T>) => {
        const current = drafts.get(key) as DraftEntry<T> | undefined;
        const previous = current?.value ?? canonical;
        const value = typeof update === "function" ? (update as (value: T) => T)(previous) : update;
        const baseline = current?.baseline ?? canonical;
        const dirty = JSON.stringify(value) !== JSON.stringify(baseline);
        if (!dirty && current && current.observedSource !== source) drafts.delete(key);
        else
          drafts.set(key, {
            value,
            baseline,
            baseRevision: current?.baseRevision ?? revision,
            observedSource: current?.observedSource ?? source,
            dirty,
            inputVersion: version + 1,
          });
        setRetainedDraftDirty(key, dirty);
        notify();
      },
      [canonical, key, revision, source],
    );
    const discard = useCallback(() => discardSessionDraft(key), [key]);
    const acceptSaved = useCallback(
      (value: T, savedRevision?: Revision, submitted: T = value): boolean => {
        const current = drafts.get(key) as DraftEntry<T> | undefined;
        // A response acknowledges its submitted snapshot, never text typed after it.
        const newerInput = current && JSON.stringify(current.value) !== JSON.stringify(submitted);
        const nextValue = newerInput ? current.value : value;
        const dirty = JSON.stringify(nextValue) !== JSON.stringify(value);
        drafts.set(key, {
          value: nextValue,
          baseline: value,
          baseRevision: savedRevision,
          observedSource: source,
          dirty,
        });
        setRetainedDraftDirty(key, dirty);
        notify();
        return !dirty;
      },
      [key, source],
    );
    const acceptSavedAs = useCallback(
      (nextKey: string, value: T, savedRevision: Revision, submitted: T): boolean => {
        // A late save acknowledgement belongs to the submitting caller, even after sign-in changes.
        nextKey = scopedDraftKey(nextKey, caller);
        if (nextKey === key) return acceptSaved(value, savedRevision, submitted);
        if (drafts.get(nextKey)?.dirty)
          throw new Error(
            "The saved version already has a retained draft. Both drafts are preserved; review them before continuing.",
          );
        const current = drafts.get(key) as DraftEntry<T> | undefined;
        const nextValue =
          current && JSON.stringify(current.value) !== JSON.stringify(submitted) ? current.value : value;
        const dirty = JSON.stringify(nextValue) !== JSON.stringify(value);
        drafts.delete(key);
        setRetainedDraftDirty(key, false);
        drafts.set(nextKey, {
          value: nextValue,
          baseline: value,
          baseRevision: savedRevision,
          observedSource: signature(value, savedRevision),
          dirty,
        });
        setRetainedDraftDirty(nextKey, dirty);
        notify();
        return !dirty;
      },
      [acceptSaved, caller, key],
    );
    const rebaseToCurrent = useCallback(() => {
      const current = drafts.get(key) as DraftEntry<T> | undefined;
      if (!available || !current) return;
      const dirty = JSON.stringify(current.value) !== JSON.stringify(canonical);
      drafts.set(key, { ...current, baseline: canonical, baseRevision: revision, observedSource: source, dirty });
      setRetainedDraftDirty(key, dirty);
      notify();
    }, [available, canonical, key, revision, source]);
    useFormDirty(key, options.active !== false && Boolean(entry?.dirty), {
      label: options.label,
      keepDraft: true,
      onDiscard: discard,
      onSave: options.onSave,
    });
    return {
      key,
      value: entry?.value ?? canonical,
      setValue,
      isDirty: entry?.dirty ?? false,
      inputVersion: entry?.inputVersion ?? 0,
      baseRevision: entry?.baseRevision ?? revision,
      hasRemoteChanges: Boolean(entry?.dirty && available && entry.baseRevision !== revision),
      discard,
      acceptSaved,
      acceptSavedAs,
      rebaseToCurrent,
      hasUnattributedDraft,
      recoverUnattributedDraft,
    };
  }

  function __resetSessionDraftsForTests(): void {
    for (const key of drafts.keys()) setRetainedDraftDirty(key, false);
    drafts.clear();
    notify();
  }

  return {
    hasSessionDraft,
    useSessionDraftVersion,
    discardSessionDraft,
    useSessionDraft,
    resetForTests: __resetSessionDraftsForTests,
  };
}
