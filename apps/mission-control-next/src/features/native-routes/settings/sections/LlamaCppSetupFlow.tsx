import type { AppRoute } from "@next/app/route-model";
import { NativeCard } from "../../NativeRoutePageLayout";
import type { SettingsSectionProps } from "../SettingsShared";
import { LlamaSetupControls } from "../LlamaSetupControls";

export function LlamaCppSetupFlow({
  workspaceId,
  route,
  navigate,
}: {
  workspaceId: string;
  route: AppRoute;
  navigate: SettingsSectionProps["navigate"];
}) {
  return (
    <NativeCard
      id="llamacpp-setup"
      density="compact"
      className="mc-next-settings-panel"
      title="Set up llama.cpp"
      subtitle="Choose who runs the server, review its setup, and separately test a real Chat response."
    >
      <LlamaSetupControls
        workspaceId={workspaceId}
        onApproval={(approvalId) => navigate({ area: "ops", section: "approvals", approvalId, theme: route.theme })}
      />
    </NativeCard>
  );
}
