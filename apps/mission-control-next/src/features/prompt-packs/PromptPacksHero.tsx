import { AlertTriangle, BarChart3, CheckCircle2, LoaderCircle, Play, RefreshCcw, Sparkles } from "lucide-react";
import { AssessmentThresholdBar } from "./PromptPacksWorkbenchPage.components";
import type { ActiveRunState } from "@goatcitadel/mission-control-shared/pages/prompt-lab/prompt-lab-types";

export interface PromptPacksHeroProps {
  isOpsVariant: boolean;
  title: string;
  subtitle: string;
  summaryCards: Array<{ label: string; value: string; detail: string }>;
  passRate?: number;
  passThreshold?: number;
  hasReport: boolean;
  error: string | null;
  success: string | null;
  activeRun: ActiveRunState | null;
  selectedPackId: string | null;
  testsLength: number;
  running: boolean;
  benchmarkActive: boolean;
  autoScoring: boolean;
  unscoredCompletedCount: number;
  isRefreshing: boolean;
  onRunNext: () => void;
  onRunAll: () => void;
  onAutoScoreUnscored: () => void;
  onRefresh: () => void;
}

export function PromptPacksHero({
  isOpsVariant,
  title,
  subtitle,
  summaryCards,
  passRate,
  passThreshold,
  hasReport,
  error,
  success,
  activeRun,
  selectedPackId,
  testsLength,
  running,
  benchmarkActive,
  autoScoring,
  unscoredCompletedCount,
  isRefreshing,
  onRunNext,
  onRunAll,
  onAutoScoreUnscored,
  onRefresh,
}: PromptPacksHeroProps) {
  return (
    <>
      <header className="mc-pp-hero">
        <div className="mc-pp-hero-copy">
          <p className="mc-pp-kicker">{isOpsVariant ? "Quality" : "Prompt Packs"}</p>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <div className="mc-pp-hero-actions">
          <button
            type="button"
            className="mc-next-button"
            onClick={onRunNext}
            disabled={!selectedPackId || testsLength === 0 || running}
          >
            {activeRun?.mode === "next" ? <LoaderCircle size={16} className="mc-spin" /> : <Play size={16} />}
            Run next
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={onRunAll}
            disabled={!selectedPackId || testsLength === 0 || running || benchmarkActive}
          >
            {benchmarkActive ? <LoaderCircle size={16} className="mc-spin" /> : <Sparkles size={16} />}
            Run all
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-secondary"
            onClick={onAutoScoreUnscored}
            disabled={!selectedPackId || unscoredCompletedCount === 0 || autoScoring || running}
          >
            {autoScoring ? <LoaderCircle size={16} className="mc-spin" /> : <BarChart3 size={16} />}
            Auto-score
          </button>
          <button
            type="button"
            className="mc-next-button mc-next-button-ghost"
            onClick={onRefresh}
            disabled={isRefreshing}
          >
            {isRefreshing ? <LoaderCircle size={16} className="mc-spin" /> : <RefreshCcw size={16} />}
            Refresh
          </button>
        </div>
      </header>

      <section className="mc-pp-summary-row" aria-label="Prompt pack overview">
        {summaryCards.map((card) => (
          <article key={card.label} className="mc-pp-summary-card">
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <p>{card.detail}</p>
          </article>
        ))}
      </section>

      {hasReport && passRate !== undefined && passThreshold !== undefined ? (
        <AssessmentThresholdBar passRate={passRate} threshold={passThreshold} />
      ) : null}

      {error ? (
        <div className="mc-pp-alert danger" role="alert">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}
      {success ? (
        <div className="mc-pp-alert success" role="status">
          <CheckCircle2 size={16} />
          <span>{success}</span>
        </div>
      ) : null}
    </>
  );
}
