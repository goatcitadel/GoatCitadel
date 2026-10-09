import { useState } from "react";
import type { OnboardingState } from "@goatcitadel/contracts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";
import { McpDraftLeave } from "./McpDraftLeave";
import { LlamaSetupSettings } from "./LlamaSetupSettings";

export function FirstRunModelStep({
  state,
  workspaceId,
  onReload,
  onModelReady,
  canContinue,
  onContinue,
}: {
  state: OnboardingState;
  workspaceId?: string;
  onReload: () => Promise<void>;
  onModelReady: () => void;
  canContinue: boolean;
  onContinue: () => void;
}) {
  const { navigate } = useCockpitRoute();
  const [choice, setChoice] = useState<"provider" | "llama" | null>(null);
  const leave = useDraftLeave();
  const label =
    state.settings.llm.providers.find((item) => item.providerId === state.settings.llm.activeProviderId)?.label ??
    state.settings.llm.activeProviderId;
  const providerReady = state.setupReadiness?.items.find((item) => item.id === "provider")?.status === "ready";
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
        Provider and model:{" "}
        {providerReady ? "Configured for a first send. Send a Chat message after setup to check the first answer."
          : "Setup needed. Connect a provider and refresh checks before continuing."}
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
      {!choice ? <div className="space-y-2">
        <Button variant="primary" aria-describedby="first-run-model-prerequisite" disabled={!canContinue}
          onClick={() => leave.request(onContinue)}>Continue to safety</Button>
        <p id="first-run-model-prerequisite" className="text-xs text-fg-muted">
          {canContinue ? "Continue rechecks the ready default model before reviewing safety."
            : "Connect and confirm a ready default model, then wait for current checks and pending changes to settle."}
        </p>
      </div> : null}
      {choice === "provider" ? (
        <>
          <CockpitGuidedModelSetup
            onboarding={state}
            reloadOnboarding={onReload}
            onEnterChat={onModelReady}
            enterChatLabel="Continue to safety"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => leave.request(() => navigate("/settings/models?shell=cockpit#providers"))}
          >
            Advanced: edit provider profiles
          </Button>
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
