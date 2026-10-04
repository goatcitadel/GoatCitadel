import { useState } from "react";
import type { OnboardingState } from "@goatcitadel/contracts";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { GuidedModelSetup } from "../../../features/native-routes/settings/sections/GuidedModelSetup";
import { buildAppHref } from "../../../app/route-model";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";

/** The guided chat-model owner, shared by Models settings and first run. It includes the API-key path. */
export function CockpitGuidedModelSetup({
  onboarding,
  reloadOnboarding,
  onEnterChat,
}: {
  onboarding: OnboardingState;
  reloadOnboarding: () => Promise<void>;
  onEnterChat: () => void;
}) {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <div className="cockpit-model-setup mt-4">
        <GuidedModelSetup
          workspaceId={workspaceId}
          onboarding={onboarding}
          route={{ area: "settings", section: "onboarding" }}
          navigate={(route) => navigate(buildAppHref(route))}
          renderApprovalAction={(plan, pending, selection) => (
            <SettingsApprovalOwnerAction
              plan={plan}
              owner="guided-model"
              workspaceId={workspaceId}
              disabled={pending}
              viewIdentity={selection}
            />
          )}
          reloadOnboarding={reloadOnboarding}
          setNotice={(next) => setNotice(next?.message ?? null)}
          onEnterChat={onEnterChat}
        />
      </div>
      {notice ? (
        <p role="status" className="mt-3 text-sm text-fg-secondary">
          {notice}
        </p>
      ) : null}
    </>
  );
}
