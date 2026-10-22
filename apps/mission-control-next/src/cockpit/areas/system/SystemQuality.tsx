import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { fetchOpsQualitySnapshot } from "@goatcitadel/mission-control-shared/api/ops-quality";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/Tabs";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { QualityGates } from "./quality/QualityGates";
import { QualityEvaluations } from "./quality/QualityEvaluations";
import { QualityDesign } from "./quality/QualityDesign";
import { QualityExports } from "./quality/QualityExports";
import { QualityGlobalWarnings, QualityWarnings, qualityTimestamp } from "./quality/QualityEvidence";

const VIEWS = [
  { id: "gates", label: "Gates" },
  { id: "evaluations", label: "Evaluations" },
  { id: "design", label: "Design" },
] as const;
type QualityView = (typeof VIEWS)[number]["id"];

export function SystemQuality() {
  const [view, setView] = useState<QualityView>("gates");
  const proof = useQuery({
    queryKey: [...queryKeys.systemQuality(), "snapshot", 200, 25],
    queryFn: () => fetchOpsQualitySnapshot({ packLimit: 200, evalLimit: 25 }),
    refetchInterval: 60_000,
  });
  const snapshot = proof.isError ? undefined : proof.data;
  return (
    <section className={AREA_PAGE}>
      <AreaHeader
        title="Quality"
        description="Stored quality results for this installation. Refresh and exports do not run evaluations."
        actions={
          <Button size="sm" disabled={proof.isFetching} onClick={() => void proof.refetch()}>
            <RefreshCw aria-hidden="true" className="size-4" /> Refresh
          </Button>
        }
      />
      {proof.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading quality proof…
        </p>
      ) : null}
      {proof.isError ? (
        <EmptyState
          title="Quality proof unavailable"
          description={describeApiError(proof.error).summary}
          action={<Button onClick={() => void proof.refetch()}>Try again</Button>}
        />
      ) : null}
      {snapshot ? (
        <>
          <div className="space-y-1 text-sm text-fg-secondary">
            <p>Results checked {qualityTimestamp(snapshot.generatedAt)}.</p>
            <p>{snapshot.metricScope.note}</p>
            <QualityWarnings items={snapshot.warnings.filter((item) => item !== snapshot.metricScope.note)} />
          </div>
          <Tabs value={view} onValueChange={(value) => setView(value as QualityView)}>
            <TabsList aria-label="Quality results">
              {VIEWS.map((item) => (
                <TabsTrigger key={item.id} value={item.id} className="min-h-11 flex-1 font-medium hover:text-fg">
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <QualityGlobalWarnings.Provider value={[...snapshot.warnings, snapshot.metricScope.note]}>
              <TabsContent value="gates" className="pt-3">
                <QualityGates snapshot={snapshot} reload={() => proof.refetch()} />
              </TabsContent>
              <TabsContent value="evaluations" className="pt-3">
                <QualityEvaluations source={snapshot.evalProof} />
              </TabsContent>
              <TabsContent value="design" className="pt-3">
                <QualityDesign source={snapshot.designQuality} />
              </TabsContent>
            </QualityGlobalWarnings.Provider>
          </Tabs>
          {snapshot.nextChecks.length ? (
            <details className="border-t border-line-subtle pt-4">
              <summary className="cursor-pointer text-sm font-semibold text-fg">Recorded next checks</summary>
              <ul className="mt-3 space-y-2">
                {snapshot.nextChecks.map((check, index) => (
                  <li key={`${index}:${check.label}`}>
                    <h2 className="text-sm font-medium text-fg">{check.label}</h2>
                    <p className="text-sm text-fg-secondary">{check.reason}</p>
                    <code className="break-words text-xs text-fg-muted">{check.command}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-fg-muted">
                Commands are recorded guidance. This page does not execute them.
              </p>
            </details>
          ) : null}
        </>
      ) : null}
      <QualityExports />
    </section>
  );
}
