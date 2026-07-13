// Ship punchlist H-9 (data integrity) — unsaved-state plumbing for Settings.
// See: docs/review/mission-control-next-ship-punchlist.md
//
// Why this exists: SettingsNativePage previously had zero dirty-tracking — an
// operator could edit a form, navigate away, and silently lose work. This
// module provides a per-section dirty registry that lets:
//   1. Section components report whether their local draft diverges from the
//      server snapshot.
//   2. The page shell render an "Unsaved" indicator next to the section header.
//   3. A `beforeunload` listener block tab/window close while edits are pending.
//   4. The shell-level rail navigator defer route changes behind a confirm.
//
// Design choices:
//   - Module-scoped singleton Map keyed by section. Multiple sections may run
//     in parallel (route can change while a draft is mid-edit), and the shell
//     navigation guard lives outside the Settings page tree — so a React-only
//     context registry wouldn't reach it. The module singleton works for both.
//   - useSyncExternalStore so React components re-render on registry changes
//     in a concurrent-safe way (React 19 compatible).
//   - Non-hook accessors (`hasDirtySections`, `getDirtySectionKeys`,
//     `describeDirtySections`, `clearAllDirty`) are exposed for the shell-level
//     navigation gate, which runs inside a `useCallback` and cannot subscribe.
//
// Migration playbook (for follow-up PRs):
//   1. In each settings section, derive `isDirty` by comparing the local draft
//      state to a "server baseline" snapshot (rebuilt whenever fresh data
//      arrives via `useAsyncLoad`).
//   2. Call `useFormDirty("settings:<section>", isDirty, { label: "<copy>" })`
//      once per section.
//   3. After a successful save/reload, the new server snapshot will collapse
//      the diff back to clean automatically — no manual cleanup required.
//   4. Pass an "Unsaved" `StatusChip` into the section's primary
//      `SettingsPanel` via the new `headerAccessory` prop. The
//      `useFormDirtyChip(key)` helper is not provided; the page wires the
//      chip inline so each section keeps full control over which panel hosts
//      the indicator.
//
// Boundaries: this hook ONLY tracks dirty state. It does not autosave, does
// not produce diffs, and does not persist anything. The discard path simply
// drops registry entries so the next navigation proceeds without prompting;
// the section is responsible for resetting its own draft to the server value.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const dirtyRegistry = new Map<string, boolean>();
const labelRegistry = new Map<string, string>();
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const subscriber of subscribers) {
    subscriber();
  }
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

// Stable cached snapshot — useSyncExternalStore requires the same array
// reference until something actually changes, otherwise React loops.
let cachedSnapshot: readonly string[] = Object.freeze([]);

function rebuildSnapshot(): void {
  const next: string[] = [];
  for (const [key, value] of dirtyRegistry) {
    if (value) {
      next.push(key);
    }
  }
  next.sort();
  if (next.length !== cachedSnapshot.length || next.some((key, index) => key !== cachedSnapshot[index])) {
    cachedSnapshot = Object.freeze(next);
  }
}

function getSnapshot(): readonly string[] {
  return cachedSnapshot;
}

function getServerSnapshot(): readonly string[] {
  return cachedSnapshot;
}

/**
 * Imperatively mark or clear a section's dirty flag. Intended for use inside
 * `useFormDirty`; section code should prefer the hook so cleanup runs on
 * unmount.
 */
export function setSectionDirty(key: string, isDirty: boolean, label?: string): void {
  const previous = dirtyRegistry.get(key) ?? false;
  if (label !== undefined) {
    labelRegistry.set(key, label);
  }
  if (previous === isDirty) {
    return;
  }
  dirtyRegistry.set(key, isDirty);
  rebuildSnapshot();
  notifySubscribers();
}

/**
 * Remove a section from the registry entirely. Called on section unmount so a
 * stale section that was mid-edit doesn't keep blocking navigation.
 */
export function unregisterSection(key: string): void {
  if (!dirtyRegistry.has(key) && !labelRegistry.has(key)) {
    return;
  }
  dirtyRegistry.delete(key);
  labelRegistry.delete(key);
  rebuildSnapshot();
  notifySubscribers();
}

