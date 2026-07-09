import { useEffect, useMemo, useState } from "react";
import { BarChart3, ClipboardCopy } from "lucide-react";
import type {
  LlmEvalProofRunRecord,
  OpsQualitySnapshotResponse,
  PromptPackExportRecord,
  PromptPackRecord,
  PromptPackReportRecord,
  PromptPackSecurityEvalPackRecord,
  PromptPackSecurityQualityGateRecord,
} from "@goatcitadel/contracts";
import {
  exportLlmEvalProofRuns,
  exportOpsQualityEvidence,
  fetchOpsQualitySnapshot,
  fetchPromptPackExport,
  fetchPromptPackReport,
  importBuiltinPromptPack,
} from "@goatcitadel/mission-control-shared/api/client";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, ErrorState, NativeButton, NoticeBanner, ResultCount, StatusChip } from "../primitives";
import {
  formatBytes,
  formatDateTime,
  nativeLoad,
  nativeLoadIssues,
  useAsyncLoad,
  type NativeLoadIssue,
} from "../shared/native-helpers";
import { LibraryLoadWarnings, LibraryMetricGrid } from "../shared/library-primitives";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

export function QualityDashboardRoutePage({ activeWorkspaceName, navigate, route }: NativeRoutePagesProps) {
  const [exporting, setExporting] = useState(false);
  const [otelExporting, setOtelExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [importingPackKey, setImportingPackKey] = useState<string | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const { loading, error, data, reload } = useAsyncLoad(async () => {
    const snapshot = await nativeLoad(
      "Ops quality snapshot",
      fetchOpsQualitySnapshot({ packLimit: 200, evalLimit: 25 }),
      {
        version: "ops.quality_snapshot.v1",
        generatedAt: new Date(0).toISOString(),
        sourceEndpoint: "/api/v1/ops/quality",
        posture: {
          readOnly: true,
          sideEffectPosture: "audit_only",
          note: "Ops quality snapshot is unavailable; showing empty fallback state.",
        },
        metricScope: {
          scope: "bounded_read",
          promptPackLimit: 200,
          evalRunLimit: 25,
          note: "Fallback snapshot contains no stored evidence.",
        },
        metrics: {
          promptPackCount: 0,
          promptPackTestCount: 0,
          redTeamPackCount: 0,
          redTeamTestCount: 0,
          evalRunCount: 0,
          paretoModelCount: 0,
          securityGateCount: 0,
          passingSecurityGateCount: 0,
          securityExecutionReadyCount: 0,
          securityExecutionBlockedCount: 0,
          designQualityCheckCount: 0,
          designQualityBlockingCount: 0,
        },
        promptPacks: { state: "not_available", items: [] as PromptPackRecord[] },
        evalProof: { state: "not_available", items: [] as LlmEvalProofRunRecord[] },
        securityEvalPacks: {
          state: "not_available",
          items: [] as PromptPackSecurityEvalPackRecord[],
          warnings: [],
        },
        securityQualityGates: {
          state: "not_available",
          items: [] as PromptPackSecurityQualityGateRecord[],
          warnings: [],
        },
        securityExecution: {
          state: "not_available",
          items: [],
          warnings: [],
        },
        designQuality: {
          state: "not_available",
          posture: {
            readOnly: true,
            sideEffectPosture: "audit_only",
            source: "repo_files",
            callsProviders: false,
            mutationPerformed: false,
            note: "Fallback design-quality snapshot contains no repo evidence.",
          },
          summary: {
            totalChecks: 0,
            passingCount: 0,
            advisoryCount: 0,
            blockingCount: 0,
            unknownCount: 0,
            p0Count: 0,
            p1Count: 0,
            p2Count: 0,
            p3Count: 0,
          },
          checks: [],
          warnings: [],
        },
        warnings: [],
        nextChecks: [],
      } satisfies OpsQualitySnapshotResponse,
    );
    const quality = snapshot.data;
    return {
      issues: [...nativeLoadIssues([snapshot]), ...qualitySnapshotIssues(quality)],
      quality,
      packs: quality.promptPacks.items,
      evalRuns: quality.evalProof.items,
      securityEvalPacks: quality.securityEvalPacks.items,
      securityEvalWarnings: quality.securityEvalPacks.warnings,
      securityGates: quality.securityQualityGates.items,
      securityGateWarnings: quality.securityQualityGates.warnings,
      securityExecution: quality.securityExecution.items,
      securityExecutionWarnings: quality.securityExecution.warnings,
      designQuality: quality.designQuality,
    };
  }, []);

  const packs = useMemo(() => data?.packs ?? [], [data?.packs]);
  const evalRuns = data?.evalRuns ?? [];
  const securityEvalPacks = data?.securityEvalPacks ?? [];
  const securityGates = data?.securityGates ?? [];
  const securityExecution = data?.securityExecution ?? [];
  const designQuality = data?.designQuality;
  const quality = data?.quality;
  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? packs[0] ?? null;
  const totalTests =
    quality?.metrics.promptPackTestCount ?? packs.reduce((sum, pack) => sum + (pack.testCount ?? 0), 0);
  const securityEvalTests =
    quality?.metrics.redTeamTestCount ?? securityEvalPacks.reduce((sum, pack) => sum + pack.testCount, 0);
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

  const copyOtelQualityExport = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      setExportError("Clipboard export is not available in this environment.");
      setExportNotice(null);
      return;
    }
    setOtelExporting(true);
    setExportError(null);
    setExportNotice(null);
    try {
      const exported = await exportOpsQualityEvidence({ packLimit: 200, evalLimit: 25, format: "otel_json" });
      await navigator.clipboard.writeText(exported.content);
      setExportNotice(`Copied Ops Quality OTel export ${exported.filename}.`);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setOtelExporting(false);
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

  const openPromptPackWorkbench = (packId?: string) => {
    navigate({
      area: "library",
      section: "prompt-packs",
      view: packId ? `pack:${packId}` : undefined,
      theme: route.theme,
    });
  };

  const importSecurityEvalPack = async (packKey: string) => {
    setImportingPackKey(packKey);
    setExportError(null);
    setExportNotice(null);
    try {
      const imported = await importBuiltinPromptPack(packKey);
      setExportNotice(`Imported ${imported.pack.name} with ${imported.tests.length} tests.`);
      await reload();
      openPromptPackWorkbench(imported.pack.packId);
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
      kicker={routeKicker(route)}
      title="Quality Dashboard"
      className="mc-next-quality-dashboard-page"
      description={`Evaluation proof, prompt-pack gates, and export posture for ${activeWorkspaceName}.`}
      loading={loading}
      error={error}
      metrics={[
        { label: "Prompt packs", value: String(packs.length) },
        { label: "Pack tests", value: String(totalTests) },
        { label: "Red team tests", value: String(securityEvalTests) },
        { label: "Eval runs", value: String(evalRuns.length) },
        { label: "Pareto", value: String(paretoModels.length) },
      ]}
      actions={
        <>
          <NativeButton variant="secondary" onClick={() => void copyEvalProofExport()} disabled={exporting}>
            <ClipboardCopy className="h-4 w-4" />
            {exporting ? "Exporting..." : "Copy eval proof export"}
          </NativeButton>
          <NativeButton variant="secondary" onClick={() => void reload()}>
            <BarChart3 className="h-4 w-4" />
            Refresh
          </NativeButton>
        </>
      }
    >
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {exportNotice ? <NoticeBanner tone="success" message={exportNotice} /> : null}
      {exportError ? <ErrorState size="inline" description={exportError} /> : null}
      <NativeGrid className="mc-next-quality-dashboard-grid">
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
              {packs.length > 6 ? <ResultCount shown={6} total={packs.length} noun="prompt packs" /> : null}
              <div className="mc-next-approvals-inline-actions">
                {packs.slice(0, 6).map((pack) => (
                  <NativeButton
                    key={pack.packId}
                    variant={pack.packId === selectedPack?.packId ? "default" : "secondary"}
                    onClick={() => setSelectedPackId(pack.packId)}
                  >
                    {pack.name}
                  </NativeButton>
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
                <NativeButton
                  variant="secondary"
                  onClick={() => void copyPromptPackExportPath()}
                  disabled={!selectedExport}
                >
                  <ClipboardCopy className="h-4 w-4" />
                  Copy prompt-pack export path
                </NativeButton>
                <NativeButton variant="secondary" onClick={() => openPromptPackWorkbench(selectedPack?.packId)}>
                  Open selected pack
                </NativeButton>
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
          {data?.securityEvalWarnings?.[0] ? <NoticeBanner tone="info" message={data.securityEvalWarnings[0]} /> : null}
          <NativeList
            density="compact"
            items={securityEvalPacks.map((pack) => ({
              title: pack.title,
              meta: [
                formatSecurityEvalStatus(pack.status),
                `${pack.testCount} tests`,
                `Chat ${pack.modeCounts.chat ?? 0}`,
                `Legacy plan ${pack.modeCounts.cowork ?? 0}`,
                `Legacy code ${pack.modeCounts.code ?? 0}`,
              ].join(" · "),
              body:
                pack.blockers.length > 0
                  ? pack.blockers.join(" ")
                  : `${pack.capabilityTargets.slice(0, 4).join(", ")} coverage is ready for prompt-pack runs.`,
            }))}
            emptyLabel="No security eval pack definitions are visible."
            maxHeight="min(38vh, 24rem)"
          />
          {securityEvalPacks.some((pack) => pack.status === "available" || pack.importedPackId) ? (
            <div className="mc-next-approvals-inline-actions">
              {securityEvalPacks
                .filter((pack) => pack.status === "available" || pack.importedPackId)
                .map((pack) => (
                  <NativeButton
                    key={pack.packKey}
                    variant="secondary"
                    onClick={() =>
                      pack.importedPackId
                        ? openPromptPackWorkbench(pack.importedPackId)
                        : void importSecurityEvalPack(pack.packKey)
                    }
                    disabled={pack.status === "available" && importingPackKey === pack.packKey}
                  >
                    {pack.importedPackId
                      ? "Open defensive security pack"
                      : importingPackKey === pack.packKey
                        ? "Importing..."
                        : "Import and open defensive security pack"}
                  </NativeButton>
                ))}
            </div>
          ) : null}
          <button
            type="button"
            className="mc-next-directory-action"
            onClick={() =>
              openPromptPackWorkbench(securityEvalPacks.find((pack) => pack.importedPackId)?.importedPackId)
            }
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
          {data?.securityGateWarnings?.[0] ? <NoticeBanner tone="info" message={data.securityGateWarnings[0]} /> : null}
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
          {securityGates.some((gate) => gate.packId) ? (
            <div className="mc-next-approvals-inline-actions">
              {securityGates
                .filter((gate) => gate.packId)
                .slice(0, 2)
                .map((gate) => (
                  <NativeButton
                    key={gate.gateId}
                    variant="secondary"
                    onClick={() => openPromptPackWorkbench(gate.packId)}
                  >
                    Review security pack scoring
                  </NativeButton>
                ))}
            </div>
          ) : null}
        </NativeCard>

        <NativeCard
          title="Design quality"
          subtitle="Read-only skill, routing, anti-slop, and visual-proof evidence for Mission Control design work."
          stats={[
            { label: "Checks", value: String(designQuality?.summary.totalChecks ?? 0) },
            { label: "Passing", value: String(designQuality?.summary.passingCount ?? 0) },
            { label: "Advisory", value: String(designQuality?.summary.advisoryCount ?? 0) },
            { label: "Blocking", value: String(designQuality?.summary.blockingCount ?? 0) },
          ]}
        >
          {designQuality?.error ? (
            <ErrorState size="inline" description={designQuality.error} />
          ) : data?.designQuality?.warnings[0] ? (
            <NoticeBanner tone="info" message={data.designQuality.warnings[0]} />
          ) : null}
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone={designQuality?.state === "available" ? "success" : "warning"}>
              {formatAvailabilityState(designQuality?.state)}
            </StatusChip>
            <StatusChip tone="muted">Read-only</StatusChip>
            <StatusChip tone="muted">No provider calls</StatusChip>
            <StatusChip tone="muted">No source writes</StatusChip>
          </div>
          <LibraryMetricGrid
            items={[
              { label: "P0", value: String(designQuality?.summary.p0Count ?? 0), meta: "blocking" },
              { label: "P1", value: String(designQuality?.summary.p1Count ?? 0), meta: "serious advisory" },
              { label: "P2", value: String(designQuality?.summary.p2Count ?? 0), meta: "medium advisory" },
              { label: "P3", value: String(designQuality?.summary.p3Count ?? 0), meta: "passing/info" },
            ]}
          />
          <NativeList
            density="compact"
            items={(designQuality?.checks ?? []).map((check) => ({
              title: check.label,
              meta: `${check.severity} · ${formatDesignQualityStatus(check.status)} · ${check.owner}`,
              body: check.nextAction ?? check.evidence,
            }))}
            emptyLabel="No design-quality checks are available."
            maxHeight="min(36vh, 24rem)"
          />
          <div className="mc-next-approvals-inline-actions">
            <NativeButton
              variant="secondary"
              onClick={() => navigate({ area: "library", section: "skills", theme: route.theme })}
            >
              Open skills
            </NativeButton>
            <NativeButton
              variant="secondary"
              onClick={() => navigate({ area: "ops", section: "runtime", theme: route.theme })}
            >
              Open runtime evidence
            </NativeButton>
          </div>
        </NativeCard>

        <NativeCard
          title="Security execution depth"
          subtitle="Stored defensive-security run coverage, scoring coverage, and pass posture by pack."
          stats={[
            { label: "Rows", value: String(securityExecution.length) },
            { label: "Ready", value: String(quality?.metrics.securityExecutionReadyCount ?? 0) },
            { label: "Blocked", value: String(quality?.metrics.securityExecutionBlockedCount ?? 0) },
          ]}
        >
          {data?.securityExecutionWarnings?.[0] ? (
            <NoticeBanner tone="info" message={data.securityExecutionWarnings[0]} />
          ) : null}
          <NativeList
            density="compact"
            items={securityExecution.map((item) => ({
              title: item.title,
              meta: [
                formatSecurityExecutionState(item.state),
                `${formatScore(item.runCoverage)} run coverage`,
                `${formatScore(item.scoredCoverage)} scored`,
                `${formatScore(item.effectivePassRate)} pass`,
              ].join(" · "),
              body:
                item.blockers[0] ??
                item.nextActions[0] ??
                `${formatSecurityModeCounts(item.modeCounts)} · ${formatSecurityToolTierCounts(item.toolTierCounts)}`,
            }))}
            emptyLabel="No security execution depth rows are available."
            maxHeight="min(34vh, 22rem)"
          />
          <NativeList
            density="compact"
            items={securityExecution.slice(0, 3).map((item) => ({
              title: `${item.packKey} coverage`,
              meta: `${item.completedRuns}/${item.testCount} runs · ${item.needsScoreCount} need score`,
              body:
                item.failingCodes.length > 0
                  ? `Failing codes: ${item.failingCodes.slice(0, 8).join(", ")}`
                  : `${item.capabilityTargets.slice(0, 5).join(", ") || "No capability targets recorded."}`,
            }))}
            emptyLabel="No security coverage details are available."
          />
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone="muted">Audit-only</StatusChip>
            <StatusChip tone="muted">No provider calls</StatusChip>
            <StatusChip tone="muted">Stored evidence</StatusChip>
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
          {paretoModels.length > 8 ? <ResultCount shown={8} total={paretoModels.length} noun="models" /> : null}
        </NativeCard>

        <NativeCard
          title="Export posture"
          subtitle="Exports are read-only evidence snapshots; they do not rerun, approve, or replay work."
        >
          <div className="mc-next-approvals-chip-row">
            <StatusChip tone="success">Prompt-pack report export</StatusChip>
            <StatusChip tone="success">Run trace JSON export</StatusChip>
            <StatusChip tone="success">Eval proof JSON export</StatusChip>
            <StatusChip tone="success">OTel JSON evidence export</StatusChip>
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
              {
                title: "OTel JSON evidence",
                meta: "Ops · Quality",
                body: "Copies stored quality evidence as an OpenTelemetry-style transport payload without changing runtime truth.",
              },
            ]}
            emptyLabel="No export surfaces are registered."
          />
          <div className="mc-next-approvals-inline-actions">
            <NativeButton variant="secondary" onClick={() => void copyOtelQualityExport()} disabled={otelExporting}>
              <ClipboardCopy className="h-4 w-4" />
              {otelExporting ? "Exporting..." : "Copy OTel evidence"}
            </NativeButton>
          </div>
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
            items={(quality?.nextChecks ?? []).map((check) => ({
              title: check.label,
              meta: check.command.replace(/^pnpm\s+/, ""),
              body: check.reason,
            }))}
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

function formatSecurityExecutionState(
  state: OpsQualitySnapshotResponse["securityExecution"]["items"][number]["state"],
) {
  if (state === "definition_missing") return "Definition missing";
  if (state === "definition_only") return "Definition only";
  if (state === "run_required") return "Run required";
  if (state === "scoring_required") return "Scoring required";
  if (state === "review_required") return "Review required";
  if (state === "failing") return "Failing";
  if (state === "passing") return "Passing";
  return "Unknown";
}

function formatAvailabilityState(state: OpsQualitySnapshotResponse["designQuality"]["state"] | undefined): string {
  if (state === "available") return "Available";
  if (state === "not_available") return "Not available";
  return "Unknown";
}

function formatDesignQualityStatus(
  status: OpsQualitySnapshotResponse["designQuality"]["checks"][number]["status"],
): string {
  if (status === "passing") return "Passing";
  if (status === "advisory") return "Advisory";
  if (status === "blocking") return "Blocking";
  return "Unknown";
}

function formatSecurityModeCounts(
  counts: OpsQualitySnapshotResponse["securityExecution"]["items"][number]["modeCounts"],
): string {
  return `Chat ${counts.chat ?? 0} · Legacy plan ${counts.cowork ?? 0} · Legacy code ${counts.code ?? 0}`;
}

function formatSecurityToolTierCounts(
  counts: OpsQualitySnapshotResponse["securityExecution"]["items"][number]["toolTierCounts"],
): string {
  return `No-tools ${counts["no-tools"] ?? 0} · Implicit ${counts["implicit-tools"] ?? 0} · Explicit ${
    counts["explicit-tools"] ?? 0
  }`;
}

function qualitySnapshotIssues(snapshot: OpsQualitySnapshotResponse): NativeLoadIssue[] {
  return [
    snapshot.promptPacks.error ? { label: "Prompt packs", message: snapshot.promptPacks.error } : null,
    snapshot.evalProof.error ? { label: "Eval proof", message: snapshot.evalProof.error } : null,
    snapshot.securityEvalPacks.error
      ? { label: "Security eval packs", message: snapshot.securityEvalPacks.error }
      : null,
    snapshot.securityQualityGates.error
      ? { label: "Security quality gates", message: snapshot.securityQualityGates.error }
      : null,
    snapshot.securityExecution.error
      ? { label: "Security execution depth", message: snapshot.securityExecution.error }
      : null,
    snapshot.designQuality.error ? { label: "Design quality", message: snapshot.designQuality.error } : null,
  ].filter((issue): issue is NativeLoadIssue => Boolean(issue));
}
