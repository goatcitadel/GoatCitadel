import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Scale, Waypoints } from "lucide-react";
import type { ModelComparisonRun } from "@goatcitadel/contracts";
import { judgeModelComparison, listModelComparisons } from "@goatcitadel/mission-control-shared/api/model-comparisons";
import { NativeCard } from "../NativeRoutePageLayout";
import type { NativeRoutePagesProps } from "../types";
import {
  formatDateTime,
  getErrorMessage,
  nativeLoad,
  nativeLoadIssues,
  truncateText,
  useAsyncLoad,
  type Notice,
} from "../shared/native-helpers";
import {
  LibraryActionCardGrid,
  LibraryActionList,
  LibraryButtonRow,
  LibraryEmptyState,
  LibraryField,
  LibraryFieldGrid,
  LibraryLoadWarnings,
  LibraryMetricGrid,
  LibraryNotice,
  LibrarySectionShell,
  LibrarySelectableList,
} from "../shared/library-primitives";

type ScoreValue = "0" | "1" | "2" | "3" | "4";
type ScoreDraft = Record<string, ScoreValue>;

const SCORE_OPTIONS: ScoreValue[] = ["0", "1", "2", "3", "4"];

export function LibraryPromptPacksSection({ route, navigate }: NativeRoutePagesProps) {
  const [selectedComparisonId, setSelectedComparisonId] = useState("");
  const [selectedTestId, setSelectedTestId] = useState("");
  const [winnerCandidateId, setWinnerCandidateId] = useState("");
  const [scoreDraft, setScoreDraft] = useState<ScoreDraft>({});
  const [notes, setNotes] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    const comparisons = await nativeLoad("Model comparisons", listModelComparisons(30), { items: [] });
    return { issues: nativeLoadIssues([comparisons]), comparisons: comparisons.data.items };
  }, []);
  const { loading, error, data, reload } = useAsyncLoad(load, [load]);

  const comparisons = useMemo(() => data?.comparisons ?? [], [data?.comparisons]);
  const selectedComparison = comparisons.find((item) => item.comparisonId === selectedComparisonId) ?? null;
  const selectedResults = useMemo(
    () => selectedComparison?.results.filter((result) => result.testId === selectedTestId) ?? [],
    [selectedComparison, selectedTestId],
  );

  useEffect(() => {
    setSelectedComparisonId((current) =>
      comparisons.some((comparison) => comparison.comparisonId === current)
        ? current
        : (comparisons[0]?.comparisonId ?? ""),
    );
  }, [comparisons]);

  useEffect(() => {
    if (!selectedComparison) {
      setSelectedTestId("");
      setWinnerCandidateId("");
      setScoreDraft({});
      return;
    }
    const nextTestId = selectedComparison.testIds.includes(selectedTestId)
      ? selectedTestId
      : (selectedComparison.testIds[0] ?? "");
    const nextWinner = selectedComparison.candidates.some((candidate) => candidate.candidateId === winnerCandidateId)
      ? winnerCandidateId
      : (selectedComparison.candidates[0]?.candidateId ?? "");
    setSelectedTestId(nextTestId);
    setWinnerCandidateId(nextWinner);
    setScoreDraft(
      (current) =>
        Object.fromEntries(
          selectedComparison.candidates.map((candidate) => [
            candidate.candidateId,
            current[candidate.candidateId] ?? "3",
          ]),
        ) as ScoreDraft,
    );
  }, [selectedComparison, selectedTestId, winnerCandidateId]);

  const saveJudgment = useCallback(async () => {
    if (!selectedComparison || !selectedTestId) {
      setNotice({ tone: "warning", message: "Select a comparison and test before saving a judgment." });
      return;
    }
    setSaving(true);
    try {
      await judgeModelComparison(selectedComparison.comparisonId, {
        testId: selectedTestId,
        winnerCandidateId: winnerCandidateId || undefined,
        scores: selectedComparison.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          quality: Number(scoreDraft[candidate.candidateId] ?? "3") as 0 | 1 | 2 | 3 | 4,
        })),
        notes: notes.trim() || undefined,
        reviewerId: "operator",
      });
      setNotice({ tone: "success", message: "Saved model comparison judgment." });
      setNotes("");
      await reload();
    } catch (judgeError) {
      setNotice({ tone: "error", message: getErrorMessage(judgeError) });
    } finally {
      setSaving(false);
    }
  }, [notes, reload, scoreDraft, selectedComparison, selectedTestId, winnerCandidateId]);

  return (
    <LibrarySectionShell loading={loading} error={error}>
      <LibraryLoadWarnings issues={data?.issues ?? []} onRetry={reload} />
      {notice ? <LibraryNotice notice={notice} /> : null}
      <div className="mc-next-settings-grid">
        <NativeCard
          title="Prompt-pack review queue"
          subtitle="Recent model comparisons attached to prompt-pack evaluation work."
          stats={[
            { label: "Runs", value: String(comparisons.length) },
            { label: "Completed", value: String(comparisons.filter((item) => item.status === "completed").length) },
          ]}
        >
          <LibraryMetricGrid
            items={[
              {
                label: "Judgments",
                value: String(comparisons.reduce((total, item) => total + item.judgments.length, 0)),
                meta: "Operator review records",
              },
              {
                label: "Results",
                value: String(comparisons.reduce((total, item) => total + item.results.length, 0)),
                meta: "Model response records",
              },
              {
                label: "Active run",
                value: selectedComparison?.status ?? "none",
                meta: selectedComparison?.packId ?? "Select a comparison run",
              },
            ]}
          />
          <LibrarySelectableList
            items={comparisons.map((comparison) => ({
              id: comparison.comparisonId,
              title: comparison.title,
              meta: comparison.status,
              body: `${comparison.packId} - ${comparison.candidates.length} candidates - ${formatDateTime(
                comparison.updatedAt,
              )}`,
            }))}
            selectedId={selectedComparisonId}
            onSelect={setSelectedComparisonId}
            emptyLabel="No model comparison runs are visible yet."
          />
          <LibraryButtonRow>
            <button type="button" className="mc-next-settings-filter" onClick={() => void reload()}>
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
            <button
              type="button"
              className="mc-next-settings-filter"
              onClick={() => navigate({ area: "ops", section: "quality", theme: route.theme })}
            >
              <Waypoints className="h-4 w-4" />
              Ops quality
            </button>
          </LibraryButtonRow>
        </NativeCard>
        <div className="mc-next-settings-stack">
          <NativeCard
            title={selectedComparison?.title ?? "Model comparison detail"}
            subtitle={
              selectedComparison ? `${selectedComparison.packId} - ${selectedComparison.status}` : "Select a run."
            }
          >
            {selectedComparison ? (
              <>
                <LibraryActionCardGrid
                  items={selectedComparison.candidates.map((candidate) => ({
                    id: candidate.candidateId,
                    label: candidate.blindLabel,
                    value: candidate.model,
                    description: `Provider ${candidate.providerId}; candidate id ${candidate.candidateId}.`,
                    meta: candidate.providerId,
                    tone: candidate.candidateId === winnerCandidateId ? "success" : "neutral",
                  }))}
                  emptyLabel="No candidates were recorded for this comparison."
                />
                <LibraryActionList
                  items={selectedResults.map((result) => ({
                    id: result.resultId,
                    label: labelForResult(result.candidateId, selectedComparison),
                    description: result.error
                      ? result.error
                      : truncateText(result.responseText ?? "No response text was recorded.", 220),
                    meta: [
                      result.latencyMs ? `${result.latencyMs} ms` : undefined,
                      result.costUsd !== undefined ? `$${result.costUsd.toFixed(4)}` : undefined,
                      result.runId,
                    ]
                      .filter((value): value is string => Boolean(value))
                      .join(" - "),
                  }))}
                  emptyLabel="No results are visible for the selected test."
                  maxHeight="min(36vh, 22rem)"
                />
              </>
            ) : (
              <LibraryEmptyState label="Select a model comparison run to inspect it." />
            )}
          </NativeCard>
          <NativeCard title="Review selected test" subtitle="Save one operator judgment without leaving Library.">
            {selectedComparison ? (
              <>
                <LibraryFieldGrid>
                  <LibraryField label="Test">
                    <select
                      className="mc-next-settings-input"
                      value={selectedTestId}
                      onChange={(event) => setSelectedTestId(event.target.value)}
                    >
                      {selectedComparison.testIds.map((testId) => (
                        <option key={testId} value={testId}>
                          {testId}
                        </option>
                      ))}
                    </select>
                  </LibraryField>
                  <LibraryField label="Winner">
                    <select
                      className="mc-next-settings-input"
                      value={winnerCandidateId}
                      onChange={(event) => setWinnerCandidateId(event.target.value)}
                    >
                      <option value="">No winner</option>
                      {selectedComparison.candidates.map((candidate) => (
                        <option key={candidate.candidateId} value={candidate.candidateId}>
                          {candidate.blindLabel} - {candidate.model}
                        </option>
                      ))}
                    </select>
                  </LibraryField>
                  {selectedComparison.candidates.map((candidate) => (
                    <LibraryField key={candidate.candidateId} label={`${candidate.blindLabel} quality`}>
                      <select
                        className="mc-next-settings-input"
                        value={scoreDraft[candidate.candidateId] ?? "3"}
                        onChange={(event) =>
                          setScoreDraft((current) => ({
                            ...current,
                            [candidate.candidateId]: event.target.value as ScoreValue,
                          }))
                        }
                      >
                        {SCORE_OPTIONS.map((score) => (
                          <option key={score} value={score}>
                            {score}
                          </option>
                        ))}
                      </select>
                    </LibraryField>
                  ))}
                  <LibraryField label="Review notes" span={2}>
                    <textarea
                      className="mc-next-settings-input"
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Why did this model win?"
                      rows={4}
                    />
                  </LibraryField>
                </LibraryFieldGrid>
                <LibraryButtonRow>
                  <button
                    type="button"
                    className="mc-next-button"
                    disabled={saving || !selectedTestId}
                    onClick={() => void saveJudgment()}
                  >
                    <Scale className="h-4 w-4" />
                    Save judgment
                  </button>
                </LibraryButtonRow>
                <LibraryActionList
                  items={selectedComparison.judgments.map((judgment) => ({
                    id: judgment.judgmentId,
                    label: judgment.testId,
                    description: judgment.notes ?? "No notes recorded.",
                    meta: `${judgment.winnerCandidateId ?? "no winner"} - ${formatDateTime(judgment.createdAt)}`,
                  }))}
                  emptyLabel="No judgments have been saved for this run."
                  maxHeight="min(28vh, 16rem)"
                />
              </>
            ) : (
              <LibraryEmptyState label="Select a comparison before saving a judgment." />
            )}
          </NativeCard>
        </div>
      </div>
    </LibrarySectionShell>
  );
}

function labelForResult(candidateId: string, comparison: ModelComparisonRun): string {
  const candidate = comparison.candidates.find((item) => item.candidateId === candidateId);
  return candidate ? `${candidate.blindLabel} - ${candidate.model}` : candidateId;
}
