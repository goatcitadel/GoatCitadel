import { useQuery } from "@tanstack/react-query";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";
import { ProviderCatalogSettings } from "./ProviderCatalogSettings";
import { ProviderConnectionSettings } from "./ProviderConnectionSettings";
import { ProviderManagementSettings } from "./ProviderManagementSettings";
import { ProviderRoutingSettings } from "./ProviderRoutingSettings";
import { ProviderAdviceSettings } from "./ProviderAdviceSettings";

/** The Models settings section: the provider owners plus the shared guided model setup. */
export function ModelsSettings() {
  const { navigate } = useCockpitRoute();
  const onboarding = useQuery({
    queryKey: ["system", "onboarding"],
    queryFn: fetchOnboardingState,
    refetchOnWindowFocus: true,
  });
  return (
    <>
      <ProviderCatalogSettings />
      <ProviderConnectionSettings />
      <ProviderManagementSettings />
      <ProviderRoutingSettings />
      <ProviderAdviceSettings />
      <section aria-label="Model setup" className="mt-4 border-t border-line-subtle pt-4">
        <h3 className="font-display text-md font-semibold text-fg">Guided model setup</h3>
        <p className="mt-1 text-sm text-fg-secondary">
          Review the Gateway default, connection evidence, and model choices before using Chat.
        </p>
        {onboarding.isLoading ? (
          <p role="status" className="mt-3 text-sm text-fg-muted">
            Checking model setup…
          </p>
        ) : null}
        {onboarding.isError ? (
          <p role="alert" className="mt-3 text-sm text-status-failed">
            Model setup unavailable: {describeApiError(onboarding.error).summary}
          </p>
        ) : null}
        {onboarding.isError ? (
          <Button size="sm" onClick={() => void onboarding.refetch()}>
            Try again
          </Button>
        ) : null}
        {!onboarding.isError && onboarding.data ? (
          <CockpitGuidedModelSetup
            onboarding={onboarding.data}
            reloadOnboarding={async () => {
              await onboarding.refetch();
            }}
            onEnterChat={() => navigate("/chat")}
          />
        ) : null}
      </section>
    </>
  );
}
