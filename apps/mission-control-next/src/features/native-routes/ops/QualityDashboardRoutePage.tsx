import { useEffect, useState } from "react";
import { BarChart3, ClipboardCopy } from "lucide-react";
import type {
  LlmEvalProofRunRecord,
  PromptPackExportRecord,
  PromptPackRecord,
  PromptPackReportRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "@goatcitadel/contracts";
import {
  exportLlmEvalProofRuns,
  fetchLlmEvalProofRuns,
  fetchPromptPackBuiltins,
  fetchPromptPackExport,
  fetchPromptPackReport,
  fetchPromptPackSecurityGates,
  fetchPromptPacks,
  importBuiltinPromptPack,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, StatusChip } from "../primitives";
import { formatBytes, formatDateTime, nativeLoad, nativeLoadIssues, useAsyncLoad } from "../shared/native-helpers";
import { LibraryLoadWarnings, LibraryMetricGrid } from "../shared/library-primitives";
import type { NativeRoutePagesProps } from "../types";

export function QualityDashboardRoutePage({ activeWorkspaceName, navigate, route }: NativeRoutePagesProps) {
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importingPackKey, setImportingPackKey] = useState<string | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const [packs, evalRuns, securityEvalPacks, securityGates] = await Promise.all([
      nativeLoad("Prompt packs", fetchPromptPacks(200), { items: [] as PromptPackRecord[] }),
      nativeLoad("Eval proof runs", fetchLlmEvalProofRuns(25), {
        generatedAt: new Date(0).toISOString(),
        items: [] as LlmEvalProofRunRecord[],
      }),
      nativeLoad("Security eval packs", fetchPromptPackBuiltins(), {
        generatedAt: new Date(0).toISOString(),
        items: [] as PromptPackSecurityEvalPackRecord[],
        warnings: [],
      }),
      nativeLoad("Security quality gates", fetchPromptPackSecurityGates(), {
        generatedAt: new Date(0).toISOString(),
        items: [] as PromptPackSecurityQualityGateRecord[],
        warnings: [],
      }),
    ]);
    return {
      issues: nativeLoadIssues([packs, evalRuns, securityEvalPacks, securityGates]),
      packs: packs.data.items,
      evalRuns: evalRuns.data.items,
      securityEvalPacks: securityEvalPacks.data.items,
      securityEvalWarnings: securityEvalPacks.data.warnings,
      securityGates: securityGates.data.items,
      securityGateWarnings: securityGates.data.warnings,
    };
  }, []);

  const packs = data?.packs ?? [];
  const evalRuns = data?.evalRuns ?? [];
  const securityEvalPacks = data?.securityEvalPacks ?? [];
  const securityGates = data?.securityGates ?? [];
  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? packs[0] ?? null;
  const totalTests = packs.reduce((sum, pack) => sum + (pack.testCount ?? 0), 0);
  const securityEvalTests = securityEvalPacks.reduce((sum, pack) => sum + pack.testCount, 0);
  const latestEval = evalRuns[0];
  const paretoModels = evalRuns.flatMap((run) => run.results.filter((result) => result.paretoOptimal));
  const selectedPackEvidence = useAsyncLoad(async () => {
    if (!selectedPack?.packId) {
      return {
        issues: [],
        report: null as PromptPackReportRecord | null,
        exportInfo: null as PromptPackExportRecord | null,
      };
    }
    const [report, exportInfo] = await Promise.all([
      nativeLoad(
        "Prompt-pack report",
        fetchPromptPackReport(selectedPack.packId),
        null as PromptPackReportRecord | null,
      ),
      nativeLoad(
        "Prompt-pack export",
        fetchPromptPackExport(selectedPack.packId),
        null as PromptPackExportRecord | null,
      ),
    ]);
    return {
      issues: nativeLoadIssues([report, exportInfo]),
      report: report.data,
      exportInfo: exportInfo.data,
    };
  }, [selectedPack?.packId]);
  const selectedReport = selectedPackEvidence.data?.report;
  const selectedExport = selectedPackEvidence.data?.exportInfo;

  useEffect(() => {
    if (!packs.length) {
      setSelectedPackId(null);
      return;
    }
    setSelectedPackId((current) =>
      current && packs.some((pack) => pack.packId === current) ? current : packs[0]!.packId,
    );
  }, [packs]);

  const copyEvalProofExport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportError("Clipboard export is not available in this environment.");
      setExportNotice(null);
      return;
    }
    setExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const exported = await exportLlmEvalProofRuns(50);
      await navigator.clipboard.writeText(exported.content);
      setExportNotice(`Copied eval proof export ${exported.filename}.`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  };

  const copyPromptPackExportPath = async () => {
    const exportPath = selectedExport?.latestSnapshotPath ?? selectedExport?.latestPath ?? selectedExport?.path;
    if (!exportPath) {
      setExportError("No prompt-pack export path is recorded for the selected pack.");
      setExportNotice(null);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportError("Clipboard export is not available in this environment.");
      setExportNotice(null);
      return;
    }
    try {
      await navigator.clipboard.writeText(exportPath);
      setExportNotice(`Copied prompt-pack export path for ${selectedPack?.name ?? "selected pack"}.`);
      setExportError(null);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
      setExportNotice(null);
    }
  };

  const importSecurityEvalPack = async (packKey: string) => {
    setImportingPackKey(packKey);
    setExportError(null);
    setExportNotice(null);
    try {
      const imported = await importBuiltinPromptPack(packKey);
      setExportNotice(`Imported ${imported.pack.name} with ${imported.tests.length} tests.`);
      await reload();
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportingPackKey(null);
    }
  };

  return (
    <NativePageFrame
      area="ops"
      icon={BarChart3}
      kicker="Ops · Quality"
      title="Quality Dashboard"
      description={`Evaluation proof, prompt-pack gates, and export posture for ${activeWorkspaceName}.`}
      loading={loading}
      error={error}
      metrics={[
        { label: "Prompt packs", value: String(packs.length) },
        { label: "Pack tests", value: String(totalTests) },
        { label: "Red-team tests", value: String(securityEvalTests) },
        { label: "Eval runs", value: String(evalRuns.length) },
        { label: "Pareto models", value: String(paretoModels.length) },
      ]}
      actions={
        <>
          <button
            type="button"
            className="mc-next-secondary-button"
            onClick={() => void copyEvalProofExport()}
            disabled={exporting}
          >
            <ClipboardCopy className="h-4 w-4" />
            {exporting ? "Exporting..." : "Copy eval proof export"}
          </button>
          <button type="button" className="mc-next-secondary-button" onClick={() => void reload()}>
            <BarChart3 className="h-4 w-4" />
            Refresh
          </button>
        </>
      }
    >
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {exportNotice ? <div className="mc-next-runtime-notice tone-success">{exportNotice}</div> : null}
      {exportError ? <div className="mc-next-directory-alert">{exportError}</div> : null}
      <NativeGrid>
        <NativeCard
          title="Quality gates"
          subtitle="Prompt packs remain the editable eval surface; this dashboard summarizes their release posture."
          stats={[
            { label: "Packs", value: String(packs.length) },
            { label: "Tests", value: String(totalTests) },
          ]}
        >
          {packs.length > 0 ? (
            <>
              <NativeList
                density="compact"
                items={packs.slice(0, 6).map((pack) => ({
                  title: pack.name,
                  meta: `${pack.testCount} tests${pack.packId === selectedPack?.packId ? " · selected" : ""}`,
                  body: pack.sourceLabel ? `Source: ${pack.sourceLabel}` : "Source label not recorded.",
                }))}
                emptyLabel="No prompt packs are available."
                maxHeight="min(30vh, 18rem)"
              />
              <div className="mc-next-approvals-inline-actions">
                {packs.slice(0, 6).map((pack) => (
                  <button
                    key={pack.packId}
                    type="button"
                    className={pack.packId === selectedPack?.packId ? "mc-next-button" : "mc-next-secondary-button"}
                    onClick={() => setSelectedPackId(pack.packId)}
                  >
                    {pack.name}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <EmptyState size="compact" title="No prompt packs are available." />
          )}
          <button
            type="button"
            className="mc-next-directory-action"
            onClick={() => navigate({ area: "library", section: "prompt-packs", theme: route.theme })}
          >
            <span>Open prompt packs</span>
          </button>
        </NativeCard>

        <NativeCard
          title="Prompt-pack gate evidence"
          subtitle="Stored report, score, and export state for the selected pack; this panel does not run tests."
          stats={[
            { label: "Selected", value: selectedPack?.name ?? "none" },
            {
              label: "Pass rate",
              value: selectedReport ? formatScore(selectedReport.summary.effectivePassRate) : "unknown",
            },
            {
              label: "Needs score",
              value: String(selectedReport?.summary.needsScoreCount ?? 0),
            },
          ]}
        >
          <LibraryLoadWarnings issues={selectedPackEvidence.data?.issues ?? []} onRetry={selectedPackEvidence.reload} />
          {selectedPackEvidence.loading ? (
            <EmptyState size="compact" title="Loading prompt-pack evidence..." />
          ) : selectedReport ? (
            <>
              <LibraryMetricGrid
                items={[
                  {
                    label: "Tests",
                    value: String(selectedReport.summary.totalTests),
                    meta: selectedReport.pack.packId,
                  },
                  { label: "Completed", value: String(selectedReport.summary.completedRuns), meta: "stored runs" },
                  { label: "Failed runs", value: String(selectedReport.summary.failedRuns) },
                  { label: "Review", value: formatScore(selectedReport.summary.reviewRate), meta: "human review rate" },
                  { label: "Judge fallback", value: String(selectedReport.summary.judgeFallbackCount) },
                  { label: "Degraded", value: String(selectedReport.summary.degradedScoreCount) },
                ]}
              />
              <NativeList
                density="compact"
                items={[
                  {
                    title: "Scoring schema",
                    meta: selectedReport.summary.activeScoringSchemaVersion,
                    body: `Threshold ${selectedReport.summary.passThreshold}; average weighted score ${Math.round(
                      selectedReport.summary.averageWeightedScore,
                    )}.`,
                  },
                  {
                    title: "Failing codes",
                    meta: selectedReport.summary.failingCodes.length ? "needs review" : "none recorded",
                    body:
                      selectedReport.summary.failingCodes.slice(0, 8).join(", ") || "No failing test codes recorded.",
                  },
                  {
                    title: "Export snapshot",
                    meta: selectedExport?.exists ? "available" : "not recorded",
                    body: formatPromptPackExport(selectedExport),
                  },
                ]}
              />
              <div className="mc-next-approvals-inline-actions">
                <button
                  type="button"
                  className="mc-next-secondary-button"
                  onClick={() => void copyPromptPackExportPath()}
                  disabled={!selectedExport}
                >
                  <ClipboardCopy className="h-4 w-4" />
                  Copy prompt-pack export path
                </button>
                <button
                  type="button"
                  className="mc-next-secondary-button"
                  onClick={() => navigate({ area: "library", section: "prompt-packs", theme: route.theme })}
                >
                  Open selected pack
                </button>
              </div>
            </>
          ) : selectedPackEvidence.error ? (
            <EmptyState size="compact" title={`Prompt-pack evidence failed: ${selectedPackEvidence.error}`} />
          ) : (
            <EmptyState size="compact" title="No stored prompt-pack report is available for the selected pack." />
          )}
        </NativeCard>

        <NativeCard
          title="Security eval packs"
          subtitle="Red-team packs are visible as governed definitions; running them remains an explicit operator action."
          stats={[
            { label: "Packs", value: String(securityEvalPacks.length) },
            { label: "Tests", value: String(securityEvalTests) },
          ]}
        >
          {data?.securityEvalWarnings?.[0] ? (
            <div className="mc-next-runtime-notice tone-info">{data.securityEvalWarnings[0]}</div>
          ) : null}
          <NativeList
            density="compact"
            items={securityEvalPacks.map((pack) => ({
              title: pack.title,
              meta: [
                formatSecurityEvalStatus(pack.status),
                `${pack.testCount} tests`,
                `Chat ${pack.modeCounts.chat ?? 0}`,
                `Cowork ${pack.modeCounts.cowork ?? 0}`,
                `Code ${pack.modeCounts.code ?? 0}`,
              ].join(" · "),
              body:
                pack.blockers.length > 0
                  ? pack.blockers.join(" ")
                  : `${pack.capabilityTargets.slice(0, 4).join(", ")} coverage is ready for prompt-pack runs.`,
            }))}
            emptyLabel="No security eval pack definitions are visible."
            maxHeight="min(38vh, 24rem)"
          />
          {securityEvalPacks.some((pack) => pack.status === "available") ? (
            <div className="mc-next-approvals-inline-actions">
              {securityEvalPacks
                .filter((pack) => pack.status === "available")
                .map((pack) => (
                  <button
                    key={pack.packKey}
                    type="button"
                    className="mc-next-secondary-button"
                    onClick={() => void importSecurityEvalPack(pack.packKey)}
                    disabled={importingPackKey === pack.packKey}
                  >
                    {importingPackKey === pack.packKey ? "Importing..." : "Import defensive security pack"}
                  </button>
                ))}
            </div>
          ) : null}
          <button
            type="button"
            className="mc-next-directory-action"
            onClick={() => navigate({ area: "library", section: "prompt-packs", theme: route.theme })}
          >
            <span>Open prompt packs</span>
          </button>
        </NativeCard>

        <NativeCard
          title="Security quality gates"
          subtitle="Named defensive-security gates summarize stored prompt-pack run and score evidence."
          stats={[
            { label: "Gates", value: String(securityGates.length) },
            {
              label: "Passing",
              value: String(securityGates.filter((gate) => gate.status === "passed").length),
            },
          ]}
        >
          {data?.securityGateWarnings?.[0] ? (
            <div className="mc-next-runtime-notice tone-info">{data.securityGateWarnings[0]}</div>
          ) : null}
          <NativeList
            density="compact"
            items={securityGates.map((gate) => ({
              title: gate.title,
              meta: [
                formatSecurityGateStatus(gate.status),
                `${gate.evidence.completedRuns}/${gate.evidence.testCount} runs`,
                `${formatScore(gate.evidence.effectivePassRate)} pass`,
              ].join(" · "),
              body:
                gate.blockers[0] ??
                gate.nextActions[0] ??
                "Stored defensive-security prompt-pack evidence is available.",
            }))}
            emptyLabel="No security quality gates are available."
            maxHeight="min(30vh, 18rem)"
          />
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone="muted">Read-only</StatusChip>
            <StatusChip tone="muted">Stored evidence</StatusChip>
            <StatusChip tone="muted">No provider calls</StatusChip>
          </div>
        </NativeCard>

        <NativeCard
          title="Eval proof"
          subtitle="Provider/model quality evidence only appears when proof runs have been recorded."
          stats={[
            { label: "Latest", value: latestEval ? latestEval.status : "none" },
            { label: "Warnings", value: String(latestEval?.warnings.length ?? 0) },
          ]}
        >
          {latestEval ? (
            <>
              <div className="mc-next-approvals-chip-row">
                <StatusChip tone={latestEval.status === "completed" ? "success" : "warning"}>
                  {latestEval.status}
                </StatusChip>
                <StatusChip tone="muted">{formatDateTime(latestEval.createdAt)}</StatusChip>
              </div>
              <LibraryMetricGrid
                items={[
                  { label: "Candidates", value: String(latestEval.candidates.length), meta: latestEval.runId },
                  { label: "Results", value: String(latestEval.results.length), meta: "model rows" },
                  { label: "Pareto", value: String(latestEval.results.filter((item) => item.paretoOptimal).length) },
                  { label: "Prompt", value: latestEval.promptHash.slice(0, 12), meta: "hash" },
                ]}
              />
            </>
          ) : (
            <EmptyState size="compact" title="No eval proof runs have been recorded." />
          )}
        </NativeCard>

        <NativeCard title="Pareto frontier" subtitle="Fast/cheap/high-quality candidates surfaced by eval proof runs.">
          <NativeList
            density="compact"
            items={paretoModels.slice(0, 8).map((result) => ({
              title: `${result.providerId} / ${result.model}`,
              meta: [
                result.qualityScore !== undefined ? `quality ${formatScore(result.qualityScore)}` : "quality unknown",
                result.latencyMs !== undefined ? `${Math.round(result.latencyMs)} ms` : undefined,
                result.estimatedCostUsd !== undefined ? `$${result.estimatedCostUsd.toFixed(4)}` : undefined,
              ]
                .filter(Boolean)
                .join(" · "),
              body: result.notes.join(" ") || `Measurement source: ${result.measurementSource}.`,
            }))}
            emptyLabel="No Pareto-optimal eval results are available yet."
            maxHeight="min(42vh, 26rem)"
          />
        </NativeCard>

        <NativeCard
          title="Export posture"
          subtitle="Exports are read-only evidence snapshots; they do not rerun, approve, or replay work."
        >
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone="success">Prompt-pack report export</StatusChip>
            <StatusChip tone="success">Run trace JSON export</StatusChip>
            <StatusChip tone="success">Eval proof JSON export</StatusChip>
            <StatusChip tone="muted">Audit-only</StatusChip>
          </div>
          <NativeList
            density="compact"
            items={[
              {
                title: "Prompt-pack report",
                meta: "Library · Prompt Packs",
                body: "Exports the stored report and snapshot path from the prompt-pack workbench.",
              },
              {
                title: "Eval proof JSON",
                meta: "Ops · Quality",
                body: "Copies stored runtime measurement and operator quality-score evidence without calling providers.",
              },
              {
                title: "Run trace JSON",
                meta: "Ops · Run Detail",
                body: "Copies the observe trace export payload from the selected durable run.",
              },
            ]}
            emptyLabel="No export surfaces are registered."
          />
          <button
            type="button"
            className="mc-next-directory-action"
            onClick={() => navigate({ area: "ops", section: "runtime", theme: route.theme })}
          >
            <span>Open runtime evidence</span>
          </button>
        </NativeCard>

        <NativeCard
          title="Governance reminders"
          subtitle="Quality evidence is advisory unless it is tied to durable runs, approvals, and release gates."
        >
          <NativeList
            density="compact"
            items={[
              {
                title: "No hidden pass claim",
                meta: "Truth posture",
                body: "A green eval row is not a release claim unless the relevant verification lane also passed.",
              },
              {
                title: "No autonomous promotion",
                meta: "Human-in-the-loop",
                body: "Skill, model, and prompt-pack changes still route through visible operator review.",
              },
              {
                title: "Exports are snapshots",
                meta: "Audit-only",
                body: "Exported traces and eval reports preserve evidence; they do not mutate runtime state.",
              },
            ]}
            emptyLabel="No governance reminders are configured."
          />
        </NativeCard>

        <NativeCard
          title="Next checks"
          subtitle="Use existing release lanes instead of inventing dashboard-only proof."
        >
          <NativeList
            density="compact"
            items={[
              {
                title: "Prompt gates",
                meta: "prompt:gates",
                body: "Run targeted prompt-pack gates for behavior changes that affect Chat, Cowork, or Code.",
              },
              {
                title: "Runtime truth",
                meta: "verify:runtime:truth",
                body: "Use runtime truth for gateway/durable/API changes.",
              },
              {
                title: "Surface regression",
                meta: "verify:surface:regression",
                body: "Use surface regression for visible operator route changes.",
              },
            ]}
            emptyLabel="No checks are configured."
          />
        </NativeCard>
      </NativeGrid>
    </NativePageFrame>
  );
}

function formatScore(value: number): string {
  return value <= 1 ? `${Math.round(value * 100)}%` : value.toFixed(2);
}

function formatPromptPackExport(exportInfo: PromptPackExportRecord | null | undefined): string {
  if (!exportInfo) {
    return "Export metadata is unavailable.";
  }
  const path = exportInfo.latestSnapshotPath ?? exportInfo.latestPath ?? exportInfo.path;
  const size = exportInfo.latestSnapshotSizeBytes ?? exportInfo.sizeBytes;
  const updated = exportInfo.latestSnapshotUpdatedAt ?? exportInfo.updatedAt;
  return [
    path,
    exportInfo.snapshotCount !== undefined ? `${exportInfo.snapshotCount} snapshots` : undefined,
    size !== undefined ? formatBytes(size) : undefined,
    updated ? `updated ${formatDateTime(updated)}` : undefined,
  ]
    .filter((item): item is string => Boolean(item))
    .join(" · ");
}

function formatSecurityEvalStatus(status: PromptPackSecurityEvalPackRecord["status"]): string {
  if (status === "imported") return "Imported";
  if (status === "available") return "Available";
  return "Unavailable";
}

function formatSecurityGateStatus(status: PromptPackSecurityQualityGateRecord["status"]): string {
  if (status === "missing_definition") return "Missing definition";
  if (status === "not_imported") return "Not imported";
  if (status === "not_run") return "Not run";
  if (status === "needs_score") return "Needs score";
  if (status === "review") return "Review";
  if (status === "failed") return "Failed";
  return "Passed";
}
