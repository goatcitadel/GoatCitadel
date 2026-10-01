import { useCallback, useEffect } from "react";
import type { ChangePlanRecord } from "@goatcitadel/contracts";
import {
  completeChangePlanProviderOAuth,
  startChangePlanProviderOAuth,
  pollChangePlanProviderOAuth,
  submitChangePlanManagedSourceSelection,
} from "@goatcitadel/mission-control-shared/api/client";
import { changePlanClientContext } from "./change-plan-controller-helpers";
import { requestNativeManagedSourcePath } from "./request-native-managed-source-path";
import type { ChatChangePlanState } from "./useChatChangePlanState";

type Input = Pick<
  ChatChangePlanState,
  | "activeChangePlan"
  | "changePlanOAuthFlow"
  | "setChangePlanOAuthFlow"
  | "setChangePlanActionError"
  | "setChangePlanActionPending"
> & {
  workspaceId: string;
  recordChangePlanResult: (updated: ChangePlanRecord) => ChangePlanRecord;
};

export function useChatChangePlanOAuth({
  workspaceId,
  activeChangePlan,
  changePlanOAuthFlow,
  recordChangePlanResult,
  setChangePlanOAuthFlow,
  setChangePlanActionError,
  setChangePlanActionPending,
}: Input) {
  const handleChangePlanOAuth = useCallback(
    async (plan: ChangePlanRecord) => {
      const action = plan.requiredAction;
      if (action?.kind !== "oauth") {
        setChangePlanActionError("This OAuth action changed. Reload the Change Plan.");
        return;
      }
      if (action.targetId !== "openai-codex") {
        setChangePlanActionError(
          "This provider does not expose a first-party Chat OAuth owner yet. The Change Plan remains unapplied; use its dedicated provider Settings flow.",
        );
        return;
      }
      const currentFlow =
        changePlanOAuthFlow?.planId === plan.planId &&
        changePlanOAuthFlow.actionId === action.actionId &&
        Date.parse(changePlanOAuthFlow.flow.expiresAt) > Date.now()
          ? changePlanOAuthFlow
          : null;
      if (currentFlow) {
        globalThis.open?.(currentFlow.flow.verificationUrl, "_blank", "noopener,noreferrer");
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        const flow = await startChangePlanProviderOAuth(plan.planId, changePlanClientContext(workspaceId, plan), {
          expectedRevision: plan.revision,
          actionId: action.actionId,
          actionNonce: action.actionNonce,
        });
        setChangePlanOAuthFlow({
          planId: plan.planId,
          planRevision: plan.revision,
          actionId: action.actionId,
          actionNonce: action.actionNonce,
          flow,
        });
        globalThis.open?.(flow.verificationUrl, "_blank", "noopener,noreferrer");
      } catch (error) {
        setChangePlanActionError(
          error instanceof Error ? error.message : "Unable to start the provider OAuth owner flow.",
        );
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [changePlanOAuthFlow, setChangePlanActionError, setChangePlanActionPending, setChangePlanOAuthFlow, workspaceId],
  );

  useEffect(() => {
    const owned = changePlanOAuthFlow;
    if (!owned || activeChangePlan?.planId !== owned.planId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (cancelled) return;
      if (Date.parse(owned.flow.expiresAt) <= Date.now()) {
        setChangePlanOAuthFlow(null);
        setChangePlanActionError(
          "The provider OAuth flow expired. Start it again to keep the credential owner binding exact.",
        );
        return;
      }
      try {
        const result = await pollChangePlanProviderOAuth(
          owned.planId,
          changePlanClientContext(workspaceId, activeChangePlan),
          {
            expectedRevision: owned.planRevision,
            actionId: owned.actionId,
            actionNonce: owned.actionNonce,
            flowId: owned.flow.flowId,
          },
        );
        if (cancelled) return;
        if (result.status === "connected") {
          const plan = activeChangePlan;
          const action = plan.requiredAction;
          if (
            plan.revision !== owned.planRevision ||
            action?.kind !== "oauth" ||
            action.actionId !== owned.actionId ||
            action.actionNonce !== owned.actionNonce
          ) {
            setChangePlanOAuthFlow(null);
            setChangePlanActionError(
              "The OAuth Change Plan action changed before completion. Its credential was not promoted by this plan.",
            );
            return;
          }
          const updated = await completeChangePlanProviderOAuth(
            plan.planId,
            changePlanClientContext(workspaceId, plan),
            {
              expectedRevision: plan.revision,
              actionId: action.actionId,
              actionNonce: action.actionNonce,
            },
          );
          setChangePlanOAuthFlow(null);
          recordChangePlanResult(updated);
          return;
        }
        if (result.status === "expired" || result.status === "failed") {
          setChangePlanOAuthFlow(null);
          setChangePlanActionError(result.error ?? `Provider OAuth ${result.status}. Start the dedicated flow again.`);
          return;
        }
        timer = setTimeout(() => void poll(), Math.max(1_000, result.retryAfterMs ?? owned.flow.pollAfterMs));
      } catch (error) {
        if (!cancelled) {
          setChangePlanActionError(error instanceof Error ? error.message : "Unable to poll the provider OAuth owner.");
          timer = setTimeout(() => void poll(), Math.max(2_000, owned.flow.pollAfterMs));
        }
      }
    };
    timer = setTimeout(() => void poll(), Math.max(1_000, owned.flow.pollAfterMs));
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [
    activeChangePlan,
    changePlanOAuthFlow,
    recordChangePlanResult,
    setChangePlanActionError,
    setChangePlanOAuthFlow,
    workspaceId,
  ]);
  const handleChangePlanNativePath = useCallback(
    async (plan: ChangePlanRecord) => {
      const action = plan.requiredAction;
      if (action?.kind !== "native_path_picker") {
        setChangePlanActionError("This native picker action changed. Reload the Change Plan.");
        return;
      }
      setChangePlanActionPending(true);
      setChangePlanActionError(null);
      try {
        const rootPath = await requestNativeManagedSourcePath(plan.planId, action.actionId);
        if (!rootPath) return;
        recordChangePlanResult(
          await submitChangePlanManagedSourceSelection(plan.planId, changePlanClientContext(workspaceId, plan), {
            expectedRevision: plan.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
            rootPath,
          }),
        );
      } catch (error) {
        setChangePlanActionError(
          error instanceof Error ? error.message : "The native source picker could not complete.",
        );
      } finally {
        setChangePlanActionPending(false);
      }
    },
    [recordChangePlanResult, setChangePlanActionError, setChangePlanActionPending, workspaceId],
  );
  return { handleChangePlanOAuth, handleChangePlanNativePath };
}
