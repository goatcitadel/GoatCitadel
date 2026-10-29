import { useSyncExternalStore } from "react";
import type { CapabilitySkillState } from "@goatcitadel/contracts";

/**
 * A change the switch asked for and is following: the state it asked for, and the state the list showed when it
 * asked. `target` is unknown for a wait picked up from the list after a reload, so the list's state moving away from
 * `from` is what ends it then.
 */
export interface SkillChange {
  readonly target?: CapabilitySkillState;
  readonly from: CapabilitySkillState;
}

/**
 * Where one skill's switch stands between a click and the list that shows its result. A skill with no entry shows the
 * list's own state. Messages are plain words.
 */
export type SkillSwitchEntry =
  /** The switch's request is on its way. */
  | { readonly phase: "saving" }
  /** The change waits on its approval in Inbox. The switch keeps the list's state until the approval lands. */
  | ({
      readonly phase: "waiting";
      readonly skillId: string;
      readonly approvalId: string;
      /** Picked up from the list's waiting mark (after a reload) rather than from a click in this tab. */
      readonly recovered?: boolean;
      /** The approval couldn't be read several times in a row; the wait goes on. */
      readonly unreadable?: boolean;
    } & SkillChange)
  /** Approved: the change is being applied, and the list is read until it shows it. */
  | ({ readonly phase: "applying" } & SkillChange)
  /**
   * Why the last change didn't happen. `change` is set only when the checks ran out while the change was still being
   * applied, so the line goes once the list shows it.
   */
  | { readonly phase: "failed"; readonly message: string; readonly conflict: boolean; readonly change?: SkillChange };

export type FollowingEntry = Extract<SkillSwitchEntry, { phase: "waiting" | "applying" }>;

export const SAVING: SkillSwitchEntry = { phase: "saving" };

// Entries live for this app session, outside any component. One skill can show as a row and in the open panel at
// once, and a wait for an approval outlasts both. Nothing here is stored in the browser.
const entries = new Map<string, SkillSwitchEntry>();
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

export function isFollowing(entry: SkillSwitchEntry | undefined): entry is FollowingEntry {
  return entry?.phase === "waiting" || entry?.phase === "applying";
}

// One timer per skill while its entry follows a change, and the reads it started. They don't depend on a mounted
// hook, so closing the panel or following "Open in Inbox" doesn't stall the wait, and both stop as soon as the entry
// stops following or leaves the store. What a timer runs belongs to the hook's module, which registers it.
const timers = new Map<string, ReturnType<typeof globalThis.setTimeout>>();
const controllers = new Map<string, AbortController>();
let tickOf: ((skillId: string) => unknown) | undefined;

/** Sets what each skill's timer runs. The hook's module calls it once. */
export function setSkillSwitchTicker(tick: (skillId: string) => unknown) {
  tickOf = tick;
}

/** Runs the skill's next check after `ms`, in place of any check already scheduled. */
export function scheduleSkillSwitchTick(skillId: string, ms: number) {
  const scheduled = timers.get(skillId);
  if (scheduled !== undefined) globalThis.clearTimeout(scheduled);
  timers.set(
    skillId,
    globalThis.setTimeout(() => {
      timers.delete(skillId);
      void tickOf?.(skillId);
    }, ms),
  );
}

/** The signal for the skill's reads while it follows a change. It aborts when the entry stops following. */
export function followSignal(skillId: string): AbortSignal {
  let controller = controllers.get(skillId);
  if (!controller) {
    controller = new AbortController();
    controllers.set(skillId, controller);
  }
  return controller.signal;
}

function stopFollowing(skillId: string) {
  const scheduled = timers.get(skillId);
  if (scheduled !== undefined) globalThis.clearTimeout(scheduled);
  timers.delete(skillId);
  controllers.get(skillId)?.abort();
  controllers.delete(skillId);
}

export function readSkillSwitch(skillId: string): SkillSwitchEntry | undefined {
  return entries.get(skillId);
}

/** Replaces the skill's entry; `undefined` forgets it, so the switch shows the list's own state again. */
export function setSkillSwitch(skillId: string, entry: SkillSwitchEntry | undefined) {
  if (entries.get(skillId) === entry) return;
  if (entry) entries.set(skillId, entry);
  else entries.delete(skillId);
  if (!isFollowing(entry)) stopFollowing(skillId);
  publish();
}

export function useSkillSwitchEntry(skillId: string): SkillSwitchEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => entries.get(skillId),
    () => undefined,
  );
}

export function __resetSkillSwitchStoreForTests() {
  for (const skillId of [...timers.keys(), ...controllers.keys()]) stopFollowing(skillId);
  entries.clear();
  publish();
}
