/* eslint-disable @typescript-eslint/no-unused-vars */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CapabilityCatalogEntry,
  CapabilityProposalRecord,
  SkillMergedSourceResult,
  SkillListItem,
  SkillRuntimeState,
  SkillSourceLookupParsedSource,
  SkillSourceProvider,
  SkillSourceSearchRecord,
} from "@goatcitadel/contracts";
import {
  fetchCapabilityCatalog,
  fetchCapabilityProposals,
  fetchSkillLookup,
  fetchSkillImportHistory,
  fetchSkillSources,
  fetchSkills,
  installSkillImport,
  reloadSkills,
  validateSkillImport,
  updateSkillState,
  fetchSkillActivationPolicies,
  patchSkillActivationPolicies,
} from "../api/client";
import { DataToolbar } from "../components/DataToolbar";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { PageGuideCard } from "../components/PageGuideCard";
import { StatusChip } from "../components/StatusChip";
import { HelpHint } from "../components/HelpHint";
import { GCSelect, GCSwitch } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";
import { useUiPreferences } from "../state/ui-preferences";
import {
  BANKR_MIGRATION_CARD_TITLE,
  BANKR_MIGRATION_DOC_PATH,
  BANKR_MIGRATION_TEMPLATE_PATH,
  IMPORT_PROVIDER_OPTIONS,
  SKILL_CATEGORY_RULES,
  SKILL_FAMILY_TO_CATEGORY,
  STATE_OPTIONS,
  deriveCategoryLabel,
  deriveSkillCategoryLabel,
  deriveSourceCategoryLabel,
  describeValidationTrust,
  formatValidationList,
  groupByCategory,
} from "./skills/skills-page-helpers";

