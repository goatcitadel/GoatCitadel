import { ArrowRight, Circle } from "lucide-react";
import type { StatusPresentation } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";

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