/**
 * Clear every section. Called after the operator confirms "Discard changes" in
 * the route-change guard, since the underlying section state will be reset by
 * the section itself on next render (server snapshot re-applied).
 */
export function clearAllDirty(): void {
  if (dirtyRegistry.size === 0) {
    return;
  }
  dirtyRegistry.clear();
  rebuildSnapshot();
  notifySubscribers();
}

/**
 * Non-hook accessor for the shell-level navigation gate. Safe to call from
 * inside a `useCallback` or event handler.
 */
export function getDirtySectionKeys(): readonly string[] {
  return cachedSnapshot;
}

/**
 * Non-hook accessor — true if any section currently reports dirty state.
 */
export function hasDirtySections(): boolean {
  return cachedSnapshot.length > 0;
}

/**
 * Human-friendly list of dirty sections for the confirm-modal copy. Uses the
 * label supplied to `useFormDirty`, falling back to the registry key.
 */
export function describeDirtySections(keys: readonly string[] = cachedSnapshot): string {
  if (keys.length === 0) {
    return "";
  }
  const labels = keys.map((key) => labelRegistry.get(key) ?? key);
  if (labels.length === 1) {
    return labels[0] ?? "";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export interface UseFormDirtyOptions {
  /**
   * Display label surfaced in the confirm-discard prompt. Defaults to the key.
   */
  label?: string;
}

/**
 * Register a section's dirty flag for the duration of the calling component's
 * lifecycle. Sections call this once with a stable key (e.g.
 * `"settings:personalities"`) and a boolean derived from comparing their
 * draft to the server snapshot.
 */
export function useFormDirty(sectionKey: string, isDirty: boolean, options?: UseFormDirtyOptions): void {
  const label = options?.label;
  useEffect(() => {
    setSectionDirty(sectionKey, isDirty, label);
  }, [sectionKey, isDirty, label]);

  // Cleanup runs when the section unmounts entirely; depend only on the key
  // so we don't unregister-and-reregister on every render.
  useEffect(() => {
    return () => {
      unregisterSection(sectionKey);
    };
  }, [sectionKey]);
}

/**
 * Subscribe to the list of currently-dirty section keys. The returned array
 * is stable across renders as long as membership is unchanged.
 */
export function useAnySectionDirty(): readonly string[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Convenience hook — returns true if any section is dirty. Reuses the same
 * subscription as `useAnySectionDirty`.
 */
export function useHasAnyDirtySection(): boolean {
  return useAnySectionDirty().length > 0;
}

const BEFORE_UNLOAD_MESSAGE = "You have unsaved changes in Settings. Leave anyway?";

/**
 * Wire a `beforeunload` listener for the lifetime of the calling component.
 * Browsers display their own generic prompt, so the message we set is mostly
 * informational; modern browsers (Chrome/Edge/Firefox) require
 * `event.preventDefault()` plus a non-empty `returnValue` to actually pop a
 * dialog.
 */
export function useBeforeUnloadGuard(): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
      return;
    }
    function handler(event: BeforeUnloadEvent): string | undefined {
      if (!hasDirtySections()) {
        return undefined;
      }
      event.preventDefault();
      // Chrome/Edge require an explicit `returnValue` to display the prompt.
      event.returnValue = BEFORE_UNLOAD_MESSAGE;
      return BEFORE_UNLOAD_MESSAGE;
    }
    window.addEventListener("beforeunload", handler);
    return () => {
      if (typeof window.removeEventListener === "function") {
        window.removeEventListener("beforeunload", handler);
      }
    };
  }, []);
}

export interface PendingNavigation<Route> {
  route: Route;
  options?: { replace?: boolean };
}

export interface NavigateGuardController<Route> {
  /**
   * Use this in place of the underlying navigate function. When any section
   * is dirty and the destination differs from the current route, the
   * navigation is deferred and `pending` becomes non-null so the caller can
   * render a confirm modal.
   */
  navigate: (route: Route, options?: { replace?: boolean }) => void;
  /**
   * Non-null when a navigation is deferred awaiting operator confirmation.
   */
  pending: PendingNavigation<Route> | null;
  /**
   * Discard all dirty sections and proceed with the deferred navigation.
   */
  confirmDiscard: () => void;
  /**
   * Drop the deferred navigation; leave dirty sections intact so the operator
   * keeps their edits.
   */
  cancelDiscard: () => void;
}

