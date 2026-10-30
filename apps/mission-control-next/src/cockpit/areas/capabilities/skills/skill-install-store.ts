import { useSyncExternalStore } from "react";
import type { CapabilitySkillInstall, CapabilitySkillSource } from "@goatcitadel/contracts";

/**
 * Where one install panel stands. `ready` holds a check that passed or is blocked; `following` any later step, read
 * from the Gateway; `done` is switched on. Messages are plain words.
 */
export type SkillInstallState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "check_failed"; message: string; code?: string }
  | { phase: "ready"; install: CapabilitySkillInstall }
  | { phase: "following"; install: CapabilitySkillInstall }
  | { phase: "done"; skillId: string; install?: CapabilitySkillInstall }
  | { phase: "failed"; message: string; install?: CapabilitySkillInstall };

/** The two install steps a panel asks for. */
export type SkillInstallStepKind = "install_inactive" | "activate";

/**
 * One panel's flow, kept for this app session outside any component, so closing the panel, leaving the tab or a list
 * that reads again loses nothing. A check's own entry is keyed by its id; a check not answered yet (from Discover, or
 * a Git address) by a key of its own, which then points at the check it made (`movedTo`). Nothing is stored in the
 * browser: after a reload, the Gateway's installs list is the truth.
 */
export interface SkillInstallEntry {
  readonly state: SkillInstallState;
  /** The source the last check read, for Check again. */
  readonly source?: CapabilitySkillSource;
  /** The last check's key, sent again only to retry a check whose answer never came. */
  readonly idempotencyKey?: string;
  /** The step a confirmation in this app session asked for last. */
  readonly asked?: SkillInstallStepKind;
  /** That step's request is on its way, or its answer isn't read back yet. */
  readonly asking?: boolean;
  /** The confirmation goes on to switch the skill on once it is installed. */
  readonly chain?: boolean;
  /** A plain line about the last request: a decline, or why a request didn't go through. */
  readonly notice?: string;
  /** The install couldn't be read several times in a row; the reads go on. */
  readonly unreadable?: boolean;
  /** The check this key's panel should move to, once. */
  readonly movedTo?: string;
}

/** A panel's key before its check has answered: from Discover (`draft:pack:<id>`) or a Git address (`draft:git`). */
const DRAFT_PREFIX = "draft:";

export function draftInstallKey(name: string): string {
  return `${DRAFT_PREFIX}${name}`;
}

/** Whether a key is a panel's own rather than a check's id. */
export function isDraftInstallKey(key: string): boolean {
  return key.startsWith(DRAFT_PREFIX);
}

const entries = new Map<string, SkillInstallEntry>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// One timer per check while its install is followed, and the reads it started. They don't depend on a mounted panel,
// so closing the panel doesn't stall an install. What a timer runs belongs to the hook's module, which registers it.
const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
const controllers = new Map<string, AbortController>();
let tickOf: ((key: string) => unknown) | undefined;

/** Sets what each check's timer runs. The hook's module calls it once. */
export function setSkillInstallTicker(tick: (key: string) => unknown) {
  tickOf = tick;
}

/** Runs the check's next read after `ms`, in place of any read already scheduled. */
export function scheduleSkillInstallTick(key: string, ms: number) {
  const scheduled = timers.get(key);
  if (scheduled !== undefined) globalThis.clearTimeout(scheduled);
  timers.set(
    key,
    globalThis.setTimeout(() => {
      timers.delete(key);
      void tickOf?.(key);
    }, ms),
  );
}

/** Stops the check's scheduled read, if any. */
export function cancelSkillInstallTick(key: string) {
  const scheduled = timers.get(key);
  if (scheduled !== undefined) globalThis.clearTimeout(scheduled);
  timers.delete(key);
}

/** The signal for the check's reads. It aborts when the entry goes or reaches an end. */
export function installSignal(key: string): AbortSignal {
  let controller = controllers.get(key);
  if (!controller) {
    controller = new AbortController();
    controllers.set(key, controller);
  }
  return controller.signal;
}

function stopFollowing(key: string) {
  cancelSkillInstallTick(key);
  controllers.get(key)?.abort();
  controllers.delete(key);
}

export function readSkillInstall(key: string): SkillInstallEntry | undefined {
  return entries.get(key);
}

/** Replaces the key's entry; `undefined` forgets it. An entry that reached an end stops its reads. */
export function setSkillInstall(key: string, entry: SkillInstallEntry | undefined) {
  if (entries.get(key) === entry) return;
  if (entry) entries.set(key, entry);
  else entries.delete(key);
  const phase = entry?.state.phase;
  if (!entry || phase === "done" || phase === "failed" || phase === "check_failed") stopFollowing(key);
  publish();
}

export function useSkillInstallEntry(key: string | undefined): SkillInstallEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (key === undefined ? undefined : entries.get(key)),
    () => undefined,
  );
}

export function __resetSkillInstallStoreForTests() {
  for (const key of [...timers.keys(), ...controllers.keys()]) stopFollowing(key);
  entries.clear();
  publish();
}
