import { useEffect, useRef, useState } from "react";
import { evaluateUiChangeRisk, type IntegrationCatalogEntry, type IntegrationConnection } from "../../api/client";
import {
  deriveOverallRisk,
  evaluateLocalRisk,
  mergeRiskItems,
  type UiRiskItem,
  type UiRiskLevel,
} from "../integrations-page-utils";
import { isAbortError, type IntegrationKind } from "./integrations-page-constants";

type UseIntegrationsRiskReviewArgs = {
  kindFilter: IntegrationKind;
  selectedCatalog?: IntegrationCatalogEntry;
  selectedCatalogId: string;
  status: IntegrationConnection["status"];
  enabled: boolean;
  effectiveConfig: Record<string, unknown>;
};

export function useIntegrationsRiskReview({
  kindFilter,
  selectedCatalog,
  selectedCatalogId,
  status,
  enabled,
  effectiveConfig,
}: UseIntegrationsRiskReviewArgs): { overall: UiRiskLevel; items: UiRiskItem[] } {
  const [changeReview, setChangeReview] = useState<{ overall: UiRiskLevel; items: UiRiskItem[] }>({
    overall: "safe",
    items: [],
  });
  const riskDebounceRef = useRef<number | null>(null);
  const riskAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const serializedConfig = JSON.stringify(effectiveConfig);
    const localReview = evaluateLocalRisk({
      selectedCatalog,
      selectedCatalogId,
      configJson: serializedConfig,
      status,
      enabled,
    });
    if (riskDebounceRef.current) {
      window.clearTimeout(riskDebounceRef.current);
      riskDebounceRef.current = null;
    }
    riskDebounceRef.current = window.setTimeout(() => {
      riskAbortRef.current?.abort();
      const controller = new AbortController();
      riskAbortRef.current = controller;
      void evaluateUiChangeRisk(
        {
          pageId: "integrations",
          changes: [
            { field: "integration.kindFilter", from: "all", to: kindFilter },
            { field: "integration.catalogId", from: "", to: selectedCatalogId },
            { field: "integration.status", from: "connected", to: status },
            { field: "integration.enabled", from: true, to: enabled },
            { field: "integration.configJson", from: "{}", to: serializedConfig },
          ],
        },
        { signal: controller.signal },
      )
        .then((remoteReview) => {
          const merged = mergeRiskItems(
            localReview.items,
            remoteReview.items.map((item) => ({
              field: item.field,
              level: item.level,
              hint: item.hint,
            })),
          );
          setChangeReview({
            overall: deriveOverallRisk(merged),
            items: merged,
          });
        })
        .catch((err: unknown) => {
          if (isAbortError(err)) {
            return;
          }
          setChangeReview({
            overall: deriveOverallRisk(localReview.items),
            items: localReview.items,
          });
        });
    }, 400);
    return () => {
      if (riskDebounceRef.current) {
        window.clearTimeout(riskDebounceRef.current);
        riskDebounceRef.current = null;
      }
      riskAbortRef.current?.abort();
    };
  }, [effectiveConfig, enabled, kindFilter, selectedCatalog, selectedCatalogId, status]);

  return changeReview;
}
