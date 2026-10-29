import { useEffect } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type {
  ApprovalRequest,
  CapabilitySkillActionOutcome,
  CapabilitySkillItem,
  CapabilitySkillState,
  CapabilitySkillsResponse,
  SkillRuntimeState,
} from "@goatcitadel/contracts";
import { fetchApproval } from "@goatcitadel/mission-control-shared/api/approvals";
import { setCapabilitySkillState } from "@goatcitadel/mission-control-shared/api/capability-skills";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/http-internal";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { skillListQuery } from "../../../data/capability-skills-query";
import { approvalExpiredUnresolved } from "../../inbox/approval-settlement";
import {
  __resetSkillSwitchStoreForTests,
  followSignal,
  readSkillSwitch,
  SAVING,
  scheduleSkillSwitchTick,
  setSkillSwitch,
  setSkillSwitchTicker,
  useSkillSwitchEntry,
  type SkillChange,
  type SkillSwitchEntry,
} from "./skill-switch-store";

/** Waits between list reads after a change is approved: the reads come 1, 3, 7 and 15 seconds in, then it gives up. */
const LIST_CHECKS_MS = [1_000, 2_000, 4_000, 8_000] as const;
/** Waits between reads of a waiting approval: every 5 seconds at first, then less often, at most every 30. */
const APPROVAL_CHECKS_MS = [5_000, 5_000, 5_000, 10_000, 20_000, 30_000] as const;
/** Failed approval reads in a row before the switch says it can't check. */
const MISSED_READS_LIMIT = 3;

/** The switch's states as the request names them. */
const REQUEST_STATE: Record<CapabilitySkillState, SkillRuntimeState> = {
  on: "enabled",
  paused: "sleep",
  off: "disabled",
};

const DECLINED = "Not changed. The change was declined.";
const EXPIRED = "Not changed. The request expired.";
const STILL_APPLYING = "Still applying. Refresh to check.";
const CANT_CHECK = "Can't check the approval right now. It will try again.";

export interface SkillSwitch {
  /** What the switch shows: the skill's state in the list. Never ahead of it; on or paused both count. */
  checked: boolean;
  paused: boolean;
  /** The request is on its way, or an approved change is being applied and the list doesn't show it yet. */
  pending: boolean;
  /** The change waits on your approval. The switch keeps its old state until the approval lands. */
  waiting: boolean;
  /** The approval the change waits on, for the approval in the skill's panel. */
  waitingApprovalId?: string;
  /**
   * The state the waiting change asks for, when a click in this tab asked for it; unknown for a wait picked up from the
   * list after a load. It only words the change for the operator.
   */
  waitingTarget?: CapabilitySkillState;
  /**
   * The wait began with a click in this tab, not picked up from the list after a load. Only such a wait is read out:
   * nobody just asked for one found on load.
   */
  waitStartedHere: boolean;
  /**
   * Why the last change didn't happen, or why its wait can't be checked, in plain words. `conflict` means `reload` is
   * the way forward. It is the same object for as long as that failure stands, in every view, so a view can tell a
   * failure it was already showing from a new one.
   */
  failure?: { message: string; conflict: boolean };
  /** Switches the skill on (`enabled`) or off (`disabled`). */
  setOn(next: boolean): void;
  /** Pauses the skill (`sleep`) or resumes it (`enabled`). The panel offers it; the row doesn't. */
  setPaused(next: boolean): void;
  /** Reads the list again and drops the last failure. */
  reload(): void;
  /**
   * Reads the waiting approval now and starts its back-off again, for a decision made where the switch can't hear it
   * (a decline sends no skill event). Does nothing when nothing waits.
   */
  checkApproval(): void;
}

type Failure = NonNullable<SkillSwitch["failure"]>;
type WaitingEntry = Extract<SkillSwitchEntry, { phase: "waiting" }>;
type FailedEntry = Extract<SkillSwitchEntry, { phase: "failed" }>;

/** Where one skill's list lives, for the checks that run once no view of the skill is mounted. */
interface ListContext {
  readonly client: QueryClient;
  readonly listKey: QueryKey;
}

const contexts = new Map<string, ListContext>();
/** Skills whose approval is being read now. */
const reading = new Set<string>();
/** Checks done in the skill's current wait or apply, which set how long the next one waits. */
const beats = new Map<string, number>();
/** Failed approval reads in a row. */
const misses = new Map<string, number>();
/** Approvals whose outcome this tab has taken on. The list's waiting mark for one of them is never picked up again. */
const settled = new Set<string>();
/** Picked-up approvals already read once because the list dropped their waiting mark. */
const checkedGone = new Set<string>();

