import { GCModal } from "@goatcitadel/mission-control-shared/components/ui/GCModal";
import { useDemoBootstrap } from "../use-demo-bootstrap";
import { DEMO_BOOTSTRAP_CONSEQUENCE } from "../demo-bootstrap-binding";
import { NativeCard } from "../../NativeRoutePageLayout";
import { NativeButton } from "../../primitives";
import { SettingsActionList, SettingsButtonRow, SettingsNotice, type SettingsSectionProps } from "../SettingsShared";
import { useDraftLeave } from "../../library/DraftLeaveDialog";

export function OnboardingDemoPanel({
  route,
  navigate,
  activeWorkspaceId,
  setActiveWorkspaceId,
  setActiveCitadelId,
}: SettingsSectionProps) {
  const control = useDemoBootstrap(activeWorkspaceId),
    leave = useDraftLeave();
  return (
    <NativeCard id="onboarding-start" title="Try a safe demo" subtitle={DEMO_BOOTSTRAP_CONSEQUENCE}>
      {control.message || control.attempt ? (
        <SettingsNotice notice={{ tone: "warning", message: control.attempt?.message ?? control.message! }} />
      ) : null}
      <p>
        Sample records: {control.state?.status?.replaceAll("_", " ") ?? "Not checked"}. This is not completed execution
        or approval evidence.
      </p>
      {control.receipt ? (
        <>
          <p>Last acknowledged preparation: {control.receipt.status}.</p>
          <ul>
            {control.receipt.notes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </>
      ) : null}
      <SettingsActionList
        ariaLabel="Starter prompt samples"
        items={(control.state?.starterPrompts ?? [])
          .slice(0, 3)
          .map((prompt) => ({
            id: prompt.title,
            label: prompt.title,
            description: prompt.prompt,
            meta: prompt.surface,
          }))}
      />
      <SettingsButtonRow>
        <NativeButton disabled={control.locked || control.loading || !control.state} onClick={control.begin}>
          Review demo preparation
        </NativeButton>
        <NativeButton
          disabled={control.loading || control.attempt?.phase === "pending"}
          onClick={() => void control.refresh()}
        >
          Refresh demo state
        </NativeButton>
        <NativeButton
          disabled={
            control.loading ||
            control.attempt?.phase === "pending" ||
            !control.state?.sessions?.length ||
            !setActiveCitadelId
          }
          onClick={() =>
            leave.request(
              () =>
                void control.open((destination) => {
                  setActiveCitadelId?.(destination.citadelId);
                  setActiveWorkspaceId(destination.workspaceId);
                  navigate({
                    area: "chat",
                    sessionId: destination.sessionId,
                    projectId: destination.projectId,
                    theme: route.theme,
                  });
                }),
            )
          }
        >
          Open recorded demo
        </NativeButton>
      </SettingsButtonRow>
      <GCModal
        open={Boolean(control.review)}
        title="Prepare local demo"
        description={DEMO_BOOTSTRAP_CONSEQUENCE}
        onOpenChange={(open) => {
          if (!open) control.cancel();
        }}
        confirmLabel="Confirm demo preparation"
        confirmDisabled={control.locked}
        onConfirm={control.confirm}
      >
        <p>
          Workspace: {control.review?.state.workspace?.name ?? "The Gateway selects or creates GoatCitadel Demo"}. This
          operation has no expected revision.
        </p>
      </GCModal>
      {leave.dialog}
    </NativeCard>
  );
}
