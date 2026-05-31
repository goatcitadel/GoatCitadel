import type { AppRoute } from "@next/app/route-model";
import { EmptyState } from "../native-routes/primitives";
import { AdvancedQualityOpsPanel } from "./AdvancedQualityOpsPanel";
import { AssessmentTab } from "./AssessmentTab";
import { ImportPackPanel } from "./ImportPackPanel";
import { InsightsTab } from "./InsightsTab";
import { OutputTab } from "./OutputTab";
import { PromptPackDetailHeader } from "./PromptPackDetailHeader";
import { PromptPackLibraryPanel } from "./PromptPackLibraryPanel";
import { PromptPackTestsColumn } from "./PromptPackTestsColumn";
import { PromptPacksHero } from "./PromptPacksHero";
import { PromptPacksStatusRow } from "./PromptPacksStatusRow";
import { PromptTab } from "./PromptTab";
import { ReviewTab } from "./ReviewTab";
import { RunSettingsPanel } from "./RunSettingsPanel";
import { usePromptPacksWorkbenchState } from "./usePromptPacksWorkbenchState";
import "./prompt-packs-workbench.css";

// Re-export helpers and small components so existing tests and external imports
// against `./PromptPacksWorkbenchPage` continue to work after decomposition.
export {
  buildLatestPromptPackAssessmentByTest,
  buildLatestPromptPackRunByTest,
  buildPromptPackRunRoute,
  buildPromptPackSelectedRunLink,
  chooseNextPromptPackTest,
  computeDraftVerdict,
  computeDraftWeightedScore,
  filterPromptPackTestsByResult,
  formatPromptPackAttribution,
  formatPromptPackExecutionStyle,
  getPromptPackScoreDimensionLabels,
  isPromptPackV2UiEnabled,
  parsePromptForChips,
  readPromptPackScoreDimension,
  resultCategoryClass,
  statusChipClass,
  summarizePromptPackTestOutcomes,
} from "./PromptPacksWorkbenchPage.helpers";
export type { DetailTab, PromptBlockRow, PromptInlineSegment } from "./PromptPacksWorkbenchPage.helpers";
export { AssessmentThresholdBar, DiagnosticChipGroup, PromptSourceEditor } from "./PromptPacksWorkbenchPage.components";

interface PromptPacksWorkbenchPageProps {
  workspaceId?: string;
  variant?: "library" | "ops";
  navigate?: (route: AppRoute, options?: { replace?: boolean }) => void;
  initialPackId?: string;
}

