import { useState } from "react";
import type { OnboardingState } from "@goatcitadel/contracts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { Button } from "../../ui/Button";
import { McpDraftLeave } from "./McpDraftLeave";
import { ProviderManagementSettings } from "./ProviderManagementSettings";
import { ProviderRoutingSettings } from "./ProviderRoutingSettings";
import { LlamaSetupSettings } from "./LlamaSetupSettings";

export function FirstRunModelStep({ state, workspaceId }: { state: OnboardingState; workspaceId?: string }) {
  const [choice, setChoice] = useState<"provider" | "llama" | null>(null);
  const leave = useDraftLeave();
  const label =
    state.settings.llm.providers.find((item) => item.providerId === state.settings.llm.activeProviderId)?.label ??
    state.settings.llm.activeProviderId;
  return (
    <div className="space-y-4">
      <h2 className="font-display text-lg font-semibold text-fg">Choose a model</h2>
      <p className="break-words text-sm text-fg-secondary">
        Current default:{" "}
        {label && state.settings.llm.activeModel
          ? `${label} · ${state.settings.llm.activeModel}`
          : "No model confirmed"}
        .
      </p>
      <p className="text-sm text-fg-secondary">
        Gateway connection:{" "}
        {state.setupReadiness?.items.find((item) => item.id === "provider")?.detail ??
          "Not reported. Refresh after connecting a provider."}
      </p>
      <p className="text-sm text-fg-secondary">
        Keep an existing ready model, or choose a setup path. Credentials, model defaults, and local runtime changes
        keep their own review and approval steps.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button aria-pressed={choice === "provider"} onClick={() => leave.request(() => setChoice("provider"))}>
          Connect a provider
        </Button>
        <Button aria-pressed={choice === "llama"} onClick={() => leave.request(() => setChoice("llama"))}>
          Configure llama.cpp
        </Button>
        {choice ? <Button onClick={() => leave.request(() => setChoice(null))}>Close model controls</Button> : null}
      </div>
      {choice === "provider" ? (
        <>
          <ProviderManagementSettings />
          <ProviderRoutingSettings />
        </>
      ) : null}
      {choice === "llama" ? <LlamaSetupSettings workspaceId={workspaceId} /> : null}
      <p className="text-xs text-fg-muted">
        After saving or finishing an approved change, use Refresh checks below. A model catalog or connection check is
        not a completed Chat response.
      </p>
      <McpDraftLeave {...leave.dialogProps} />
    </div>
  );
}
