import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";
import { fetchChangePlan } from "@goatcitadel/mission-control-shared/api/client";
import { getErrorMessage } from "../SettingsShared";
import type { ProviderNoticeSetter } from "./provider-section-types";
import { confirmReviewedSettingsPlan, submitReviewedProviderCredential } from "./provider-connection-actions";
import {
  beginProviderMutation,
  finishProviderMutation,
  retainProviderMutationUncertainty,
  useProviderEditorEpoch,
  useProviderMutationState,
} from "./provider-mutation-state";

export function useProviderPlanActions(options: {
  plan: ChangePlanRecord | null;
  setPlan: (plan: ChangePlanRecord | null) => void;
  setNotice: ProviderNoticeSetter;
  onSettled: () => Promise<unknown>;
  onAcknowledged?: (plan: ChangePlanRecord) => void;
  viewIdentity?: unknown;
}) {
  const mutation = useProviderMutationState();
  const capture = useProviderEditorEpoch(options.plan);
  const captureView = useProviderEditorEpoch(options.viewIdentity);
  async function act(plan: ChangePlanRecord, credential?: string) {
    if (
      credential === undefined
        ? plan.requiredAction?.kind !== "confirmation"
        : plan.requiredAction?.kind !== "secure_input" || !credential.trim()
    ) {
      options.setNotice({
        tone: "warning",
        message: "Refresh and review the current provider action before continuing.",
      });
      return;
    }
    if (options.plan !== plan || !beginProviderMutation()) return;
    const isCurrent = capture();
    const viewCurrent = captureView();
    let attempted = false;
    let acknowledged = false;
    try {
      const fresh = await fetchChangePlan(plan.planId, {
        workspaceId: plan.origin.workspaceId,
        sessionId: plan.origin.sessionId,
        turnId: plan.origin.turnId,
      });
      if (!isCurrent() || !viewCurrent()) return;
      if (canonicalJsonString(fresh) !== canonicalJsonString(plan))
        throw new Error("This reviewed provider action changed. Refresh its status and review it again.");
      attempted = true;
      const next =
        credential === undefined
          ? await confirmReviewedSettingsPlan(plan)
          : await submitReviewedProviderCredential(plan, credential);
      acknowledged = true;
      if (viewCurrent()) options.onAcknowledged?.(next);
      if (isCurrent()) options.setPlan(credential === undefined ? null : next);
      await options.onSettled();
      if (viewCurrent())
        options.setNotice({
          tone: ["completed", "applied"].includes(next.status) ? "success" : "info",
          message: next.result?.summary ?? next.summary,
        });
    } catch (error) {
      if (attempted && !acknowledged) retainProviderMutationUncertainty();
      if (viewCurrent())
        options.setNotice({
          tone: "error",
          message: acknowledged
            ? "The Gateway acknowledged the provider action, but refreshing evidence failed. Inspect its saved status."
            : getErrorMessage(error),
        });
    } finally {
      finishProviderMutation();
    }
  }
  return {
    mutation,
    confirm: (plan: ChangePlanRecord) => act(plan),
    secure: (plan: ChangePlanRecord, values: Record<string, string>) =>
      act(plan, values.credential ?? values.apiKey ?? ""),
  };
}