export function PromptPacksWorkbenchPage({
  workspaceId: _workspaceId,
  variant = "library",
  navigate,
  initialPackId,
}: PromptPacksWorkbenchPageProps) {
  const state = usePromptPacksWorkbenchState({ variant: variant ?? "library", navigate, initialPackId });

  if (state.initialLoading) {
    return (
      <section className="mc-prompt-packs">
        <div className="mc-pp-loading-shell">
          <div className="mc-pp-loading-block" />
          <div className="mc-pp-loading-grid">
            <div className="mc-pp-loading-block" />
            <div className="mc-pp-loading-block" />
            <div className="mc-pp-loading-block" />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="mc-prompt-packs" data-variant={variant}>
      <PromptPacksHero
        isOpsVariant={state.isOpsVariant}
        title={state.title}
        subtitle={state.subtitle}
        summaryCards={state.summaryCards}
        passRate={state.report?.summary.passRate}
        passThreshold={state.passThreshold}
        hasReport={!!state.report}
        error={state.error}
        success={state.success}
        activeRun={state.activeRun}
        selectedPackId={state.selectedPackId}
        testsLength={state.tests.length}
        running={state.running}
        benchmarkActive={state.benchmarkActive}
        autoScoring={state.autoScoring}
        unscoredCompletedCount={state.unscoredCompletedCount}
        isRefreshing={state.isRefreshing}
        onRunNext={() => void state.runNext()}
        onRunAll={() => void state.runAll()}
        onAutoScoreUnscored={() => void state.autoScoreUnscored()}
        onRefresh={() => void state.load({ background: true })}
      />

      <PromptPacksStatusRow
        activeRun={state.activeRun}
        benchmarkStatus={state.benchmarkStatus}
        regressionStatus={state.regressionStatus}
        isFallbackRefreshing={state.isFallbackRefreshing}
      />

      <div className="mc-pp-layout">
        <aside className="mc-pp-sidebar">
          <PromptPackLibraryPanel
            isOpsVariant={state.isOpsVariant}
            packs={state.packs}
            selectedPackId={state.selectedPackId}
            onSelectPack={(packId) => {
              state.setSelectedPackId(packId);
              state.setDetailTab("prompt");
            }}
          />

          <RunSettingsPanel
            isOpsVariant={state.isOpsVariant}
            providerOptions={state.providerOptions}
            selectedProviderId={state.selectedProviderId}
            selectedModel={state.selectedModel}
            reuseLastModel={state.reuseLastModel}
            autoScoreOnRun={state.autoScoreOnRun}
            executionStyle={state.executionStyle}
            lastSuccessfulModel={state.lastSuccessfulModel}
            selectedRunModel={state.selectedRunModel}
            executionStyleDescription={state.executionStyleDescription}
            onSelectProvider={state.setSelectedProviderId}
            onSelectModel={state.setSelectedModel}
            onSetReuseLastModel={state.setReuseLastModel}
            onSetAutoScoreOnRun={state.setAutoScoreOnRun}
            onSetExecutionStyle={state.setExecutionStyle}
          />

          <AdvancedQualityOpsPanel
            benchmarkTestCodes={state.benchmarkTestCodes}
            benchmarkProvidersInput={state.benchmarkProvidersInput}
            selectedPackId={state.selectedPackId}
            running={state.running}
            benchmarkPending={state.benchmarkPending}
            benchmarkActive={state.benchmarkActive}
            benchmarkStopping={state.benchmarkStopping}
            benchmarkRunId={state.benchmarkRunId}
            regressionPending={state.regressionPending}
            regressionRunId={state.regressionRunId}
            exporting={state.exporting}
            latestSavedLogPath={state.latestSavedLogPath}
            resetClearRuns={state.resetClearRuns}
            resetClearScores={state.resetClearScores}
            confirmResetArmed={state.confirmResetArmed}
            resetting={state.resetting}
            exportInfo={state.exportInfo}
            onSetBenchmarkTestCodes={state.setBenchmarkTestCodes}
            onSetBenchmarkProvidersInput={state.setBenchmarkProvidersInput}
            onRunBenchmark={() => void state.runBenchmark()}
            onStopBenchmark={() => void state.stopBenchmark()}
            onRefreshBenchmark={state.refreshBenchmark}
            onRunRegression={() => void state.runRegression()}
            onRefreshRegression={state.refreshRegression}
            onExportReport={() => void state.exportReport()}
            onCopyExportPath={() => void state.copyExportPath()}
            onSetResetClearRuns={state.setResetClearRuns}
            onSetResetClearScores={state.setResetClearScores}
            onArmResetConfirm={() => state.setConfirmResetArmed(true)}
            onConfirmResetPack={() => void state.confirmResetPack()}
            onCancelResetConfirm={() => state.setConfirmResetArmed(false)}
          />

          {!state.isOpsVariant ? (
            <ImportPackPanel
              importText={state.importText}
              importing={state.importing}
              onSetImportText={state.setImportText}
              onImport={() => void state.handleImport()}
            />
          ) : null}
        </aside>

        <PromptPackTestsColumn
          selectedPackName={state.selectedPack?.name}
          testsLength={state.tests.length}
          filteredTests={state.filteredTests}
          testResultFilter={state.testResultFilter}
          testOutcomeSummary={state.testOutcomeSummary}
          latestRunByTest={state.latestRunByTest}
          latestAssessmentByTest={state.latestAssessmentByTest}
          selectedTestId={state.selectedTestId}
          activeRun={state.activeRun}
          running={state.running}
          onSetTestResultFilter={state.setTestResultFilter}
          onSelectTest={(testId) => {
            state.setSelectedTestId(testId);
            state.setDetailTab("prompt");
          }}
          onRunOne={(test) => void state.runOne(test, "single")}
        />

        <section className="mc-pp-detail">
          {state.selectedTest ? (
            <>
              <PromptPackDetailHeader
                selectedTest={state.selectedTest}
                selectedRun={state.selectedRun}
                selectedAssessment={state.selectedAssessment}
                selectedCategory={state.selectedCategory}
                selectedRunModelUsage={state.selectedRunModelUsage}
                selectedRunLink={state.selectedRunLink}
                hasNavigate={Boolean(navigate)}
                activeRun={state.activeRun}
                running={state.running}
                executionStyle={state.executionStyle}
                detailTab={state.detailTab}
                onRunSelected={() => state.selectedTest && void state.runOne(state.selectedTest, "single")}
                onOpenSelectedRun={state.openSelectedRun}
                onCopySelectedRunLink={() => void state.copySelectedRunLink()}
                onSetDetailTab={state.setDetailTab}
              />

              <div className="mc-pp-tab-panel">
                {state.detailTab === "prompt" ? (
                  <PromptTab
                    selectedTest={state.selectedTest}
                    selectedPlaceholders={state.selectedPlaceholders}
                    selectedMissingPlaceholders={state.selectedMissingPlaceholders}
                    placeholderValues={state.placeholderValues}
                    selectedDiagnosticMetadata={state.selectedDiagnosticMetadata}
                    onPlaceholderChange={(key, value) =>
                      state.setPlaceholderValues((current) => ({
                        ...current,
                        [key]: value,
                      }))
                    }
                  />
                ) : null}

                {state.detailTab === "output" ? (
                  <OutputTab
                    selectedRun={state.selectedRun}
                    selectedRunModelUsage={state.selectedRunModelUsage}
                    executionStyle={state.executionStyle}
                  />
                ) : null}

                {state.detailTab === "assessment" ? (
                  <AssessmentTab selectedAssessment={state.selectedAssessment} />
                ) : null}

                {state.detailTab === "review" ? (
                  <ReviewTab
                    v2UiEnabled={state.v2UiEnabled}
                    scoreDraft={state.scoreDraft}
                    draftWeightedScore={state.draftWeightedScore}
                    draftVerdict={state.draftVerdict}
                    completedDraftDimensions={state.completedDraftDimensions}
                    selectedRun={state.selectedRun}
                    savingScore={state.savingScore}
                    autoScoring={state.autoScoring}
                    onSetScoreDraft={state.setScoreDraft}
                    onSubmitScore={() => void state.submitScore()}
                    onAutoScoreSelected={() => void state.autoScoreSelected()}
                  />
                ) : null}

                {state.detailTab === "insights" ? (
                  <InsightsTab
                    report={state.report}
                    testOutcomeSummary={state.testOutcomeSummary}
                    passThreshold={state.passThreshold}
                    trendSeries={state.trendSeries}
                    benchmarkStatus={state.benchmarkStatus}
                    regressionStatus={state.regressionStatus}
                  />
                ) : null}
              </div>
            </>
          ) : (
            <EmptyState
              title="Select a test"
              description="Pick a test from the list to inspect the prompt, output, scoring, and review controls."
            />
          )}
        </section>
      </div>
    </section>
  );
}
