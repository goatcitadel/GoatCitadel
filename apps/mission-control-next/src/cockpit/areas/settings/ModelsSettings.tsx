import { useState } from "react";
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
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { McpDraftLeave } from "./McpDraftLeave";
import { getDirtySectionKeys } from "../../../features/native-routes/library/use-form-dirty";
import { sessionDraftSectionKey } from "../../../features/native-routes/library/session-drafts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

/** The Models settings section: the provider owners plus the shared guided model setup. */
export function ModelsSettings() {
  const { navigate } = useCockpitRoute();
  // Kept here, outside the guided card: a failed re-read after a change unmounts the card, and the
  // change's result must stay on screen next to the error.
  const [notice, setNotice] = useState<string | null>(null);
  const { mode } = useUiPreferences();
  const [expertOpen, setExpertOpen] = useState(mode === "advanced");
  const leave = useDraftLeave();
  const onboarding = useQuery({
    queryKey: ["system", "onboarding"],
    queryFn: fetchOnboardingState,
    refetchOnWindowFocus: true,
  });
  return (
    <>
      <section aria-label="Model setup" className="mt-4">
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
            onNoticeChange={setNotice}
          />
        ) : null}
        {notice ? (
          <p role="status" className="mt-3 text-sm text-fg-secondary">
            {notice}
          </p>
        ) : null}
      </section>
      <section aria-label="Advanced providers" className="mt-4 border-t border-line-subtle pt-4">
        <Button aria-expanded={expertOpen} aria-controls="expert-provider-controls"
          onClick={() => expertOpen
            ? leave.request(() => setExpertOpen(false), getDirtySectionKeys().filter((key) => /^(provider|provider-secret|provider-endpoint):system:/.test(sessionDraftSectionKey(key)) || sessionDraftSectionKey(key) === "provider-routing:system"))
            : setExpertOpen(true)}>
          Advanced provider configuration
        </Button>
        <p className="mt-2 text-xs text-fg-muted">Inspect catalogs, edit profiles, test connections, and review routing advice.</p>
        {expertOpen ? <div id="expert-provider-controls" className="mt-4 grid gap-4">
          <ProviderCatalogSettings />
          <ProviderConnectionSettings />
          <ProviderManagementSettings />
          <ProviderRoutingSettings />
          <ProviderAdviceSettings />
        </div> : null}
      </section>
      <McpDraftLeave {...leave.dialogProps} />
    </>
  );
}