/** What an entry shows as `failure`, made once per entry so its identity says which failure it is. */
const failures = new WeakMap<SkillSwitchEntry, Failure>();

function failureOf(entry: SkillSwitchEntry | undefined): Failure | undefined {
  const shown =
    entry?.phase === "failed"
      ? { message: entry.message, conflict: entry.conflict }
      : entry?.phase === "waiting" && entry.unreadable
        ? { message: CANT_CHECK, conflict: false }
        : undefined;
  if (!entry || !shown) return undefined;
  const known = failures.get(entry);
  if (known) return known;
  failures.set(entry, shown);
  return shown;
}

/** Whether the list's row shows the change: the state asked for, or after a reload any move away from the old one. */
const shows = (change: SkillChange, row: CapabilitySkillItem) =>
  change.target ? row.state === change.target : row.state !== change.from;

const changeOf = ({ target, from }: SkillChange): SkillChange => ({ ...(target ? { target } : {}), from });

function rowOf({ client, listKey }: ListContext, skillId: string) {
  return client.getQueryData<CapabilitySkillsResponse>(listKey)?.items.find((row) => row.skillId === skillId);
}

/**
 * Reads the list again. Every switch shares the read: one already under way is joined, never cancelled and never
 * doubled, because the list route is heavy and allows 60 reads a minute. It never throws; a failed read leaves the
 * last good rows (and the tab says it couldn't read them).
 */
function readList({ client, listKey }: ListContext) {
  return client.refetchQueries({ queryKey: listKey, exact: true }, { cancelRefetch: false });
}

function forget(skillId: string) {
  beats.delete(skillId);
  misses.delete(skillId);
}

/** The change shows in the list: the switch goes back to the list's own state. */
function finish(skillId: string) {
  const entry = readSkillSwitch(skillId);
  if (entry?.phase === "waiting") settled.add(entry.approvalId);
  setSkillSwitch(skillId, undefined);
  forget(skillId);
}

function fail(
  skillId: string,
  message: string,
  {
    conflict = false,
    change,
    readAgain = true,
  }: { conflict?: boolean; change?: SkillChange; readAgain?: boolean } = {},
) {
  const entry = readSkillSwitch(skillId);
  if (entry?.phase === "waiting") settled.add(entry.approvalId);
  const context = contexts.get(skillId);
  // The version the line is about: once the skill moves past it some other way, the line no longer holds.
  const revision = context ? rowOf(context, skillId)?.revision : undefined;
  setSkillSwitch(skillId, {
    phase: "failed",
    message,
    conflict,
    ...(change ? { change } : {}),
    ...(revision === undefined ? {} : { revision }),
  });
  forget(skillId);
  // Whatever happened, the list shows what is held now. A decline sends no skill event, so this also drops the
  // list's waiting mark.
  if (readAgain && context) void readList(context);
}

function startWaiting(entry: WaitingEntry) {
  setSkillSwitch(entry.skillId, entry);
  forget(entry.skillId);
  scheduleSkillSwitchTick(entry.skillId, APPROVAL_CHECKS_MS[0]);
}

function startApplying(skillId: string, change: SkillChange) {
  setSkillSwitch(skillId, { phase: "applying", ...changeOf(change) });
  forget(skillId);
  scheduleSkillSwitchTick(skillId, LIST_CHECKS_MS[0]);
}

/** An approved change: reads the list until it shows the change, and gives up after the last check. */
async function checkList(skillId: string) {
  const entry = readSkillSwitch(skillId);
  const context = contexts.get(skillId);
  if (entry?.phase !== "applying" || !context) return;
  await readList(context);
  // The list may have shown it meanwhile (an event read it), which already ended the wait.
  if (readSkillSwitch(skillId) !== entry) return;
  const row = rowOf(context, skillId);
  if (row && shows(entry, row)) return finish(skillId);
  const done = (beats.get(skillId) ?? 0) + 1;
  if (done >= LIST_CHECKS_MS.length)
    return fail(skillId, STILL_APPLYING, { change: changeOf(entry), readAgain: false });
  beats.set(skillId, done);
  scheduleSkillSwitchTick(skillId, waitAt(LIST_CHECKS_MS, done));
}

/** The wait before check `step + 1` of a schedule; past its end, the last wait repeats. */
function waitAt(schedule: readonly [number, ...number[]], step: number): number {
  return schedule[Math.min(step, schedule.length - 1)] ?? schedule[0];
}

function nextApprovalCheck(skillId: string) {
  const done = (beats.get(skillId) ?? 0) + 1;
  beats.set(skillId, done);
  scheduleSkillSwitchTick(skillId, waitAt(APPROVAL_CHECKS_MS, done));
}

