import { useSyncExternalStore } from "react";
import type { ToolGroupId } from "@goatcitadel/contracts";

/** How often a plan that waits in Inbox, or is still being applied, is read again. */
const PLAN_POLL_MS = 5_000;

/** A switch change the Gateway took as a plan that isn't finished yet: the plan this tab follows for the group. */
interface PlanFollow {
  readonly groupId: ToolGroupId;
  readonly planId: string;
  /** The way the plan switches the group: on, or off. */
  readonly enabled: boolean;
}

/**
 * Where one group's switch stands between a click and the list that shows its result. A group with no entry shows
 * the list's own state. Messages are plain words.
 */
export type ToolGroupSwitchEntry =
  | { readonly phase: "saving" }
  /** Waiting on an approval in Inbox. The approval's id is optional on a plan, so the wait can be known without it. */
  | ({ readonly phase: "waiting"; readonly approvalId?: string } & PlanFollow)
  /** Neither waiting nor finished: being applied, or between steps. */
  | ({ readonly phase: "applying" } & PlanFollow)
  /** The change is made; the list is being read again to show it. */
  | { readonly phase: "confirming" }
  | { readonly phase: "failed"; readonly message: string; readonly conflict: boolean };

export const SAVING: ToolGroupSwitchEntry = { phase: "saving" };
export const CONFIRMING: ToolGroupSwitchEntry = { phase: "confirming" };

// Entries live for this app session, outside any component. One group can show as a Most used card, a row and the open
// panel at once, and a wait in Inbox outlasts all three (P2-R28). Nothing here is stored in the browser.
const entries = new Map<ToolGroupId, ToolGroupSwitchEntry>();
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

export function isFollowing(
  entry: ToolGroupSwitchEntry | undefined,
): entry is Extract<ToolGroupSwitchEntry, { phase: "waiting" | "applying" }> {
  return entry?.phase === "waiting" || entry?.phase === "applying";
}

// One plan read timer per group while its entry follows a plan. It doesn't depend on a mounted hook, so closing the
// panel or following "Open in Inbox" doesn't stall the wait, and it stops once the plan settles. The read itself belongs
// to the hook's module, which registers it.
const polls = new Map<ToolGroupId, ReturnType<typeof globalThis.setInterval>>();
let readPlanOf: ((groupId: ToolGroupId) => unknown) | undefined;

/** Sets the read each plan poll runs. The hook's module calls it once. */
export function setToolGroupPlanReader(read: (groupId: ToolGroupId) => unknown) {
  readPlanOf = read;
}

function syncPlanPoll(groupId: ToolGroupId, entry: ToolGroupSwitchEntry | undefined) {
  const timer = polls.get(groupId);
  if (isFollowing(entry)) {
    if (!timer)
      polls.set(
        groupId,
        globalThis.setInterval(() => void readPlanOf?.(groupId), PLAN_POLL_MS),
      );
    return;
  }
  if (timer === undefined) return;
  globalThis.clearInterval(timer);
  polls.delete(groupId);
}

export function readToolGroupSwitch(groupId: ToolGroupId): ToolGroupSwitchEntry | undefined {
  return entries.get(groupId);
}

/** Replaces the group's entry; `undefined` forgets it, so the switch shows the list's own state again. */
export function setToolGroupSwitch(groupId: ToolGroupId, entry: ToolGroupSwitchEntry | undefined) {
  if (entries.get(groupId) === entry) return;
  if (entry) entries.set(groupId, entry);
  else entries.delete(groupId);
  syncPlanPoll(groupId, entry);
  publish();
}

/**
 * Whether a save is in flight for any group. The Settings revision is one for the whole install, so a second save sent
 * meanwhile would carry the same expected revision and be refused as changed elsewhere (P2-R28).
 */
export function isAnyToolGroupSaving(): boolean {
  for (const entry of entries.values()) if (entry.phase === "saving") return true;
  return false;
}

export function useToolGroupSwitchEntry(groupId: ToolGroupId): ToolGroupSwitchEntry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => entries.get(groupId),
    () => undefined,
  );
}

export function __resetToolGroupSwitchStoreForTests() {
  for (const timer of polls.values()) globalThis.clearInterval(timer);
  polls.clear();
  entries.clear();
  publish();
}
