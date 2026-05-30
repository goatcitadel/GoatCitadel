import { useCallback, useEffect, useState } from "react";
import { FileText, Plus, RefreshCw, Save, Sparkles, Workflow } from "lucide-react";
import type { CapabilityProposalDetailRecord, SkillEvaluationRunRecord, SkillListItem } from "@goatcitadel/contracts";
import {
  activateImprovementCandidate,
  approveImprovementCandidate,
  createSkillEvaluationProposal,
  fetchCapabilityProposal,
  fetchCuratorReviewItem,
  fetchSkillActivationPolicies,
  fetchSkillEvaluations,
  fetchSkillImportHistory,
  fetchSkillSources,
  fetchSkills,
  previewSkillEvaluation,
  promoteImprovementCandidate,
  rejectImprovementCandidate,
  reloadSkills,
  runSkillEvaluation,
  snoozeImprovementCandidate,
  updateSkillState,
  validateImprovementCandidate,
} from "@goatcitadel/mission-control-shared/api/client";
import type {
  CuratorReviewItem,
  ImprovementCandidateLifecycleAction,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, QuickJumpCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  formatDateTime,
  formatEvidenceMetadata,
  formatPercent,
  formatTaskStatus,
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  parseCriterionDrafts,
  parseScenarioDrafts,
  readPayloadEvidenceRefs,
  readPayloadString,
  serializeCriterionDrafts,
  serializeScenarioDrafts,
  truncateText,
  useAsyncLoad,
  type Notice,
} from "../shared/native-helpers";
import {
  LibraryActionList,
  LibraryButtonRow,
  LibraryCodeBlock,
  LibraryEmptyState,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibraryNotice,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

export function LibrarySkillsSection({ route, navigate }: NativeRoutePagesProps) {
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [skills, sources, history, policy] = await Promise.all([
      nativeLoad("Skills", fetchSkills(), { items: [] }),
      nativeLoad("Skill sources", fetchSkillSources({ limit: 10 }), {
        generatedAt: "1970-01-01T00:00:00.000Z",
        items: [],
        providers: [],
      }),
      nativeLoad("Skill import history", fetchSkillImportHistory(10), { items: [] }),
      nativeLoad("Skill activation policy", fetchSkillActivationPolicies(), null),
    ]);
    return {
      issues: nativeLoadIssues([skills, sources, history, policy]),
      skills: skills.data.items,
      sources: sources.data.items,
      history: history.data.items,
      policy: policy.data,
    };
  }, []);

  useEffect(() => {
    if (!data?.skills.length) {
      setSelectedSkillId("");
      return;
    }
    setSelectedSkillId((current) =>
      data.skills.some((item) => item.skillId === current) ? current : (data.skills[0]?.skillId ?? ""),
    );
  }, [data]);

  const selectedSkill = data?.skills.find((item) => item.skillId === selectedSkillId) ?? null;

  const handleSkillState = async (state: SkillListItem["state"]) => {
    if (!selectedSkill) {
      return;
    }
    try {
      await updateSkillState(selectedSkill.skillId, { state });
      setNotice({ tone: "success", message: `${selectedSkill.name} set to ${state}.` });
      await reload();
    } catch (stateError) {
      setNotice({ tone: "error", message: getErrorMessage(stateError) });
    }
  };

  const handleReloadSkills = async () => {
    try {
      await reloadSkills();
      setNotice({ tone: "success", message: "Skills reloaded from disk." });
      await reload();
    } catch (reloadError) {
      setNotice({ tone: "error", message: getErrorMessage(reloadError) });
    }
  };

  return (
    <LibrarySectionShell loading={loading} error={error}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Installed skills"
          subtitle="Reusable behavior you can inspect and change from the native library."
          stats={[
            { label: "Installed", value: String(data?.skills.length ?? 0) },
            { label: "Callable", value: String(data?.skills.filter((item) => item.callable).length ?? 0) },
          ]}
        >
          <LibrarySelectableList
            items={(data?.skills ?? []).map((item) => ({
              id: item.skillId,
              title: item.name,
              meta: item.state,
              body: item.note ?? item.reviewWarning ?? item.capabilityCategory ?? item.source,
            }))}
            selectedId={selectedSkillId}
            onSelect={setSelectedSkillId}
            emptyLabel="No skills available yet."
          />
          <LibraryButtonRow>
            <button type="button" className="mc-next-settings-filter" onClick={() => void handleReloadSkills()}>
              <RefreshCw className="h-4 w-4" />
              Reload skills
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedSkill?.name ?? "Skill detail"}
            subtitle={selectedSkill?.source ?? "Select a skill to inspect its instruction, tools, and lifecycle."}
          >
            {selectedSkill ? (
              <>
                <LibraryMetricGrid
                  items={[
                    { label: "State", value: selectedSkill.state, meta: selectedSkill.trustLabel ?? "Runtime posture" },
                    {
                      label: "Source",
                      value: selectedSkill.source,
                      meta: selectedSkill.lifecycleState ?? "Skill source",
                    },
                    {
                      label: "Callable",
                      value: selectedSkill.callable ? "Yes" : "No",
                      meta: selectedSkill.capabilityCategory ?? "Capability category",
                    },
                    { label: "Requires", value: String(selectedSkill.requires.length), meta: selectedSkill.dir },
                  ]}
                />
                <LibraryCodeBlock label="Instruction body">
                  {truncateText(selectedSkill.instructionBody, 1200)}
                </LibraryCodeBlock>
                <LibraryCodeBlock label="Declared tools">
                  {selectedSkill.declaredTools.length ? selectedSkill.declaredTools.join(", ") : "No declared tools"}
                </LibraryCodeBlock>
                <LibraryButtonRow>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void handleSkillState("enabled")}
                  >
                    Enable
                  </button>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void handleSkillState("sleep")}
                  >
                    Sleep
                  </button>
                  <button
                    type="button"
                    className="mc-next-settings-filter"
                    onClick={() => void handleSkillState("disabled")}
                  >
                    Disable
                  </button>
                </LibraryButtonRow>
                <SkillEvaluationWorkbench skill={selectedSkill} onNotice={setNotice} />
              </>
            ) : (
              <LibraryEmptyState label="Select a skill to inspect it." />
            )}
          </NativeCard>
          <NativeCard
            title="Discovery and import posture"
            subtitle="Sources and recent import history stay visible in Library."
          >
            <LibraryMetricGrid
              items={[
                {
                  label: "Source matches",
                  value: String(data?.sources.length ?? 0),
                  meta: "Search providers currently responding",
                },
                { label: "Import history", value: String(data?.history.length ?? 0), meta: "Recent install attempts" },
                {
                  label: "Auto threshold",
                  value: String(data?.policy?.guardedAutoThreshold ?? "n/a"),
                  meta: data?.policy?.requireFirstUseConfirmation
                    ? "First use confirmation on"
                    : "First use confirmation off",
                },
              ]}
            />
            <LibraryActionList
              items={(data?.sources ?? []).slice(0, 5).map((item) => ({
                id: item.sourceUrl,
                label: item.name,
                description: item.description,
                meta: `${item.sourceProvider} · ${describeSkillSourceDisposition(item)}`,
              }))}
              emptyLabel="No skill source matches are available right now."
            />
            <LibraryActionList
              items={(data?.history ?? []).slice(0, 5).map((item) => ({
                id: item.importId,
                label: item.sourceRef,
                description: `${item.action} · ${item.outcome} · ${formatSkillImportPosture(item.details)}`,
                meta: `${item.sourceProvider} · ${formatDateTime(item.createdAt)}`,
              }))}
              emptyLabel="No import history yet."
            />
          </NativeCard>
          <QuickJumpCard
            title="Related routes"
            subtitle="Keep adjacent Library surfaces within reach."
            actions={[
              { label: "Agents", route: { area: "library", section: "agents", theme: route.theme } },
              { label: "Capabilities", route: { area: "library", section: "capabilities", theme: route.theme } },
              { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
              { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
            ]}
            navigate={navigate}
          />
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function SkillEvaluationWorkbench({ skill, onNotice }: { skill: SkillListItem; onNotice: (notice: Notice) => void }) {
  const [runs, setRuns] = useState<SkillEvaluationRunRecord[]>([]);
  const [activeRun, setActiveRun] = useState<SkillEvaluationRunRecord | null>(null);
  const [proposalDetail, setProposalDetail] = useState<CapabilityProposalDetailRecord | null>(null);
  const [curatorReview, setCuratorReview] = useState<CuratorReviewItem | null>(null);
  const [scenarioDraft, setScenarioDraft] = useState("");
  const [criteriaDraft, setCriteriaDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [proposalBusyKey, setProposalBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const response = await fetchSkillEvaluations(skill.skillId);
      setRuns(response.items);
      setActiveRun((current) =>
        current && response.items.some((item) => item.runId === current.runId)
          ? (response.items.find((item) => item.runId === current.runId) ?? current)
          : (response.items[0] ?? null),
      );
    } catch (runError) {
      setError(getErrorMessage(runError));
    }
  }, [skill.skillId]);

  useEffect(() => {
    setRuns([]);
    setActiveRun(null);
    setProposalDetail(null);
    setCuratorReview(null);
    setScenarioDraft("");
    setCriteriaDraft("");
    setError(null);
    void loadRuns();
  }, [loadRuns]);

  useEffect(() => {
    if (!activeRun) {
      return;
    }
    setScenarioDraft(serializeScenarioDrafts(activeRun.scenarios));
    setCriteriaDraft(serializeCriterionDrafts(activeRun.criteria));
  }, [activeRun]);

  const runAction = async (action: () => Promise<SkillEvaluationRunRecord>, successMessage: string) => {
    setBusy(true);
    setError(null);
    try {
      const run = await action();
      setActiveRun(run);
      await loadRuns();
      onNotice({ tone: "success", message: successMessage });
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateScenarios = () =>
    runAction(async () => (await previewSkillEvaluation(skill.skillId)).run, "Generated evaluation scenarios.");

  const handleRunBaseline = () =>
    runAction(
      async () =>
        (
          await previewSkillEvaluation(skill.skillId, {
            scenarios: parseScenarioDrafts(scenarioDraft),
            criteria: parseCriterionDrafts(criteriaDraft),
          })
        ).run,
      "Baseline preview completed.",
    );

  const handleRunImprovement = () =>
    runAction(
      async () =>
        (
          await runSkillEvaluation(skill.skillId, {
            scenarios: parseScenarioDrafts(scenarioDraft),
            criteria: parseCriterionDrafts(criteriaDraft),
          })
        ).run,
      "Skill improvement run stored.",
    );

  const handleCreateProposal = async () => {
    if (!activeRun) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await createSkillEvaluationProposal(activeRun.runId);
      setActiveRun(response.run);
      setProposalDetail({ proposal: response.proposal, events: [], candidate: undefined });
      if (response.run.improvementCandidateId) {
        setCuratorReview(await fetchCuratorReviewItem(response.run.improvementCandidateId));
      }
      await loadRuns();
      onNotice({ tone: "success", message: `Proposal created: ${response.proposal.proposalId}` });
    } catch (proposalError) {
      setError(getErrorMessage(proposalError));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenProposal = async () => {
    const proposalId = activeRun?.proposalId;
    if (!proposalId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const detail = await fetchCapabilityProposal(proposalId);
      setProposalDetail(detail);
      const candidateId = detail.proposal.candidateId ?? activeRun?.improvementCandidateId;
      if (candidateId) {
        setCuratorReview(await fetchCuratorReviewItem(candidateId));
      }
    } catch (proposalError) {
      setError(getErrorMessage(proposalError));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenTrustReview = async () => {
    const candidateId = activeRun?.improvementCandidateId ?? proposalDetail?.proposal.candidateId;
    if (!candidateId) {
      return;
    }
    setProposalBusyKey("open-review");
    setError(null);
    try {
      setCuratorReview(await fetchCuratorReviewItem(candidateId));
    } catch (reviewError) {
      setError(getErrorMessage(reviewError));
    } finally {
      setProposalBusyKey(null);
    }
  };

  const handleProposalLifecycleAction = async (action: ImprovementCandidateLifecycleAction) => {
    const candidateId = curatorReview?.candidate.candidateId ?? activeRun?.improvementCandidateId;
    if (!candidateId) {
      return;
    }
    setProposalBusyKey(action);
    setError(null);
    try {
      const input =
        action === "snooze"
          ? {
              reason: "Operator snoozed from proposal trust review.",
              snoozeUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            }
          : { reason: `Operator selected ${action} from proposal trust review.` };
      const result =
        action === "validate"
          ? await validateImprovementCandidate(candidateId, input)
          : action === "approve"
            ? await approveImprovementCandidate(candidateId, input)
            : action === "reject"
              ? await rejectImprovementCandidate(candidateId, input)
              : action === "snooze"
                ? await snoozeImprovementCandidate(candidateId, input)
                : action === "activate"
                  ? await activateImprovementCandidate(candidateId, input)
                  : await promoteImprovementCandidate(candidateId, input);
      setCuratorReview(result.review);
      await loadRuns();
      onNotice({
        tone: result.mutationApplied ? "success" : "info",
        message: `${action} recorded. Mutation applied: ${result.mutationApplied ? "yes" : "no"}.`,
      });
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setProposalBusyKey(null);
    }
  };

  const baselineRate = activeRun ? formatPercent(activeRun.baselineResult.score.passRate) : "n/a";
  const candidateRate = activeRun?.candidateResult ? formatPercent(activeRun.candidateResult.score.passRate) : "n/a";
  const trustReviewCandidateId = activeRun?.improvementCandidateId ?? proposalDetail?.proposal.candidateId;

  return (
    <div className="mc-next-settings-stack">
      <LibraryMetricGrid
        items={[
          { label: "Baseline", value: baselineRate, meta: activeRun ? "Instruction behavior score" : "No run yet" },
          {
            label: "Candidate",
            value: candidateRate,
            meta: activeRun?.accepted ? `+${formatPercent(activeRun.improvementDelta)}` : "Proposal gated",
          },
          {
            label: "Proposal",
            value: activeRun?.proposalId ? "Created" : activeRun?.accepted ? "Ready" : "None",
            meta: activeRun?.proposalId ?? "Review before activation",
          },
          { label: "Truth", value: "No scripts", meta: "No direct skill file writes" },
        ]}
      />
      {error ? <LibraryNotice notice={{ tone: "error", message: error }} /> : null}
      <LibraryFieldGrid>
        <LibraryField label="Scenarios" span={2}>
          <textarea
            className="mc-next-settings-textarea"
            value={scenarioDraft}
            onChange={(event) => setScenarioDraft(event.target.value)}
            rows={5}
            placeholder="Title | Prompt | Expected outcome"
          />
        </LibraryField>
        <LibraryField label="Criteria" span={2}>
          <textarea
            className="mc-next-settings-textarea"
            value={criteriaDraft}
            onChange={(event) => setCriteriaDraft(event.target.value)}
            rows={5}
            placeholder="Label | Description | required, terms"
          />
        </LibraryField>
      </LibraryFieldGrid>
      <LibraryButtonRow>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleGenerateScenarios}>
          <Sparkles className="h-4 w-4" />
          Generate scenarios
        </button>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleRunBaseline}>
          <RefreshCw className="h-4 w-4" />
          Run baseline
        </button>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleRunImprovement}>
          <Save className="h-4 w-4" />
          Run improvement
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={busy || !activeRun?.accepted || Boolean(activeRun.proposalId)}
          onClick={() => void handleCreateProposal()}
        >
          <Plus className="h-4 w-4" />
          Create proposal
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={busy || !activeRun?.proposalId}
          onClick={() => void handleOpenProposal()}
        >
          <FileText className="h-4 w-4" />
          Open proposal
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={Boolean(proposalBusyKey) || !trustReviewCandidateId}
          onClick={() => void handleOpenTrustReview()}
        >
          <Workflow className="h-4 w-4" />
          Trust review
        </button>
      </LibraryButtonRow>
      {activeRun ? (
        <>
          <LibraryCodeBlock label="Mutation diff">
            {activeRun.mutation
              ? truncateText(activeRun.mutation.patchPreview, 1600)
              : "No candidate mutation has been generated yet."}
          </LibraryCodeBlock>
          <LibraryCodeBlock label="Evidence">
            {JSON.stringify(
              {
                runId: activeRun.runId,
                status: activeRun.status,
                targetPassRate: activeRun.targetPassRate,
                accepted: activeRun.accepted,
                operatorTruth: activeRun.operatorTruth,
                ledgerSignalId: activeRun.ledgerSignalId,
                improvementCandidateId: activeRun.improvementCandidateId,
                proposalId: activeRun.proposalId,
                warnings: activeRun.warnings,
              },
              null,
              2,
            )}
          </LibraryCodeBlock>
        </>
      ) : (
        <LibraryEmptyState label="No skill evaluation run is selected." />
      )}
      {proposalDetail || curatorReview ? (
        <ProposalTrustReviewPanel
          proposalDetail={proposalDetail}
          curatorReview={curatorReview}
          busyKey={proposalBusyKey}
          onAction={(action) => void handleProposalLifecycleAction(action)}
        />
      ) : null}
      <LibraryActionList
        items={runs.slice(0, 5).map((run) => ({
          id: run.runId,
          label: `${formatPercent(run.baselineResult.score.passRate)} → ${
            run.candidateResult ? formatPercent(run.candidateResult.score.passRate) : "n/a"
          }`,
          description: run.mutation?.summary ?? "Baseline only",
          meta: `${run.status} · ${formatDateTime(run.updatedAt)}`,
          actionLabel: activeRun?.runId === run.runId ? "Selected" : "Open",
          onClick: () => setActiveRun(run),
        }))}
        emptyLabel="No stored skill evaluations yet."
      />
    </div>
  );
}

function ProposalTrustReviewPanel({
  proposalDetail,
  curatorReview,
  busyKey,
  onAction,
}: {
  proposalDetail: CapabilityProposalDetailRecord | null;
  curatorReview: CuratorReviewItem | null;
  busyKey: string | null;
  onAction: (action: ImprovementCandidateLifecycleAction) => void;
}) {
  const proposal = proposalDetail?.proposal;
  const payload = proposal?.payload;
  const observedIssue =
    curatorReview?.observedIssue ??
    readPayloadString(payload, ["observedIssue", "issue", "summary"]) ??
    proposal?.summary ??
    "No observed issue was attached to this proposal.";
  const proposedChange =
    curatorReview?.proposedChange ??
    readPayloadString(payload, ["proposedChange", "mutation.summary", "proposalType"]) ??
    "Review the linked proposal payload before approving any mutation.";
  const risk = curatorReview?.risk ?? readPayloadString(payload, ["risk"]) ?? "unknown";
  const callableImpact = curatorReview?.callableImpact ?? readPayloadString(payload, ["callableImpact"]) ?? "unknown";
  const rollbackRef =
    curatorReview?.rollbackRef ??
    curatorReview?.latestActivation?.preActivationSnapshot.refId ??
    readPayloadString(payload, ["rollbackRef"]) ??
    "not created";
  const approvalState = curatorReview?.latestActivation?.approvalId
    ? `${curatorReview.latestActivation.status} · approval ${curatorReview.latestActivation.approvalId}`
    : (curatorReview?.candidate.status ?? proposal?.status ?? "not requested");
  const mutationApplied = Boolean(curatorReview?.mutationApplied);
  const evidence = curatorReview?.evidence.length ? curatorReview.evidence : readPayloadEvidenceRefs(payload);
  const actionDisabledReasons = curatorReview?.disabledReasons ?? {};
  const actionStatuses = curatorReview?.actionStatuses;
  const actions: ImprovementCandidateLifecycleAction[] = [
    "validate",
    "approve",
    "reject",
    "snooze",
    "activate",
    "promote",
  ];

  const canRunAction = (action: ImprovementCandidateLifecycleAction) => {
    if (!curatorReview || busyKey) {
      return false;
    }
    if (actionStatuses?.[action] !== "ready") {
      return false;
    }
    if ((action === "activate" || action === "promote") && curatorReview.candidate.status !== "approved") {
      return false;
    }
    return true;
  };

  return (
    <div className="mc-next-settings-stack" data-testid="proposal-trust-review">
      <LibraryMetricGrid
        items={[
          { label: "Approval", value: approvalState, meta: "Review-first lifecycle" },
          { label: "Mutation applied", value: mutationApplied ? "true" : "false", meta: "No silent mutation" },
          {
            label: "Risk",
            value: risk,
            meta: curatorReview?.approvalRequired ? "Approval required" : "Review visible",
          },
          {
            label: "Callable impact",
            value: callableImpact,
            meta: curatorReview?.corruptionStatus ?? "proposal payload",
          },
        ]}
      />
      <LibraryCodeBlock label="Observed issue">{observedIssue}</LibraryCodeBlock>
      <LibraryCodeBlock label="Proposed change">{proposedChange}</LibraryCodeBlock>
      <LibraryCodeBlock label="Rollback">{rollbackRef}</LibraryCodeBlock>
      <LibraryActionList
        items={evidence.slice(0, 8).map((item) => ({
          id: `${item.refType}:${item.refId}`,
          label: item.refType,
          description: item.refId,
          meta: item.hash ? `hash ${item.hash}` : formatEvidenceMetadata(item.metadata),
        }))}
        emptyLabel="No proposal evidence refs are attached yet."
      />
      <LibraryButtonRow>
        {actions.map((action) => {
          const disabledReason = !curatorReview
            ? "Open the trust review before running lifecycle actions."
            : (actionDisabledReasons[action] ??
              ((action === "activate" || action === "promote") && curatorReview.candidate.status !== "approved"
                ? "Candidate must be approved before mutation-capable actions."
                : undefined));
          const disabled = !canRunAction(action);
          return (
            <button
              key={action}
              type="button"
              className="mc-next-settings-filter"
              disabled={disabled}
              title={disabled ? disabledReason : undefined}
              onClick={() => onAction(action)}
            >
              {busyKey === action ? "Working..." : formatTaskStatus(action)}
            </button>
          );
        })}
      </LibraryButtonRow>
      {curatorReview ? (
        <LibraryCodeBlock label="Lifecycle truth">
          {JSON.stringify(
            {
              candidateId: curatorReview.candidate.candidateId,
              status: curatorReview.candidate.status,
              runtimeProvenCallable: curatorReview.runtimeProvenCallable,
              corruptionStatus: curatorReview.corruptionStatus,
              disabledReasons: curatorReview.disabledReasons,
              latestActivation: curatorReview.latestActivation
                ? {
                    activationId: curatorReview.latestActivation.activationId,
                    status: curatorReview.latestActivation.status,
                    approvalId: curatorReview.latestActivation.approvalId,
                    mutationApplied,
                  }
                : null,
            },
            null,
            2,
          )}
        </LibraryCodeBlock>
      ) : (
        <LibraryEmptyState label="Open the trust review to see action guards and lifecycle state." />
      )}
      {proposal ? (
        <LibraryCodeBlock label="Capability proposal">
          {JSON.stringify(
            {
              proposalId: proposal.proposalId,
              status: proposal.status,
              title: proposal.title,
              activationTargetId: proposal.activationTargetId,
              candidateId: proposal.candidateId,
              events: proposalDetail?.events.length ?? 0,
            },
            null,
            2,
          )}
        </LibraryCodeBlock>
      ) : null}
    </div>
  );
}

function describeSkillSourceDisposition(item: {
  installability?: string;
  skillFamily?: string;
  tags?: string[];
  name?: string;
}) {
  if (item.installability === "not_installable") {
    return "Rejected";
  }
  const family = item.skillFamily?.toLowerCase() ?? "";
  const conditionalFamilies = new Set([
    "openclaw_experiment",
    "github_connector_playbook",
    "google_cli_oauth",
    "copy_humanizer",
    "canvas_a2ui",
  ]);
  if (conditionalFamilies.has(family) || item.installability === "installable") {
    return "Conditional install";
  }
  const referenceOnlyFamilies = new Set([
    "auto_updates",
    "global_search_broker",
    "proactive_automation",
    "automation_designer",
    "decision_journal",
    "typed_memory_ontology",
    "frontend_review_guidance",
    "voice_transcription",
  ]);
  if (referenceOnlyFamilies.has(family)) {
    return "Reference only";
  }
  const nativeOverlapFamilies = new Set([
    "harness_engineering",
    "capability_evolution",
    "browser_automation",
    "cloudflare_dns",
    "skill_vetting",
    "multi_agent_swarm",
  ]);
  if (nativeOverlapFamilies.has(family)) {
    return "Native overlap";
  }
  if (item.installability === "review_only") {
    return "Reference only";
  }
  const haystack = [family, item.name, ...(item.tags ?? [])].filter(Boolean).join(" ").toLowerCase();
  if (/native|overlap|vetting|capability|browser_automation|multi_agent_swarm/.test(haystack)) {
    return "Native overlap";
  }
  return "Reference only";
}

function formatSkillImportPosture(details: unknown) {
  const record = readRecord(details);
  const disposition = readRecord(record.scriptDisposition);
  const scriptAction = typeof disposition.action === "string" ? disposition.action : "none";
  const mappings = Array.isArray(record.externalToolMappings) ? record.externalToolMappings : [];
  const mappedCount = mappings.filter((item) => readRecord(item).disposition === "mapped").length;
  const provenance = readRecord(record.provenance);
  const nonCallable = provenance.nonCallableUntilActivated === true ? "non-callable" : "provenance pending";
  return `${nonCallable}; scripts ${scriptAction}; tools ${mappedCount}/${mappings.length} mapped`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