const sameWait = (entry: SkillSwitchEntry | undefined, approvalId: string): entry is WaitingEntry =>
  entry?.phase === "waiting" && entry.approvalId === approvalId;

function missedRead(skillId: string, approvalId: string) {
  const current = readSkillSwitch(skillId);
  // An aborted read: the wait ended meanwhile.
  if (!sameWait(current, approvalId)) return;
  const missed = (misses.get(skillId) ?? 0) + 1;
  misses.set(skillId, missed);
  if (missed >= MISSED_READS_LIMIT && !current.unreadable) setSkillSwitch(skillId, { ...current, unreadable: true });
  nextApprovalCheck(skillId);
}

function approvalSettled(skillId: string, current: WaitingEntry, approval: ApprovalRequest) {
  if (approval.status === "approved") {
    settled.add(current.approvalId);
    return startApplying(skillId, current);
  }
  // An expiry is a rejection by the expiry check. An edited skill approval never applies, so it counts as declined.
  if (approval.status === "rejected") return fail(skillId, approvalExpiredUnresolved(approval) ? EXPIRED : DECLINED);
  if (approval.status === "edited") return fail(skillId, DECLINED);
  // Still pending: a read that works again clears the line about failed reads.
  misses.delete(skillId);
  if (current.unreadable) setSkillSwitch(skillId, { ...current, unreadable: false });
  nextApprovalCheck(skillId);
}

/** Reads the skill's approval once and moves its switch on. The skill's timer calls it while the entry waits. */
async function checkApproval(skillId: string) {
  const entry = readSkillSwitch(skillId);
  if (entry?.phase !== "waiting" || reading.has(skillId)) return;
  const { approvalId } = entry;
  reading.add(skillId);
  let approval: ApprovalRequest;
  try {
    // Skill approvals belong to no workspace, so a read scoped to one would find nothing.
    approval = await fetchApproval(approvalId, { signal: followSignal(skillId) });
  } catch {
    reading.delete(skillId);
    return missedRead(skillId, approvalId);
  }
  reading.delete(skillId);
  const current = readSkillSwitch(skillId);
  if (sameWait(current, approvalId)) approvalSettled(skillId, current, approval);
}

/** A decision made elsewhere: the approval is read now, and the reads after it start again at their first pace. */
function checkApprovalNow(skillId: string) {
  if (readSkillSwitch(skillId)?.phase !== "waiting") return;
  beats.delete(skillId);
  void checkApproval(skillId);
}

setSkillSwitchTicker((skillId) => {
  const phase = readSkillSwitch(skillId)?.phase;
  if (phase === "waiting") return checkApproval(skillId);
  if (phase === "applying") return checkList(skillId);
  return undefined;
});

/** The route's own plain line for a refusal (pinned, stale, duplicate, can't be switched); otherwise a plain summary. */
function refusalOf(error: unknown): Failure {
  if (isApiRequestError(error) && (error.status === 409 || error.status === 404)) {
    const body = (typeof error.body === "object" && error.body !== null ? error.body : {}) as {
      error?: unknown;
      details?: { reason?: unknown };
    };
    const conflict = error.status === 409 && body.details?.reason === "stale";
    if (typeof body.error === "string" && body.error.trim()) return { message: body.error.trim(), conflict };
  }
  return { message: describeApiError(error).summary, conflict: false };
}

function receive(item: CapabilitySkillItem, target: CapabilitySkillState, outcome: CapabilitySkillActionOutcome) {
  const { skillId, state: from } = item;
  if (outcome.status === "approved") {
    settled.add(outcome.approvalId);
    return startApplying(skillId, { target, from });
  }
  if (outcome.status === "waiting") {
    return startWaiting({ phase: "waiting", skillId, approvalId: outcome.approvalId, target, from });
  }
  if (outcome.status === "declined") {
    settled.add(outcome.approvalId);
    return fail(skillId, outcome.expired ? EXPIRED : DECLINED, { readAgain: false });
  }
  // Unchanged: the skill already had that state, so the list is read once to show it.
  const context = contexts.get(skillId);
  void (context ? readList(context) : Promise.resolve()).then(() => {
    if (readSkillSwitch(skillId) === SAVING) finish(skillId);
  });
}

/** Never sends the state the skill already has: the request carries no note, so it would clear one. */
async function send(
  item: CapabilitySkillItem,
  target: CapabilitySkillState,
  workspaceId: string,
  context: ListContext,
) {
  const { skillId } = item;
  const current = readSkillSwitch(skillId);
  if (!item.switchable || item.state === target || (current && current.phase !== "failed")) return;
  contexts.set(skillId, context);
  setSkillSwitch(skillId, SAVING);
  let outcome: CapabilitySkillActionOutcome;
  try {
    outcome = await setCapabilitySkillState({
      workspaceId,
      skillId,
      state: REQUEST_STATE[target],
      expectedRevision: item.revision,
    });
  } catch (error) {
    const refusal = refusalOf(error);
    if (readSkillSwitch(skillId) === SAVING) fail(skillId, refusal.message, { conflict: refusal.conflict });
    return;
  }
  if (readSkillSwitch(skillId) === SAVING) receive(item, target, outcome);
}

