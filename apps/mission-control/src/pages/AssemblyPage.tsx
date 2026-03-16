import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AdversarialSettings,
  AssemblyDomainPreset,
  AssemblyMode,
  AssemblyParticipantModel,
  AssemblyRunDetailResponse,
  AssemblyRunRecord,
  CreateAssemblyRunInput,
  ModelReputation,
} from "@goatcitadel/contracts";
import {
  createAssemblyRun,
  fetchAssemblyReputations,
  fetchAssemblyRunDetail,
  fetchAssemblyRuns,
  fetchLlmConfig,
  fetchLlmModels,
} from "../api/client";
import { HelpHint } from "../components/HelpHint";
import { PageGuideCard } from "../components/PageGuideCard";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { pageCopy } from "../content/copy";

const DOMAIN_PRESETS: AssemblyDomainPreset[] = ["coding", "architecture", "writing", "seo", "analysis", "strategy"];
const MODES: AssemblyMode[] = ["consensus", "debate", "critique", "brainstorm"];

interface ParticipantDraft {
  providerId: string;
  model: string;
}

const DEFAULT_SETTINGS = {
  domainPreset: "coding" as AssemblyDomainPreset,
  mode: "consensus" as AssemblyMode,
  maxRounds: 2,
  maxCritiquePasses: 1,
  maxInterModelExchanges: 1,
  convergenceThreshold: 0.78,
  stagnationWindow: 2,
  timeBudgetMs: 60_000,
  tokenBudget: 10_000,
  costBudgetUsd: 3,
  synthesisStyle: "balanced" as const,
};

const DEFAULT_ADVERSARIAL: AdversarialSettings = {
  enabled: false,
  reviewerCount: 1,
  selectionStrategy: "rotate_among_participants",
  strictness: "balanced",
  requireMitigations: true,
  requireEvidenceTags: true,
  defenseRoundEnabled: true,
  repetitiveObjectionCutoff: true,
  minorityReportRequired: false,
};

