import { useEffect } from "react";
import { isCancelledError, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type {
  CapabilityToolGroupItem,
  CapabilityToolGroupState,
  CapabilityToolsResponse,
  ChangePlanReceipt,
  ChangePlanRecord,
  ChangePlanRequiredAction,
  ToolGroupChange,
  ToolGroupId,
} from "@goatcitadel/contracts";
import { fetchChangePlan, fetchChangePlans } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { patchSettings } from "@goatcitadel/mission-control-shared/api/settings-operations";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { toolListQuery } from "../../../data/capability-tools-query";
import { DONE, ENDED } from "../change-plan-outcome";
import {
  __resetToolGroupSwitchStoreForTests,
  CONFIRMING,
  isAnyToolGroupSaving,
  isFollowing,
  readToolGroupSwitch,
  SAVING,
  setToolGroupPlanReader,
  setToolGroupSwitch,
  useToolGroupSwitchEntry,
  type ToolGroupSwitchEntry,
} from "./tool-group-switch-store";

/** Settings saves make their plans in the installation's own workspace, whichever workspace the page shows. */
const PLAN_CONTEXT = { workspaceId: "default" } as const;
/** How many plans waiting in Inbox one read after a reload looks through. */
const RECOVERY_LIMIT = 100;

const CONFLICT = "Changed elsewhere. Reload to see the latest.";
const NOT_SWITCHED_ON = "Not switched on.";
const NOT_SWITCHED_OFF = "Not switched off.";
const DECLINED = "The change was declined in Inbox.";
const EXPIRED = "The request expired.";
const CANCELLED = "The request was cancelled.";
const SETTINGS_CHANGED = "Settings changed while this waited in Inbox.";
/** What the Gateway's runtime settings owner says when the settings moved on after a plan was prepared. */
const SETTINGS_CHANGED_SUMMARY = "Runtime settings changed after this Change Plan was prepared.";

export interface ToolGroupSwitch {
  /** What the switch shows: the group's state in the list. Off shows at once; On only once the list says so. */
  checked: boolean;
  /** A save, the plan it made, or the read that confirms it is running. */
  pending: boolean;
  /** The change waits on an approval in Inbox. The switch keeps its old state until the approval lands. */
  waiting: boolean;
  /** The Inbox approval the change waits on, when the plan names it. */
  waitingApprovalId?: string;
  /** Why the last change didn't happen, in plain words. `conflict` means `reload` is the way forward. */
  failure?: { message: string; conflict: boolean };
  setEnabled(next: boolean): void;
  /** Reads the list again and drops the last failure. */
  reload(): void;
}

/** What following one group's change needs once no view of it is mounted: where its list lives. */
interface ListContext {
  readonly client: QueryClient;
  readonly listKey: QueryKey;
}

const contexts = new Map<ToolGroupId, ListContext>();
const reading = new Set<ToolGroupId>();

const approvalIdOf = (action: ChangePlanRequiredAction | undefined) =>
  action?.kind === "approval" ? action.approvalId : undefined;

/** A copy of the list with one group's state changed. Every other group is kept as it is. */
function withState(list: CapabilityToolsResponse | undefined, groupId: ToolGroupId, state: CapabilityToolGroupState) {
  return list
    ? { ...list, groups: list.groups.map((group) => (group.groupId === groupId ? { ...group, state } : group)) }
    : list;
}

function putState({ client, listKey }: ListContext, groupId: ToolGroupId, state: CapabilityToolGroupState) {
  client.setQueryData<CapabilityToolsResponse>(listKey, (list) => withState(list, groupId, state));
}

/** The switch change a plan makes, when it is a tool group plan whose target is that group. */
function toolGroupChangeOf(plan: ChangePlanRecord | undefined): ToolGroupChange | undefined {
  const request = plan?.request;
  if (request?.kind !== "runtime_configuration" || request.change.operation !== "tool_group_access") return undefined;
  const { groupId, enabled } = request.change;
  return plan?.target?.resourceId === `tool_group_access:${groupId}` ? { groupId, enabled } : undefined;
}

/** Where a change goes next from a plan that isn't finished: waiting in Inbox, or still being applied. */
function followEntry(plan: Pick<ChangePlanReceipt, "planId" | "status" | "requiredAction">, change: ToolGroupChange) {
  const follow = { groupId: change.groupId, planId: plan.planId, enabled: change.enabled };
  if (plan.status !== "awaiting_approval") return { phase: "applying", ...follow } as const;
  const approvalId = approvalIdOf(plan.requiredAction);
  return { phase: "waiting", ...follow, ...(approvalId ? { approvalId } : {}) } as const;
}

type FollowEntry = Extract<ToolGroupSwitchEntry, { phase: "waiting" | "applying" }>;
const approvalOf = (entry: FollowEntry) => (entry.phase === "waiting" ? entry.approvalId : undefined);
/** Two entries that follow the same group's change the same way. Re-setting an equal one would only re-render. */
const sameFollow = (a: FollowEntry, b: FollowEntry) =>
  a.phase === b.phase && a.planId === b.planId && approvalOf(a) === approvalOf(b);

function fail(groupId: ToolGroupId, message: string, conflict = false) {
  setToolGroupSwitch(groupId, { phase: "failed", message, conflict });
  // Whatever the plan or request did, the list shows what the Gateway holds now.
  const context = contexts.get(groupId);
  if (context) void context.client.invalidateQueries({ queryKey: context.listKey });
}

/**
 * Reads the list again and says whether that worked. A cancelled read counts: another read took over. A failed read
 * leaves the last good rows (and the tab says it couldn't read them).
 */
async function readListAgain({ client, listKey }: ListContext): Promise<boolean> {
  try {
    await client.invalidateQueries({ queryKey: listKey }, { throwOnError: true });
    return true;
  } catch (error) {
    return isCancelledError(error);
  }
}

/** The change is made: the switch stays pending until the list read again shows it. */
async function confirm(groupId: ToolGroupId) {
  setToolGroupSwitch(groupId, CONFIRMING);
  const context = contexts.get(groupId);
  if (context) await readListAgain(context);
  if (readToolGroupSwitch(groupId) === CONFIRMING) setToolGroupSwitch(groupId, undefined);
}

/**
 * Whether the plan ended because another save moved the Settings revision before the approval. The apply refuses with
 * a `WRITE_CONFLICT` conflict, which the control plane records as a generic adapter failure whose summary is the
 * conflict's message, so the code and that message both count.
 */
function endedByChangedSettings(plan: ChangePlanRecord | undefined) {
  const result = plan?.result;
  return result?.failureCode === "WRITE_CONFLICT" || result?.summary === SETTINGS_CHANGED_SUMMARY;
}

/** Why the plan ended without switching, in plain words. The control plane's text for a denial or expiry isn't shown. */
function planEnded(groupId: ToolGroupId, enabled: boolean, plan: ChangePlanRecord | undefined) {
  const code = plan?.result?.failureCode;
  const reason =
    code === "approval_denied"
      ? DECLINED
      : code === "approval_expired" || code === "expired"
        ? EXPIRED
        : plan?.status === "cancelled"
          ? CANCELLED
          : endedByChangedSettings(plan)
            ? `${SETTINGS_CHANGED} Switch it ${enabled ? "on" : "off"} again.`
            : describeApiError(plan?.result?.summary).summary;
  fail(groupId, `${enabled ? NOT_SWITCHED_ON : NOT_SWITCHED_OFF} ${reason}`);
}

/** Reads the group's plan once and moves its switch on. The store's plan poll calls it while the entry follows a plan. */
async function readPlan(groupId: ToolGroupId) {
  const entry = readToolGroupSwitch(groupId);
  if (!isFollowing(entry) || reading.has(groupId)) return;
  reading.add(groupId);
  let plan: ChangePlanRecord;
  try {
    plan = await fetchChangePlan(entry.planId, PLAN_CONTEXT);
  } catch {
    // Ignore a missed read: the plan is still followed, and the next beat reads it again.
    return;
  } finally {
    reading.delete(groupId);
  }
  if (readToolGroupSwitch(groupId) !== entry) return;
  const change = toolGroupChangeOf(plan);
  if (plan?.planId !== entry.planId || change?.groupId !== groupId || change.enabled !== entry.enabled) {
    return planEnded(groupId, entry.enabled, undefined);
  }
  if (DONE.has(plan.status)) return void confirm(groupId);
  if (ENDED.has(plan.status)) return planEnded(groupId, entry.enabled, plan);
  const next = followEntry(plan, change);
  if (!sameFollow(entry, next)) setToolGroupSwitch(groupId, next);
}

setToolGroupPlanReader(readPlan);

/** Takes on the settings save's answer: a change that is made, one that waits in Inbox, or one still under way. */
function receive(groupId: ToolGroupId, enabled: boolean, receipt: ChangePlanReceipt | undefined) {
  // No receipt: Change Plans are off on this install, and the save made the change itself.
  if (!receipt?.planId || DONE.has(receipt.status)) return void confirm(groupId);
  setToolGroupSwitch(groupId, followEntry(receipt, { groupId, enabled }));
  // A plan waiting in Inbox is read at the poll's pace. One that ended or is under way is read now for its outcome.
  if (receipt.status !== "awaiting_approval") void readPlan(groupId);
}

async function save(group: CapabilityToolGroupItem, next: boolean, expectedRevision: number, context: ListContext) {
  const { groupId, state: before } = group;
  const current = readToolGroupSwitch(groupId);
  if (before === "always_on" || isAnyToolGroupSaving() || (current && current.phase !== "failed")) return;
  contexts.set(groupId, context);
  setToolGroupSwitch(groupId, SAVING);
  if (!next) {
    // Switching off is the safe direction, so it shows before the Gateway answers. A read that started before the
    // change would put the old state back; cancelling starts at once, so the row changes in the same turn as the click.
    void context.client.cancelQueries({ queryKey: context.listKey });
    putState(context, groupId, "off");
  }
  let saved: Awaited<ReturnType<typeof patchSettings>>;
  try {
    saved = await patchSettings({ expectedRevision, toolGroupChange: { groupId, enabled: next } });
  } catch (error) {
    // Only this group goes back, and only when it was changed. A newer list may have landed for the others.
    if (!next) putState(context, groupId, before);
    const described = describeApiError(error);
    const conflict = described.category === "conflict";
    // A request that reported a failure can still have been committed, so `fail` reads the list again.
    return fail(groupId, conflict ? CONFLICT : described.summary, conflict);
  }
  // The next save, of any group, has to start from the revision this one made. This says nothing about the switch.
  if (typeof saved?.revision === "number") {
    const revision = saved.revision;
    context.client.setQueryData<CapabilityToolsResponse>(context.listKey, (list) =>
      list ? { ...list, settingsRevision: revision } : list,
    );
  }
  const receipt = saved?.changePlanReceipt;
  // An Off that the Gateway hasn't made yet goes back until it is made.
  if (!next && receipt?.planId && !DONE.has(receipt.status)) putState(context, groupId, before);
  receive(groupId, next, receipt);
}

/**
 * Plans from before a reload that still wait in Inbox are read once per app session, when the first switch shows: a
 * reload forgets every entry, and the switch would otherwise offer On again while the old request waits.
 */
let recovery: "reading" | "done" | undefined;

function recoverWaits(context: ListContext) {
  if (recovery) return;
  recovery = "reading";
  fetchChangePlans(PLAN_CONTEXT, { status: "awaiting_approval", limit: RECOVERY_LIMIT }).then(
    (read) => {
      recovery = "done";
      for (const plan of read?.items ?? []) {
        const change = toolGroupChangeOf(plan);
        // A group this tab already follows or saves keeps what it has.
        if (!change || plan.status !== "awaiting_approval" || readToolGroupSwitch(change.groupId)) continue;
        contexts.set(change.groupId, context);
        setToolGroupSwitch(change.groupId, followEntry(plan, change));
      }
    },
    () => {
      // Nothing was taken on, so the next list read (a new revision) or the next view reads the plans again.
      recovery = undefined;
    },
  );
}

/**
 * The on/off switch of one tool group. Every view of the group (a Most used card, its row, the open panel) reads the
 * same entry, so a save, a wait in Inbox or a failure shows on all of them and outlasts each. Switching off shows in
 * the cached list at once and is put back for this group alone if it fails; switching on leaves the list alone until
 * the Gateway has made the change. `group` should be the live row from the cached list, and `settingsRevision` that
 * list's revision.
 */
export function useToolGroupSwitch(group: CapabilityToolGroupItem, settingsRevision: number): ToolGroupSwitch {
  const client = useQueryClient();
  const { activeWorkspaceId: workspaceId } = useUiPreferences();
  const listKey = toolListQuery(workspaceId).queryKey;
  const entry = useToolGroupSwitchEntry(group.groupId);

  useEffect(() => {
    recoverWaits({ client, listKey: toolListQuery(workspaceId).queryKey });
  }, [client, workspaceId, settingsRevision]);

  const waiting = entry?.phase === "waiting";
  return {
    checked: group.state !== "off",
    pending: entry?.phase === "saving" || entry?.phase === "applying" || entry?.phase === "confirming",
    waiting,
    ...(entry?.phase === "waiting" && entry.approvalId ? { waitingApprovalId: entry.approvalId } : {}),
    ...(entry?.phase === "failed" ? { failure: { message: entry.message, conflict: entry.conflict } } : {}),
    setEnabled: (next) => void save(group, next, settingsRevision, { client, listKey }),
    reload: () => {
      if (readToolGroupSwitch(group.groupId)?.phase === "failed") setToolGroupSwitch(group.groupId, undefined);
      void client.invalidateQueries({ queryKey: listKey });
    },
  };
}

export function __resetToolGroupSwitchesForTests() {
  recovery = undefined;
  contexts.clear();
  reading.clear();
  __resetToolGroupSwitchStoreForTests();
}
