import type { ChatDelegatedScopeCandidateRecord, ChatDelegatedScopeCandidatesResponse } from "@goatcitadel/contracts";
import {
  fetchChatDelegatedScopeCandidates,
  requestChatDelegatedScopeExpansion,
} from "@goatcitadel/mission-control-shared/api/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ActiveChatDelegationRun } from "./useChatDelegationPolicyActions";

export interface ThreadedDelegatedScopeControls {
  stepLabel: string;
  candidates: readonly ChatDelegatedScopeCandidateRecord[];
  loading: boolean;
  requesting: boolean;
  pendingApprovalId?: string;
  error: string | null;
  onReload: () => void;
  onRequest: (candidateId: string) => void;
}

export function useChatDelegatedScopeControls(input: {
  sessionId: string | null;
  delegationRun: ActiveChatDelegationRun | null;
  pushLocalNotice?: (message: string) => void;
}): ThreadedDelegatedScopeControls | null {
  const { delegationRun, pushLocalNotice, sessionId } = input;
  const activeStep = useMemo(
    () =>
      delegationRun?.status === "running"
        ? delegationRun.steps.find(
            (step) => step.status === "running" && Boolean(step.scopeControl) && isChatScopeExpandableRole(step.role),
          )
        : undefined,
    [delegationRun],
  );
  const runId = delegationRun?.runId;
  const stepId = activeStep?.stepId;
  const [response, setResponse] = useState<ChatDelegatedScopeCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const activeKey = sessionId && runId && stepId ? `${sessionId}:${runId}:${stepId}` : "";
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  useEffect(() => {
    setResponse(null);
    setError(null);
    if (!sessionId || !runId || !stepId) return;
    let cancelled = false;
    setLoading(true);
    void fetchChatDelegatedScopeCandidates({ sessionId, runId, stepId })
      .then((next) => {
        if (cancelled) return;
        if (next.scopeHash !== activeStep?.scopeControl?.scopeHash) {
          setError("The delegated scope changed. Refresh the run before requesting another path.");
          setResponse(null);
          return;
        }
        setResponse(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load eligible scope paths.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeStep?.scopeControl?.scopeHash, reloadToken, runId, sessionId, stepId]);

  const onReload = useCallback(() => setReloadToken((current) => current + 1), []);
  const onRequest = useCallback(
    (candidateId: string) => {
      if (!sessionId || !runId || !stepId || requesting) return;
      const candidate = response?.candidates.find((item) => item.candidateId === candidateId);
      if (!candidate) {
        setError("That workspace scope option is no longer eligible. Refresh and choose again.");
        return;
      }
      setRequesting(true);
      setError(null);
      const requestKey = activeKey;
      void requestChatDelegatedScopeExpansion({
        sessionId,
        runId,
        stepId,
        candidateIds: [candidate.candidateId],
      })
        .then((result) => {
          if (activeKeyRef.current !== requestKey) return;
          setResponse((current) =>
            current ? { ...current, candidates: [], pendingApprovalId: result.approvalId } : current,
          );
          pushLocalNotice?.(`Additional scope “${candidate.label}” is waiting for the canonical approval decision.`);
        })
        .catch((cause: unknown) => {
          if (activeKeyRef.current !== requestKey) return;
          setError(cause instanceof Error ? cause.message : "Unable to request additional scope.");
        })
        .finally(() => {
          if (activeKeyRef.current === requestKey) setRequesting(false);
        });
    },
    [activeKey, pushLocalNotice, requesting, response?.candidates, runId, sessionId, stepId],
  );

  if (!sessionId || !runId || !activeStep) return null;
  return {
    stepLabel: formatScopeStepLabel(activeStep.label ?? activeStep.role),
    candidates: response?.candidates ?? [],
    loading,
    requesting,
    pendingApprovalId: response?.pendingApprovalId,
    error,
    onReload,
    onRequest,
  };
}

function formatScopeStepLabel(value: string): string {
  const words = value.trim().replace(/[-_]+/gu, " ");
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Delegated step";
}

function isChatScopeExpandableRole(role: string): boolean {
  const normalized = role
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-");
  return normalized === "coder" || normalized === "workspace-explorer";
}
