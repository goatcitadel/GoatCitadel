import { useState } from "react";
import type { OnboardingState } from "@goatcitadel/contracts";
import { useDraftLeave } from "../../../features/native-routes/library/DraftLeaveDialog";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { CockpitGuidedModelSetup } from "./CockpitGuidedModelSetup";
import { FirstRunDemo } from "./FirstRunDemo";
import { McpDraftLeave } from "./McpDraftLeave";
import { LLAMA_SETUP_HREF, SettingsOwnerPointer } from "./SettingsOwnerPointer";
import { firstRunModelSummary } from "./first-run-summaries";

type ModelChoice = "provider" | "demo";
const CHOICES: readonly { id: ModelChoice; label: string }[] = [
  { id: "provider", label: "Use a cloud provider" },
  { id: "demo", label: "Try the demo" },
];

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
  const [choice, setChoice] = useState<ModelChoice | null>(null);
  const leave = useDraftLeave();
  const providerReady = state.setupReadiness?.items.find((item) => item.id === "provider")?.status === "ready";
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold text-fg">Choose a model</h2>
      <p className="break-words text-sm text-fg-secondary">
        Default model: {firstRunModelSummary(state)}.{" "}
        {providerReady
          ? "Configured for a first send. Send a Chat message after setup to check the first answer."
          : "Setup needed. Connect a provider, or try the demo's sample records first."}
      </p>
      <div role="group" aria-label="How to start" className="flex flex-wrap gap-2">
        {CHOICES.map((item) => (
          <Button
            key={item.id}
            aria-pressed={choice === item.id}
            onClick={() => leave.request(() => setChoice(choice === item.id ? null : item.id))}
          >
            {item.label}
          </Button>
        ))}
      </div>
      {choice === "provider" ? (
        <>
          <CockpitGuidedModelSetup
            onboarding={state}
            reloadOnboarding={onReload}
            onEnterChat={onModelReady}
            enterChatLabel="Continue to safety"
            showSteps={false}
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
      {choice === "demo" ? <FirstRunDemo workspaceId={workspaceId ?? "default"} /> : null}
      <SettingsOwnerPointer
        text="To run a local model instead, llama.cpp setup is on"
        label="Models › Local AI"
        href={LLAMA_SETUP_HREF}
      />
      {choice !== "provider" ? (
        <div className="space-y-2">
          <Button
            variant={choice ? "secondary" : "primary"}
            aria-describedby="first-run-model-prerequisite"
            disabled={!canContinue}
            onClick={() => leave.request(onContinue)}
          >
            Continue to safety
          </Button>
          <p id="first-run-model-prerequisite" className="text-xs text-fg-muted">
            {canContinue
              ? "Continue rechecks the ready default model before reviewing safety."
              : "Connect and confirm a ready default model, then use Refresh checks below."}
          </p>
        </div>
      ) : null}
      <McpDraftLeave {...leave.dialogProps} />
    </div>
  );
}
