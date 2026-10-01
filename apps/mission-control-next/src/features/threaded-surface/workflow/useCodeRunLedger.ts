import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CodeModeRunRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeVerificationCommandName,
  CodeModeVerificationEvidenceRecord,
} from "@goatcitadel/contracts";
import {
  fetchCodeModeExecutionBackends,
  fetchCodeModeRun,
  fetchCodeModeRunVerificationEvidence,
  fetchCodeModeRuns,
  verifyCodeModeRun,
} from "@goatcitadel/mission-control-shared/api/capabilities";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import type { CodePanelType } from "./code-workbench-model";
import type { CodeModeRunLedgerItem } from "./format";
import { effectiveCodeModeVerificationStatus, codeModeArtifactIntegritySummary } from "./code-workbench-evidence";

export function useCodeRunLedger(props: CodePanelType["props"]) {
  const { workbenchState, selectedTurn, workspaceId, output, onRunHelperSnippet } = props;
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runList, setRunList] = useState<CodeModeRunRecord[]>([]);
  const [runListLoading, setRunListLoading] = useState(false);
  const [runListError, setRunListError] = useState<string | null>(null);
  const [runListRefreshRevision, setRunListRefreshRevision] = useState(0);
  const [executionBackends, setExecutionBackends] = useState<CodeModeExecutionBackendsResponse | null>(null);
  const [executionBackendsError, setExecutionBackendsError] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<CodeModeRunRecord | null>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [runDetailError, setRunDetailError] = useState<string | null>(null);
  const [verificationCommandName, setVerificationCommandName] =
    useState<CodeModeVerificationCommandName>("git_diff_check");
  const [verificationEvidence, setVerificationEvidence] = useState<CodeModeVerificationEvidenceRecord[]>([]);
  const [verificationEvidenceLoading, setVerificationEvidenceLoading] = useState(false);
  const [verificationActionBusy, setVerificationActionBusy] = useState(false);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const codeLedgerSessionId = workbenchState?.sessionId ?? selectedTurn?.trace.sessionId ?? null;
  const codeLedgerTurnId = selectedTurn?.turnId ?? null;
  const codeLedgerWorkspaceId = workspaceId ?? null;
  const visibleRunItems = useMemo<CodeModeRunLedgerItem[]>(() => {
    const byId = new Map<string, CodeModeRunLedgerItem>();
    for (const run of runList) {
      if (codeLedgerTurnId && run.turnId && run.turnId !== codeLedgerTurnId) {
        continue;
      }
      byId.set(run.runId, run);
    }
    for (const helperRun of output?.helperRuns ?? []) {
      const helperRunTurnId =
        "turnId" in helperRun && typeof helperRun.turnId === "string" ? helperRun.turnId : undefined;
      if (codeLedgerTurnId && helperRunTurnId && helperRunTurnId !== codeLedgerTurnId) {
        continue;
      }
      const existing = byId.get(helperRun.runId);
      byId.set(helperRun.runId, { ...existing, ...helperRun });
    }
    return [...byId.values()].sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
      return rightTime - leftTime;
    });
  }, [codeLedgerTurnId, output?.helperRuns, runList]);
  const visibleRunIds = useMemo(() => visibleRunItems.map((run) => run.runId).join("|"), [visibleRunItems]);
  const selectedRunSummary = useMemo(
    () => visibleRunItems.find((run) => run.runId === selectedRunId) ?? visibleRunItems[0] ?? null,
    [selectedRunId, visibleRunItems],
  );
  const selectedRunDetail = runDetail?.runId === selectedRunSummary?.runId ? runDetail : null;
  const selectedRunApprovalId = selectedRunDetail?.approvalId ?? selectedRunSummary?.approvalId;
  const selectedRunVerificationStatus = selectedRunDetail
    ? effectiveCodeModeVerificationStatus(selectedRunDetail, verificationEvidence)
    : "not_applicable";
  const selectedRunVerificationEvidence = selectedRunDetail
    ? (verificationEvidence.find((item) => item.evidenceId === selectedRunDetail.verification?.evidenceId) ??
      verificationEvidence[0])
    : undefined;
  const selectedRunArtifactIntegrity = selectedRunDetail ? codeModeArtifactIntegritySummary(selectedRunDetail) : null;
  const selectedRunScope = useMemo(
    () => ({
      ...((selectedRunSummary?.sessionId ?? codeLedgerSessionId)
        ? { sessionId: selectedRunSummary?.sessionId ?? codeLedgerSessionId ?? undefined }
        : {}),
      ...(selectedRunSummary?.turnId ? { turnId: selectedRunSummary.turnId } : {}),
      ...((selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId)
        ? { workspaceId: selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId ?? undefined }
        : {}),
    }),
    [
      codeLedgerSessionId,
      codeLedgerWorkspaceId,
      selectedRunSummary?.sessionId,
      selectedRunSummary?.turnId,
      selectedRunSummary?.workspaceId,
    ],
  );
  const selectedRunComparisonScope = useMemo(
    () => ({
      ...((selectedRunSummary?.sessionId ?? codeLedgerSessionId)
        ? { sessionId: selectedRunSummary?.sessionId ?? codeLedgerSessionId ?? undefined }
        : {}),
      ...((selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId)
        ? { workspaceId: selectedRunSummary?.workspaceId ?? codeLedgerWorkspaceId ?? undefined }
        : {}),
    }),
    [codeLedgerSessionId, codeLedgerWorkspaceId, selectedRunSummary?.sessionId, selectedRunSummary?.workspaceId],
  );
  const comparisonCandidates = useMemo(
    () => visibleRunItems.filter((run) => run.runId !== selectedRunSummary?.runId),
    [selectedRunSummary?.runId, visibleRunItems],
  );
  useEffect(() => {
    const runIds = visibleRunIds ? visibleRunIds.split("|").filter(Boolean) : [];
    if (runIds.length === 0) {
      setSelectedRunId(null);
      return;
    }
    setSelectedRunId((current) => (current && runIds.includes(current) ? current : runIds[0]!));
  }, [visibleRunIds]);

  useEffect(() => {
    if (!codeLedgerSessionId) {
      setRunList([]);
      setRunListError(null);
      setRunListLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRunListLoading(true);
    setRunListError(null);
    fetchCodeModeRuns({
      sessionId: codeLedgerSessionId,
      ...(codeLedgerWorkspaceId ? { workspaceId: codeLedgerWorkspaceId } : {}),
      ...(codeLedgerTurnId ? { turnId: codeLedgerTurnId } : {}),
      limit: 25,
    })
      .then((response) => {
        if (!cancelled) {
          setRunList(response.items);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunList([]);
          setRunListError(error instanceof Error ? error.message : "Unable to load Code Mode run ledger.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunListLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [codeLedgerSessionId, codeLedgerTurnId, codeLedgerWorkspaceId, runListRefreshRevision]);

  const handleRunHelperSnippet = useCallback(
    async (language: string, source: string) => {
      await onRunHelperSnippet(language, source);
      setRunListRefreshRevision((current) => current + 1);
    },
    [onRunHelperSnippet],
  );

  useEffect(() => {
    let cancelled = false;
    setExecutionBackendsError(null);
    fetchCodeModeExecutionBackends()
      .then((response) => {
        if (!cancelled) {
          setExecutionBackends(response);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setExecutionBackends(null);
          setExecutionBackendsError(
            error instanceof Error ? error.message : "Unable to load Code Mode execution backends.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedRunSummary?.runId) {
      setRunDetail(null);
      setRunDetailError(null);
      setRunDetailLoading(false);
      return undefined;
    }
    let cancelled = false;
    setRunDetailLoading(true);
    setRunDetailError(null);
    setRunDetail(null);
    fetchCodeModeRun(selectedRunSummary.runId, selectedRunScope)
      .then((detail) => {
        if (!cancelled) {
          setRunDetail(detail);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRunDetail(null);
          setRunDetailError(error instanceof Error ? error.message : "Unable to load Code Mode run detail.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setRunDetailLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunScope, selectedRunSummary?.runId]);

  useEffect(() => {
    if (!selectedRunSummary?.runId) {
      setVerificationEvidence([]);
      setVerificationEvidenceLoading(false);
      setVerificationError(null);
      return undefined;
    }
    let cancelled = false;
    setVerificationEvidence([]);
    setVerificationEvidenceLoading(true);
    setVerificationError(null);
    fetchCodeModeRunVerificationEvidence(selectedRunSummary.runId, {
      ...selectedRunScope,
      limit: 25,
    })
      .then((response) => {
        if (!cancelled) {
          setVerificationEvidence(response.items);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setVerificationEvidence([]);
          setVerificationError(
            error instanceof Error ? error.message : "Unable to load durable Code Mode verification evidence.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setVerificationEvidenceLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunScope, selectedRunSummary?.runId]);

  const runNamedCodeModeVerification = async () => {
    if (
      !selectedRunDetail ||
      selectedRunDetail.status !== "completed" ||
      !selectedRunDetail.sessionId ||
      verificationActionBusy
    ) {
      return;
    }
    setVerificationActionBusy(true);
    setVerificationError(null);
    try {
      const response = await verifyCodeModeRun(
        selectedRunDetail.runId,
        { commandName: verificationCommandName },
        selectedRunScope,
      );
      if (!isMounted()) {
        return;
      }
      setRunDetail(response.run);
      setRunList((current) => current.map((run) => (run.runId === response.run.runId ? response.run : run)));
      setVerificationEvidence((current) => [
        response.evidence,
        ...current.filter((item) => item.evidenceId !== response.evidence.evidenceId),
      ]);
    } catch (error) {
      if (isMounted()) {
        setVerificationError(error instanceof Error ? error.message : "Unable to run the named Code Mode proof.");
      }
    } finally {
      if (isMounted()) {
        setVerificationActionBusy(false);
      }
    }
  };

  return {
    isMounted,
    selectedRunId,
    setSelectedRunId,
    runListLoading,
    runListError,
    executionBackends,
    executionBackendsError,
    runDetailLoading,
    runDetailError,
    verificationCommandName,
    setVerificationCommandName,
    verificationEvidence,
    verificationEvidenceLoading,
    verificationActionBusy,
    verificationError,
    visibleRunItems,
    visibleRunIds,
    selectedRunSummary,
    selectedRunDetail,
    selectedRunApprovalId,
    selectedRunVerificationStatus,
    selectedRunVerificationEvidence,
    selectedRunArtifactIntegrity,
    selectedRunScope,
    selectedRunComparisonScope,
    comparisonCandidates,
    handleRunHelperSnippet,
    runNamedCodeModeVerification,
  };
}
