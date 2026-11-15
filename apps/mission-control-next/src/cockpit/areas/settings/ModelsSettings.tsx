import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOnboardingState } from "@goatcitadel/mission-control-shared/api/client";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { projectFirstRunState } from "./first-run-state";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";
import { ProviderCatalogSettings } from "./ProviderCatalogSettings";
import { ProviderManagementSettings } from "./ProviderManagementSettings";
import { ProviderRoutingSettings } from "./ProviderRoutingSettings";
import { ProviderAdviceSettings } from "./ProviderAdviceSettings";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { McpDraftLeave } from "./McpDraftLeave";
import { getDirtySectionKeys } from "../../../features/native-routes/library/use-form-dirty";
import { sessionDraftSectionKey } from "../../../features/native-routes/library/session-drafts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { OnboardingState } from "@goatcitadel/contracts";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** One line on Get started's progress, so this page never keeps a second, disagreeing setup. */
function SetupStatusLine({ onboarding }: { onboarding: OnboardingState }) {
  if (!onboarding.completed)
    return (
      <p className="mt-3 flex flex-wrap items-center gap-x-3 text-sm text-fg-secondary">
        <span>
          Setup isn&apos;t finished. After you confirm a model here, Get started asks for your safety settings and a
          test message.
        </span>
        <NativeOwnerLink
          href="/settings/first-run"
          scope="models-setup"
          className="text-sm font-medium text-accent hover:underline"
        >
          Open setup
        </NativeOwnerLink>
      </p>
    );
  return (
    <p className="mt-3 text-sm text-fg-secondary">
      {projectFirstRunState(onboarding).firstResponseVerified
        ? "Setup is done and your first Chat answer is verified."
        : "Setup is recorded. Send a test message in Chat to verify the first answer."}
    </p>
  );
}

/** The Models settings section: the provider owners plus the shared guided model setup. */
export function ModelsSettings() {
  const { navigate } = useCockpitRoute();
  // Kept here, outside the guided card: a failed re-read after a change unmounts the card, and the
  // change's result must stay on screen next to the error.
  const [notice, setNotice] = useState<string | null>(null);
  const [codexOAuthStatus, setCodexOAuthStatus] = useState<StatusPresentation>();
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
      <section aria-label="Chat model" className="mt-4">
        <h3 className="text-md font-semibold text-fg">Chat model</h3>
        <p className="mt-1 text-sm text-fg-secondary">The model new Chats use. Get started uses this same choice.</p>
        {!onboarding.isError && onboarding.data ? <SetupStatusLine onboarding={onboarding.data} /> : null}
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
            enterChatLabel={onboarding.data.completed ? undefined : "Continue setup"}
            onEnterChat={() => navigate(onboarding.data.completed ? "/chat" : "/settings/first-run")}
            showReadinessNote
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
        <Button
          aria-expanded={expertOpen}
          aria-controls="expert-provider-controls"
          onClick={() =>
            expertOpen
              ? leave.request(
                  () => {
                    setExpertOpen(false);
                    setCodexOAuthStatus(undefined);
                  },
                  getDirtySectionKeys().filter(
                    (key) =>
                      /^(provider|provider-secret|provider-endpoint):system:/.test(sessionDraftSectionKey(key)) ||
                      sessionDraftSectionKey(key) === "provider-routing:system",
                  ),
                )
              : setExpertOpen(true)
          }
        >
          Advanced provider configuration
        </Button>
        <p className="mt-2 text-xs text-fg-muted">
          Edit each provider in one place, then inspect catalogs, routing, and advice.
        </p>
        {expertOpen ? (
          <div id="expert-provider-controls" className="mt-4 grid gap-4">
            <ProviderManagementSettings onCodexOAuthStatusChange={setCodexOAuthStatus} />
            <ProviderCatalogSettings codexOAuthStatus={codexOAuthStatus} />
            <ProviderRoutingSettings />
            <ProviderAdviceSettings />
          </div>
        ) : null}
      </section>
      <McpDraftLeave {...leave.dialogProps} />
    </>
  );
}