export function AssemblyPage({ workspaceId }: { workspaceId?: string }) {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [adversarial, setAdversarial] = useState<AdversarialSettings>(DEFAULT_ADVERSARIAL);
  const [participants, setParticipants] = useState<ParticipantDraft[]>([]);
  const [providers, setProviders] = useState<Array<{ providerId: string; label: string; defaultModel: string }>>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, string[]>>({});
  const [runs, setRuns] = useState<AssemblyRunRecord[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunDetail, setSelectedRunDetail] = useState<AssemblyRunDetailResponse | null>(null);
  const [reputations, setReputations] = useState<ModelReputation[]>([]);

  const selectedRun = selectedRunDetail?.run ?? runs.find((run) => run.runId === selectedRunId) ?? null;

  const load = useCallback(async (options?: { preserveSelection?: boolean }) => {
    const preserveSelection = options?.preserveSelection ?? true;
    try {
      const [llmConfig, runResponse, reputationResponse] = await Promise.all([
        fetchLlmConfig(),
        fetchAssemblyRuns(25),
        fetchAssemblyReputations(12),
      ]);
      const providerList = llmConfig.providers.map((provider) => ({
        providerId: provider.providerId,
        label: provider.label,
        defaultModel: provider.defaultModel,
      }));
      setProviders(providerList);
      const modelEntries = await Promise.all(providerList.map(async (provider) => {
        const response = await fetchLlmModels(provider.providerId);
        return [provider.providerId, response.items.map((item) => item.id)] as const;
      }));
      const nextModelsByProvider = Object.fromEntries(modelEntries);
      setModelsByProvider(nextModelsByProvider);
      setRuns(runResponse.items);
      setReputations(reputationResponse.items);
      setParticipants((current) => {
        if (current.length >= 2) {
          return current;
        }
        return buildDefaultParticipants(providerList, nextModelsByProvider);
      });
      const nextSelectedRunId = preserveSelection
        ? selectedRunId ?? runResponse.items[0]?.runId ?? null
        : runResponse.items[0]?.runId ?? null;
      setSelectedRunId(nextSelectedRunId);
      if (nextSelectedRunId) {
        setSelectedRunDetail(await fetchAssemblyRunDetail(nextSelectedRunId));
      } else {
        setSelectedRunDetail(null);
      }
      setError(null);
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setIsInitialLoading(false);
    }
  }, [selectedRunId]);

  useEffect(() => {
    void load({ preserveSelection: true });
  }, [load]);

  useEffect(() => {
    if (!selectedRun || (selectedRun.status !== "queued" && selectedRun.status !== "running")) {
      return;
    }
    const interval = window.setInterval(() => {
      void fetchAssemblyRunDetail(selectedRun.runId).then(setSelectedRunDetail).catch(() => {});
      void fetchAssemblyRuns(25).then((response) => setRuns(response.items)).catch(() => {});
    }, 3500);
    return () => window.clearInterval(interval);
  }, [selectedRun]);

  const participantModels = useMemo<AssemblyParticipantModel[]>(() => {
    return participants.map((participant, index) => ({
      participantId: `participant-${index + 1}`,
      providerId: participant.providerId,
      model: participant.model,
      label: `${participant.providerId}/${participant.model}`,
    }));
  }, [participants]);

  const handleSubmit = useCallback(async () => {
    if (participantModels.length < 2 || prompt.trim().length === 0) {
      setError("Assembly needs at least two participant models and a non-empty prompt.");
      return;
    }
    setIsSubmitting(true);
    try {
      const payload: CreateAssemblyRunInput = {
        workspaceId,
        prompt: prompt.trim(),
        settings: {
          ...settings,
          participantModels,
          exportTargets: ["artifact", "task", "chat"],
        },
        adversarialSettings: adversarial.enabled ? adversarial : { ...adversarial, enabled: false },
      };
      const run = await createAssemblyRun(payload);
      setPrompt("");
      setSelectedRunId(run.runId);
      await load({ preserveSelection: true });
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  }, [adversarial, load, participantModels, prompt, settings, workspaceId]);

  const runSummary = useMemo(() => {
    if (!selectedRunDetail) {
      return null;
    }
    const artifactCounts = selectedRunDetail.artifacts.reduce<Record<string, number>>((counts, artifact) => {
      counts[artifact.artifactType] = (counts[artifact.artifactType] ?? 0) + 1;
      return counts;
    }, {});
    return artifactCounts;
  }, [selectedRunDetail]);

  if (isInitialLoading) {
    return (
      <section className="workflow-page">
        <PageHeader eyebrow="Operate" title={pageCopy.assembly.title} subtitle={pageCopy.assembly.subtitle} />
        <p>Loading Assembly surfaces...</p>
      </section>
    );
  }

  return (
    <section className="workflow-page assembly-page">
      <PageHeader
        eyebrow="Operate"
        title={pageCopy.assembly.title}
        subtitle={pageCopy.assembly.subtitle}
        hint="Assembly is a dedicated multi-model surface. It persists its own runs, exposes each stage artifact, and only exports outward when you ask it to."
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone={selectedRun?.status === "completed" ? "success" : selectedRun?.status === "failed" ? "critical" : "warning"}>
              {selectedRun?.status ?? "idle"}
            </StatusChip>
            <StatusChip tone="muted">{runs.length} run(s)</StatusChip>
            <StatusChip tone="muted">{reputations.length} reputation snapshot(s)</StatusChip>
          </div>
        )}
      />
      <PageGuideCard
        pageId="assembly"
        what={pageCopy.assembly.guide?.what ?? ""}
        when={pageCopy.assembly.guide?.when ?? ""}
        actions={pageCopy.assembly.guide?.actions ?? []}
        terms={pageCopy.assembly.guide?.terms}
      />

      {error ? <p className="error">{error}</p> : null}

      <div className="assembly-grid">
        <Panel
          title="Setup"
          subtitle={(
            <>
              Normalize the problem, choose the participant set, and keep the run bounded.
              <HelpHint label="Assembly setup help" text="Domain presets change rubric weights and prompt framing, not the core protocol." />
            </>
          )}
          className="assembly-pane"
        >
          <div className="assembly-form">
            <label className="assembly-field assembly-field-full">
              <span>Problem</span>
              <textarea
                rows={7}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the problem, constraints, and desired outcome."
              />
            </label>
            <label className="assembly-field">
              <span>Domain preset</span>
              <select
                value={settings.domainPreset}
                onChange={(event) => setSettings((current) => ({ ...current, domainPreset: event.target.value as AssemblyDomainPreset }))}
              >
                {DOMAIN_PRESETS.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="assembly-field">
              <span>Mode</span>
              <select
                value={settings.mode}
                onChange={(event) => setSettings((current) => ({ ...current, mode: event.target.value as AssemblyMode }))}
              >
                {MODES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </label>
            <label className="assembly-field">
              <span>Max rounds</span>
              <input
                type="number"
                min={1}
                max={6}
                value={settings.maxRounds}
                onChange={(event) => setSettings((current) => ({ ...current, maxRounds: Number(event.target.value) || 1 }))}
              />
            </label>
            <label className="assembly-field">
              <span>Convergence threshold</span>
              <input
                type="number"
                min={0.5}
                max={1}
                step={0.01}
                value={settings.convergenceThreshold}
                onChange={(event) => setSettings((current) => ({ ...current, convergenceThreshold: Number(event.target.value) || 0.78 }))}
              />
            </label>
            <label className="assembly-field">
              <span>Token budget</span>
              <input
                type="number"
                min={1000}
                step={500}
                value={settings.tokenBudget}
                onChange={(event) => setSettings((current) => ({ ...current, tokenBudget: Number(event.target.value) || 1000 }))}
              />
            </label>
            <label className="assembly-field">
              <span>Cost budget (USD)</span>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={settings.costBudgetUsd}
                onChange={(event) => setSettings((current) => ({ ...current, costBudgetUsd: Number(event.target.value) || 0.1 }))}
              />
            </label>

            <div className="assembly-participants">
              <div className="assembly-participants-header">
                <h3>Participant models</h3>
                <button
                  type="button"
                  onClick={() => setParticipants((current) => current.length >= 5 ? current : [...current, current[0] ?? buildDefaultParticipants(providers, modelsByProvider)[0]!])}
                >
                  Add model
                </button>
              </div>
              {participants.map((participant, index) => (
                <div key={`${participant.providerId}-${participant.model}-${index}`} className="assembly-participant-row">
                  <select
                    value={participant.providerId}
                    onChange={(event) => {
                      const providerId = event.target.value;
                      const nextModel = modelsByProvider[providerId]?.[0] ?? "";
                      setParticipants((current) => current.map((item, currentIndex) => currentIndex === index ? { providerId, model: nextModel } : item));
                    }}
                  >
                    {providers.map((provider) => (
                      <option key={provider.providerId} value={provider.providerId}>{provider.label}</option>
                    ))}
                  </select>
                  <select
                    value={participant.model}
                    onChange={(event) => {
                      const model = event.target.value;
                      setParticipants((current) => current.map((item, currentIndex) => currentIndex === index ? { ...item, model } : item));
                    }}
                  >
                    {(modelsByProvider[participant.providerId] ?? []).map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={participants.length <= 2}
                    onClick={() => setParticipants((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>

            <label className="assembly-toggle">
              <input
                type="checkbox"
                checked={adversarial.enabled}
                onChange={(event) => setAdversarial((current) => ({ ...current, enabled: event.target.checked }))}
              />
              <span>Adversarial mode</span>
            </label>
            {adversarial.enabled ? (
              <div className="assembly-adversarial-grid">
                <label className="assembly-field">
                  <span>Reviewer count</span>
                  <input
                    type="number"
                    min={1}
                    max={5}
                    value={adversarial.reviewerCount}
                    onChange={(event) => setAdversarial((current) => ({ ...current, reviewerCount: Number(event.target.value) || 1 }))}
                  />
                </label>
                <label className="assembly-field">
                  <span>Selection strategy</span>
                  <select
                    value={adversarial.selectionStrategy}
                    onChange={(event) => setAdversarial((current) => ({ ...current, selectionStrategy: event.target.value as AdversarialSettings["selectionStrategy"] }))}
                  >
                    <option value="rotate_among_participants">rotate_among_participants</option>
                    <option value="user_selected">user_selected</option>
                    <option value="auto_selected_by_reputation">auto_selected_by_reputation</option>
                  </select>
                </label>
                <label className="assembly-field">
                  <span>Strictness</span>
                  <select
                    value={adversarial.strictness}
                    onChange={(event) => setAdversarial((current) => ({ ...current, strictness: event.target.value as AdversarialSettings["strictness"] }))}
                  >
                    <option value="light">light</option>
                    <option value="balanced">balanced</option>
                    <option value="aggressive">aggressive</option>
                  </select>
                </label>
                <label className="assembly-check"><input type="checkbox" checked={adversarial.requireMitigations} onChange={(event) => setAdversarial((current) => ({ ...current, requireMitigations: event.target.checked }))} />Require mitigations</label>
                <label className="assembly-check"><input type="checkbox" checked={adversarial.requireEvidenceTags} onChange={(event) => setAdversarial((current) => ({ ...current, requireEvidenceTags: event.target.checked }))} />Require evidence tags</label>
                <label className="assembly-check"><input type="checkbox" checked={adversarial.defenseRoundEnabled} onChange={(event) => setAdversarial((current) => ({ ...current, defenseRoundEnabled: event.target.checked }))} />Defense round</label>
                <label className="assembly-check"><input type="checkbox" checked={adversarial.repetitiveObjectionCutoff} onChange={(event) => setAdversarial((current) => ({ ...current, repetitiveObjectionCutoff: event.target.checked }))} />Repetitive objection cutoff</label>
                <label className="assembly-check"><input type="checkbox" checked={adversarial.minorityReportRequired} onChange={(event) => setAdversarial((current) => ({ ...current, minorityReportRequired: event.target.checked }))} />Minority report required</label>
              </div>
            ) : null}

            <div className="assembly-actions">
              <button type="button" onClick={handleSubmit} disabled={isSubmitting || participantModels.length < 2 || prompt.trim().length === 0}>
                {isSubmitting ? "Launching..." : "Start Assembly"}
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="Live Deliberation" subtitle="Stage timeline, recent runs, and artifact pressure." className="assembly-pane">
          <div className="assembly-run-list">
            {runs.length === 0 ? <p>No Assembly runs yet.</p> : runs.map((run) => (
              <button
                key={run.runId}
                type="button"
                className={`assembly-run-row${selectedRun?.runId === run.runId ? " active" : ""}`}
                onClick={() => {
                  setSelectedRunId(run.runId);
                  void fetchAssemblyRunDetail(run.runId).then(setSelectedRunDetail).catch((detailError) => setError((detailError as Error).message));
                }}
              >
                <span>{run.title}</span>
                <StatusChip tone={run.status === "completed" ? "success" : run.status === "failed" ? "critical" : "warning"}>{run.status}</StatusChip>
              </button>
            ))}
          </div>
          {selectedRunDetail ? (
            <>
              <div className="assembly-kpi-strip">
                <StatusChip tone="muted">stage {selectedRunDetail.run.currentStage}</StatusChip>
                <StatusChip tone="muted">round {selectedRunDetail.run.currentRoundIndex}</StatusChip>
                <StatusChip tone="muted">{selectedRunDetail.run.settings.participantModels.length} models</StatusChip>
              </div>
              <ul className="assembly-timeline">
                {selectedRunDetail.rounds.map((round) => (
                  <li key={round.roundId}>
                    <div>
                      <strong>{round.stage}</strong>
                      <p>{round.artifactIds.length} artifact(s)</p>
                    </div>
                    <StatusChip tone={round.stopCheck?.shouldStop ? "warning" : "default"}>{round.status}</StatusChip>
                  </li>
                ))}
              </ul>
              <div className="assembly-artifact-summary">
                {Object.entries(runSummary ?? {}).map(([artifactType, count]) => (
                  <StatusChip key={artifactType} tone="default">{artifactType}: {count}</StatusChip>
                ))}
              </div>
            </>
          ) : (
            <p>Select a run to inspect the timeline.</p>
          )}
        </Panel>

        <Panel title="Result" subtitle="Consensus, disagreements, minority preservation, and export outcomes." className="assembly-pane">
          {selectedRun?.result ? (
            <div className="assembly-result">
              <div className="assembly-result-block">
                <h3>Recommendation</h3>
                <p>{selectedRun.result.recommendation}</p>
              </div>
              <div className="assembly-result-block">
                <h3>Disagreements</h3>
                <ul>
                  {selectedRun.result.disagreements.length === 0 ? <li>No material disagreement clusters remained.</li> : selectedRun.result.disagreements.map((item) => (
                    <li key={item.clusterId}><strong>{item.topic}</strong>: {item.summary}</li>
                  ))}
                </ul>
              </div>
              <div className="assembly-result-block">
                <h3>Implementation plan</h3>
                <ul>
                  {selectedRun.result.implementationPlan.map((item) => <li key={item}>{item}</li>)}
                </ul>
              </div>
              {selectedRun.result.minorityReport ? (
                <div className="assembly-result-block assembly-minority">
                  <h3>Minority report</h3>
                  <p>{selectedRun.result.minorityReport.summary}</p>
                  <ul>
                    {selectedRun.result.minorityReport.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </div>
              ) : null}
              <div className="assembly-result-block">
                <h3>Exports</h3>
                <ul>
                  {selectedRun.result.exports.map((item) => (
                    <li key={item.target}>{item.target}: {item.status}{item.detail ? ` - ${item.detail}` : ""}</li>
                  ))}
                </ul>
              </div>
              <div className="assembly-result-block">
                <h3>Contribution summary</h3>
                <ul>
                  {selectedRun.result.modelContributionSummary.map((item) => (
                    <li key={`${item.modelRef}-${item.contributionRole}`}>{item.modelRef}: {item.summary}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p>Assembly result will appear here after synthesis completes.</p>
          )}

          <div className="assembly-reputation">
            <h3>Reputation snapshot</h3>
            <ul>
              {reputations.length === 0 ? <li>No reputation data recorded yet.</li> : reputations.map((item) => (
                <li key={item.modelRef}>
                  <strong>{item.modelRef}</strong>
                  <span>{item.overall.toFixed(2)} overall</span>
                </li>
              ))}
            </ul>
          </div>
        </Panel>
      </div>
    </section>
  );
}

function buildDefaultParticipants(
  providers: Array<{ providerId: string; label: string; defaultModel: string }>,
  modelsByProvider: Record<string, string[]>,
): ParticipantDraft[] {
  const uniqueProviders = providers.slice(0, 2);
  if (uniqueProviders.length >= 2) {
    return uniqueProviders.map((provider) => ({
      providerId: provider.providerId,
      model: modelsByProvider[provider.providerId]?.[0] ?? provider.defaultModel,
    }));
  }
  const first = providers[0];
  if (!first) {
    return [];
  }
  const models = modelsByProvider[first.providerId] ?? [first.defaultModel];
  return [
    { providerId: first.providerId, model: models[0] ?? first.defaultModel },
    { providerId: first.providerId, model: models[1] ?? models[0] ?? first.defaultModel },
  ];
}
