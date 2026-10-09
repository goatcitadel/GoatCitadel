import { useLayoutEffect, useRef, useState } from "react";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { commitTaskDetailReview, taskRecordsEqual, type TaskDetailChange } from "./task-detail-mutation";
import { taskMutationKey, useTaskMutation } from "./task-mutation-state";

export function useTaskDetailReview(task: TaskRecord, workspaceId: string) {
  const base = getGatewayApiBaseUrl();
  const key = taskMutationKey(base, workspaceId, task.taskId);
  const attempt = useTaskMutation(key);
  const live = useRef({ key, task, mounted: true, generation: 0, ownerGeneration: 0 });
  if (live.current.key !== key) {
    live.current = {
      ...live.current,
      key,
      task,
      generation: live.current.generation + 1,
      ownerGeneration: live.current.ownerGeneration + 1,
    };
  } else if (!taskRecordsEqual(live.current.task, task)) {
    live.current = { ...live.current, task, ownerGeneration: live.current.ownerGeneration + 1 };
  }
  const [review, setReview] = useState<{
    task: TaskRecord;
    change: TaskDetailChange;
    key: string;
    generation: number;
    ownerGeneration: number;
  } | null>(null);
  const [message, setMessage] = useState<{ key: string; text: string } | null>(null);
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      live.current.mounted = false;
      live.current.generation++;
    };
  }, []);
  const invalidate = () => {
    live.current.generation++;
    setReview(null);
  };
  const visibleReview =
    review?.key === key &&
    review.generation === live.current.generation &&
    review.ownerGeneration === live.current.ownerGeneration
      ? review
      : null;
  const begin = (record: TaskRecord, change: TaskDetailChange) => {
    invalidate();
    if (attempt.phase !== "idle" || !taskRecordsEqual(record, task)) return;
    setMessage(null);
    setReview({
      task: record,
      change,
      key,
      generation: live.current.generation,
      ownerGeneration: live.current.ownerGeneration,
    });
  };
  const confirm = async (onConfirmed: (saved: TaskRecord) => void, directChange?: TaskDetailChange) => {
    // Routine board edits use the same fresh preflight and receipt owner without a risk dialog.
    const origin = directChange ? { task, change: directChange, key, generation: live.current.generation, ownerGeneration: live.current.ownerGeneration } : visibleReview;
    if (!origin) return;
    const viewCurrent = () =>
      live.current.mounted && live.current.key === origin.key && live.current.generation === origin.generation;
    const current = () => viewCurrent() && live.current.ownerGeneration === origin.ownerGeneration;
    const result = await commitTaskDetailReview({
      task: origin.task,
      workspaceId,
      base,
      change: origin.change,
      current,
    });
    // An owner refresh can publish this exact save before its HTTP response settles.
    // Accept that one transition only after receipt/readback verification; other owner
    // transitions (including ABA), newer input, and navigation still invalidate this view.
    const ownRefresh =
      result.kind === "confirmed" &&
      live.current.ownerGeneration === origin.ownerGeneration + 1 &&
      taskRecordsEqual(live.current.task, result.task);
    if (!viewCurrent() || (!current() && !ownRefresh)) return;
    setReview(null);
    if (result.kind === "confirmed") {
      // A presentation callback is outside the mutation evidence contract.
      try {
        onConfirmed(result.task);
      } catch {
        setMessage({
          key,
          text: "The Gateway save was confirmed, but this view could not refresh. Reopen the current task record.",
        });
      }
    } else if (result.kind !== "cancelled") setMessage({ key, text: result.message });
  };
  return {
    begin,
    confirm,
    invalidate,
    review: visibleReview,
    message: attempt.message ?? (message?.key === key ? message.text : null),
    busy: attempt.phase === "pending",
    locked: attempt.phase !== "idle",
    uncertain: attempt.phase === "uncertain",
  };
}
