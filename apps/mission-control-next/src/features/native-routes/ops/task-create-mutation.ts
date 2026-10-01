import { canonicalJsonString } from "@goatcitadel/contracts";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { createTask, fetchTask } from "@goatcitadel/mission-control-shared/api/tasks";
import { acquireTaskMutations } from "./task-mutation-state";

export type TaskCreateDraft = { title: string; description: string; priority: TaskRecord["priority"] };
export const TASK_CREATE_BOUNDARY =
  "Creates one workspace task record without launching an agent or run. The API has no revision precondition or reusable create identity; an unconfirmed response locks further creation in this workspace for this app session.";
export const taskCreateKey = (base: string, workspaceId: string) => JSON.stringify([base, "task-create", workspaceId]);
export type TaskCreateResult =
  | { kind: "confirmed"; task: TaskRecord }
  | { kind: "blocked" | "cancelled" | "uncertain"; message: string };

export function normalizeTaskCreateDraft(draft: TaskCreateDraft): TaskCreateDraft {
  const value = { title: draft.title.trim(), description: draft.description.trim(), priority: draft.priority };
  if (!value.title || !["low", "normal", "high", "urgent"].includes(value.priority))
    throw new Error("Enter a task title and choose a supported priority.");
  return value;
}

/** Shared UI admission and receipt checks; task creation and scope validation remain Gateway-owned. */
export async function commitTaskCreate(review: {
  base: string;
  workspaceId: string;
  citadelId?: string;
  draft: TaskCreateDraft;
  current: () => boolean;
}): Promise<TaskCreateResult> {
  const { base, workspaceId, citadelId } = review;
  const current = () => review.current() && getGatewayApiBaseUrl() === base;
  if (!current()) return { kind: "cancelled", message: "The task creation review is no longer current." };
  const admission = acquireTaskMutations([taskCreateKey(base, workspaceId)]);
  if (!admission) return { kind: "blocked", message: "Task creation is pending or unconfirmed in this workspace." };
  let dispatched = false;
  try {
    const draft = normalizeTaskCreateDraft(review.draft);
    if (!workspaceId.trim()) throw new Error("Select a workspace before creating a task.");
    if (!current()) return { kind: "cancelled", message: "The task creation review changed before dispatch." };
    dispatched = true;
    const receipt = await createTask({
      workspaceId,
      ...(citadelId ? { citadelId } : {}),
      title: draft.title,
      ...(draft.description ? { description: draft.description } : {}),
      priority: draft.priority,
    });
    if (getGatewayApiBaseUrl() !== base) throw new Error("The original Gateway installation changed.");
    const expected: TaskRecord = {
      taskId: receipt.taskId,
      workspaceId,
      title: draft.title,
      ...(draft.description ? { description: draft.description } : {}),
      priority: draft.priority,
      revision: 1,
      status: "inbox",
      createdAt: receipt.createdAt,
      updatedAt: receipt.createdAt,
    };
    if (
      !receipt.taskId?.trim() ||
      !Number.isFinite(Date.parse(receipt.createdAt)) ||
      canonicalJsonString(receipt) !== canonicalJsonString(expected)
    )
      throw new Error("The task creation receipt differs from the reviewed record.");
    const saved = await fetchTask(receipt.taskId, workspaceId, citadelId, { signal: new AbortController().signal });
    if (getGatewayApiBaseUrl() !== base || canonicalJsonString(saved) !== canonicalJsonString(receipt))
      throw new Error("The new task could not be confirmed by independent owner readback.");
    return { kind: "confirmed", task: saved };
  } catch (cause) {
    if (dispatched) {
      const message =
        "The create outcome is unconfirmed. Further task creation in this workspace is locked in both shells for this app session. Review current tasks before continuing.";
      admission.uncertain(message);
      return { kind: "uncertain", message };
    }
    return { kind: "blocked", message: cause instanceof Error ? cause.message : "The task could not be reviewed." };
  } finally {
    admission.settle();
  }
}
