import type { ApprovalListResponse, ApprovalRequest, DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { runString, runWorkspaceId } from "./inbox-projection-model.js";

/** Reverse canonical linkage is absent from some in-flight turn projections.
 * Read bounded indexed execution-linkage pages through the approval owner; never infer from a
 * shared session or treat the approval-wait run as the original Chat run. */
export async function loadRunLinkedApprovals(
  storage: Storage,
  run: DurableRunRecord,
): Promise<{ items: ApprovalRequest[]; incomplete: boolean }> {
  const workspaceId = runWorkspaceId(run);
  const sessionId = runString(run, "sessionId");
  // Do not broaden discovery to all workspaces when the durable owner lacks scope.
  if (!workspaceId) return { items: [], incomplete: true };
  const items: ApprovalRequest[] = [];
  let cursor: string | undefined;
  for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
    const result: { value?: ApprovalListResponse; error?: Error } = await safeReadAsync(() =>
      storage.approvals.listByRunLinkage({
        workspaceId,
        runId: run.runId,
        sessionId: sessionId ?? undefined,
        limit: 200,
        cursor,
      }),
    );
    if (!result.value) return { items, incomplete: true };
    for (const approval of result.value.items) {
      const linkage = approval.linkage;
      if (linkage?.workspaceId !== workspaceId || (sessionId && linkage.sessionId && linkage.sessionId !== sessionId))
        continue;
      if (linkage.runId === run.runId || linkage.durableRunId === run.runId) items.push(approval);
    }
    const nextCursor = result.value.nextCursor;
    if (!nextCursor) return { items, incomplete: false };
    if (nextCursor === cursor) return { items, incomplete: true };
    cursor = nextCursor;
  }
  return { items, incomplete: true };
}

export async function safeReadAsync<T>(read: () => Promise<T>): Promise<{ value?: T; error?: Error }> {
  try {
    return { value: await read() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}
