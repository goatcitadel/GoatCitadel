import { useCallback, useEffect, useRef, useState } from "react";
import { canonicalJsonString, type ChangePlanRecord } from "@goatcitadel/contracts";
import {
  cancelChangePlan,
  completeChangePlanProviderOAuth,
  createChangePlan,
  fetchChangePlans,
  fetchOpenAICodexOAuthStatus,
  pollChangePlanProviderOAuth,
  startChangePlanProviderOAuth,
  type OpenAICodexDeviceStartResponse,
  type OpenAICodexOAuthStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  clearStoredOpenAICodexOAuthFlow,
  isStoredOpenAICodexOAuthFlow,
  isTrustedOpenAICodexVerificationUrl,
} from "../helpers/provider-oauth";
import type { ProviderNoticeSetter } from "./provider-section-types";
import { assertSettingsPlanResponse } from "./provider-connection-actions";
import { useProviderOAuthOperation } from "./use-provider-oauth-operation";
import { useProviderOAuthPolling } from "./use-provider-oauth-polling";

function assertOAuthPlan(plan: ChangePlanRecord, workspaceId: string) {
  if (
    !plan?.planId ||
    !Number.isSafeInteger(plan.revision) ||
    plan.revision < 1 ||
    plan.origin.workspaceId !== workspaceId ||
    Boolean(plan.origin.sessionId || plan.origin.turnId) ||
    plan.request.kind !== "provider_connection" ||
    plan.request.providerId !== "openai-codex" ||
    plan.kind !== "provider_connection" ||
    plan.target.ownerId !== "provider_connection" ||
    plan.target.resourceId !== "openai-codex"
  ) {
    throw new Error("The Gateway did not return the scoped OpenAI Codex provider plan. Refresh owner evidence.");
  }
}

