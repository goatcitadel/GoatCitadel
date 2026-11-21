import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AssistantReadinessAction, ChangePlanRecord } from "@goatcitadel/contracts";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";
import {
  fetchAssistantReadiness,
  prepareAssistantSetup,
} from "@goatcitadel/mission-control-shared/api/assistant-readiness";
import { confirmChangePlan, fetchChangePlan } from "@goatcitadel/mission-control-shared/api/chat";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { subscribeRefresh } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { ChatChangePlanActionDialog } from "@goatcitadel/mission-control-shared/components/chat/ChatChangePlanActionDialog";
import { SettingsApprovalDialog } from "../settings/SettingsApprovalDialog";
import { useSettingsApprovalContinuation } from "../../../features/native-routes/settings/use-settings-approval-continuation";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { ChatAssistantReadiness } from "./ChatAssistantReadiness";
import { Button } from "../../ui/Button";
import { useProjectAccess } from "../../../features/native-routes/projects/use-project-access";
type ReadinessControlProps = { sessionId: string; workspaceId: string; onMemoryPreference: () => Promise<void> };
export function ChatAssistantReadinessControl(props: ReadinessControlProps) {
  const { activeCitadelId, activeWorkspaceId } = useUiPreferences();
  const access = useProjectAccess(props.workspaceId);
  const identity = JSON.stringify([
    getGatewayApiBaseUrl(),
    access.identity,
    activeCitadelId,
    activeWorkspaceId,
    props.workspaceId,
    props.sessionId,
  ]);
  if (activeWorkspaceId && activeWorkspaceId !== props.workspaceId) return null;
  return <ReadinessSession key={identity} {...props} identity={identity} />;
}
function ReadinessSession({
  sessionId,
  workspaceId,
  onMemoryPreference,
  identity,
}: ReadinessControlProps & { identity: string }) {
  const route = useCockpitRoute(),
    context = { sessionId, workspaceId };
  const readiness = useQuery({
    queryKey: ["chat", "assistant-readiness", identity],
    queryFn: () => fetchAssistantReadiness(sessionId, workspaceId),
    staleTime: 15_000,
  });
  const [plan, setPlan] = useState<ChangePlanRecord | null>(null),
    [review, setReview] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const current = useRef(true),
    operationLock = useRef(false);
  useEffect(() => {
    current.current = true;
    return () => {
      current.current = false;
    };
  }, []);
  const pendingReview = useRef<Parameters<typeof prepareAssistantSetup>[0] | undefined>(undefined);
  function assertScope(result: ChangePlanRecord) {
    if (result.origin.workspaceId !== workspaceId || result.origin.sessionId !== sessionId)
      throw new Error("The setup review scope changed. Open a fresh review.");
    return result;
  }
  useEffect(() => {
    const subscriptions = (["memory", "skills", "system", "approvals"] as const).map((topic) =>
      subscribeRefresh(topic, () => void readiness.refetch()),
    );
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [identity, readiness.refetch]);
  const polled = useQuery({
    queryKey: ["chat", "assistant-setup-plan", identity, plan?.planId],
    queryFn: async () => {
      const result = await fetchChangePlan(plan!.planId, context);
      if (
        result.origin.workspaceId !== workspaceId ||
        result.origin.sessionId !== sessionId ||
        result.planId !== plan!.planId ||
        result.intentHash !== plan!.intentHash
      )
        throw new Error("The setup review scope changed. Open a fresh review.");
      return result;
    },
    enabled: Boolean(plan),
    refetchInterval:
      plan && ["staging", "applying", "verifying", "awaiting_approval", "monitoring"].includes(plan.status)
        ? 1500
        : false,
  });
  useEffect(() => {
    if (polled.data && plan && polled.data.planId === plan.planId && polled.data.revision > plan.revision) {
      setPlan(polled.data);
      void readiness.refetch();
    }
  }, [polled.data, plan?.revision]);
  async function run(operation: () => Promise<unknown>) {
    if (operationLock.current) return;
    operationLock.current = true;
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      if (current.current) setError(describeApiError(cause).summary);
    } finally {
      operationLock.current = false;
      if (current.current) setPending(false);
    }
  }
  async function prepareReview(action: AssistantReadinessAction): Promise<ChangePlanRecord> {
    const itemId =
      readiness.data!.items.find(
        (item) => canonicalJsonString(item.nextAction?.request ?? null) === canonicalJsonString(action.request ?? null),
      )?.id ??
      (canonicalJsonString(readiness.data!.indexedRecallSetup?.request ?? null) ===
      canonicalJsonString(action.request ?? null)
        ? "indexed_recall"
        : canonicalJsonString(readiness.data!.reviewedSkillUseSetup?.request ?? null) === canonicalJsonString(action.request ?? null)
          ? "skill_use"
          : undefined);
    if (!itemId) throw new Error("This setup action changed. Refresh readiness before reviewing it.");
    if (pendingReview.current && pendingReview.current.itemId !== itemId)
      throw new Error(
        "An earlier setup review could not be confirmed. Retry that same setup before preparing a different change.",
      );
    const input = (pendingReview.current ??= {
      ...context,
      itemId,
      expectedSourceHash: readiness.data!.sourceHash,
      operationId: crypto.randomUUID(),
    });
    try {
      const result = assertScope(await prepareAssistantSetup(input));
      pendingReview.current = undefined;
      if (canonicalJsonString(result.request) !== canonicalJsonString(action.request))
        throw new Error("The setup review intent changed. Refresh and inspect its owner before deciding.");
      if (result.target && result.target.expectedRevision !== readiness.data!.configRevision)
        throw new Error(
          "This recorded review predates the current settings. Review setup again for a fresh confirmation.",
        );
      return result;
    } catch (cause) {
      if (!isApiRequestError(cause) || cause.status !== 409) throw cause;
      const body = cause.body as { details?: { reason?: unknown } } | undefined;
      if (body?.details?.reason === "assistant_setup_review_blocked")
        throw new Error(
          "An existing setup review needs attention. Close this panel to review or cancel its setup card in this conversation.",
        );
      throw new Error("Setup changed. Refresh readiness and review the current settings before continuing.");
    }
  }
  async function act(action: AssistantReadinessAction) {
    if (action.sessionPreference)
      return run(async () => {
        await onMemoryPreference();
        await readiness.refetch();
      });
    if (!action.request) {
      route.navigate(action.href);
      return;
    }
    if (!readiness.data) return;
    await run(async () => {
      const result = await prepareReview(action);
      if (current.current) {
        setPlan(result);
        setReview(true);
      }
      void readiness.refetch();
    });
  }
  async function refresh() {
    await Promise.all([readiness.refetch(), plan ? polled.refetch() : Promise.resolve()]);
  }
  const continuation = useSettingsApprovalContinuation({ plan: plan ?? undefined, workspaceId, onSettled: refresh });
  const approval = plan?.requiredAction?.kind === "approval" ? plan.requiredAction : undefined;
  const unavailable = { state: "unavailable" as const, reasonCode: "readiness_unavailable" };
  // Preserve the reader's disclosures while making every stale value and
  // setup action unavailable. The cached owner response itself stays intact.
  const displayedReadiness = readiness.data && readiness.error ? {
    ...readiness.data,
    items: readiness.data.items.map(item => ({ ...item, state: "unavailable" as const, reasons: [], nextAction: undefined })),
    learning: {
      canExtractMemory: false, canDraftSkill: false, canEvaluateMaintenance: false,
      source: unavailable, memory: unavailable, skill: unavailable, maintenance: unavailable,
      provider: unavailable, budget: unavailable,
    },
    indexedRecall: unavailable,
    reviewedSkillUse: readiness.data.reviewedSkillUse ? unavailable : undefined,
    indexedRecallSetup: undefined,
    reviewedSkillUseSetup: undefined,
  } : readiness.data;
  return (
    <div className="grid min-w-0 gap-3">
      <ChatAssistantReadiness
        readiness={displayedReadiness}
        pending={pending}
        error={
          error ??
          (readiness.error
            ? describeApiError(readiness.error).summary
            : polled.error
              ? describeApiError(polled.error).summary
              : undefined)
        }
        onAction={act}
        onRefresh={refresh}
      />
      {plan ? (
        <>
          <p role="status" className="text-sm text-fg-secondary">
            {plan.result?.summary ??
              "Setup review prepared. The feature is ready only when the runtime confirms it above."}
          </p>
          {plan.requiredAction && !approval ? (
            <Button size="sm" disabled={pending} onClick={() => setReview(true)}>
              Review current setup change
            </Button>
          ) : null}
        </>
      ) : null}
      {approval?.approvalId ? (
        <SettingsApprovalDialog
          key={approval.approvalId}
          approvalId={approval.approvalId}
          workspaceId={workspaceId}
          installationSetting
          installationPlanId={plan!.planId}
          presentation="inline"
          onResolved={async (status) => {
            if (status === "approved") await continuation.continueApproved();
            await refresh();
          }}
        />
      ) : null}
      {continuation.message ? (
        <div role="status" className="text-sm text-fg-secondary">
          <p>{continuation.message}</p>
          {continuation.visible ? (
            <Button size="sm" disabled={continuation.disabled} onClick={() => void continuation.continueApproved()}>
              Continue approved setup
            </Button>
          ) : null}
        </div>
      ) : null}
      <ChatChangePlanActionDialog
        plan={review && !approval ? plan : null}
        pending={pending}
        error={error}
        contextNote="This setup change applies to the whole installation. Existing tool and memory approvals still apply."
        onClose={() => setReview(false)}
        onConfirm={(snapshot) =>
          run(async () => {
            const action = snapshot.requiredAction;
            if (action?.kind !== "confirmation") throw new Error("The review changed. Refresh before deciding.");
            const result = assertScope(
              await confirmChangePlan(snapshot.planId, context, {
                expectedRevision: snapshot.revision,
                actionNonce: action.actionNonce,
              }),
            );
            if (result.planId !== snapshot.planId || result.intentHash !== snapshot.intentHash)
              throw new Error("The setup request changed. Open a fresh review.");
            if (current.current) setPlan(result);
            await readiness.refetch();
          })
        }
        onSubmitPublicForm={() => setError("Open the feature's owner to complete its required setup.")}
        onSubmitSecureInput={() => setError("Use the model's sign-in flow to complete setup.")}
        onContinueOAuth={() => setError("Use the model's sign-in flow to complete setup.")}
        onReviewArtifacts={() => setError("Open the exact artifact review before continuing.")}
        onOpenNativePathPicker={() => setError("Select the path from the existing Settings owner.")}
      />
    </div>
  );
}
