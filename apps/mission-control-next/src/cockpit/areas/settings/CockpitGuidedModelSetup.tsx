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
  enterChatLabel,
  onNoticeChange,
}: {
  onboarding: OnboardingState;
  reloadOnboarding: () => Promise<void>;
  onEnterChat: () => void;
  /** Overrides the guided owner's "Enter Chat" button text when the host's next step is not Chat. */
  enterChatLabel?: string;
  /**
   * Given by a host that keeps and shows the notice itself, so it outlives this card: Models settings
   * unmounts the card when the re-read after a change fails. Without it the card shows its own (first run).
   */
  onNoticeChange?: (notice: string | null) => void;
}) {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const [ownNotice, setOwnNotice] = useState<string | null>(null);
  const setNotice = onNoticeChange ?? setOwnNotice;
  const notice = onNoticeChange ? null : ownNotice;
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
          enterChatLabel={enterChatLabel}
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
