import { useCallback, useEffect, useState } from "react";
import { fetchCostSummary, fetchMemoryQmdStats, runCheaper, type CostSummaryResponse } from "../api/client";
import { ActionButton } from "../components/ActionButton";
import { DataToolbar } from "../components/DataToolbar";
import { FieldHelp } from "../components/FieldHelp";
import { PageHeader } from "../components/PageHeader";
import { Panel } from "../components/Panel";
import { StatusChip } from "../components/StatusChip";
import { GCSelect } from "../components/ui";
import { pageCopy } from "../content/copy";
import { useRefreshSubscription } from "../hooks/useRefreshSubscription";

type CostScope = "day" | "session" | "agent" | "task";

export function CostConsolePage() {
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFallbackRefreshing, setIsFallbackRefreshing] = useState(false);
  const [scope, setScope] = useState<CostScope>("day");
  const [data, setData] = useState<CostSummaryResponse | null>(null);
  const [recommendation, setRecommendation] = useState<string[] | null>(null);
  const [qmdSavings, setQmdSavings] = useState<{
    totalRuns: number;
    compressionPercent: number;
    expansionPercent: number;
    efficiencyLabel: "reduced" | "expanded" | "neutral";
    originalTokenEstimate: number;
    distilledTokenEstimate: number;
    netTokenDelta: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (options?: { background?: boolean }) => {
    const background = options?.background ?? false;
    if (background) {
      setIsRefreshing(true);
    } else {
      setIsInitialLoading(true);
    }
    try {
      const [summary, stats] = await Promise.all([
        fetchCostSummary(scope),
        fetchMemoryQmdStats(),
      ]);
      setData(summary);
      setQmdSavings({
        totalRuns: stats.totalRuns,
        compressionPercent: stats.compressionPercent,
        expansionPercent: stats.expansionPercent,
        efficiencyLabel: stats.efficiencyLabel,
        originalTokenEstimate: stats.originalTokenEstimate,
        distilledTokenEstimate: stats.distilledTokenEstimate,
        netTokenDelta: stats.netTokenDelta,
      });
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
  }, [scope]);

  useEffect(() => {
    void load({ background: false });
  }, [load]);

  useRefreshSubscription(
    "system",
    async () => {
      await load({ background: true });
    },
    {
      enabled: !isInitialLoading,
      coalesceMs: 1200,
      staleMs: 20000,
      pollIntervalMs: 15000,
      onFallbackStateChange: setIsFallbackRefreshing,
    },
  );

  const onRunCheaper = async () => {
    try {
      const res = await runCheaper();
      setRecommendation(res.actions);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (error) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Economics"
          title={pageCopy.costs.title}
          subtitle={pageCopy.costs.subtitle}
          hint="Track usage coverage, token consumption, QMD impact, and lower-cost recommendations from one operator console."
        />
        <p className="error">{error}</p>
      </section>
    );
  }

  if (isInitialLoading || !data) {
    return (
      <section className="workflow-page">
        <PageHeader
          eyebrow="Economics"
          title={pageCopy.costs.title}
          subtitle={pageCopy.costs.subtitle}
          hint="Track usage coverage, token consumption, QMD impact, and lower-cost recommendations from one operator console."
        />
        <p>Loading cost data...</p>
      </section>
    );
  }

  const totalInputTokens = data.items.reduce((sum, item) => sum + item.tokenInput, 0);
  const totalOutputTokens = data.items.reduce((sum, item) => sum + item.tokenOutput, 0);
  const totalTokens = data.items.reduce((sum, item) => sum + item.tokenTotal, 0);
  const totalCostUsd = data.items.reduce((sum, item) => sum + item.costUsd, 0);
  const hasTokenUsage = data.items.some((item) => item.tokenTotal > 0);
  const showsMissingRecordedSpend = hasTokenUsage && totalCostUsd === 0;

  return (
    <section className="workflow-page">
      <PageHeader
        eyebrow="Economics"
        title={pageCopy.costs.title}
        subtitle={pageCopy.costs.subtitle}
        hint="Use this page to compare token spend by scope, confirm usage coverage, and inspect whether QMD is actually saving context cost."
        actions={(
          <div className="workflow-summary-strip">
            <StatusChip tone="muted">{scope}</StatusChip>
            <StatusChip tone={qmdSavings?.efficiencyLabel === "reduced" ? "success" : qmdSavings?.efficiencyLabel === "expanded" ? "warning" : "muted"}>
              {qmdSavings ? describeQmdImpact(qmdSavings) : "No QMD samples"}
            </StatusChip>
            <StatusChip tone="muted">{data.items.length} rows</StatusChip>
          </div>
        )}
      />
      <div className="workflow-status-stack">
        {isRefreshing ? <p className="status-banner">Refreshing costs...</p> : null}
        {isFallbackRefreshing ? (
          <p className="status-banner warning">Live updates degraded, checking periodically.</p>
        ) : null}
        {showsMissingRecordedSpend ? (
          <p className="status-banner warning">
            USD spend is not being recorded for this window. GoatCitadel received token usage,
            but these runs did not report a dollar amount, so recorded spend remains {formatUsd(totalCostUsd)}.
            This commonly happens with local models or providers that omit price metadata.
          </p>
        ) : null}
      </div>
      <DataToolbar
        primary={
          <label className="chat-v11-select" htmlFor="scope">
            Scope
            <GCSelect
              id="scope"
              value={scope}
              onChange={(value) => setScope(value as CostScope)}
              options={[
                { value: "day", label: "day" },
                { value: "session", label: "session" },
                { value: "agent", label: "agent" },
                { value: "task", label: "task" },
              ]}
            />
          </label>
        }
        center={
          <div className="workflow-summary-strip">
            <StatusChip tone={showsMissingRecordedSpend ? "warning" : "success"}>
              Recorded spend {formatUsd(totalCostUsd)}
            </StatusChip>
            <StatusChip tone="muted">Input {totalInputTokens.toLocaleString()}</StatusChip>
            <StatusChip tone="muted">Output {totalOutputTokens.toLocaleString()}</StatusChip>
            <StatusChip tone="muted">Total {totalTokens.toLocaleString()}</StatusChip>
          </div>
        }
        secondary={<ActionButton label="Run Leaner" onClick={() => void onRunCheaper()} />}
      />
      <Panel title="Window Totals" subtitle="Recorded spend, token flow, and QMD posture for the selected scope." padding="compact">
        <p className="office-subtitle">
          {showsMissingRecordedSpend
            ? "The page can account for token volume here, but not actual USD charges yet."
            : "Recorded spend reflects only the runs that reported a USD amount through the gateway."}
        </p>
        <FieldHelp>
          Scope changes what the summary rows group by. “Run Leaner” asks GoatCitadel for concrete lower-cost actions without changing current provider defaults.
        </FieldHelp>
        {qmdSavings ? (
          <p className="office-subtitle">
            QMD impact: {describeQmdImpact(qmdSavings)} Went from {qmdSavings.originalTokenEstimate} tokens to{" "}
            {qmdSavings.distilledTokenEstimate} ({formatTokenDelta(qmdSavings.netTokenDelta)}).
          </p>
        ) : (
          <p className="office-subtitle">No QMD metrics yet.</p>
        )}
      </Panel>
      {recommendation ? (
        <Panel title="Leaner Recommendations" subtitle="Current cost-reduction suggestions from the optimization helper." tone="soft">
          <ul className="improvement-simple-list">
            {recommendation.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {data.usageAvailability ? (
        <Panel title="Usage Coverage" subtitle="How much of the recent agent activity reported provider usage metadata.">
          <p>
            Tracked events: {data.usageAvailability.trackedEvents}
            {" | "}
            Usage unavailable: {data.usageAvailability.unknownEvents}
            {" | "}
            Total agent events: {data.usageAvailability.totalAgentEvents}
          </p>
          {data.usageAvailability.unknownEvents > 0 ? (
            <p className="office-subtitle">
              Some assistant responses did not include provider usage, so totals are partial for those events.
            </p>
          ) : showsMissingRecordedSpend ? (
            <p className="office-subtitle">
              Token usage is available, but USD spend was not recorded for these runs.
            </p>
          ) : (
            <p className="office-subtitle">All recent assistant events reported usage successfully.</p>
          )}
        </Panel>
      ) : null}

      <Panel title="Cost Rows" subtitle="Grouped usage totals for the selected scope.">
        <table className="gc-data-table">
          <thead>
            <tr>
              <th>Scope Key</th>
              <th>Token Input</th>
              <th>Token Output</th>
              <th>Total Tokens</th>
              <th>Recorded Cost (USD)</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.key}>
                <td>{item.key}</td>
                <td>{item.tokenInput}</td>
                <td>{item.tokenOutput}</td>
                <td>{item.tokenTotal}</td>
                <td>{formatRecordedCost(item.costUsd, item.tokenTotal, showsMissingRecordedSpend)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </section>
  );
}

function describeQmdImpact(stats: {
  efficiencyLabel: "reduced" | "expanded" | "neutral";
  compressionPercent: number;
  expansionPercent: number;
}): string {
  if (stats.efficiencyLabel === "reduced") {
    return `Context reduced by ${stats.compressionPercent.toFixed(1)}%.`;
  }
  if (stats.efficiencyLabel === "expanded") {
    return `Context grew by ${stats.expansionPercent.toFixed(1)}%.`;
  }
  return "Context size stayed stable.";
}

function formatTokenDelta(delta: number): string {
  if (delta > 0) {
    return `+${Math.round(delta)} tokens`;
  }
  if (delta < 0) {
    return `${Math.round(delta)} tokens`;
  }
  return "no token change";
}

function formatUsd(amount: number, fractionDigits = 2): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

function formatRecordedCost(costUsd: number, tokenTotal: number, showsMissingRecordedSpend: boolean): string {
  if (costUsd > 0) {
    return formatUsd(costUsd, 4);
  }
  if (showsMissingRecordedSpend && tokenTotal > 0) {
    return "Not recorded";
  }
  return formatUsd(costUsd, 4);
}