/**
 * Follows the approval the list marks as waiting, unless this tab already took on how it ended. Says whether it did.
 * Nobody here asked for it, so it is a picked-up wait: not read out, and the row opens no panel for it. A panel
 * already open for the skill still shows its approval in place.
 */
function pickUpWait(item: CapabilitySkillItem, context: ListContext): boolean {
  const { skillId, pendingApprovalId: approvalId } = item;
  if (!approvalId || settled.has(approvalId)) return false;
  contexts.set(skillId, context);
  startWaiting({ phase: "waiting", skillId, approvalId, from: item.state, recovered: true });
  return true;
}

/** Whether a failure's line no longer says anything true about the skill the list shows. */
function failureOutdated(entry: FailedEntry, item: CapabilitySkillItem): boolean {
  // A change still being applied when the checks ran out: the line goes once the list shows it.
  if (entry.change) return shows(entry.change, item);
  // A conflict keeps its line and its Reload until the operator reloads: the list read after it is newer by nature.
  if (entry.conflict) return false;
  // Any other line (a decline, an expiry, a refusal) is about the version it failed on.
  return entry.revision !== undefined && item.revision !== entry.revision;
}

/** Takes on what the list says about the skill: a wait from before a reload, or a change that now shows. */
function observe(item: CapabilitySkillItem, context: ListContext) {
  const { skillId } = item;
  const entry = readSkillSwitch(skillId);
  if (!entry) {
    pickUpWait(item, context);
    return;
  }
  if (entry.phase === "saving") return;
  if (entry.phase === "failed") {
    // A newer approval the list marks (asked for again in Chat, or the one a duplicate refusal points at) replaces the
    // line, because the Skills tab is the only place a skill approval can be decided. The approval this tab saw end is
    // settled, so its line stays until the next click, or until the skill moves past it.
    if (!pickUpWait(item, context) && failureOutdated(entry, item)) setSkillSwitch(skillId, undefined);
    return;
  }
  if (shows(entry, item)) return finish(skillId);
  // A picked-up wait whose mark the list dropped: its approval is read now to learn how it ended.
  if (entry.phase === "waiting" && entry.recovered && item.pendingApprovalId !== entry.approvalId) {
    if (checkedGone.has(entry.approvalId)) return;
    checkedGone.add(entry.approvalId);
    void checkApproval(skillId);
  }
}

/**
 * The switch of one skill. Every view of the skill (its row, the open panel) reads the same entry, so a request, a wait
 * for approval or a failure shows on all of them and outlasts each. It is never ahead of the list: any change may wait
 * for an approval, so the switch shows the list's state until the list shows the change. `item` should be the live
 * row from the cached list.
 */
export function useSkillSwitch(item: CapabilitySkillItem): SkillSwitch {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const listKey = skillListQuery(workspaceId).queryKey;
  const entry = useSkillSwitchEntry(item.skillId);

  useEffect(() => {
    observe(item, { client, listKey: skillListQuery(workspaceId).queryKey });
  }, [client, workspaceId, item, entry]);

  const context = { client, listKey };
  const failure = failureOf(entry);
  return {
    checked: item.state !== "off",
    paused: item.state === "paused",
    pending: entry?.phase === "saving" || entry?.phase === "applying",
    waiting: entry?.phase === "waiting",
    ...(entry?.phase === "waiting" ? { waitingApprovalId: entry.approvalId } : {}),
    ...(entry?.phase === "waiting" && entry.target ? { waitingTarget: entry.target } : {}),
    waitStartedHere: entry?.phase === "waiting" && !entry.recovered,
    ...(failure ? { failure } : {}),
    setOn: (next) => void send(item, next ? "on" : "off", workspaceId, context),
    setPaused: (next) => void send(item, next ? "paused" : "on", workspaceId, context),
    reload: () => {
      if (readSkillSwitch(item.skillId)?.phase === "failed") setSkillSwitch(item.skillId, undefined);
      void readList(context);
    },
    checkApproval: () => checkApprovalNow(item.skillId),
  };
}

export function __resetSkillSwitchesForTests() {
  contexts.clear();
  reading.clear();
  beats.clear();
  misses.clear();
  settled.clear();
  checkedGone.clear();
  __resetSkillSwitchStoreForTests();
}