export {
  BANKR_MIGRATION_CARD_TITLE,
  BANKR_MIGRATION_DOC_PATH,
  BANKR_MIGRATION_TEMPLATE_PATH,
  SKILL_FAMILY_TO_CATEGORY,
  deriveSkillCategoryLabel,
  deriveSourceCategoryLabel,
} from "./skills/skills-page-helpers";

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
  const [policy, setPolicy] = useState<SkillActivationPolicyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
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
  const [importHistory, setImportHistory] = useState<Awaited<ReturnType<typeof fetchSkillImportHistory>>["items"]>([]);
  const [importBusy, setImportBusy] = useState<null | "validate" | "install">(null);
  const [confirmHighRiskImport, setConfirmHighRiskImport] = useState(false);

  const load = useCallback(async (options?: { background?: boolean; includeStatic?: boolean }) => {
    const background = options?.background ?? false;
    const includeStatic = options?.includeStatic ?? !background;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    try {
      const [skillsResponse, policyResponse, importHistoryResponse, catalogResponse, proposalsResponse] =
        await Promise.all([
          fetchSkills(),
          includeStatic ? fetchSkillActivationPolicies() : Promise.resolve(null),
          includeStatic ? fetchSkillImportHistory(30) : Promise.resolve(null),
          fetchCapabilityCatalog("inspectable"),
          fetchCapabilityProposals(100),
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

  if (isInitialLoading) {
    return <p>Loading Playbook skills...</p>;
  }

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Operate"
        title={pageCopy.skills.title}
        subtitle={pageCopy.skills.subtitle}
        hint="Discover, validate, install, and govern reusable playbook skills without leaving the operator workflow."
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
      <PageGuideCard
        pageId="skills"
        what={pageCopy.skills.guide?.what ?? ""}
        when={pageCopy.skills.guide?.when ?? ""}
        actions={pageCopy.skills.guide?.actions ?? []}
        terms={pageCopy.skills.guide?.terms}
      />

      <div className="workflow-status-stack">
        {error ? <p className="error">{error}</p> : null}
        {status ? <p className="status-banner">{status}</p> : null}
        {isRefreshing ? <p className="status-banner">Refreshing skills and activation policy...</p> : null}
      </div>

      <Panel title="What are skills?" subtitle="Reusable instruction packs for specific jobs and workflows.">
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
        title="Skill Sources & Import"
        subtitle="Browse curated sources first, validate before install, and keep imported skills disabled until you explicitly enable them."
      >
        <DataToolbar
          primary={
            <div className="controls-row">
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
              <button type="button" onClick={() => void onLoadSources()} disabled={sourcesLoading} className="gc-button">
                {sourcesLoading ? "Searching..." : sourceQuery.trim() ? "Lookup" : "Browse"}
              </button>
            </div>
          }
          secondary={
            sourceProviders.length > 0 ? (
              <div className="token-row">
                {sourceProviders.map((provider) => (
                  <span
                    key={provider.provider}
                    className={`token-chip ${provider.available ? "token-chip-active" : ""}`}
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
          <button type="button" onClick={() => void onValidateImport()} disabled={importBusy !== null} className="gc-button">
            {importBusy === "validate" ? "Validating..." : "Validate import"}
          </button>
          <button
            type="button"
            onClick={() => void onInstallImport()}
            disabled={importBusy !== null || Boolean(validationResult?.nativeOverlaps?.length)}
           className="gc-button">
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
        title={BANKR_MIGRATION_CARD_TITLE}
        subtitle="Bankr support is optional and intentionally off by default."
        tone="soft"
      >
        <p className="table-subtext">
          Built-in Bankr support is disabled by default. If you need it, install it as an optional skill pack and keep
          it in <code>disabled</code> or <code>sleep</code> until policy grants are reviewed.
        </p>
        <ul>
          <li>
            Install guide: <code>{BANKR_MIGRATION_DOC_PATH}</code>
          </li>
          <li>
            Starter template: <code>{BANKR_MIGRATION_TEMPLATE_PATH}</code>
          </li>
          <li>Legacy built-in endpoints return migration guidance (`410`) while disabled.</li>
        </ul>
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
                  </tr>
                </thead>
                <tbody>
                  {candidateEntries.map((entry) => (
                    <tr key={entry.capabilityId}>
                      <td>{entry.title}</td>
                      <td>{entry.lifecycleState ?? "candidate"}</td>
                      <td>{entry.trustLabel ?? "Candidate"}</td>
                      <td>{entry.capabilityId}</td>
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
                  </tr>
                </thead>
                <tbody>
                  {capabilityProposals.map((proposal) => (
                    <tr key={proposal.proposalId}>
                      <td>{proposal.title}</td>
                      <td>{proposal.proposalKind}</td>
                      <td>{proposal.status}</td>
                      <td>{proposal.summary}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Panel>

      <Panel
        title="Skills"
        subtitle="Review installed skills, change runtime state, and attach operator notes without leaving the page."
      >
        <DataToolbar
          primary={
            <>
              <button type="button" onClick={() => void onReload()} className="gc-button">
                Reload Playbook
              </button>
            </>
          }
          secondary={
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
        />

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
                    <th>
                      State
                      <HelpHint
                        label="Skill state help"
                        text="Enabled means the skill can activate automatically. Sleep means it only auto-activates when confidence is high enough. Disabled means it will not activate at all."
                      />
                    </th>
                    <th>Note</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {section.items.map((skill) => {
                    const draftState = stateDraftBySkill[skill.skillId] ?? skill.state;
                    const draftNote = noteDraftBySkill[skill.skillId] ?? "";
                    const changed = draftState !== skill.state || draftNote !== (skill.note ?? "");
                    return (
                      <tr key={skill.skillId}>
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
                          <div className="table-subtext">
                            {skill.trustLabel ?? "Unlabeled"}
                            {skill.callable === false ? " · inspect only" : ""}
                          </div>
                          {skill.reviewWarning ? <div className="table-subtext">{skill.reviewWarning}</div> : null}
                        </td>
                        <td>{skill.declaredTools.join(", ") || "-"}</td>
                        <td>{skill.requires.join(", ") || "-"}</td>
                        <td>
                          <GCSelect
                            value={draftState}
                            onChange={(value) => {
                              const nextState = value as SkillRuntimeState;
                              setStateDraftBySkill((current) => ({
                                ...current,
                                [skill.skillId]: nextState,
                              }));
                              if (nextState === skill.state) {
                                dirtyStateDraftSkillIdsRef.current.delete(skill.skillId);
                              } else {
                                dirtyStateDraftSkillIdsRef.current.add(skill.skillId);
                              }
                            }}
                            options={STATE_OPTIONS.map((option) => ({ value: option, label: option }))}
                          />
                        </td>
                        <td>
                          <input
                            value={draftNote}
                            placeholder="Optional reason"
                            onChange={(event) => {
                              const nextNote = event.target.value;
                              setNoteDraftBySkill((current) => ({
                                ...current,
                                [skill.skillId]: nextNote,
                              }));
                              if (nextNote === (skill.note ?? "")) {
                                dirtyNoteDraftSkillIdsRef.current.delete(skill.skillId);
                              } else {
                                dirtyNoteDraftSkillIdsRef.current.add(skill.skillId);
                              }
                            }}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            disabled={!changed || busySkillId === skill.skillId}
                            onClick={() => void onSaveSkillState(skill)}
                           className="gc-button">
                            {busySkillId === skill.skillId ? "Saving..." : "Save"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </Panel>
    </section>
  );
}

