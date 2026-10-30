import { useCallback, useEffect, useState } from "react";
import type { ReviewReadinessSummary } from "@goatcitadel/contracts";
import {
  fetchReviewReadiness,
  refreshRuntimeReleaseTrust,
} from "@goatcitadel/mission-control-shared/api/review-readiness";
import { type AppRoute } from "@next/app/route-model";
import { useIsMounted } from "@next/hooks/use-is-mounted";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";

export function useRuntimeReviewReadiness(section: NonNullable<AppRoute["section"]>, supportPanel: string | null) {
  const [reviewReadiness, setReviewReadiness] = useState<ReviewReadinessSummary | null>(null);
  const [reviewReadinessLoading, setReviewReadinessLoading] = useState(false);
  const [reviewReadinessError, setReviewReadinessError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const loadReviewReadiness = useCallback(
    async (forceRuntimeReleaseRefresh = false) => {
      setReviewReadinessLoading(true);
      try {
        const summary = forceRuntimeReleaseRefresh ? await refreshRuntimeReleaseTrust() : await fetchReviewReadiness();
        if (!isMounted()) {
          return;
        }
        setReviewReadiness(summary);
        setReviewReadinessError(null);
      } catch (error) {
        if (isMounted()) {
          setReviewReadinessError(describeApiError(error, "Could not load review readiness.").summary);
        }
      } finally {
        if (isMounted()) {
          setReviewReadinessLoading(false);
        }
      }
    },
    [isMounted],
  );

  const refreshReleaseProof = useCallback(async () => {
    await loadReviewReadiness(true);
  }, [loadReviewReadiness]);

  useEffect(() => {
    if (section === "diagnostics" && (supportPanel === "release" || supportPanel === "readiness")) {
      void loadReviewReadiness();
    }
  }, [loadReviewReadiness, section, supportPanel]);

  return { reviewReadiness, reviewReadinessLoading, reviewReadinessError, loadReviewReadiness, refreshReleaseProof };
}
