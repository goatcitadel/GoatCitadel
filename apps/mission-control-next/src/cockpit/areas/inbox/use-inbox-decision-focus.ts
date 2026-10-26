import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { requestCockpitToast } from "../../ui/toast-runtime";
import type { WindowedRecordListHandle } from "../../ui/WindowedRecordList";
import { inboxItemTitle } from "./inbox-presentation";
import type { InboxViewGroupId } from "./inbox-triage";

type FocusTarget = { kind: "item"; id: string } | { kind: "empty" } | { kind: "notice" };

/** The inspector is a modal dialog or phone sheet: focus cannot leave it, so the decision notice inside takes it. */
function inspectorIsModal() {
  return Boolean(document.querySelector('[role="dialog"] [data-inspector-body="true"]'));
}

const RECORDED_DECISION = /^Decision recorded: (Approved with edits|Approved|Denied)\.\s*(.*)$/su;

/**
 * Names the item in the outcome: "Denied Review file write." (plus any follow-on note). A message that is not a
 * recorded approval decision, such as a changed record, is announced as it is.
 */
export function decisionOutcome(title: string, message: string): { verdict: string | null; announcement: string } {
  const match = RECORDED_DECISION.exec(message);
  if (!match) return { verdict: null, announcement: message };
  const verdict = `${match[1]} ${title}.`;
  return { verdict, announcement: [verdict, match[2]].filter(Boolean).join(" ") };
}

/**
 * The single owner of what happens after an Inbox decision (IN-07): the outcome is announced once through the
 * page announcer, then focus moves once, to the next item, or to the empty state when nothing is left. A record
 * that changed instead of settling keeps its place, so focus goes to the decision notice that explains it.
 */
export function useInboxDecisionFocus({
  orderedItems,
  groupOf,
  listHandles,
  select,
  announce,
}: {
  orderedItems: OperatorInboxItem[];
  groupOf: (item: OperatorInboxItem) => InboxViewGroupId;
  listHandles: MutableRefObject<Map<string, WindowedRecordListHandle>>;
  select: (id: string) => void;
  announce: (message: string) => void;
}) {
  const pending = useRef<FocusTarget | null>(null);
  const latest = useRef(orderedItems);
  latest.current = orderedItems;

  const onDecision = useCallback(
    (item: OperatorInboxItem, message: string, settled: boolean) => {
      const outcome = decisionOutcome(inboxItemTitle(item), message);
      announce(outcome.announcement);
      // The row leaves the list, so a sighted reader also gets a brief confirmation of what just happened.
      const verdict = outcome.verdict;
      if (settled && verdict)
        requestCockpitToast(
          (toast) => void toast(verdict, { duration: 4000 }),
          () => true,
        );
      if (!settled) {
        pending.current = { kind: "notice" };
        return;
      }
      const items = latest.current;
      const index = items.findIndex((entry) => entry.id === item.id);
      const remaining = items.filter((entry) => entry.id !== item.id);
      const next =
        remaining.slice(Math.max(index, 0)).find((entry) => entry.group === item.group) ??
        remaining.find((entry) => entry.group === item.group) ??
        remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
      pending.current = next ? { kind: "item", id: next.id } : { kind: "empty" };
      if (next) select(next.id);
    },
    [announce, select],
  );

  // Runs after every commit: a target that is not on the page yet (the empty state) waits for the render that adds it.
  useEffect(() => {
    const target = pending.current;
    if (!target) return;
    if (target.kind === "item" && inspectorIsModal()) pending.current = { kind: "notice" };
    // A closing confirmation dialog hands focus back to its trigger on a zero-delay timer; move focus after it.
    const timer = setTimeout(() => {
      const current = pending.current;
      if (!current) return;
      if (current.kind === "notice") {
        const notice = document.querySelector<HTMLElement>("[data-inbox-decision-notice]");
        if (!notice) return;
        pending.current = null;
        notice.focus();
      } else if (current.kind === "item") {
        const item = latest.current.find((entry) => entry.id === current.id);
        pending.current = null;
        if (item) listHandles.current.get(groupOf(item))?.focusRecord(item.id, "[data-inbox-detail]");
      } else {
        if (latest.current.length) return;
        // The Inbox empty state, or the filter summary when filters hide the remaining items.
        const empty =
          document.querySelector<HTMLElement>("[data-inbox-empty]") ??
          document.querySelector<HTMLElement>("[data-inbox-filter-summary]");
        if (!empty) return;
        pending.current = null;
        empty.focus();
      }
    }, 0);
    return () => clearTimeout(timer);
  });

  const focusPending = useCallback(() => pending.current !== null, []);
  return useMemo(() => ({ onDecision, focusPending }), [onDecision, focusPending]);
}
