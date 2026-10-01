import { useCallback } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  ApiRequestError,
  respondToChangePlan,
  submitChangePlanGatewayAuthCredential,
  submitChangePlanProviderSecret,
  submitChangePlanChannelSecrets,
} from "@goatcitadel/mission-control-shared/api/client";
import type { ChangePlanPublicValues } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { changePlanClientContext } from "./change-plan-controller-helpers";
import type { ChatChangePlanState } from "./useChatChangePlanState";

type Input = Pick<
  ChatChangePlanState,
  "setActiveChangePlan" | "setChangePlanActionError" | "setChangePlanActionPending"
> & {
  workspaceId: string;
  onOpenApprovals: (approvalId?: string) => void;
  recordChangePlanResult: (updated: ChangePlanRecord) => ChangePlanRecord;
};

export function useChatChangePlanOwnerActions({
  workspaceId,
  recordChangePlanResult,
  onOpenApprovals,
  setActiveChangePlan,
  setChangePlanActionError,
  setChangePlanActionPending,
}: Input) {
  const handleSubmitChangePlanForm = useCallback(
    async (plan: ChangePlanRecord, values: ChangePlanPublicValues) => {
      const action = plan.requiredAction;
      if (action?.kind !== "public_form") {
        setChangePlanActionError("The requested form is no longer current. Reload this Change Plan.");
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        recordChangePlanResult(
          await respondToChangePlan(plan.planId, changePlanClientContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
            values,
          }),
        );
      } catch (error) {
        setChangePlanActionError(
          error instanceof Error ? error.message : "Unable to submit these Change Plan details.",
        );
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [recordChangePlanResult, setChangePlanActionError, setChangePlanActionPending, workspaceId],
  );
  const handleSubmitChangePlanSecret = useCallback(
    async (plan: ChangePlanRecord, values: Readonly<Record<string, string>>) => {
      const action = plan.requiredAction;
      if (
        action?.kind !== "secure_input" ||
        (plan.request.kind !== "provider_connection" &&
          plan.request.kind !== "channel_connection" &&
          !(
            plan.request.kind === "runtime_configuration" &&
            plan.request.change.operation === "gateway_auth_configuration"
          ))
      ) {
        setChangePlanActionError(
          "This secure owner action changed. Reload the Change Plan before entering a credential.",
        );
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        const exactAction = {
          expectedRevision: plan.revision,
          actionId: action.actionId,
          actionNonce: action.actionNonce,
        };
        const context = changePlanClientContext(workspaceId, plan);
        const result =
          plan.request.kind === "provider_connection"
            ? await submitChangePlanProviderSecret(plan.planId, context, {
                ...exactAction,
                apiKey: values.credential ?? Object.values(values)[0] ?? "",
              })
            : plan.request.kind === "channel_connection"
              ? await submitChangePlanChannelSecrets(plan.planId, context, { ...exactAction, values })
              : await submitChangePlanGatewayAuthCredential(plan.planId, context, {
                  ...exactAction,
                  credential: Object.values(values)[0] ?? "",
                });
        recordChangePlanResult(result);
      } catch (error) {
        setChangePlanActionError(error instanceof Error ? error.message : "Unable to submit this credential securely.");
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [recordChangePlanResult, setChangePlanActionError, setChangePlanActionPending, workspaceId],
  );
  const handleReviewChangePlanArtifacts = useCallback(
    async (plan: ChangePlanRecord) => {
      const action = plan.requiredAction;
      if (action?.kind !== "artifact_review") {
        setChangePlanActionError("The artifact review changed. Reload this Change Plan.");
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        recordChangePlanResult(
          await respondToChangePlan(plan.planId, changePlanClientContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
            values: {},
          }),
        );
      } catch (error) {
        setChangePlanActionError(error instanceof Error ? error.message : "Unable to acknowledge the artifact review.");
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [recordChangePlanResult, setChangePlanActionError, setChangePlanActionPending, workspaceId],
  );
  const handleOpenChangePlanApproval = useCallback(
    async (plan: ChangePlanRecord) => {
      const action = plan.requiredAction;
      if (action?.kind !== "approval" || !action.approvalId) {
        setChangePlanActionError("The canonical approval is not available yet.");
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        const result = await respondToChangePlan(plan.planId, changePlanClientContext(workspaceId, plan), {
          expectedRevision: plan.revision,
          actionId: action.actionId,
          actionNonce: action.actionNonce,
          values: {},
        });
        recordChangePlanResult(result);
      } catch (error) {
        if (error instanceof ApiRequestError && error.status === 409) {
          onOpenApprovals(action.approvalId);
          setActiveChangePlan(null);
        } else {
          setChangePlanActionError(
            error instanceof Error ? error.message : "Unable to resume this approved Change Plan.",
          );
        }
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [
      onOpenApprovals,
      recordChangePlanResult,
      setActiveChangePlan,
      setChangePlanActionError,
      setChangePlanActionPending,
      workspaceId,
    ],
  );
  return {
    handleSubmitChangePlanForm,
    handleSubmitChangePlanSecret,
    handleReviewChangePlanArtifacts,
    handleOpenChangePlanApproval,
  };
}
