import { useState } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import { cancelChangePlan, confirmChangePlan, requestChangePlanRollback, respondToChangePlan } from "../../api/chat";
import { ApiRequestError } from "../../api/http-internal";
import { ChatChangePlanCard } from "./ChatChangePlanCard";
import { ChatChangePlanActionDialog } from "./ChatChangePlanActionDialog";

/** Review bounded capability/settings plans using their server-issued actions. */
export function OwnedChangePlanList({
  plans,
  onUpdated,
  onOpenApproval,
}: {
  plans: ChangePlanRecord[];
  onUpdated: (plan: ChangePlanRecord) => void;
  onOpenApproval: (approvalId: string) => void;
}) {
  const [selected, setSelected] = useState<ChangePlanRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = (plan: ChangePlanRecord) => ({
    workspaceId: plan.origin.workspaceId,
    sessionId: plan.origin.sessionId,
    turnId: plan.origin.turnId,
  });
  const run = async (operation: () => Promise<ChangePlanRecord | undefined>) => {
    setBusy(true);
    setError(null);
    try {
      const plan = await operation();
      if (!plan) return;
      onUpdated(plan);
      setSelected(plan.requiredAction ? plan : null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The change could not be completed.");
    } finally {
      setBusy(false);
    }
  };
  const respond = (plan: ChangePlanRecord, values: Readonly<Record<string, string | number | boolean>>) => {
    const action = plan.requiredAction;
    if (!action) return;
    return run(() =>
      respondToChangePlan(plan.planId, context(plan), {
        expectedRevision: plan.revision,
        actionId: action.actionId,
        actionNonce: action.actionNonce,
        values,
      }),
    );
  };
  const unsupported = () => {
    setError("Continue this action through its dedicated Settings owner.");
  };
  return (
    <>
      {plans.map((plan) => (
        <ChatChangePlanCard
          key={plan.planId}
          plan={plan}
          pending={busy}
          onRollback={(item) => void run(() => requestChangePlanRollback(item.planId, context(item), item.revision))}
          onReview={(item) => {
            setError(null);
            setSelected(item);
          }}
          onCancel={(item) => {
            if (item.requiredAction)
              void run(() =>
                cancelChangePlan(item.planId, context(item), {
                  expectedRevision: item.revision,
                  actionNonce: item.requiredAction!.actionNonce,
                }),
              );
          }}
        />
      ))}
      {error && !selected ? <p role="alert">{error}</p> : null}
      <ChatChangePlanActionDialog
        plan={selected}
        pending={busy}
        error={error}
        onClose={() => setSelected(null)}
        onConfirm={(plan) =>
          run(() =>
            confirmChangePlan(plan.planId, context(plan), {
              expectedRevision: plan.revision,
              actionNonce: plan.requiredAction!.actionNonce,
            }),
          )
        }
        onSubmitPublicForm={respond}
        onReviewArtifacts={(plan) => respond(plan, {})}
        onSubmitSecureInput={unsupported}
        onContinueOAuth={unsupported}
        onOpenNativePathPicker={unsupported}
        onOpenApproval={(plan) => {
          const action = plan.requiredAction;
          if (action?.kind === "approval" && action.approvalId) {
            return run(async () => {
              try {
                return await respondToChangePlan(plan.planId, context(plan), {
                  expectedRevision: plan.revision,
                  actionId: action.actionId,
                  actionNonce: action.actionNonce,
                  values: {},
                });
              } catch (failure) {
                if (failure instanceof ApiRequestError && failure.status === 409) {
                  setSelected(null);
                  onOpenApproval(action.approvalId!);
                  return undefined;
                }
                throw failure;
              }
            });
          }
        }}
      />
    </>
  );
}
