import { useCallback, useEffect, useState } from "react";
import type { AppRoute } from "@next/app/route-model";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { fetchCuratorReviewItems, type CuratorReviewItem } from "@goatcitadel/mission-control-shared/api/improvement";
import { NativeCard } from "../NativeRoutePageLayout";
import { EmptyState, NativeButton, NoticeBanner, StatusChip } from "../primitives";
import type { NativeRoutePagesProps } from "../types";

export function ImprovementInboxPanel({
  workspaceId,
  routeTheme,
  navigate,
}: {
  workspaceId: string;
  routeTheme?: AppRoute["theme"];
  navigate: NativeRoutePagesProps["navigate"];
}) {
  const [items, setItems] = useState<CuratorReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchCuratorReviewItems({ limit: 40, workspaceId });
      if (isMounted()) setItems(response.items);
    } catch (loadError) {
      if (isMounted()) {
        setError(loadError instanceof Error ? loadError.message : "Could not load the improvement inbox.");
      }
    } finally {
      if (isMounted()) setLoading(false);
    }
  }, [isMounted, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const suggestions = items.filter((item) => !item.mutationApplied && item.candidate.status !== "rejected");
  return (
    <NativeCard
      title="Improvement inbox"
      subtitle="Deduplicated local observations and evaluated suggestions. Opening Chat does not apply them."
      stats={[
        { label: "Suggestions", value: loading ? "…" : String(suggestions.length) },
        {
          label: "Ready",
          value: loading ? "…" : String(suggestions.filter((item) => item.actionStatuses.activate === "ready").length),
        },
      ]}
      actions={
        <NativeButton variant="default" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh inbox"}
        </NativeButton>
      }
    >
      {error ? <NoticeBanner tone="error" message={error} /> : null}
      {suggestions.length === 0 && !loading && !error ? (
        <EmptyState
          title="No improvement suggestions"
          description="Cheap local observation can collect signals without interrupting Chat."
        />
      ) : null}
      {suggestions.length > 0 ? (
        <div className="mc-next-stack mc-next-stack--compact" aria-label="Improvement suggestions">
          {suggestions.map((item) => {
            const ready = item.actionStatuses.activate === "ready";
            return (
              <div className="mc-next-inline-card" key={item.candidate.candidateId}>
                <div className="mc-next-inline-card__body">
                  <div className="mc-next-inline-card__title-row">
                    <strong>{item.candidate.summary}</strong>
                    <StatusChip tone={ready ? "success" : item.risk === "high" ? "critical" : "warning"}>
                      {ready ? "ready for plan" : item.candidate.status.replaceAll("_", " ")}
                    </StatusChip>
                  </div>
                  <p>{item.proposedChange ?? item.observedIssue ?? "Review the linked evidence before deciding."}</p>
                  <small>
                    Candidate {item.candidate.candidateId} · {item.candidate.supportingSignalCount} supporting signal
                    {item.candidate.supportingSignalCount === 1 ? "" : "s"} · risk {item.risk}
                  </small>
                </div>
                <NativeButton
                  variant={ready ? "default" : "outline"}
                  onClick={() => navigate({ area: "chat", theme: routeTheme })}
                >
                  Review in Chat
                </NativeButton>
              </div>
            );
          })}
        </div>
      ) : null}
      <p className="mc-next-help-text">
        In Chat, ask to apply an improvement and include its candidate ID. GoatCitadel will create the inspectable
        Change Plan there; this inbox never activates a candidate directly.
      </p>
    </NativeCard>
  );
}