export function useProviderOAuthFlow({
  activeWorkspaceId,
  hasCodexOAuthProvider,
  setNotice,
}: {
  activeWorkspaceId: string;
  hasCodexOAuthProvider: boolean;
  setNotice: ProviderNoticeSetter;
}) {
  const [codexOAuthStatus, setCodexOAuthStatus] = useState<OpenAICodexOAuthStatus | null>(null);
  const [codexOAuthStatusError, setCodexOAuthStatusError] = useState<string | null>(null);
  const [codexOAuthFlow, setCodexOAuthFlow] = useState<OpenAICodexDeviceStartResponse | null>(null);
  const [codexOAuthPlan, setCodexOAuthPlan] = useState<ChangePlanRecord | null>(null);
  const [codexOAuthPlanDialog, setCodexOAuthPlanDialog] = useState<ChangePlanRecord | null>(null);
  const [legacyBusy, setCodexOAuthBusy] = useState(false);
  const statusRequest = useRef(0);
  const flowScope = useRef(activeWorkspaceId);
  const latest = useRef({ activeWorkspaceId, codexOAuthFlow, codexOAuthPlan, setNotice });
  latest.current = { activeWorkspaceId, codexOAuthFlow, codexOAuthPlan, setNotice };
  const { run, mutation } = useProviderOAuthOperation(activeWorkspaceId, setNotice);
  const codexOAuthBusy = legacyBusy || mutation.pending;
  const codexOAuthConnected = Boolean(codexOAuthStatus?.connected);
  const cancelStatusRead = useCallback(() => {
    statusRequest.current++;
  }, []);
  const refreshCodexOAuthStatus = useCallback(async () => {
    const id = ++statusRequest.current;
    try {
      const data = await fetchOpenAICodexOAuthStatus();
      if (data.providerId !== "openai-codex") throw new Error("OAuth status did not identify the requested provider.");
      if (statusRequest.current === id) {
        setCodexOAuthStatus(data);
        setCodexOAuthStatusError(null);
      }
      return data;
    } catch (error) {
      if (statusRequest.current === id) {
        setCodexOAuthStatus(null);
        setCodexOAuthStatusError(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }, []);
  useEffect(() => {
    clearStoredOpenAICodexOAuthFlow();
  }, []);
  useEffect(() => {
    if (!hasCodexOAuthProvider) setCodexOAuthFlow(null);
    void refreshCodexOAuthStatus().catch(() => undefined);
    return cancelStatusRead;
  }, [hasCodexOAuthProvider, refreshCodexOAuthStatus, cancelStatusRead]);
  useEffect(() => {
    setCodexOAuthFlow(null);
    setCodexOAuthPlan(null);
    setCodexOAuthPlanDialog(null);
  }, [activeWorkspaceId]);

  const openCodexOAuthVerificationUrl = useCallback((url: string) => {
    if (!isTrustedOpenAICodexVerificationUrl(url)) {
      latest.current.setNotice({
        tone: "error",
        message: "OpenAI verification URL was not trusted. Refresh the Gateway login evidence.",
      });
      return;
    }
    globalThis.open?.(url, "_blank", "noopener,noreferrer");
  }, []);

  const handleStartCodexOAuth = async (openVerificationPage = false, suppliedPlan?: ChangePlanRecord) => {
    await run(async ({ isCurrent, write }) => {
      const context = { workspaceId: activeWorkspaceId };
      let plan = suppliedPlan ?? codexOAuthPlan;
      if (plan) assertOAuthPlan(plan, context.workspaceId);
      if (
        !plan ||
        !plan.requiredAction ||
        ["completed", "applied", "cancelled", "failed", "rolled_back", "rollback_failed"].includes(plan.status)
      ) {
        const activePlans = await fetchChangePlans(context, { limit: 50 });
        if (!isCurrent()) return;
        plan = activePlans.items.find(
          (candidate) =>
            candidate.request.kind === "provider_connection" &&
            candidate.request.providerId === "openai-codex" &&
            !["completed", "applied", "cancelled", "failed", "rolled_back", "rollback_failed"].includes(
              candidate.status,
            ),
        ) ?? null;
        if (!plan)
          plan = await write(
            () =>
              createChangePlan({
                ...context,
                surface: "settings",
                request: {
                  kind: "provider_connection",
                  providerId: "openai-codex",
                  ...(codexOAuthConnected ? { credentialAction: "replace_oauth" as const } : {}),
                },
              }),
            (value) => assertOAuthPlan(value, context.workspaceId),
          );
      }
      assertOAuthPlan(plan, context.workspaceId);
      if (!isCurrent()) return;
      setCodexOAuthPlan(plan);
      const action = plan.requiredAction;
      if (action?.kind !== "oauth" || action.targetId !== "openai-codex" || !action.actionNonce) {
        setCodexOAuthPlanDialog(plan);
        setNotice({ tone: "info", message: "Review the pending provider Change Plan before starting OAuth." });
        return;
      }
      const reviewed = plan;
      const flow = await write(
        () =>
          startChangePlanProviderOAuth(reviewed.planId, context, {
            expectedRevision: reviewed.revision,
            actionId: action.actionId,
            actionNonce: action.actionNonce,
          }),
        (value) => {
          if (!isStoredOpenAICodexOAuthFlow(value) || value.providerId !== "openai-codex")
            throw new Error("OpenAI Codex OAuth start returned an invalid login flow.");
        },
      );
      if (!isCurrent()) return;
      flowScope.current = activeWorkspaceId;
      setCodexOAuthFlow(flow);
      if (openVerificationPage) openCodexOAuthVerificationUrl(flow.verificationUrl);
      setNotice({
        tone: "success",
        message: openVerificationPage
          ? "ChatGPT login started. If the OpenAI page did not open, use the Open OpenAI page button."
          : flow.userCode
            ? "ChatGPT login started. Use the code shown below on the OpenAI page."
            : "ChatGPT login started. Complete the OpenAI browser approval.",
      });
    });
  };

  const poll = useCallback(
    async (showPendingNotice = false): Promise<number | false> => {
      const owner = latest.current;
      const flow = owner.codexOAuthFlow,
        plan = owner.codexOAuthPlan,
        action = plan?.requiredAction;
      if (
        !flow ||
        !plan ||
        action?.kind !== "oauth" ||
        action.targetId !== "openai-codex" ||
        flowScope.current !== owner.activeWorkspaceId
      )
        return false;
      const result = await run(async ({ isCurrent, write }) => {
        const currentFlow = () => isCurrent() && latest.current.codexOAuthFlow?.flowId === flow.flowId;
        assertOAuthPlan(plan, owner.activeWorkspaceId);
        const response = await write(
          () =>
            pollChangePlanProviderOAuth(
              plan.planId,
              { workspaceId: plan.origin.workspaceId },
              {
                expectedRevision: plan.revision,
                actionId: action.actionId,
                actionNonce: action.actionNonce,
                flowId: flow.flowId,
              },
            ),
          (value) => {
            if (
              value.providerId !== "openai-codex" ||
              value.flowId !== flow.flowId ||
              !["pending", "connected", "expired", "failed"].includes(value.status)
            )
              throw new Error("The OAuth poll did not confirm the current provider login flow.");
          },
        );
        if (!currentFlow()) return false;
        if (response.status === "connected") {
          const next = await write(
            () =>
              completeChangePlanProviderOAuth(
                plan.planId,
                { workspaceId: plan.origin.workspaceId },
                {
                  expectedRevision: plan.revision,
                  actionId: action.actionId,
                  actionNonce: action.actionNonce,
                },
              ),
            (value) => {
              assertSettingsPlanResponse(plan, value);
              if (canonicalJsonString(value.request) !== canonicalJsonString(plan.request))
                throw new Error("OAuth completion changed the reviewed provider request.");
            },
          );
          if (!currentFlow()) return false;
          setCodexOAuthFlow(null);
          clearStoredOpenAICodexOAuthFlow();
          setCodexOAuthPlan(next);
          setCodexOAuthPlanDialog(next);
          owner.setNotice({
            tone: "success",
            message:
              "OpenAI approved the login. Review the exact Change Plan below to promote it into the provider runtime.",
          });
          return false;
        }
        if (response.status === "expired" || response.status === "failed") {
          setCodexOAuthFlow(null);
          clearStoredOpenAICodexOAuthFlow();
          owner.setNotice({
            tone: response.status === "expired" ? "warning" : "error",
            message:
              response.status === "expired"
                ? "OpenAI Codex OAuth login expired. Start ChatGPT login again."
                : (response.error ?? "OpenAI Codex OAuth pairing failed."),
          });
          return false;
        }
        if (showPendingNotice)
          owner.setNotice({ tone: "info", message: "Still waiting for OpenAI approval for this login." });
        return response.retryAfterMs ?? flow.pollAfterMs;
      });
      // A different admitted provider operation may temporarily occupy the owner. Admission still prevents duplicates.
      return result ?? flow.pollAfterMs;
    },
    [run],
  );
  const autoPoll = useCallback(() => poll(false), [poll]);
  useProviderOAuthPolling({
    workspaceId: activeWorkspaceId,
    flowId: mutation.uncertain ? undefined : codexOAuthFlow?.flowId,
    pollAfterMs: codexOAuthFlow?.pollAfterMs,
    poll: autoPoll,
  });
  const handlePollCodexOAuth = async () => {
    await poll(true);
  };
  const handleRestartCodexOAuth = async () => {
    await handleStartCodexOAuth(true);
  };
  const handleDisconnectCodexOAuth = async () => {
    await run(async ({ isCurrent, write }) => {
      const plan = await write(
        () =>
          createChangePlan({
            workspaceId: activeWorkspaceId,
            surface: "settings",
            request: { kind: "provider_connection", providerId: "openai-codex", credentialAction: "remove_oauth" },
          }),
        (value) => {
          assertOAuthPlan(value, activeWorkspaceId);
          if (value.request.kind !== "provider_connection" || value.request.credentialAction !== "remove_oauth")
            throw new Error("The Gateway did not return the reviewed OAuth removal intent.");
        },
      );
      if (!isCurrent()) return;
      setCodexOAuthPlan(plan);
      setCodexOAuthPlanDialog(plan);
      setNotice({ tone: "warning", message: "Review and confirm the exact OAuth disconnect Change Plan." });
    });
  };
  const handleOpenCodexOAuthVerification = () => {
    if (codexOAuthFlow?.verificationUrl) openCodexOAuthVerificationUrl(codexOAuthFlow.verificationUrl);
  };
  const handleCancelCodexOAuth = async (plan: ChangePlanRecord) => {
    if (plan !== codexOAuthPlan || !plan.requiredAction?.actionNonce) return;
    const action = plan.requiredAction;
    await run(async ({ isCurrent, write }) => {
      assertOAuthPlan(plan, activeWorkspaceId);
      const next = await write(
        () =>
          cancelChangePlan(
            plan.planId,
            { workspaceId: plan.origin.workspaceId },
            {
              expectedRevision: plan.revision,
              actionNonce: action.actionNonce,
            },
          ),
        (value) => {
          assertSettingsPlanResponse(plan, value);
          if (value.status !== "cancelled")
            throw new Error("The Gateway did not confirm cancellation of this provider plan.");
        },
      );
      if (isCurrent()) {
        setCodexOAuthPlan(next);
        setCodexOAuthFlow(null);
        setCodexOAuthPlanDialog(null);
      }
    });
  };
  return {
    codexOAuthStatus,
    codexOAuthStatusError,
    codexOAuthFlow,
    setCodexOAuthFlow,
    codexOAuthPlan,
    setCodexOAuthPlan,
    codexOAuthPlanDialog,
    setCodexOAuthPlanDialog,
    codexOAuthBusy,
    setCodexOAuthBusy,
    codexOAuthConnected,
    mutation,
    refreshCodexOAuthStatus,
    handleStartCodexOAuth,
    handleRestartCodexOAuth,
    handlePollCodexOAuth,
    handleDisconnectCodexOAuth,
    handleOpenCodexOAuthVerification,
    handleCancelCodexOAuth,
  };
}
