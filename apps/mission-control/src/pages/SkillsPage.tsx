/* eslint-disable max-lines -- Skills remains a single operator surface while capability detail, proposal, and lifecycle controls settle. */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  CandidateSkillDetailRecord,
  CapabilityCatalogEntry,
  CodeModeSandboxMetadata,
  CapabilityProposalDetailRecord,
  CapabilityProposalRecord,
  SkillMergedSourceResult,
  SkillListItem,
  SkillRuntimeState,
  SkillSourceLookupParsedSource,
  SkillSourceProvider,
  SkillSourceSearchRecord,
} from "@goatcitadel/contracts";
import {
  fetchCapabilityCandidate,
  fetchCapabilityCatalog,
  fetchCapabilityProposal,
  fetchCapabilityProposals,
  fetchHarnessAuditReport,
  fetchSkillLookup,
  fetchSkillImportHistory,
  fetchSkillSources,
  fetchSkills,
  installSkillImport,
  promoteCapabilityCandidate,
  reloadSkills,
  revokeCapabilityCandidate,
  rollbackCapabilityCandidate,
  validateSkillImport,
  updateSkillState,
  fetchSkillActivationPolicies,
  patchSkillActivationPolicies,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { OperatorSplitLayout } from "../components/OperatorSplitLayout";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { HelpHint } from "../components/HelpHint";
import { GCSelect, GCSwitch } from "../components/ui";
import { GCEmptyState } from "../components/ui/GCEmptyState";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { useUiPreferences } from "../state/ui-preferences";
import {
  IMPORT_PROVIDER_OPTIONS,
  STATE_OPTIONS,
  deriveSkillCategoryLabel,
  deriveSourceCategoryLabel,
  describeValidationTrust,
  formatValidationList,
  groupByCategory,
} from "./skills/skills-page-helpers";

export {
  SKILL_FAMILY_TO_CATEGORY,
  deriveSkillCategoryLabel,
  deriveSourceCategoryLabel,
} from "./skills/skills-page-helpers";

function describeOriginatingRunSandbox(sandbox: CodeModeSandboxMetadata): string {
  if (sandbox.available) {
    return "available";
  }
  if (!sandbox.required) {
    return "advisory unsandboxed";
  }
  return "failed closed";
}

interface SkillActivationPolicyState {
  guardedAutoThreshold: number;
  requireFirstUseConfirmation: boolean;
}

export function SkillsPage() {
  const { mode } = useUiPreferences();
  const dirtyStateDraftSkillIdsRef = useRef<Set<string>>(new Set());
  const dirtyNoteDraftSkillIdsRef = useRef<Set<string>>(new Set());
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [capabilityCatalog, setCapabilityCatalog] = useState<CapabilityCatalogEntry[]>([]);
  const [capabilityProposals, setCapabilityProposals] = useState<CapabilityProposalRecord[]>([]);
  const [candidateDetail, setCandidateDetail] = useState<CandidateSkillDetailRecord | null>(null);
  const [proposalDetail, setProposalDetail] = useState<CapabilityProposalDetailRecord | null>(null);
  const [policy, setPolicy] = useState<SkillActivationPolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [stateDraftBySkill, setStateDraftBySkill] = useState<Record<string, SkillRuntimeState>>({});
  const [noteDraftBySkill, setNoteDraftBySkill] = useState<Record<string, string>>({});
  const [stateFilter, setStateFilter] = useState<"all" | SkillRuntimeState>("all");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourceItems, setSourceItems] = useState<SkillMergedSourceResult[]>([]);
  const [sourceProviders, setSourceProviders] = useState<SkillSourceSearchRecord[]>([]);
  const [sourceLookupMeta, setSourceLookupMeta] = useState<{
    bestMatch?: SkillMergedSourceResult;
    parsedSource?: SkillSourceLookupParsedSource;
  } | null>(null);
  const [importSourceRef, setImportSourceRef] = useState("");
  const [importSourceType, setImportSourceType] = useState<"local_path" | "local_zip" | "git_url">("local_path");
  const [importSourceProvider, setImportSourceProvider] = useState<SkillSourceProvider>("local");
  const [validationResult, setValidationResult] = useState<Awaited<ReturnType<typeof validateSkillImport>> | null>(
    null,
  );
  const [harnessAudit, setHarnessAudit] = useState<Awaited<ReturnType<typeof fetchHarnessAuditReport>> | null>(null);
  const [importHistory, setImportHistory] = useState<Awaited<ReturnType<typeof fetchSkillImportHistory>>["items"]>([]);
  const [importBusy, setImportBusy] = useState<null | "validate" | "install">(null);
  const [confirmHighRiskImport, setConfirmHighRiskImport] = useState(false);
  const [reviewBusyKey, setReviewBusyKey] = useState<string | null>(null);

  const load = useCallback(async (options?: { background?: boolean; includeStatic?: boolean }) => {
    const background = options?.background ?? false;
    const includeStatic = options?.includeStatic ?? !background;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    try {
      const [
        skillsResponse,
        policyResponse,
        importHistoryResponse,
        catalogResponse,
        proposalsResponse,
        harnessAuditResponse,
      ] = await Promise.all([
        fetchSkills(),
        includeStatic ? fetchSkillActivationPolicies() : Promise.resolve(null),
        includeStatic ? fetchSkillImportHistory(30) : Promise.resolve(null),
        fetchCapabilityCatalog("inspectable"),
        fetchCapabilityProposals(100),
        includeStatic ? fetchHarnessAuditReport() : Promise.resolve(null),
      ]);
      setSkills(skillsResponse.items);
      setCapabilityCatalog(catalogResponse.items);
      setCapabilityProposals(proposalsResponse.items);
      if (policyResponse) {
        setPolicy({
          guardedAutoThreshold: policyResponse.guardedAutoThreshold,
          requireFirstUseConfirmation: policyResponse.requireFirstUseConfirmation,
        });
      }
      if (importHistoryResponse) {
        setImportHistory(importHistoryResponse.items);
      }
      if (harnessAuditResponse) {
        setHarnessAudit(harnessAuditResponse);
      }
      setStateDraftBySkill((current) =>
        Object.fromEntries(
          skillsResponse.items.map((skill) => [
            skill.skillId,
            dirtyStateDraftSkillIdsRef.current.has(skill.skillId)
              ? (current[skill.skillId] ?? skill.state)
              : skill.state,
          ]),
        ),
      );
      setNoteDraftBySkill((current) =>
        Object.fromEntries(
          skillsResponse.items.map((skill) => [
            skill.skillId,
            dirtyNoteDraftSkillIdsRef.current.has(skill.skillId)
              ? (current[skill.skillId] ?? skill.note ?? "")
              : (skill.note ?? ""),
          ]),
        ),
      );
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      if (background) {
        setIsRefreshing(false);
      } else {
        setIsInitialLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  useRefreshSubscription(
    "skills",
    async () => {
      await load({ background: true, includeStatic: false });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1100,
      staleMs: 20000,
      pollIntervalMs: 15000,
    },
  );

  const filteredSkills = useMemo(
    () => skills.filter((skill) => (stateFilter === "all" ? true : skill.state === stateFilter)),
    [skills, stateFilter],
  );
  const selectedSkill = filteredSkills.find((skill) => skill.skillId === selectedSkillId) ?? filteredSkills[0] ?? null;
  const candidateEntries = useMemo(
    () => capabilityCatalog.filter((entry) => entry.kind === "candidate_skill"),
    [capabilityCatalog],
  );
  const proposalEntries = useMemo(
    () => capabilityCatalog.filter((entry) => entry.kind === "proposal"),
    [capabilityCatalog],
  );
  const groupedSkills = useMemo(() => groupByCategory(filteredSkills, deriveSkillCategoryLabel), [filteredSkills]);
  const groupedSourceItems = useMemo(() => groupByCategory(sourceItems, deriveSourceCategoryLabel), [sourceItems]);

  useEffect(() => {
    if (filteredSkills.length === 0) {
      if (selectedSkillId !== null) {
        setSelectedSkillId(null);
      }
      return;
    }
    const nextSelectedId =
      filteredSkills.find((skill) => skill.skillId === selectedSkillId)?.skillId ?? filteredSkills[0]?.skillId ?? null;
    if (nextSelectedId !== selectedSkillId) {
      setSelectedSkillId(nextSelectedId);
    }
  }, [filteredSkills, selectedSkillId]);

  const onReload = useCallback(async () => {
    try {
      await reloadSkills();
      await load({ background: true, includeStatic: false });
      setStatus("Skills reloaded.");
    } catch (err) {
      setError((err as Error).message);
    }
  }, [load]);

  const onSavePolicy = useCallback(async () => {
    if (!policy) {
      return;
    }
    setSavingPolicy(true);
    try {
      const updated = await patchSkillActivationPolicies({
        guardedAutoThreshold: policy.guardedAutoThreshold,
        requireFirstUseConfirmation: policy.requireFirstUseConfirmation,
      });
      setPolicy({
        guardedAutoThreshold: updated.guardedAutoThreshold,
        requireFirstUseConfirmation: updated.requireFirstUseConfirmation,
      });
      setStatus("Activation policy saved.");
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingPolicy(false);
    }
  }, [policy]);

  const onSaveSkillState = useCallback(
    async (skill: SkillListItem) => {
      const draftState = stateDraftBySkill[skill.skillId] ?? skill.state;
      const draftNote = noteDraftBySkill[skill.skillId] ?? "";
      setBusySkillId(skill.skillId);
      try {
        await updateSkillState(skill.skillId, {
          state: draftState,
          note: draftNote.trim() || undefined,
        });
        dirtyStateDraftSkillIdsRef.current.delete(skill.skillId);
        dirtyNoteDraftSkillIdsRef.current.delete(skill.skillId);
        await load({ background: true, includeStatic: false });
        setStatus(`Updated ${skill.name} to ${draftState}.`);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusySkillId(null);
      }
    },
    [load, noteDraftBySkill, stateDraftBySkill],
  );

  const onLoadSources = useCallback(async () => {
    setSourcesLoading(true);
    try {
      const query = sourceQuery.trim();
      if (query) {
        const response = await fetchSkillLookup({
          q: query,
          limit: 25,
        });
        setSourceItems(response.items);
        setSourceProviders(response.providers);
        setSourceLookupMeta({
          bestMatch: response.bestMatch,
          parsedSource: response.parsedSource,
        });
      } else {
        const response = await fetchSkillSources({
          limit: 25,
        });
        setSourceItems(response.items);
        setSourceProviders(response.providers);
        setSourceLookupMeta(null);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSourcesLoading(false);
    }
  }, [sourceQuery]);

  useEffect(() => {
    setSourcesLoading(true);
    void fetchSkillSources({ limit: 25 })
      .then((response) => {
        setSourceItems(response.items);
        setSourceProviders(response.providers);
        setSourceLookupMeta(null);
      })
      .catch((err) => {
        setError((err as Error).message);
      })
      .finally(() => setSourcesLoading(false));
  }, []);

  const onValidateImport = useCallback(async () => {
    const sourceRef = importSourceRef.trim();
    if (!sourceRef) {
      setError("Provide a local path, zip file path, or git URL.");
      return;
    }
    setImportBusy("validate");
    try {
      const validation = await validateSkillImport({
        sourceRef,
        sourceType: importSourceType,
        sourceProvider: importSourceProvider,
      });
      setValidationResult(validation);
      setStatus(
        validation.valid
          ? `Validation passed (${validation.riskLevel} risk).`
          : "Validation completed with blocking errors.",
      );
      setError(null);
      await load({ background: true, includeStatic: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportBusy(null);
    }
  }, [importSourceRef, importSourceType, importSourceProvider, load]);

  const onInstallImport = useCallback(async () => {
    const sourceRef = importSourceRef.trim();
    if (!sourceRef) {
      setError("Provide a source before install.");
      return;
    }
    if (validationResult?.nativeOverlaps?.length) {
      setError("This import is blocked because it overlaps a native GoatCitadel capability family.");
      return;
    }
    if (validationResult?.reviewDisposition === "reference_only" || validationResult?.reviewDisposition === "reject") {
      setError(validationResult.reviewMessage ?? "This import is review-only and cannot be installed directly.");
      return;
    }
    setImportBusy("install");
    try {
      const installed = await installSkillImport({
        sourceRef,
        sourceType: importSourceType,
        sourceProvider: importSourceProvider,
        confirmHighRisk: confirmHighRiskImport,
        force: false,
      });
      setValidationResult(installed.validation);
      setStatus(
        installed.installedSkillId
          ? `Installed ${installed.installedSkillId}. Skill remains disabled until you enable it.`
          : "Skill installed. Reloaded and kept disabled by default.",
      );
      setError(null);
      await load({ background: true, includeStatic: true });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setImportBusy(null);
    }
  }, [confirmHighRiskImport, importSourceRef, importSourceProvider, importSourceType, load, validationResult]);

  const onInspectCandidate = useCallback(async (candidateId: string) => {
    setReviewBusyKey(`candidate:${candidateId}`);
    try {
      const detail = await fetchCapabilityCandidate(candidateId);
      setCandidateDetail(detail);
      setProposalDetail(null);
      setStatus(`Loaded candidate ${candidateId}.`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReviewBusyKey(null);
    }
  }, []);

  const onInspectProposal = useCallback(async (proposalId: string) => {
    setReviewBusyKey(`proposal:${proposalId}`);
    try {
      const detail = await fetchCapabilityProposal(proposalId);
      setProposalDetail(detail);
      setCandidateDetail(detail.candidate ?? null);
      setStatus(`Loaded proposal ${proposalId}.`);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setReviewBusyKey(null);
    }
  }, []);

  const onCandidateAction = useCallback(
    async (action: "promote" | "revoke" | "rollback", candidateId: string, versionId: string) => {
      setReviewBusyKey(`${action}:${candidateId}:${versionId}`);
      try {
        const result =
          action === "promote"
            ? await promoteCapabilityCandidate(candidateId, versionId)
            : action === "revoke"
              ? await revokeCapabilityCandidate(candidateId, versionId)
              : await rollbackCapabilityCandidate(candidateId, versionId);
        setCandidateDetail(result.detail);
        const proposalId = proposalDetail?.proposal.proposalId;
        if (proposalId) {
          setProposalDetail(await fetchCapabilityProposal(proposalId));
        }
        await load({ background: true, includeStatic: false });
        setStatus(
          `${action === "promote" ? "Promoted" : action === "revoke" ? "Revoked" : "Rolled back"} ${candidateId}.`,
        );
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setReviewBusyKey(null);
      }
    },
    [load, proposalDetail?.proposal.proposalId],
  );

  const handleSkillRowKeyDown = (event: KeyboardEvent<HTMLTableRowElement>, skillId: string) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    setSelectedSkillId(skillId);
  };

  const harnessAuditTone = useCallback(
    (status: "strong" | "watch" | "attention") =>
      status === "strong" ? "success" : status === "watch" ? "warning" : "critical",
    [],
  );

  if (isInitialLoading) {
    return <p>Loading Playbook skills...</p>;
  }

  return (
    <section className="workflow-page skills-page">
      <PageHeader
        eyebrow="Operate"
        title={pageCopy.skills.title}
        subtitle={pageCopy.skills.subtitle}
        hint="Discover, validate, install, and govern reusable playbook skills without leaving the operator workflow."
        density="compact"
        actions={
          <>
            <StatusChip tone="muted">{filteredSkills.length} visible</StatusChip>
            <StatusChip tone="default">{sourceItems.length} sources</StatusChip>
            <StatusChip tone="success">{skills.filter((skill) => skill.state === "enabled").length} enabled</StatusChip>
            <StatusChip tone="warning">{skills.filter((skill) => skill.state === "sleep").length} sleeping</StatusChip>
            <StatusChip tone="default">{candidateEntries.length} candidates</StatusChip>
            <StatusChip tone="default">{proposalEntries.length} proposals</StatusChip>
            {isRefreshing ? <StatusChip tone="live">Refreshing</StatusChip> : null}
          </>
        }
      />
      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {status ? <p className="status-banner">{status}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing skills and activation policy...</p> : null}
      </div>
      <OperatorSplitLayout
        className="skills-operator-layout"
        topbar={
          <DataToolbar
            primary={
              <div className="controls-row">
                <label htmlFor="skillsFilter">Filter</label>
                <GCSelect
                  id="skillsFilter"
                  value={stateFilter}
                  onChange={(value) => setStateFilter(value as "all" | SkillRuntimeState)}
                  options={[
                    { value: "all", label: "all" },
                    { value: "enabled", label: "enabled" },
                    { value: "sleep", label: "sleep" },
                    { value: "disabled", label: "disabled" },
                  ]}
                />
              </div>
            }
            center={
              <div className="workflow-summary-strip">
                <StatusChip tone="success">
                  {skills.filter((skill) => skill.state === "enabled").length} enabled
                </StatusChip>
                <StatusChip tone="warning">
                  {skills.filter((skill) => skill.state === "sleep").length} sleeping
                </StatusChip>
                <StatusChip tone="muted">{filteredSkills.length} visible</StatusChip>
              </div>
            }
            secondary={
              <button type="button" onClick={() => void onReload()} className="gc-button">
                Reload Playbook
              </button>
            }
          />
        }
        primary={
          <Panel
            title="Skills Catalog"
            subtitle="Review installed skills, then inspect and adjust the selected skill without losing the table."
          >
            <div className="stack-md">
              {groupedSkills.length === 0 ? (
                <p className="table-subtext">No installed skills match the current filter.</p>
              ) : null}
              {groupedSkills.map((section) => (
                <div key={section.category} className="stack-sm">
                  <p>
                    <strong>{section.category}</strong> <span className="token-chip">{section.items.length}</span>
                  </p>
                  <table className="gc-data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Source</th>
                        <th>Tools</th>
                        <th>Requires</th>
                        <th>State</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.items.map((skill) => (
                        <tr
                          key={skill.skillId}
                          className={skill.skillId === selectedSkill?.skillId ? "row-selected" : ""}
                          role="button"
                          tabIndex={0}
                          aria-pressed={skill.skillId === selectedSkill?.skillId}
                          onClick={() => setSelectedSkillId(skill.skillId)}
                          onKeyDown={(event) => handleSkillRowKeyDown(event, skill.skillId)}
                        >
                          <td>
                            {skill.name}
                            <div className="table-subtext">{skill.skillId}</div>
                            <div className="table-subtext">{(skill.tags ?? []).join(", ") || "no tags"}</div>
                          </td>
                          <td>
                            {skill.source}
                            <div className="table-subtext">
                              {skill.capabilityCategory ?? "project_local"} · {skill.lifecycleState ?? "approved"}
                            </div>
                          </td>
                          <td>{skill.declaredTools.join(", ") || "-"}</td>
                          <td>{skill.requires.join(", ") || "-"}</td>
                          <td>{stateDraftBySkill[skill.skillId] ?? skill.state}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          </Panel>
        }
        inspector={
          selectedSkill ? (
            <Panel
              title={selectedSkill.name}
              subtitle="Adjust runtime posture and notes for the selected skill."
              padding="compact"
            >
              <div className="stack-sm">
                <div className="workflow-summary-strip">
                  <StatusChip tone="muted">{selectedSkill.skillId}</StatusChip>
                  <StatusChip tone="muted">{selectedSkill.source}</StatusChip>
                  <StatusChip tone="muted">{selectedSkill.trustLabel ?? "Unlabeled"}</StatusChip>
                </div>
                <p className="office-subtitle">
                  {(selectedSkill.tags ?? []).join(", ") || "No tags"}
                  {selectedSkill.reviewWarning ? ` · ${selectedSkill.reviewWarning}` : ""}
                </p>
                <div className="controls-row">
                  <label htmlFor="selectedSkillState">State</label>
                  <GCSelect
                    id="selectedSkillState"
                    value={stateDraftBySkill[selectedSkill.skillId] ?? selectedSkill.state}
                    onChange={(value) => {
                      const nextState = value as SkillRuntimeState;
                      setStateDraftBySkill((current) => ({
                        ...current,
                        [selectedSkill.skillId]: nextState,
                      }));
                      if (nextState === selectedSkill.state) {
                        dirtyStateDraftSkillIdsRef.current.delete(selectedSkill.skillId);
                      } else {
                        dirtyStateDraftSkillIdsRef.current.add(selectedSkill.skillId);
                      }
                    }}
                    options={STATE_OPTIONS.map((option) => ({ value: option, label: option }))}
                  />
                </div>
                <div className="controls-row">
                  <label htmlFor="selectedSkillNote">Operator note</label>
                  <input
                    id="selectedSkillNote"
                    value={noteDraftBySkill[selectedSkill.skillId] ?? selectedSkill.note ?? ""}
                    placeholder="Optional reason"
                    onChange={(event) => {
                      const nextNote = event.target.value;
                      setNoteDraftBySkill((current) => ({
                        ...current,
                        [selectedSkill.skillId]: nextNote,
                      }));
                      if (nextNote === (selectedSkill.note ?? "")) {
                        dirtyNoteDraftSkillIdsRef.current.delete(selectedSkill.skillId);
                      } else {
                        dirtyNoteDraftSkillIdsRef.current.add(selectedSkill.skillId);
                      }
                    }}
                  />
                </div>
                <p className="office-subtitle">Tools: {selectedSkill.declaredTools.join(", ") || "-"}</p>
                <p className="office-subtitle">Requires: {selectedSkill.requires.join(", ") || "-"}</p>
                <button
                  type="button"
                  disabled={
                    busySkillId === selectedSkill.skillId ||
                    ((stateDraftBySkill[selectedSkill.skillId] ?? selectedSkill.state) === selectedSkill.state &&
                      (noteDraftBySkill[selectedSkill.skillId] ?? selectedSkill.note ?? "") ===
                        (selectedSkill.note ?? ""))
                  }
                  onClick={() => void onSaveSkillState(selectedSkill)}
                  className="gc-button"
                >
                  {busySkillId === selectedSkill.skillId ? "Saving..." : "Save"}
                </button>
              </div>
            </Panel>
          ) : (
            <GCEmptyState
              title="Select a skill"
              subtitle="Choose a skill from the catalog to inspect its posture and notes."
            />
          )
        }
      />
      <Panel
        title="What are skills?"
        subtitle="Reusable instruction packs for specific jobs and workflows."
        rank="muted"
        padding="compact"
        collapsible
        defaultExpanded={false}
      >
        <p className="table-subtext">
          Skills teach GoatCitadel how to do repeatable jobs. Keep them off, guarded, or fully enabled.
        </p>
        <ul>
          <li>
            <strong>enabled</strong>: skill can be selected automatically.
          </li>
          <li>
            <strong>sleep</strong>: skill only auto-runs when confidence is high enough.
          </li>
          <li>
            <strong>disabled</strong>: skill is ignored until you enable it.
          </li>
        </ul>
        {mode === "advanced" ? (
          <p className="table-subtext">
            Skills are loaded from local <code>SKILL.md</code> folders and evaluated against activation policy and tool
            governance before use.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Harness Audit"
        subtitle="Native seven-pillar review of GoatCitadel's harness posture. Use marketplace skills in this family as reference patterns, not as a second runtime control plane."
      >
        {harnessAudit ? (
          <div className="stack-md">
            <div className="workflow-summary-strip">
              <StatusChip tone={harnessAuditTone(harnessAudit.overallStatus)}>{harnessAudit.overallStatus}</StatusChip>
              <StatusChip tone="default">{harnessAudit.overallScore}/100 overall</StatusChip>
              {harnessAudit.strategyGlossary.map((item) => (
                <StatusChip key={item.tag} tone="muted">
                  {item.tag}
                </StatusChip>
              ))}
            </div>
            <p className="field-help">{harnessAudit.summary}</p>
            <ul className="improvement-simple-list">
              {harnessAudit.pillars.map((pillar) => (
                <li key={pillar.pillarId}>
                  <strong>{pillar.label}</strong> - {pillar.score}/100
                  <div className="prompt-lab-test-meta">
                    <span
                      className={`prompt-lab-chip run-${pillar.status === "strong" ? "completed" : pillar.status === "watch" ? "running" : "failed"}`}
                    >
                      {pillar.status}
                    </span>
                    <span>{pillar.nativeDestination}</span>
                  </div>
                  <div className="table-subtext">{pillar.rationale}</div>
                </li>
              ))}
            </ul>
            <div className="replay-box">
              <h4>Capability states</h4>
              <ul className="compact-list">
                <li>
                  <strong>reference pattern</strong>: source or marketplace inspiration only, never callable at runtime.
                </li>
                <li>
                  <strong>proposal</strong>: inspectable draft for operator review, not callable.
                </li>
                <li>
                  <strong>candidate</strong>: staged capability artifact that still needs promotion or activation.
                </li>
                <li>
                  <strong>activated capability</strong>: live only after explicit review, approval, and
                  destination-specific promotion.
                </li>
              </ul>
            </div>
          </div>
        ) : (
          <p className="table-subtext">Harness audit data loads with the operator policy snapshot.</p>
        )}
      </Panel>

      <Panel
        title="Skill Sources & Import"
        subtitle="Browse curated sources first, validate before install, and keep imported skills disabled until you explicitly enable them."
        className="skills-source-panel"
      >
        <DataToolbar
          primary={
            <div className="controls-row skills-source-query">
              <label htmlFor="skillSourceQuery">
                Search sources
                <HelpHint
                  label="Search skill sources help"
                  text="Searches curated marketplaces and supported GitHub-backed sources for installable skills related to the capability you need."
                />
              </label>
              <input
                id="skillSourceQuery"
                value={sourceQuery}
                onChange={(event) => setSourceQuery(event.target.value)}
                placeholder="browser, github, playwright..."
              />
              <button
                type="button"
                onClick={() => void onLoadSources()}
                disabled={sourcesLoading}
                className="gc-button"
              >
                {sourcesLoading ? "Searching..." : sourceQuery.trim() ? "Lookup" : "Browse"}
              </button>
            </div>
          }
          secondary={
            sourceProviders.length > 0 ? (
              <div className="token-row skills-source-provider-list">
                {sourceProviders.map((provider) => (
                  <span
                    key={provider.provider}
                    className={`token-chip skills-source-provider-chip ${provider.available ? "token-chip-active" : ""}`}
                    title={provider.error || ""}
                  >
                    {provider.providerLabel}: {provider.status}
                  </span>
                ))}
              </div>
            ) : undefined
          }
        />
        {sourceLookupMeta?.bestMatch ? (
          <div className="status-banner">
            <strong>Best fit:</strong> {sourceLookupMeta.bestMatch.name} ({sourceLookupMeta.bestMatch.sourceProvider})
            {sourceLookupMeta.bestMatch.matchReason ? ` · ${sourceLookupMeta.bestMatch.matchReason}` : ""}
            {sourceLookupMeta.bestMatch.installability ? ` · ${sourceLookupMeta.bestMatch.installability}` : ""}
            {sourceLookupMeta.bestMatch.alreadyInstalled ? " · already installed" : ""}
          </div>
        ) : null}
        {sourceLookupMeta?.parsedSource && !sourceLookupMeta.bestMatch ? (
          <div className="status-banner">
            <strong>Lookup:</strong> {sourceLookupMeta.parsedSource.sourceProvider}{" "}
            {sourceLookupMeta.parsedSource.sourceKind}
            {sourceLookupMeta.parsedSource.installability ? ` · ${sourceLookupMeta.parsedSource.installability}` : ""}
          </div>
        ) : null}
        <details className="advanced-panel">
          <summary>Marketplace results</summary>
          {sourceItems.length === 0 ? (
            <p className="table-subtext">No source results loaded.</p>
          ) : (
            <div className="stack-md">
              {groupedSourceItems.map((section) => (
                <div key={section.category} className="stack-sm">
                  <p>
                    <strong>{section.category}</strong> <span className="token-chip">{section.items.length}</span>
                  </p>
                  <table className="gc-data-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Source</th>
                        <th>Why</th>
                        <th>Install</th>
                        <th>Description</th>
                        <th>Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.items.map((item) => (
                        <tr key={item.canonicalKey}>
                          <td>
                            {item.name}
                            <div className="table-subtext">{item.tags.slice(0, 4).join(", ") || "uncategorized"}</div>
                          </td>
                          <td>
                            {item.sourceProvider}
                            {item.alternateProviders.length > 0 ? ` (+${item.alternateProviders.join(",")})` : ""}
                            {item.sourceKind ? ` · ${item.sourceKind}` : ""}
                            {item.alreadyInstalled ? " · installed" : ""}
                          </td>
                          <td>{item.matchReason ?? "ranked source result"}</td>
                          <td>{item.installability ?? "review_only"}</td>
                          <td>{item.description}</td>
                          <td>{item.combinedScore.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </details>
        <div className="controls-row">
          <label htmlFor="importSourceType">
            Source type
            <HelpHint
              label="Skill source type help"
              text="Choose where the import comes from: a local folder, a local zip, or a git URL."
            />
          </label>
          <GCSelect
            id="importSourceType"
            value={importSourceType}
            onChange={(value) => setImportSourceType(value as "local_path" | "local_zip" | "git_url")}
            options={[
              { value: "local_path", label: "local_path" },
              { value: "local_zip", label: "local_zip" },
              { value: "git_url", label: "git_url" },
            ]}
          />
          <label htmlFor="importSourceProvider">
            Source provider
            <HelpHint
              label="Skill source provider help"
              text="Provider identifies the marketplace or source family. It helps GoatCitadel apply the right validation rules before install."
            />
          </label>
          <GCSelect
            id="importSourceProvider"
            value={importSourceProvider}
            onChange={(value) => setImportSourceProvider(value as SkillSourceProvider)}
            options={IMPORT_PROVIDER_OPTIONS.map((provider) => ({ value: provider, label: provider }))}
          />
        </div>
        <div className="controls-row">
          <label htmlFor="importSourceRef">
            Source ref
            <HelpHint
              label="Skill source reference help"
              text="The actual path or URL GoatCitadel should validate and import. Imported skills stay disabled until you enable them."
            />
          </label>
          <input
            id="importSourceRef"
            value={importSourceRef}
            onChange={(event) => setImportSourceRef(event.target.value)}
            placeholder={
              importSourceType === "git_url"
                ? "https://github.com/owner/repo.git"
                : importSourceType === "local_zip"
                  ? "F:\\skills\\skill.zip"
                  : "F:\\skills\\my-skill-folder"
            }
          />
          <button
            type="button"
            onClick={() => void onValidateImport()}
            disabled={importBusy !== null}
            className="gc-button"
          >
            {importBusy === "validate" ? "Validating..." : "Validate import"}
          </button>
          <button
            type="button"
            onClick={() => void onInstallImport()}
            disabled={
              importBusy !== null ||
              Boolean(validationResult?.nativeOverlaps?.length) ||
              validationResult?.reviewDisposition === "reference_only" ||
              validationResult?.reviewDisposition === "reject"
            }
            className="gc-button"
          >
            {importBusy === "install" ? "Installing..." : "Install (disabled by default)"}
          </button>
        </div>
        <GCSwitch
          checked={confirmHighRiskImport}
          onCheckedChange={setConfirmHighRiskImport}
          label="Confirm high-risk import when required"
        />
        {validationResult ? (
          <div className="token-row">
            <span className={`token-chip ${validationResult.valid ? "token-chip-active" : ""}`}>
              {validationResult.valid ? "Validation passed" : "Validation failed"}
            </span>
            <span className="token-chip">Risk: {validationResult.riskLevel}</span>
            {validationResult.reviewDisposition ? (
              <span className="token-chip">Review: {validationResult.reviewDisposition}</span>
            ) : null}
            {validationResult.nativeOverlaps?.length ? (
              <span className="token-chip">Blocked: native overlap</span>
            ) : null}
            {validationResult.inferredSkillName ? (
              <span className="token-chip">Skill: {validationResult.inferredSkillName}</span>
            ) : null}
          </div>
        ) : null}
        {validationResult ? (
          <div className="stack-md">
            <p className="field-help">Trust report: {describeValidationTrust(validationResult)}</p>
            {validationResult.reviewMessage ? (
              <div className="replay-box">
                <h4>Review classification</h4>
                <p>{validationResult.reviewMessage}</p>
              </div>
            ) : null}
            {validationResult.nativeOverlaps?.length ? (
              <div className="replay-box">
                <h4>Native alternative</h4>
                <ul className="compact-list">
                  {validationResult.nativeOverlaps.map((overlap) => (
                    <li key={`${overlap.overlapFamily}:${overlap.nativeDestination}`}>
                      <strong>{overlap.nativeAlternativeName}</strong>: {overlap.blockingReason} Go to{" "}
                      {overlap.nativeDestination}.
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ul className="improvement-simple-list">
              <li>Declared tools: {formatValidationList(validationResult.declaredTools, "none declared")}</li>
              <li>Network signals: {formatValidationList(validationResult.networkSignals, "none detected")}</li>
              <li>Suspicious signals: {formatValidationList(validationResult.suspiciousSignals, "none detected")}</li>
              <li>Required dependencies: {formatValidationList(validationResult.requires, "none declared")}</li>
              <li>License files: {formatValidationList(validationResult.licenseFiles, "none found")}</li>
            </ul>
            <details className="advanced-panel">
              <summary>Raw validation payload</summary>
              <pre>{JSON.stringify(validationResult, null, 2)}</pre>
            </details>
          </div>
        ) : null}
        <details className="advanced-panel">
          <summary>Recent import history</summary>
          {importHistory.length === 0 ? (
            <p className="table-subtext">No import history yet.</p>
          ) : (
            <table className="gc-data-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Action</th>
                  <th>Outcome</th>
                  <th>Provider</th>
                  <th>Source</th>
                  <th>Risk</th>
                </tr>
              </thead>
              <tbody>
                {importHistory.map((item) => (
                  <tr key={item.importId}>
                    <td>{new Date(item.createdAt).toLocaleString()}</td>
                    <td>{item.action}</td>
                    <td>{item.outcome}</td>
                    <td>{item.sourceProvider}</td>
                    <td>{item.sourceRef}</td>
                    <td>{item.riskLevel ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>
      </Panel>

      <Panel
        title="Where to Get More Skills"
        subtitle="Discovery is separate from installation. Use these directories to find candidates, then validate and import deliberately."
        rank="muted"
        padding="compact"
        collapsible
        defaultExpanded={false}
      >
        <div className="stack-md">
          {[
            {
              label: "AgentSkill",
              trust: "Curated marketplace",
              href: "https://agentskill.sh/",
              note: "Curated installable skills with metadata and learning-focused discovery.",
            },
            {
              label: "AgentSkill Learn",
              trust: "Curated marketplace",
              href: "https://agentskill.sh/install",
              note: "Install-oriented flow for browsing and learning how to bring a skill in safely.",
            },
            {
              label: "SkillsMP",
              trust: "Cross-agent directory",
              href: "https://skillsmp.com/",
              note: "Cross-agent skills catalog. Review quality and provenance before import.",
            },
            {
              label: "ClawHub",
              trust: "Cross-agent directory",
              href: "https://clawhub.ai/",
              note: "Catalog of agent skills and shards. Treat listing pages as review-first sources, then resolve the upstream repo or package before import.",
            },
            {
              label: "Animal House",
              trust: "External experience",
              href: "https://animalhouse.ai/skills/animal-house",
              note: "Hosted game/integration for agents. Read the instructions and join the house directly instead of trying to import it as a normal skill pack.",
            },
            {
              label: "Terminal Skills",
              trust: "Cross-agent directory",
              href: "https://terminalskills.io/",
              note: "Additional public skills directory for shell and terminal-focused workflows.",
            },
            {
              label: "Agent Skills Repo",
              trust: "Community directory",
              href: "https://agentskillsrepo.com/",
              note: "Community-maintained index. Treat this as review-before-install.",
            },
          ].map((source) => (
            <div key={source.href} className="prompt-lab-run-summary">
              <p>
                <strong>{source.label}</strong> <span className="token-chip">{source.trust}</span>
              </p>
              <p className="table-subtext">{source.note}</p>
              <p>
                <a href={source.href} target="_blank" rel="noreferrer">
                  {source.href}
                </a>
              </p>
            </div>
          ))}
        </div>
        <ul>
          <li>
            <strong>AgentSkill</strong>: curated marketplace and guided install surface.
          </li>
          <li>
            <strong>SkillsMP</strong>: broader multi-agent catalog.
          </li>
          <li>
            <strong>ClawHub</strong>: optional external directory for skills and shards.
          </li>
          <li>
            <strong>Animal House</strong>: external game/integration with hosted instructions, not a standard importable
            skill.
          </li>
          <li>
            <strong>GitHub</strong>: flexible fallback when curated catalogs do not have the skill you need.
          </li>
          <li>
            <strong>local</strong>: local path or zip import for private/internal skills.
          </li>
        </ul>
      </Panel>

      <Panel
        title="Activation Policy"
        subtitle="Control how guarded skills wake up and when GoatCitadel asks for first-use confirmation."
      >
        <div className="controls-row">
          <label htmlFor="skillsThreshold">
            Guarded auto threshold
            <HelpHint
              label="Guarded auto threshold help"
              text="Sleep-mode skills only auto-activate when confidence is at or above this threshold."
            />
          </label>
          <input
            id="skillsThreshold"
            type="number"
            min={0}
            max={1}
            step={0.01}
            value={policy?.guardedAutoThreshold ?? 0.72}
            onChange={(event) => {
              const raw = Number(event.target.value);
              const clamped = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0.72;
              setPolicy((current) =>
                current
                  ? { ...current, guardedAutoThreshold: clamped }
                  : { guardedAutoThreshold: clamped, requireFirstUseConfirmation: true },
              );
            }}
          />
          <GCSwitch
            checked={policy?.requireFirstUseConfirmation ?? true}
            onCheckedChange={(checked) =>
              setPolicy((current) => ({
                guardedAutoThreshold: current?.guardedAutoThreshold ?? 0.72,
                requireFirstUseConfirmation: checked,
              }))
            }
            label="Require first-use confirmation for sleep skills"
          />
          <button type="button" onClick={() => void onSavePolicy()} disabled={savingPolicy} className="gc-button">
            {savingPolicy ? "Saving..." : "Save policy"}
          </button>
        </div>
      </Panel>

      <Panel
        title="Capability Review Queue"
        subtitle="Inspectable candidates and proposals stay visible here without becoming callable."
      >
        <div className="token-row">
          <span className="token-chip">Candidates: {candidateEntries.length}</span>
          <span className="token-chip">Proposals: {proposalEntries.length}</span>
        </div>
        <div className="stack-md">
          <div className="stack-sm">
            <p>
              <strong>Candidate skills</strong>
            </p>
            {candidateEntries.length === 0 ? (
              <p className="table-subtext">No generated candidates are staged yet.</p>
            ) : (
              <table className="gc-data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Lifecycle</th>
                    <th>Trust</th>
                    <th>Capability ID</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {candidateEntries.map((entry) => (
                    <tr key={entry.capabilityId}>
                      <td>{entry.title}</td>
                      <td>{entry.lifecycleState ?? "candidate"}</td>
                      <td>{entry.trustLabel ?? "Candidate"}</td>
                      <td>{entry.capabilityId}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => entry.candidateId && void onInspectCandidate(entry.candidateId)}
                          disabled={!entry.candidateId || reviewBusyKey === `candidate:${entry.candidateId}`}
                          className="gc-button"
                        >
                          {reviewBusyKey === `candidate:${entry.candidateId}` ? "Loading..." : "Inspect"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="stack-sm">
            <p>
              <strong>Governed proposals</strong>
            </p>
            {capabilityProposals.length === 0 ? (
              <p className="table-subtext">No capability proposals recorded yet.</p>
            ) : (
              <table className="gc-data-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Kind</th>
                    <th>Status</th>
                    <th>Summary</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {capabilityProposals.map((proposal) => (
                    <tr key={proposal.proposalId}>
                      <td>{proposal.title}</td>
                      <td>{proposal.proposalKind}</td>
                      <td>{proposal.status}</td>
                      <td>{proposal.summary}</td>
                      <td>
                        <button
                          type="button"
                          onClick={() => void onInspectProposal(proposal.proposalId)}
                          disabled={reviewBusyKey === `proposal:${proposal.proposalId}`}
                          className="gc-button"
                        >
                          {reviewBusyKey === `proposal:${proposal.proposalId}` ? "Loading..." : "Inspect"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {candidateDetail ? (
            <div className="stack-sm">
              <p>
                <strong>Candidate detail</strong> <span className="token-chip">{candidateDetail.candidateId}</span>
              </p>
              <div className="token-row">
                <span className="token-chip">
                  {candidateDetail.activeVersion
                    ? `Active: ${candidateDetail.activeVersion.versionId}`
                    : "No active version"}
                </span>
                {candidateDetail.originatingRun ? (
                  <span className="token-chip">Run: {candidateDetail.originatingRun.runId}</span>
                ) : null}
                {candidateDetail.originatingRun?.sandbox ? (
                  <span className="token-chip">
                    Sandbox: {describeOriginatingRunSandbox(candidateDetail.originatingRun.sandbox)}
                  </span>
                ) : null}
              </div>
              {candidateDetail.activationBlocked ? (
                <p className="table-subtext">{candidateDetail.activationBlockers.join(" ")}</p>
              ) : null}
              {candidateDetail.originatingRun?.sandbox?.failClosedReason ? (
                <p className="table-subtext">{candidateDetail.originatingRun.sandbox.failClosedReason}</p>
              ) : null}
              {candidateDetail.originatingRun?.sandbox?.advisoryUnsandboxedReason ? (
                <p className="table-subtext">{candidateDetail.originatingRun.sandbox.advisoryUnsandboxedReason}</p>
              ) : null}
              <table className="gc-data-table">
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Lifecycle</th>
                    <th>Updated</th>
                    <th>Artifacts</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {candidateDetail.versions.map((version) => (
                    <tr key={version.versionId}>
                      <td>
                        {version.title}
                        <div className="table-subtext">{version.versionId}</div>
                      </td>
                      <td>{version.lifecycleState}</td>
                      <td>{new Date(version.updatedAt).toLocaleString()}</td>
                      <td>
                        <div className="table-subtext">{version.proofArtifact.relPath}</div>
                        <div className="table-subtext">
                          {version.programArtifact?.relPath ?? version.manifestArtifact.relPath}
                        </div>
                      </td>
                      <td>
                        <div className="controls-row">
                          <button
                            type="button"
                            onClick={() =>
                              void onCandidateAction("promote", candidateDetail.candidateId, version.versionId)
                            }
                            disabled={reviewBusyKey === `promote:${candidateDetail.candidateId}:${version.versionId}`}
                            className="gc-button"
                          >
                            {reviewBusyKey === `promote:${candidateDetail.candidateId}:${version.versionId}`
                              ? "Working..."
                              : "Promote"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void onCandidateAction("rollback", candidateDetail.candidateId, version.versionId)
                            }
                            disabled={reviewBusyKey === `rollback:${candidateDetail.candidateId}:${version.versionId}`}
                            className="gc-button"
                          >
                            {reviewBusyKey === `rollback:${candidateDetail.candidateId}:${version.versionId}`
                              ? "Working..."
                              : "Rollback"}
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void onCandidateAction("revoke", candidateDetail.candidateId, version.versionId)
                            }
                            disabled={reviewBusyKey === `revoke:${candidateDetail.candidateId}:${version.versionId}`}
                            className="gc-button"
                          >
                            {reviewBusyKey === `revoke:${candidateDetail.candidateId}:${version.versionId}`
                              ? "Working..."
                              : "Revoke"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {candidateDetail.relatedProposals.length > 0 ? (
                <div className="stack-sm">
                  <p>
                    <strong>Related proposals</strong>
                  </p>
                  <ul className="compact-list">
                    {candidateDetail.relatedProposals.map((proposal) => (
                      <li key={proposal.proposalId}>
                        {proposal.title} · {proposal.status}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          {proposalDetail ? (
            <div className="stack-sm">
              <p>
                <strong>Proposal detail</strong>{" "}
                <span className="token-chip">{proposalDetail.proposal.proposalId}</span>
              </p>
              <p className="table-subtext">{proposalDetail.proposal.summary}</p>
              <div className="token-row">
                <span className="token-chip">Status: {proposalDetail.proposal.status}</span>
                <span className="token-chip">Kind: {proposalDetail.proposal.proposalKind}</span>
                {proposalDetail.proposal.candidateId ? (
                  <span className="token-chip">Candidate: {proposalDetail.proposal.candidateId}</span>
                ) : null}
              </div>
              <table className="gc-data-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Actor</th>
                  </tr>
                </thead>
                <tbody>
                  {proposalDetail.events.map((event) => (
                    <tr key={event.eventId}>
                      <td>{new Date(event.createdAt).toLocaleString()}</td>
                      <td>{event.eventType}</td>
                      <td>{event.actorId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      </Panel>
    </section>
  );
}
