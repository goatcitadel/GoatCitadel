import { useRef, useState } from "react";
import { canonicalJsonString, type ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import {
  createExternalSideEffectReplayAuditRun,
  fetchExternalSideEffectRuns,
  fetchDurableRun,
} from "@goatcitadel/mission-control-shared/api/client";
import { beginIntegrationMutation, useIntegrationConnectionMutation } from "../integration-connection-mutation";
import { getErrorMessage } from "../SettingsShared";
import type { IntegrationSettingsState } from "./use-integration-settings-state";

export interface IntegrationReplayReview {
  run: ExternalSideEffectRunRecord;
  isCurrent: () => boolean;
}
export const isReplayAuditCandidate = (run: ExternalSideEffectRunRecord) =>
  ["failed_before_boundary", "claimed_not_sent"].includes(run.status);

export function useIntegrationReplayActions(s: IntegrationSettingsState) {
  const [review, setReview] = useState<IntegrationReplayReview | null>(null);
  const latest = useRef(review);
  latest.current = review;
  const active = useRef<object | null>(null);
  const key = `external-replay-audit:${s.activeWorkspaceId}`;
  const replayMutation = useIntegrationConnectionMutation(key);
  const handleStartReplayAudit = (run?: ExternalSideEffectRunRecord) => {
    if (
      !run ||
      !isReplayAuditCandidate(run) ||
      run.workspaceId !== s.activeWorkspaceId ||
      replayMutation.locked ||
      !s.data?.sideEffectRuns.some((item) => canonicalJsonString(item) === canonicalJsonString(run))
    )
      return;
    setReview({ run, isCurrent: s.isCurrent });
  };
  const confirmReplayAudit = async () => {
    const reviewed = review;
    if (!reviewed?.isCurrent() || latest.current !== reviewed) return;
    const operation = beginIntegrationMutation(key);
    if (!operation) return;
    const token = {};
    active.current = token;
    s.setReplayAuditBusy(true);
    const current = () => reviewed.isCurrent() && latest.current === reviewed;
    try {
      const { run } = reviewed;
      const snapshot = await fetchExternalSideEffectRuns({
        workspaceId: run.workspaceId,
        ...(run.connectionId ? { connectionId: run.connectionId } : {}),
        limit: 25,
      });
      if (!current()) return;
      if (!snapshot.items.some((item) => canonicalJsonString(item) === canonicalJsonString(run)))
        throw new Error(
          "The reviewed side-effect record changed or is outside the current owner window. Refresh before requesting an audit.",
        );
      const input = {
        workspaceId: run.workspaceId,
        requestedBy: "operator",
        runIds: [run.runId],
        ...(run.connectionId ? { connectionId: run.connectionId } : {}),
        limit: 1,
        requestedAt: new Date().toISOString(),
      };
      const payload = { version: "external_side_effect.replay.v1", ...input };
      const result = await operation.write(
        () => createExternalSideEffectReplayAuditRun(input),
        async (receipt) => {
          if (
            !receipt.runId ||
            receipt.workflowKey !== "external_side_effect.replay" ||
            canonicalJsonString(receipt.payload) !== canonicalJsonString(payload) ||
            receipt.metadata?.posture !== "replay_audit" ||
            receipt.metadata.sideEffectPosture !== "eligibility_check"
          )
            throw new Error("The durable owner did not confirm this exact replay-audit request.");
          const saved = await fetchDurableRun(receipt.runId);
          if (
            saved.runId !== receipt.runId ||
            saved.workflowKey !== receipt.workflowKey ||
            canonicalJsonString(saved.payload) !== canonicalJsonString(receipt.payload)
          )
            throw new Error("The durable audit could not be confirmed by its canonical owner.");
        },
      );
      if (!current()) return;
      setReview(null);
      s.setLastReplayAuditRunId(result.runId);
      s.setNotice({
        tone: "success",
        message: `Replay audit ${result.runId} was created and confirmed. Its durable owner decides eligibility; no external delivery is claimed here.`,
      });
      try {
        await s.reload();
      } catch {
        if (reviewed.isCurrent())
          s.setNotice({
            tone: "warning",
            message: "The durable audit was acknowledged, but refreshing delivery history failed.",
          });
      }
    } catch (error) {
      if (current()) s.setNotice({ tone: "error", message: getErrorMessage(error) });
    } finally {
      operation.finish();
      if (active.current === token) {
        active.current = null;
        s.setReplayAuditBusy(false);
      }
    }
  };
  return {
    handleStartReplayAudit,
    replayReview: review?.isCurrent() ? review : null,
    replayMutation,
    confirmReplayAudit,
    cancelReplayAudit: () => setReview(null),
  };
}
