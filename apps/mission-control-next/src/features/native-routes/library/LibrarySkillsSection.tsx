/* eslint-disable max-lines -- LibrarySkillsSection coordinates the skill list, detail, evaluation workbench, and the HX-402 P2 approval-first state surface in one orchestrator (MemoryRoutePage precedent) until the Library surface is split. */
import { useCallback, useEffect, useMemo, useState } from "react";
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
  isApiRequestError,
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
import { NativeCard, NativeDisclosureCard, NativeSectionIndex, QuickJumpCard } from "../NativeRoutePageLayout";
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
  LibraryActionCardGrid,
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
import { describeSkillSourceDisposition, formatSkillImportPosture } from "./library-skill-trust-format";
import { SkillHubOperatorPanel } from "./SkillHubOperatorPanel";

export function LibrarySkillsSection({ route, navigate, activeWorkspaceId }: NativeRoutePagesProps) {
  const [selectedSkillId, setSelectedSkillId] = useState("");
  const [skillQuery, setSkillQuery] = useState("");
  const [skillPostureFilter, setSkillPostureFilter] = useState<SkillPostureFilter>("all");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pendingSkillState, setPendingSkillState] = useState<{
    skillId: string;
    state: SkillListItem["state"];
  } | null>(null);
  const {
    loading,
    error,
    data: skillsData,
    reload: reloadSkillsList,
  } = useAsyncLoad(async () => {
    const skills = await nativeLoad("Skills", fetchSkills(), { items: [] });
    return {
      issues: nativeLoadIssues([skills]),
      skills: skills.data.items,
    };
  }, []);
  const { data: supportingData, reload: reloadSupportingData } = useAsyncLoad(async () => {
    const [sources, history, policy] = await Promise.all([
      nativeLoad("Skill sources", fetchSkillSources({ limit: 10 }), {
        generatedAt: "1970-01-01T00:00:00.000Z",
        items: [],
        providers: [],
      }),
      nativeLoad("Skill import history", fetchSkillImportHistory(10), { items: [] }),
      nativeLoad("Skill activation policy", fetchSkillActivationPolicies(), null),
    ]);
    return {
      issues: nativeLoadIssues([sources, history, policy]),
      sources: sources.data.items,
      history: history.data.items,
      policy: policy.data,
    };
  }, []);
  const reload = useCallback(async () => {
    await Promise.all([reloadSkillsList(), reloadSupportingData()]);
  }, [reloadSkillsList, reloadSupportingData]);
  const data = useMemo(() => {
    if (!skillsData && !supportingData) {
      return null;
    }
    return {
      issues: [...(skillsData?.issues ?? []), ...(supportingData?.issues ?? [])],
      skills: skillsData?.skills ?? [],
      sources: supportingData?.sources ?? [],
      history: supportingData?.history ?? [],
      policy: supportingData?.policy ?? null,
    };
  }, [skillsData, supportingData]);

  const filteredSkills = useMemo(
    () => filterSkillList(data?.skills ?? [], { query: skillQuery, posture: skillPostureFilter }),
    [data?.skills, skillPostureFilter, skillQuery],
  );
  const reviewNeededCount = data?.skills.filter((item) => item.reviewWarning || !item.callable).length ?? 0;
  const lifecycleManagedCount = data?.skills.filter((item) => item.lifecycleState).length ?? 0;

  useEffect(() => {
    if (!filteredSkills.length) {
      setSelectedSkillId("");
      return;
    }
    setSelectedSkillId((current) =>
      filteredSkills.some((item) => item.skillId === current) ? current : (filteredSkills[0]?.skillId ?? ""),
    );
  }, [filteredSkills]);

  const selectedSkill = data?.skills.find((item) => item.skillId === selectedSkillId) ?? null;

  const handleSkillState = async (state: SkillListItem["state"]) => {
    if (!selectedSkill) {
      return;
    }
    if (!isPositiveRevision(selectedSkill.revision)) {
      setNotice({
        tone: "error",
        message: "This skill is missing a canonical revision. Refresh the skill list before changing its state.",
      });
      return;
    }
    setPendingSkillState(null);
    try {
      const outcome = await updateSkillState(selectedSkill.skillId, {
        expectedRevision: selectedSkill.revision,
        state,
      });
      setNotice({ tone: "success", message: describeSkillStateOutcome(outcome, selectedSkill.name, state) });
      await reload();
    } catch (stateError) {
      if (isWriteConflict(stateError)) {
        setPendingSkillState({ skillId: selectedSkill.skillId, state });
        await reload();
        setNotice({
          tone: "error",
          message: `${selectedSkill.name} changed elsewhere. The canonical skill list was refreshed; review it, then retry ${state} explicitly.`,
        });
        return;
      }
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
    <LibrarySectionShell loading={loading} error={error} onRetry={reload}>
      {notice ? <LibraryNotice notice={notice} /> : null}
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      <NativeSectionIndex
        items={[
          { id: "skills-installed", label: "Installed" },
          { id: "skills-detail", label: "Skill detail" },
          { id: "skills-discovery", label: "Discovery" },
          { id: "skills-related", label: "Related routes" },
        ]}
      />
      <SkillHubOperatorPanel
        workspaceId={activeWorkspaceId}
        onOpenApproval={(approvalId) => navigate({ area: "ops", section: "approvals", approvalId, theme: route.theme })}
      />
      <div className="mc-next-settings-grid">
        <NativeCard
          id="skills-installed"
          title="Installed skills"
          subtitle="Reusable behavior you can inspect and change from the native library."
          stats={[
            { label: "Installed", value: String(data?.skills.length ?? 0) },
            { label: "Callable", value: String(data?.skills.filter((item) => item.callable).length ?? 0) },
            { label: "Filtered", value: String(filteredSkills.length) },
          ]}
        >
          <LibraryFieldGrid>
            <LibraryField label="Search skills">
              <input
                className="mc-next-settings-input"
                value={skillQuery}
                onChange={(event) => setSkillQuery(event.target.value)}
                placeholder="Name, tool, tag, or source"
              />
            </LibraryField>
            <LibraryField label="Posture">
              <select
                className="mc-next-settings-input"
                value={skillPostureFilter}
                onChange={(event) => setSkillPostureFilter(event.target.value as SkillPostureFilter)}
              >
                <option value="all">All</option>
                <option value="callable">Callable</option>
                <option value="review">Needs review</option>
                <option value="enabled">Enabled</option>
                <option value="sleep">Sleep</option>
                <option value="disabled">Disabled</option>
              </select>
            </LibraryField>
          </LibraryFieldGrid>
          <LibrarySelectableList
            items={filteredSkills.map((item) => ({
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
              <RefreshCw size={16} />
              Reload skills
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            id="skills-detail"
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
                <LibraryActionCardGrid
                  items={[
                    {
                      id: "draft-import",
                      label: "Draft / import",
                      value: selectedSkill.source,
                      description: selectedSkill.lifecycleState
                        ? `Lifecycle state: ${selectedSkill.lifecycleState}.`
                        : "Loaded from disk without a lifecycle record attached.",
                      meta: selectedSkill.dir,
                      tone: selectedSkill.lifecycleState ? "info" : "neutral",
                    },
                    {
                      id: "validation-lane",
                      label: "Validation lane",
                      value: selectedSkill.callable ? "Callable" : "Needs eval",
                      description: selectedSkill.callable
                        ? "This skill can be selected by runtime skill resolution under policy."
                        : "Run baseline and improvement checks before treating this skill as runtime-ready.",
                      meta: selectedSkill.trustLabel ?? selectedSkill.note ?? "No trust label",
                      tone: selectedSkill.callable ? "success" : "warning",
                    },
                    {
                      id: "proposal-review",
                      label: "Proposal review",
                      value: selectedSkill.reviewWarning ? "Review needed" : "No warning",
                      description:
                        selectedSkill.reviewWarning ??
                        "Use the workbench below to create proposals before mutation-capable lifecycle actions.",
                      actionLabel: "Workbench below",
                      tone: selectedSkill.reviewWarning ? "warning" : "neutral",
                    },
                    {
                      id: "usage",
                      label: "Recent usage",
                      value: String(selectedSkill.usageCount ?? 0),
                      description: selectedSkill.lastUsedAt
                        ? `Last used ${formatDateTime(selectedSkill.lastUsedAt)}.`
                        : "No recent usage has been recorded on this skill state.",
                      meta: selectedSkill.pinned ? "Pinned" : "Not pinned",
                      tone: selectedSkill.lastUsedAt ? "info" : "neutral",
                    },
                    ...buildSkillDoctorSignals(selectedSkill),
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
                  {pendingSkillState?.skillId === selectedSkill.skillId ? (
                    <button
                      type="button"
                      className="mc-next-settings-filter"
                      onClick={() => void handleSkillState(pendingSkillState.state)}
                    >
                      {`Retry ${pendingSkillState.state}`}
                    </button>
                  ) : null}
                </LibraryButtonRow>
                <SkillEvaluationWorkbench skill={selectedSkill} onNotice={setNotice} />
              </>
            ) : (
              <LibraryEmptyState label="Select a skill to inspect it." />
            )}
          </NativeCard>
          <NativeDisclosureCard
            id="skills-discovery"
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
                  label: "Needs review",
                  value: String(reviewNeededCount),
                  meta: "Not callable or warning attached",
                },
                {
                  label: "Lifecycle",
                  value: String(lifecycleManagedCount),
                  meta: "Governed lifecycle records",
                },
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
              ariaLabel="Skill source matches"
              items={(data?.sources ?? []).slice(0, 5).map((item) => ({
                id: item.sourceUrl,
                label: item.name,
                description: item.description,
                meta: `${item.sourceProvider} · ${describeSkillSourceDisposition(item)}`,
              }))}
              emptyLabel="No skill source matches are available right now."
            />
            <LibraryActionList
              ariaLabel="Skill import history"
              items={(data?.history ?? []).slice(0, 5).map((item) => ({
                id: item.importId,
                label: item.sourceRef,
                description: `${item.action} · ${item.outcome} · ${formatSkillImportPosture(item.details)}`,
                meta: `${item.sourceProvider} · ${formatDateTime(item.createdAt)}`,
              }))}
              emptyLabel="No import history yet."
            />
          </NativeDisclosureCard>
          <NativeDisclosureCard
            id="skills-related"
            title="Related routes"
            subtitle="Keep adjacent Library surfaces within reach."
          >
            <QuickJumpCard
              title="Library routes"
              subtitle="Open another governed Library surface."
              actions={[
                { label: "Agents", route: { area: "library", section: "agents", theme: route.theme } },
                { label: "Capabilities", route: { area: "library", section: "capabilities", theme: route.theme } },
                { label: "Memory", route: { area: "library", section: "memory", theme: route.theme } },
                { label: "Prompt packs", route: { area: "library", section: "prompt-packs", theme: route.theme } },
              ]}
              navigate={navigate}
            />
          </NativeDisclosureCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}

export type SkillPostureFilter = "all" | "callable" | "review" | SkillListItem["state"];

/** HX-402 P2: honest approval-first copy — pending names the approval and states nothing changed; otherwise it is a pure no-op. */
export function describeSkillStateOutcome(outcome: unknown, skillName: string, state: string): string {
  const pending = (outcome as { pendingApproval?: { approvalId?: unknown } | null } | undefined)?.pendingApproval;
  const approvalId = typeof pending?.approvalId === "string" ? pending.approvalId : undefined;
  return approvalId
    ? `Approval requested to set ${skillName} to ${state}. Resolve approval ${approvalId} in Ops → Approvals; no change is applied until then.`
    : `${skillName} is already ${state}; nothing to approve.`;
}

function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isWriteConflict(error: unknown): boolean {
  if (!isApiRequestError(error) || error.status !== 409) {
    return false;
  }
  const body = error.body;
  return Boolean(body && typeof body === "object" && "code" in body && body.code === "WRITE_CONFLICT");
}

export interface SkillDoctorSignal {
  id: string;
  label: string;
  value: string;
  description: string;
  meta?: string;
  tone: "neutral" | "info" | "success" | "warning" | "danger";
}

export function buildSkillDoctorSignals(skill: SkillListItem): SkillDoctorSignal[] {
  const reviewNeeded = Boolean(skill.reviewWarning || !skill.callable || skill.state === "disabled");
  const provenance = describeSkillProvenance(skill);
  return [
    {
      id: "trust-doctor",
      label: "Trust doctor",
      value: reviewNeeded ? "Review needed" : "Ready",
      description:
        skill.reviewWarning ??
        (skill.callable
          ? "Callable posture is visible with trust label and lifecycle context attached."
          : "Skill remains inspectable until lifecycle and trust evidence make it callable."),
      meta: skill.trustLabel ?? "No trust label",
      tone: reviewNeeded ? "warning" : "success",
    },
    {
      id: "provenance-doctor",
      label: "Provenance",
      value: provenance.value,
      description: provenance.description,
      meta: provenance.meta,
      tone: provenance.tone,
    },
    {
      id: "tool-doctor",
      label: "Tool scope",
      value: `${skill.declaredTools.length} declared`,
      description: skill.declaredTools.length
        ? "Declared tools are visible before runtime policy gates actual calls."
        : "No declared tools are advertised by this skill.",
      meta: skill.requires.length ? `${skill.requires.length} requirements` : "No requirements",
      tone: skill.declaredTools.length ? "info" : "neutral",
    },
  ];
}

export function filterSkillList(
  skills: SkillListItem[],
  input: { query?: string; posture?: SkillPostureFilter },
): SkillListItem[] {
  const query = input.query?.trim().toLowerCase() ?? "";
  const posture = input.posture ?? "all";
  return skills.filter((skill) => {
    if (posture === "callable" && !skill.callable) {
      return false;
    }
    if (posture === "review" && skill.callable && !skill.reviewWarning) {
      return false;
    }
    if ((posture === "enabled" || posture === "sleep" || posture === "disabled") && skill.state !== posture) {
      return false;
    }
    if (!query) {
      return true;
    }
    const haystack = [
      skill.name,
      skill.source,
      skill.dir,
      skill.state,
      skill.lifecycleState,
      skill.trustLabel,
      skill.reviewWarning,
      skill.capabilityCategory,
      ...(skill.tags ?? []),
      ...skill.declaredTools,
      ...skill.requires,
      ...skill.keywords,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  });
}

function describeSkillProvenance(
  skill: SkillListItem,
): Pick<SkillDoctorSignal, "value" | "description" | "meta" | "tone"> {
  const sourceRef = skill.lifecycle?.provenance?.sourceRef;
  const sourceProvider = skill.lifecycle?.provenance?.sourceProvider;
  if (sourceRef || sourceProvider) {
    return {
      value: sourceProvider ?? "Recorded",
      description: sourceRef ? `Lifecycle provenance references ${sourceRef}.` : "Lifecycle provenance is recorded.",
      meta: skill.lifecycle?.provenance?.source,
      tone: "success",
    };
  }
  if (skill.lifecycleState) {
    return {
      value: "Lifecycle only",
      description: "Lifecycle state is recorded, but no source reference is attached.",
      meta: skill.lifecycleState,
      tone: "info",
    };
  }
  return {
    value: "Unmanaged",
    description: "Loaded from disk without lifecycle provenance attached.",
    meta: skill.source,
    tone: "warning",
  };
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
          <Sparkles size={16} />
          Generate scenarios
        </button>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleRunBaseline}>
          <RefreshCw size={16} />
          Run baseline
        </button>
        <button type="button" className="mc-next-settings-filter" disabled={busy} onClick={handleRunImprovement}>
          <Save size={16} />
          Run improvement
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={busy || !activeRun?.accepted || Boolean(activeRun.proposalId)}
          onClick={() => void handleCreateProposal()}
        >
          <Plus size={16} />
          Create proposal
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={busy || !activeRun?.proposalId}
          onClick={() => void handleOpenProposal()}
        >
          <FileText size={16} />
          Open proposal
        </button>
        <button
          type="button"
          className="mc-next-settings-filter"
          disabled={Boolean(proposalBusyKey) || !trustReviewCandidateId}
          onClick={() => void handleOpenTrustReview()}
        >
          <Workflow size={16} />
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
        ariaLabel="Stored skill evaluations"
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
  const supportPreview =
    readPayloadString(payload, ["supportPreview", "supportFilePreview", "supportFiles.preview"]) ??
    (evidence.length
      ? `${evidence.length} support reference${evidence.length === 1 ? "" : "s"} attached.`
      : "No support-file preview attached.");
  const revisionDiff =
    readPayloadString(payload, ["revisionDiff", "diffPreview", "mutation.diffPreview"]) ??
    "No revision diff preview was attached to this proposal.";
  const quarantineReason =
    curatorReview?.corruptionStatus === "quarantined"
      ? (readPayloadString(payload, ["quarantineReason", "corruptionReason"]) ??
        "Candidate is quarantined by curator integrity status.")
      : (readPayloadString(payload, ["quarantineReason", "corruptionReason"]) ?? "No quarantine reason recorded.");
  const proposalStatusFilter = `${proposal?.proposalKind ?? "proposal"} · ${proposal?.status ?? "not requested"}`;
  const notCallableCopy =
    curatorReview?.runtimeProvenCallable || callableImpact === "none"
      ? "No callable expansion is active from this proposal."
      : "Not callable yet: imported or generated skill material stays outside callableCatalog until governed activation.";
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
          { label: "Proposal filter", value: proposalStatusFilter, meta: "Status list scope" },
          {
            label: "Trust boundary",
            value: curatorReview?.runtimeProvenCallable ? "Runtime proven" : "Not callable yet",
            meta: "inspectableCatalog only",
          },
        ]}
      />
      <LibraryCodeBlock label="Observed issue">{observedIssue}</LibraryCodeBlock>
      <LibraryCodeBlock label="Proposed change">{proposedChange}</LibraryCodeBlock>
      <LibraryCodeBlock label="Support preview">{supportPreview}</LibraryCodeBlock>
      <LibraryCodeBlock label="Revision diff">{revisionDiff}</LibraryCodeBlock>
      <LibraryCodeBlock label="Quarantine reason">{quarantineReason}</LibraryCodeBlock>
      <LibraryCodeBlock label="Callable boundary">{notCallableCopy}</LibraryCodeBlock>
      <LibraryCodeBlock label="Rollback">{rollbackRef}</LibraryCodeBlock>
      <LibraryActionList
        ariaLabel="Proposal evidence references"
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
