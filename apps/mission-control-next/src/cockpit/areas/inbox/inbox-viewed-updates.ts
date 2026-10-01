import { useCallback, useSyncExternalStore } from "react";
import { canonicalJsonString, type OperatorInboxItem } from "@goatcitadel/contracts";

// Presentation only: no persisted acknowledgement, archive or change to Gateway counts.
const viewed = new Map<string, ReadonlySet<string>>();
const EMPTY = new Set<string>();
const listeners = new Set<() => void>();
const scopeKey = (installation: string, workspaceId: string) => JSON.stringify([installation, workspaceId]);
const snapshot = (key: string) => viewed.get(key) ?? EMPTY;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function inboxUpdateVersion(item: OperatorInboxItem, workspaceId: string): string | undefined {
  if (
    !workspaceId.trim() ||
    !item.id ||
    item.source.workspaceId !== workspaceId ||
    item.group !== "updates" ||
    item.riskLevel ||
    item.source.approvalId ||
    item.source.planId ||
    item.source.proposalId ||
    item.source.promptId ||
    item.source.deadLetterId ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    (item.updatedAt && !Number.isFinite(Date.parse(item.updatedAt)))
  )
    return undefined;
  if (item.kind === "task_deliverable") {
    if (!item.source.taskId || !item.source.deliverableId) return undefined;
  } else if (item.kind === "completed_background_run") {
    if (!item.source.runId) return undefined;
  } else return undefined;
  return canonicalJsonString(item);
}

export function isInboxUpdateViewed(installation: string, workspaceId: string, item: OperatorInboxItem): boolean {
  const version = inboxUpdateVersion(item, workspaceId);
  return version !== undefined && snapshot(scopeKey(installation, workspaceId)).has(version);
}

export function markInboxUpdateViewed(installation: string, workspaceId: string, item: OperatorInboxItem): boolean {
  const version = inboxUpdateVersion(item, workspaceId);
  if (!installation.trim() || version === undefined) return false;
  const key = scopeKey(installation, workspaceId);
  const previous = snapshot(key);
  if (previous.has(version)) return true;
  // Bound retained presentation memory. Evicted versions simply appear as unviewed again.
  const next = new Set([...previous].slice(-499));
  next.add(version);
  viewed.delete(key);
  viewed.set(key, next);
  if (viewed.size > 32) viewed.delete(viewed.keys().next().value!);
  for (const listener of listeners) listener();
  return true;
}

export function useInboxViewedUpdates(installation: string, workspaceId: string) {
  const key = scopeKey(installation, workspaceId);
  const versions = useSyncExternalStore(
    subscribe,
    () => snapshot(key),
    () => EMPTY,
  );
  const isViewed = useCallback(
    (item: OperatorInboxItem) => {
      const version = inboxUpdateVersion(item, workspaceId);
      return version !== undefined && versions.has(version);
    },
    [versions, workspaceId],
  );
  return { isViewed };
}

export function __resetInboxViewedUpdatesForTests() {
  viewed.clear();
  for (const listener of listeners) listener();
}
