import { LlamaSetupControls } from "../../../features/native-routes/settings/LlamaSetupControls";
import { SettingsApprovalOwnerAction } from "./SettingsApprovalOwnerAction";
import { Button } from "../../ui/Button";

export function LlamaSetupSettings({ workspaceId }: { workspaceId?: string }) {
  return (
    <section
      id="llamacpp-setup"
      aria-labelledby="llamacpp-setup-title"
      className="mt-4 space-y-3 rounded-lg border border-line bg-sunken p-4"
    >
      <h3 id="llamacpp-setup-title" className="font-display text-base font-semibold text-fg">
        Set up llama.cpp
      </h3>
      {workspaceId ? (
        <LlamaSetupControls
          cockpit
          buttonComponent={Button}
          workspaceId={workspaceId}
          renderApprovalAction={(plan, pending) => <SettingsApprovalOwnerAction
            plan={plan} owner="llama-setup" workspaceId={workspaceId} disabled={pending} label="Open approval details"
          />}
        />
      ) : (
        <p role="status">Select a workspace to record a setup plan and review its approval.</p>
      )}
    </section>
  );
}
