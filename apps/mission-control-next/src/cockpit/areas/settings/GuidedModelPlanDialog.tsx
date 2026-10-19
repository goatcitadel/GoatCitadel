import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  completeChangePlanProviderOAuth,
  confirmChangePlan,
  pollChangePlanProviderOAuth,
  respondToChangePlan,
  startChangePlanProviderOAuth,
  submitChangePlanProviderSecret,
} from "@goatcitadel/mission-control-shared/api/client";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { buildAppHref } from "../../../app/route-model";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import type { GuidedModelSetupControl } from "./use-guided-model-setup";

const actionContext = (workspaceId: string, plan: ChangePlanRecord) => ({
  workspaceId,
  ...(plan.origin.sessionId ? { sessionId: plan.origin.sessionId } : {}),
  ...(plan.origin.turnId ? { turnId: plan.origin.turnId } : {}),
});

/** The guided setup's review dialog: each required action on a provider or default-model Change Plan. */
export function GuidedModelPlanDialog({
  control,
  workspaceId,
}: {
  control: GuidedModelSetupControl;
  workspaceId: string;
}) {
  const { navigate } = useCockpitRoute();
  const { dialogPlan, busy, actionError, setActionError, setDialogPlan, runAction } = control;
  const selection = { providerId: control.providerId, model: control.model, thinkingLevel: control.thinkingLevel };
  return (
    <ChatChangePlanActionDialog
      plan={dialogPlan}
      pending={busy}
      error={actionError}
      renderApprovalAction={(plan, pending) => (
        <SettingsApprovalOwnerAction
          plan={plan}
          owner="guided-model"
          workspaceId={workspaceId}
          disabled={pending}
          viewIdentity={selection}
        />
      )}
      onClose={() => {
        if (!busy) {
          setDialogPlan(null);
          setActionError(null);
        }
      }}
      onConfirm={(plan) => {
        const action = plan.requiredAction;
        if (action?.kind !== "confirmation") {
          setActionError("The setup request changed. Reopen it before confirming.");
          return;
        }
        return runAction(() =>
          confirmChangePlan(plan.planId, actionContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionNonce: action.actionNonce,
          }),
        );
      }}
      onSubmitPublicForm={(plan, values) => {
        const action = plan.requiredAction;
        if (action?.kind !== "public_form") {
          setActionError("This form changed. Reopen the setup request.");
          return;
        }
        return runAction(() =>
          respondToChangePlan(plan.planId, actionContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
            values,
          }),
        );
      }}
      onSubmitSecureInput={(plan, values) => {
        const action = plan.requiredAction;
        if (action?.kind !== "secure_input" || plan.request.kind !== "provider_connection") {
          setActionError("This secure action changed. Reopen the setup request.");
          return;
        }
        return runAction(() =>
          submitChangePlanProviderSecret(plan.planId, actionContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
            apiKey: values.credential ?? Object.values(values)[0] ?? "",
          }),
        );
      }}
      onContinueOAuth={async (plan) => {
        const action = plan.requiredAction;
        if (action?.kind !== "oauth" || plan.request.kind !== "provider_connection") {
          setActionError("This sign-in action changed. Reopen the setup request.");
          return;
        }
        await runAction(async () => {
          const context = actionContext(workspaceId, plan);
          const exact = { expectedRevision: plan.revision, actionId: action.actionId, actionNonce: action.actionNonce };
          const flow = await startChangePlanProviderOAuth(plan.planId, context, exact);
          globalThis.open?.(flow.verificationUrl, "_blank", "noopener,noreferrer");
          let pollAfterMs = flow.pollAfterMs;
          for (;;) {
            await new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(1_000, pollAfterMs)));
            const result = await pollChangePlanProviderOAuth(plan.planId, context, { ...exact, flowId: flow.flowId });
            if (result.status === "pending") {
              pollAfterMs = result.retryAfterMs ?? flow.pollAfterMs;
              continue;
            }
            if (result.status !== "connected") {
              throw new Error(result.error ?? `Provider sign-in ${result.status}. Start it again.`);
            }
            return await completeChangePlanProviderOAuth(plan.planId, context, exact);
          }
        });
      }}
      onOpenApproval={(plan) => {
        const action = plan.requiredAction;
        if (action?.kind !== "approval" || !action.approvalId) {
          setActionError("The approval is not available yet.");
          return;
        }
        setDialogPlan(null);
        navigate(buildAppHref({ area: "ops", section: "approvals", approvalId: action.approvalId }));
      }}
      onReviewArtifacts={(plan) => {
        const action = plan.requiredAction;
        if (action?.kind !== "artifact_review") {
          setActionError("The artifact review changed. Reopen the setup request.");
          return;
        }
        return runAction(() =>
          respondToChangePlan(plan.planId, actionContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
            values: {},
          }),
        );
      }}
      onOpenNativePathPicker={() => {
        setActionError("Native source selection is not part of provider onboarding.");
      }}
    />
  );
}
