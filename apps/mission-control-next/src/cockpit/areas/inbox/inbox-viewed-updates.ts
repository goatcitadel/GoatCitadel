import { useCallback, useSyncExternalStore } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import {
  acknowledgeLocalInboxUpdate,
  readLocalInboxUpdates,
  localInboxStorageAvailable,
  subscribeLocalInboxReads,
} from "@goatcitadel/mission-control-shared/api/inbox-local-read-store";
function references(raw: string): Array<{ id: string; version: string }> {
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data)
      ? data.filter((e) => e && typeof e.id === "string" && typeof e.version === "string")
      : [];
  } catch {
    return [];
  }
}
export function inboxUpdateVersion(item: OperatorInboxItem, workspaceId: string): string | undefined {
  if (
    !workspaceId.trim() ||
    !item.id ||
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
  if (
    item.kind === "task_deliverable"
      ? !item.source.taskId || !item.source.deliverableId
      : item.kind === "completed_background_run"
        ? !item.source.runId
        : true
  )
    return undefined;
  return item.group === "updates" &&
    item.source.workspaceId === workspaceId &&
    typeof item.version === "string" &&
    /^[a-f0-9]{64}$/.test(item.version)
    ? JSON.stringify([item.id, item.version])
    : undefined;
}

export function isInboxUpdateViewed(installation: string, workspaceId: string, item: OperatorInboxItem): boolean {
  return Boolean(
    inboxUpdateVersion(item, workspaceId) &&
    references(readLocalInboxUpdates(installation, workspaceId)).some(
      (e) => e.id === item.id && e.version === item.version,
    ),
  );
}
export async function markInboxUpdateViewed(
  installation: string,
  workspaceId: string,
  item: OperatorInboxItem,
  isCurrent?: () => boolean,
): Promise<boolean> {
  if (!inboxUpdateVersion(item, workspaceId)) return false;
  return acknowledgeLocalInboxUpdate(installation, workspaceId, { id: item.id, version: item.version! }, isCurrent);
}
export function useInboxViewedUpdates(installation: string, workspaceId: string) {
  const raw = useSyncExternalStore(
    subscribeLocalInboxReads,
    () => readLocalInboxUpdates(installation, workspaceId),
    () => "[]",
  );
  const available = useSyncExternalStore(
    subscribeLocalInboxReads,
    () => localInboxStorageAvailable(installation, workspaceId),
    () => false,
  );
  const isViewed = useCallback(
    (item: OperatorInboxItem) =>
      Boolean(
        inboxUpdateVersion(item, workspaceId) &&
        references(raw).some((e) => e.id === item.id && e.version === item.version),
      ),
    [raw, workspaceId],
  );
  return { isViewed, available };
}
export function __resetInboxViewedUpdatesForTests() {}
