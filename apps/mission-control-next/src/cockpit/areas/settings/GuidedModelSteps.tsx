import { ArrowRight, Circle } from "lucide-react";
import type { SetupStepState } from "@goatcitadel/mission-control-shared/content/setup-progress";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";
import type { GuidedModelSetupControl } from "./use-guided-model-setup";

export type SetupStepPhase = "done" | "current" | "not_started";

const PHASE_STATUS: Readonly<Record<SetupStepPhase, StatusPresentation>> = {
  done: { label: "Done", tone: "done" },
  current: { label: "Current", tone: "neutral" },
  not_started: { label: "Not started", tone: "neutral" },
};

/** A setup step's state in words, with an icon, so it never relies on colour or a border alone. */
export function SetupStepBadge({ phase }: { phase: SetupStepPhase }) {
  return (
    <StatusBadge
      status={PHASE_STATUS[phase]}
      icon={phase === "current" ? ArrowRight : phase === "not_started" ? Circle : undefined}
    />
  );
}

const PHASE_FOR_STATE: Readonly<Record<SetupStepState, SetupStepPhase>> = {
  complete: "done",
  active: "current",
  pending: "not_started",
};

/** The guided model setup's three steps, each numbered and labelled with its state. */
export function GuidedModelSteps({ setup }: { setup: GuidedModelSetupControl }) {
  const { progress, readiness, defaultPlanCompleted } = setup;
  const steps = [
    { label: "Connect a provider", description: readiness.description },
    {
      label: "Confirm your model",
      description: defaultPlanCompleted
        ? "Your default is saved. A real Chat response verifies that the model works."
        : "This default applies only to Chats created after confirmation.",
    },
    {
      label: "Start the first Chat",
      description: progress.needsRecheck
        ? "Your first response was verified earlier. Check the connection to continue."
        : progress.steps[2] === "complete"
          ? "A completed model response is recorded in Chat."
          : "Ask your own question or choose a starter prompt in Chat.",
    },
  ];
  return (
    <ol aria-label="Model setup steps" className="grid gap-2 sm:grid-cols-3">
      {steps.map((step, index) => {
        const phase = PHASE_FOR_STATE[progress.steps[index]!];
        return (
          <li
            key={step.label}
            aria-current={phase === "current" ? "step" : undefined}
            className="grid content-start gap-1 rounded-md border border-line p-3 aria-[current=step]:border-accent"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-xs text-fg-muted">Step {index + 1}</span>
              <SetupStepBadge phase={phase} />
            </span>
            <span className="text-sm font-semibold text-fg">{step.label}</span>
            <span className="text-xs text-fg-secondary">{step.description}</span>
          </li>
        );
      })}
    </ol>
  );
}