export interface DraftTransitionGuardController<Transition> {
  /**
   * Apply an in-page selection/filter transition immediately when the current
   * draft is clean, or defer it until the operator confirms discard.
   */
  requestTransition: (transition: Transition) => void;
  /** The transition currently waiting behind the discard confirmation. */
  pendingTransition: Transition | null;
  /** Reset the current draft, then apply the deferred transition. */
  confirmDiscard: () => void;
  /** Keep the current draft and abandon the deferred transition. */
  cancelDiscard: () => void;
}

/**
 * Protect selection changes inside a settings editor. Route guards alone are
 * insufficient for master/detail screens because choosing another row resets
 * the editor without unmounting the route.
 */
export function useDraftTransitionGuard<Transition>(
  isDirty: boolean,
  applyTransition: (transition: Transition) => void,
  resetDraft: () => void,
): DraftTransitionGuardController<Transition> {
  const [pendingTransition, setPendingTransition] = useState<Transition | null>(null);

  const requestTransition = useCallback(
    (transition: Transition) => {
      if (!isDirty) {
        applyTransition(transition);
        return;
      }
      setPendingTransition(transition);
    },
    [applyTransition, isDirty],
  );

  const confirmDiscard = useCallback(() => {
    if (pendingTransition === null) {
      return;
    }
    resetDraft();
    applyTransition(pendingTransition);
    setPendingTransition(null);
  }, [applyTransition, pendingTransition, resetDraft]);

  const cancelDiscard = useCallback(() => {
    setPendingTransition(null);
  }, []);

  return { requestTransition, pendingTransition, confirmDiscard, cancelDiscard };
}

/**
 * Wrap a `navigate(route)` callback so that, when any section is dirty, the
 * caller is given a chance to gate the navigation behind a confirm. The
 * consuming component renders the modal where it sees fit using `pending`.
 *
 * `isSameRoute(route)` should return true when the destination is the route
 * the operator is already viewing — in that case the dirty check is skipped
 * since no data can be lost.
 */
export function useNavigateGuard<Route>(
  rawNavigate: (route: Route, options?: { replace?: boolean }) => void,
  isSameRoute: (route: Route) => boolean,
): NavigateGuardController<Route> {
  const [pending, setPending] = useState<PendingNavigation<Route> | null>(null);

  const navigate = useCallback(
    (route: Route, options?: { replace?: boolean }) => {
      if (!hasDirtySections() || isSameRoute(route)) {
        // Forward exactly what was passed — preserve callsites that call
        // `navigate(route)` without an options argument so spies see a single
        // call argument rather than `(route, undefined)`.
        if (options === undefined) {
          rawNavigate(route);
        } else {
          rawNavigate(route, options);
        }
        return;
      }
      setPending(options === undefined ? { route } : { route, options });
    },
    [rawNavigate, isSameRoute],
  );

  const confirmDiscard = useCallback(() => {
    // Run side effects in the handler body (not inside a setState updater, which React may
    // invoke twice under StrictMode — double-firing clearAllDirty/rawNavigate). pending is
    // reliably current because the confirm modal only renders/fires this while it is non-null.
    if (!pending) {
      return;
    }
    clearAllDirty();
    if (pending.options === undefined) {
      rawNavigate(pending.route);
    } else {
      rawNavigate(pending.route, pending.options);
    }
    setPending(null);
  }, [pending, rawNavigate]);

  const cancelDiscard = useCallback(() => {
    setPending(null);
  }, []);

  return { navigate, pending, confirmDiscard, cancelDiscard };
}

/**
 * Test-only: reset the registry. Exported so unit tests can isolate from
 * sibling tests that may have left dirty entries behind.
 */
export function __resetFormDirtyRegistryForTests(): void {
  dirtyRegistry.clear();
  labelRegistry.clear();
  subscribers.clear();
  rebuildSnapshot();
}
