import {
  formatScore,
  formatPromptPackExport,
  formatSecurityEvalStatus,
  formatSecurityGateStatus,
  formatSecurityExecutionState,
  formatAvailabilityState,
  formatDesignQualityStatus,
  formatSecurityModeCounts,
  formatSecurityToolTierCounts,
} from "./QualityDashboardRoutePage.helpers";
import { RecordEvidence as QualityRecordEvidence } from "../shared/RecordEvidence";
import { DetailInspector } from "../../../components/DetailInspector";
import { useMemo, useState } from "react";
import { BarChart3, ClipboardCopy } from "lucide-react";
import { NativeCard, NativeGrid, NativeList, NativePageFrame } from "../NativeRoutePageLayout";
import { EmptyState, ErrorState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import { formatDateTime } from "../shared/native-helpers";
import { LibraryLoadWarnings, LibraryMetricGrid } from "../shared/library-primitives";
import { routeKicker } from "@next/app/route-model";
import type { NativeRoutePagesProps } from "../types";

import { useQualityDashboardSnapshot } from "./use-quality-dashboard-snapshot";
import { useQualityPromptPackEvidence } from "./use-quality-prompt-pack-evidence";
import { useQualityEvidenceClipboard } from "./use-quality-evidence-clipboard";
import { supportsBuiltinFirstImport, useBuiltinPromptPackImport } from "./use-builtin-prompt-pack-import";
import { QualityEvidenceExportsPanel } from "./QualityEvidenceExportsPanel";
import { BuiltinPromptPackImportConfirmation } from "./BuiltinPromptPackImportConfirmation";

export function QualityDashboardRoutePage({ navigate, route }: NativeRoutePagesProps) {
  const [qualityView, setQualityView] = useState<"gates" | "evaluations" | "design">("gates");
  const [panel, setPanel] = useState<
    "pack" | "gate" | "design" | "eval" | "security" | "execution" | "pareto" | "exports" | null
  >(null);
  const [selectedGateId, setSelectedGateId] = useState<string | null>(null);
  const [selectedEvalId, setSelectedEvalId] = useState<string | null>(null);
  const [designCheckId, setDesignCheckId] = useState<string | null>(null);
  const [selectedPackId, setSelectedPackId] = useState<string | null>(null);
  const { loading, error, data, reload } = useQualityDashboardSnapshot();
  const importAction = useBuiltinPromptPackImport({ reload });
  const clipboard = useQualityEvidenceClipboard({
    includeFilename: true,
    scopeKey: `${panel}:${selectedPackId}:${data?.quality.generatedAt}`,
  });

  const packs = useMemo(() => data?.packs ?? [], [data?.packs]);
  const evalRuns = data?.evalRuns ?? [];
  const securityEvalPacks = data?.securityEvalPacks ?? [];
  const securityGates = data?.securityGates ?? [];
  const securityExecution = data?.securityExecution ?? [];
  const designQuality = data?.designQuality;
  const quality = data?.quality;
  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? null;
  const totalTests =
    quality?.metrics.promptPackTestCount ?? packs.reduce((sum, pack) => sum + (pack.testCount ?? 0), 0);
  const securityEvalTests =
    quality?.metrics.redTeamTestCount ?? securityEvalPacks.reduce((sum, pack) => sum + pack.testCount, 0);
  const selectedEval = evalRuns.find((run) => run.runId === selectedEvalId);
  const selectedGate = securityGates.find((gate) => gate.gateId === selectedGateId);
  const selectedDesignCheck = designQuality?.checks.find((check) => check.label === designCheckId);
  const paretoModels = evalRuns.flatMap((run) => run.results.filter((result) => result.paretoOptimal));
  const selectedPackEvidence = useQualityPromptPackEvidence(panel === "pack", selectedPack, quality?.generatedAt);
  const selectedReport = selectedPackEvidence.report;
  const selectedExport = selectedPackEvidence.exportInfo;
  const copyPromptPackExportPath = () =>
    clipboard.copyPath(
      selectedExport?.latestSnapshotPath ?? selectedExport?.latestPath ?? selectedExport?.path,
      selectedPack?.name ?? "selected pack",
    );

  const openPromptPackWorkbench = (packId?: string) => {
    navigate({
      area: "library",
      section: "prompt-packs",
      view: packId ? `pack:${packId}` : undefined,
      theme: route.theme,
    });
  };

  return (
    <NativePageFrame
      area="ops"
      icon={BarChart3}
      kicker={routeKicker(route)}
      title="Quality Dashboard"
      className="mc-next-quality-dashboard-page"
      description="Installation-wide evaluation proof, prompt-pack gates, and stored export posture."
      loading={loading && !data}
      error={error}
      metrics={
        data?.available
          ? [
              {
                label: "Prompt packs",
                value: quality?.promptPacks.state === "available" ? String(packs.length) : "Unavailable",
              },
              {
                label: "Pack tests",
                value: quality?.promptPacks.state === "available" ? String(totalTests) : "Unavailable",
              },
              {
                label: "Red team tests",
                value: quality?.securityEvalPacks.state === "available" ? String(securityEvalTests) : "Unavailable",
              },
              {
                label: "Eval runs",
                value: quality?.evalProof.state === "available" ? String(evalRuns.length) : "Unavailable",
              },
              {
                label: "Pareto",
                value: quality?.evalProof.state === "available" ? String(paretoModels.length) : "Unavailable",
              },
            ]
          : []
      }
      actions={
        <>
          <NativeButton
            onClick={() => {
              const gate = securityGates.find((gate) => gate.status !== "passed");
              if (gate) {
                setSelectedGateId(gate.gateId);
                setPanel("gate");
              } else setPanel("exports");
            }}
          >
            {securityGates.some((gate) => gate.status !== "passed") ? "Review gate" : "Review evidence"}
          </NativeButton>
          <NativeButton variant="outline" onClick={() => setPanel("exports")}>
            Exports and checks
          </NativeButton>
          <NativeButton variant="ghost" onClick={() => void reload()}>
            Refresh
          </NativeButton>
        </>
      }
    >
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {clipboard.notice ? (
        clipboard.notice.error ? (
          <ErrorState size="inline" description={clipboard.notice.text} />
        ) : (
          <NoticeBanner tone="success" message={clipboard.notice.text} />
        )
      ) : null}
      {importAction.notice ? <NoticeBanner tone="info" message={importAction.notice} /> : null}
      <BuiltinPromptPackImportConfirmation action={importAction} />

      <div className="mc-next-settings-filter-bar" role="group" aria-label="Quality views">
        {(["gates", "evaluations", "design"] as const).map((view) => (
          <NativeButton
            key={view}
            variant="ghost"
            aria-pressed={view === qualityView}
            onClick={() => {
              setQualityView(view);
              setPanel(null);
            }}
          >
            {view === "gates" ? "Gates" : view === "evaluations" ? "Evaluations" : "Design"}
          </NativeButton>
        ))}
      </div>
      {data?.available ? (
        <>
          <p className="mc-next-help-text">
            Evidence observed {formatDateTime(quality?.generatedAt)} · {quality?.metricScope.note}
          </p>
          <div className="mc-next-runtime-actions">
            {qualityView === "gates" ? (
              <>
                <NativeButton variant="outline" onClick={() => setPanel("security")}>
                  Security packs
                </NativeButton>
                <NativeButton variant="outline" onClick={() => setPanel("execution")}>
                  Execution depth
                </NativeButton>
              </>
            ) : qualityView === "evaluations" ? (
              <NativeButton variant="outline" onClick={() => setPanel("pareto")}>
                Pareto frontier
              </NativeButton>
            ) : null}
          </div>
          <NativeGrid className="mc-next-quality-dashboard-grid">
            {qualityView === "gates" ? (
              <>
                <NativeCard
                  title="Security quality gates"
                  subtitle="Named defensive-security gates summarize stored prompt-pack run and score evidence."
                  stats={[
                    {
                      label: "Gates",
                      value:
                        quality?.securityQualityGates.state === "available"
                          ? String(securityGates.length)
                          : "Unavailable",
                    },
                    {
                      label: "Passing",
                      value:
                        quality?.securityQualityGates.state === "available"
                          ? String(securityGates.filter((gate) => gate.status === "passed").length)
                          : "Unavailable",
                    },
                  ]}
                >
                  {data?.securityGateWarnings?.[0] ? (
                    <NoticeBanner tone="info" message={data.securityGateWarnings[0]} />
                  ) : null}
                  <NativeList
                    density="compact"
                    items={securityGates.map((gate) => ({
                      title: gate.title,
                      actions: (
                        <NativeButton
                          variant="outline"
                          onClick={() => {
                            setSelectedGateId(gate.gateId);
                            setPanel("gate");
                          }}
                        >
                          Inspect gate
                        </NativeButton>
                      ),
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
                    emptyLabel={
                      quality?.securityQualityGates.state === "available"
                        ? "No security quality gates are available."
                        : "Security gate evidence unavailable."
                    }
                    maxHeight="min(30vh, 18rem)"
                  />
                  <div className="mc-next-approvals-chip-row">
                    <StatusChip tone="muted">Stored evidence</StatusChip>
                  </div>
                  {securityGates.some((gate) => gate.packId) ? (
                    <div className="mc-next-approvals-inline-actions">
                      {securityGates
                        .filter((gate) => gate.packId)

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
                  title="Quality gates"
                  subtitle="Select a prompt pack to inspect its stored report and scoring coverage."
                >
                  <NativeList
                    items={packs.map((pack) => ({
                      title: pack.name,
                      meta: (pack.testCount ?? "Unknown") + " tests",
                      body: pack.sourceLabel,
                      actions: (
                        <NativeButton
                          variant="outline"
                          onClick={() => {
                            setSelectedPackId(pack.packId);
                            setPanel("pack");
                          }}
                        >
                          {"Inspect " + pack.name}
                        </NativeButton>
                      ),
                    }))}
                    emptyLabel={
                      quality?.promptPacks.state === "available"
                        ? "No prompt packs are available."
                        : "Prompt-pack evidence unavailable."
                    }
                    maxHeight="min(58vh, 34rem)"
                    virtualized
                  />
                  <NativeButton variant="ghost" onClick={() => openPromptPackWorkbench()}>
                    Open prompt packs
                  </NativeButton>
                </NativeCard>
              </>
            ) : qualityView === "evaluations" ? (
              <NativeCard title="Eval proof" subtitle="Recorded provider/model evaluation evidence.">
                <NativeList
                  items={evalRuns.map((run) => ({
                    title: run.runId,
                    meta: run.status + " · " + formatDateTime(run.createdAt),
                    body: run.warnings.join(" "),
                    actions: (
                      <NativeButton
                        variant="outline"
                        onClick={() => {
                          setSelectedEvalId(run.runId);
                          setPanel("eval");
                        }}
                      >
                        Inspect evaluation
                      </NativeButton>
                    ),
                  }))}
                  emptyLabel={
                    quality?.evalProof.state === "available"
                      ? "No eval proof runs have been recorded."
                      : "Evaluation evidence unavailable."
                  }
                  virtualized
                  maxHeight="min(58vh, 34rem)"
                />
              </NativeCard>
            ) : (
              <NativeCard
                title="Design quality"
                subtitle="Read-only skill, routing, anti-slop, and visual-proof evidence for Mission Control design work."
                stats={[
                  {
                    label: "Checks",
                    value:
                      designQuality?.state === "available" ? String(designQuality.summary.totalChecks) : "Unavailable",
                  },
                  {
                    label: "Passing",
                    value:
                      designQuality?.state === "available" ? String(designQuality.summary.passingCount) : "Unavailable",
                  },
                  {
                    label: "Advisory",
                    value:
                      designQuality?.state === "available"
                        ? String(designQuality.summary.advisoryCount)
                        : "Unavailable",
                  },
                  {
                    label: "Blocking",
                    value:
                      designQuality?.state === "available"
                        ? String(designQuality.summary.blockingCount)
                        : "Unavailable",
                  },
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
                </div>
                <LibraryMetricGrid
                  items={[
                    {
                      label: "P0",
                      value:
                        designQuality?.state === "available" ? String(designQuality.summary.p0Count) : "Unavailable",
                      meta: "blocking",
                    },
                    {
                      label: "P1",
                      value:
                        designQuality?.state === "available" ? String(designQuality.summary.p1Count) : "Unavailable",
                      meta: "serious advisory",
                    },
                    {
                      label: "P2",
                      value:
                        designQuality?.state === "available" ? String(designQuality.summary.p2Count) : "Unavailable",
                      meta: "medium advisory",
                    },
                    {
                      label: "P3",
                      value:
                        designQuality?.state === "available" ? String(designQuality.summary.p3Count) : "Unavailable",
                      meta: "passing/info",
                    },
                  ]}
                />
                <NativeList
                  density="compact"
                  items={(designQuality?.checks ?? []).map((check) => ({
                    title: check.label,
                    actions: (
                      <NativeButton
                        variant="outline"
                        onClick={() => {
                          setDesignCheckId(check.label);
                          setPanel("design");
                        }}
                      >
                        Inspect check
                      </NativeButton>
                    ),
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
            )}
          </NativeGrid>
        </>
      ) : !loading ? (
        <EmptyState
          title="Quality evidence unavailable"
          description="The source could not be read. Missing evidence is not a passing gate or a zero count."
        />
      ) : null}
      <DetailInspector
        open={panel !== null}
        title={
          panel === "pack"
            ? (selectedPack?.name ?? "Prompt-pack evidence")
            : panel === "gate"
              ? (selectedGate?.title ?? "Gate evidence")
              : panel === "eval"
                ? "Evaluation details"
                : panel === "design"
                  ? "Design check"
                  : panel === "security"
                    ? "Security eval packs"
                    : panel === "execution"
                      ? "Security execution depth"
                      : panel === "pareto"
                        ? "Pareto frontier"
                        : "Exports and checks"
        }
        onClose={() => setPanel(null)}
      >
        {panel === "pack" ? (
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
                value: selectedReport ? String(selectedReport.summary.needsScoreCount) : "Unavailable",
              },
            ]}
          >
            <LibraryLoadWarnings
              issues={selectedPackEvidence.data?.issues ?? []}
              onRetry={selectedPackEvidence.reload}
            />
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
                    {
                      label: "Review",
                      value: formatScore(selectedReport.summary.reviewRate),
                      meta: "human review rate",
                    },
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
                      body: selectedReport.summary.failingCodes.join(", ") || "No failing test codes recorded.",
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
                    <ClipboardCopy size={16} />
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
        ) : panel === "security" ? (
          <NativeCard
            title="Security eval packs"
            subtitle="Red-team packs are visible as governed definitions; running them remains an explicit operator action."
            stats={[
              {
                label: "Packs",
                value:
                  quality?.securityEvalPacks.state === "available" ? String(securityEvalPacks.length) : "Unavailable",
              },
              {
                label: "Tests",
                value: quality?.securityEvalPacks.state === "available" ? String(securityEvalTests) : "Unavailable",
              },
            ]}
          >
            {data?.securityEvalWarnings?.[0] ? (
              <NoticeBanner tone="info" message={data.securityEvalWarnings[0]} />
            ) : null}
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
                    : `${pack.capabilityTargets.join(", ")} coverage is ready for prompt-pack runs.`,
              }))}
              emptyLabel="No security eval pack definitions are visible."
              maxHeight="min(38vh, 24rem)"
            />
            <div className="mc-next-approvals-inline-actions">
              {securityEvalPacks.map((pack) => (
                <div key={pack.packKey}>
                  {pack.importedPackId ? (
                    <NativeButton variant="secondary" onClick={() => openPromptPackWorkbench(pack.importedPackId)}>
                      Open defensive security pack
                    </NativeButton>
                  ) : supportsBuiltinFirstImport(pack) ? (
                    <NativeButton
                      variant="secondary"
                      disabled={importAction.locked(pack.packKey)}
                      onClick={() => void importAction.requestReview(pack)}
                    >
                      Review defensive definition import
                    </NativeButton>
                  ) : (
                    <p className="mc-next-help-text">
                      Safe first import is unavailable for this definition on the connected Gateway. Existing
                      definitions are preserved.
                    </p>
                  )}
                  {importAction.stateFor(pack.packKey)?.message ? (
                    <p role="status">{importAction.stateFor(pack.packKey)?.message}</p>
                  ) : null}
                </div>
              ))}
            </div>
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
        ) : panel === "execution" ? (
          <NativeCard
            title="Security execution depth"
            subtitle="Stored defensive-security run coverage, scoring coverage, and pass posture by pack."
            stats={[
              {
                label: "Rows",
                value:
                  quality?.securityExecution.state === "available" ? String(securityExecution.length) : "Unavailable",
              },
              {
                label: "Ready",
                value:
                  quality?.securityExecution.state === "available"
                    ? String(quality.metrics.securityExecutionReadyCount)
                    : "Unavailable",
              },
              {
                label: "Blocked",
                value:
                  quality?.securityExecution.state === "available"
                    ? String(quality.metrics.securityExecutionBlockedCount)
                    : "Unavailable",
              },
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
              items={securityExecution.map((item) => ({
                title: `${item.packKey} coverage`,
                meta: `${item.completedRuns}/${item.testCount} runs · ${item.needsScoreCount} need score`,
                body:
                  item.failingCodes.length > 0
                    ? `Failing codes: ${item.failingCodes.join(", ")}`
                    : `${item.capabilityTargets.join(", ") || "No capability targets recorded."}`,
              }))}
              emptyLabel="No security coverage details are available."
            />
            <div className="mc-next-approvals-chip-row">
              <StatusChip tone="muted">Audit-only</StatusChip>
              <StatusChip tone="muted">Stored evidence</StatusChip>
            </div>
          </NativeCard>
        ) : panel === "pareto" ? (
          <NativeCard
            title="Pareto frontier"
            subtitle="Fast/cheap/high-quality candidates surfaced by eval proof runs."
          >
            <NativeList
              density="compact"
              items={paretoModels.map((result) => ({
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
        ) : panel === "exports" ? (
          <QualityEvidenceExportsPanel
            pending={clipboard.pending}
            copy={clipboard.copy}
            checks={quality?.nextChecks ?? []}
            openRuntime={() => navigate({ area: "ops", section: "runtime", theme: route.theme })}
          />
        ) : panel === "gate" ? (
          selectedGate ? (
            <>
              <p>{formatSecurityGateStatus(selectedGate.status)}</p>
              <p>{selectedGate.blockers.join(" ")}</p>
              <p>{selectedGate.nextActions.join(" ")}</p>
              <NativeButton onClick={() => openPromptPackWorkbench(selectedGate.packId)}>
                Review security pack scoring
              </NativeButton>
              <QualityRecordEvidence value={selectedGate} />
            </>
          ) : (
            <p>The selected gate is unavailable.</p>
          )
        ) : panel === "eval" ? (
          selectedEval ? (
            <>
              <LibraryMetricGrid
                items={[
                  { label: "Warnings", value: String(selectedEval.warnings.length) },
                  { label: "Candidates", value: String(selectedEval.candidates.length) },
                  { label: "Results", value: String(selectedEval.results.length) },
                  {
                    label: "Pareto",
                    value: String(selectedEval.results.filter((result) => result.paretoOptimal).length),
                  },
                ]}
              />
              <QualityRecordEvidence value={selectedEval} />
            </>
          ) : (
            <p>The selected evaluation is unavailable.</p>
          )
        ) : panel === "design" ? (
          selectedDesignCheck ? (
            <QualityRecordEvidence value={selectedDesignCheck} />
          ) : (
            <p>The selected design check is unavailable.</p>
          )
        ) : null}
      </DetailInspector>
    </NativePageFrame>
  );
}
