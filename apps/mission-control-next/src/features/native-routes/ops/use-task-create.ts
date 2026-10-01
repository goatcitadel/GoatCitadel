import { useLayoutEffect, useRef, useState } from "react";
import { canonicalJsonString } from "@goatcitadel/contracts";
import type { TaskRecord } from "@goatcitadel/mission-control-shared/api/types";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  commitTaskCreate,
  normalizeTaskCreateDraft,
  taskCreateKey,
  type TaskCreateDraft,
} from "./task-create-mutation";
import { useTaskMutation } from "./task-mutation-state";

export function useTaskCreate(options: {
  workspaceId: string;
  citadelId?: string;
  viewIdentity?: string;
  draft: TaskCreateDraft;
  onRecorded?: (task: TaskRecord, submitted: TaskCreateDraft) => TaskCreateDraft | void;
}) {
  const base = getGatewayApiBaseUrl();
  const key = taskCreateKey(base, options.workspaceId);
  const identity = canonicalJsonString([base, options.workspaceId, options.citadelId, options.draft, options.viewIdentity]);
  const live = useRef({ identity, generation: 0, lifetime: 0, mounted: true });
  if (live.current.identity !== identity) {
    live.current.identity = identity;
    live.current.generation++;
  }
  const generation = live.current.generation;
  const attempt = useTaskMutation(key);
  const [review, setReview] = useState<{
    generation: number;
    lifetime: number;
    submitted: TaskCreateDraft;
    draft: TaskCreateDraft;
  }>();
  const [feedback, setFeedback] = useState<{ identity: string; text: string }>();
  useLayoutEffect(() => {
    const owner = live.current;
    owner.mounted = true;
    return () => {
      owner.mounted = false;
      owner.lifetime++;
    };
  }, []);
  const invalidate = () => {
    live.current.generation++;
    setReview(undefined);
  };
  const current = (expected: number) =>
    live.current.mounted &&
    live.current.identity === identity &&
    live.current.generation === expected &&
    getGatewayApiBaseUrl() === base;
  const visibleReview = review?.generation === generation ? review : undefined;
  function begin() {
    if (!current(generation) || attempt.phase !== "idle") return;
    try {
      const draft = normalizeTaskCreateDraft(options.draft);
      invalidate();
      setFeedback(undefined);
      setReview({
        generation: live.current.generation,
        lifetime: live.current.lifetime,
        submitted: structuredClone(options.draft),
        draft,
      });
    } catch (error) {
      setFeedback({ identity, text: error instanceof Error ? error.message : "Task review unavailable." });
    }
  }
  async function confirm(onConfirmed: (task: TaskRecord, isCurrent: () => boolean) => unknown) {
    const origin = visibleReview;
    if (!origin || !current(origin.generation) || live.current.lifetime !== origin.lifetime) return;
    // Consume this exact review synchronously, including queued callbacks from the previous render.
    live.current.generation++;
    const dispatchGeneration = live.current.generation;
    let acknowledgedIdentity: string | undefined;
    const owns = () => live.current.lifetime === origin.lifetime && (
      current(dispatchGeneration) || (
        acknowledgedIdentity !== undefined && acknowledgedIdentity !== identity &&
        live.current.mounted && getGatewayApiBaseUrl() === base &&
        live.current.identity === acknowledgedIdentity && live.current.generation === dispatchGeneration + 1
      )
    );
    setReview(undefined);
    const result = await commitTaskCreate({
      base,
      workspaceId: options.workspaceId,
      citadelId: options.citadelId,
      draft: origin.draft,
      current: owns,
    });
    if (result.kind === "confirmed") {
      // Confirmed origin drafts can settle after navigation; newer input is protected by acceptSaved.
      const originCurrent = owns();
      try {
        const acknowledged = options.onRecorded?.(result.task, origin.submitted);
        // Permit only this verified acknowledgement's one exact input transition.
        // Off-view settlement, new input, explicit invalidation and ABA cannot adopt it.
        if (originCurrent && acknowledged) acknowledgedIdentity = canonicalJsonString([
          base, options.workspaceId, options.citadelId, acknowledged, options.viewIdentity,
        ]);
      } catch {
        /* Preserve confirmed owner truth. */
      }
    }
    if (!owns()) return;
    setReview(undefined);
    if (result.kind === "confirmed") {
      try {
        await onConfirmed(result.task, owns);
      } catch {
        if (owns())
          setFeedback({
            identity: live.current.identity,
            text: "The task was created and confirmed, but this view could not refresh. Reopen its current record.",
          });
      }
    } else if (result.kind !== "cancelled") setFeedback({ identity, text: result.message });
  }
  return {
    begin,
    confirm,
    invalidate,
    review: visibleReview?.draft,
    attempt,
    message: attempt.message ?? (feedback?.identity === identity ? feedback.text : undefined),
    busy: attempt.phase === "pending",
    locked: attempt.phase !== "idle",
    uncertain: attempt.phase === "uncertain",
  };
}
