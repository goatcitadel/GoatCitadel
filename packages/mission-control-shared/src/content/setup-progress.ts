export type SetupStepState = "complete" | "active" | "pending";

export interface SetupProgress {
  steps: readonly [SetupStepState, SetupStepState, SetupStepState];
  firstResponseLabel: string;
  needsRecheck: boolean;
}

export function deriveSetupProgress(input: {
  providerReady: boolean;
  defaultPlanCompleted: boolean;
  firstResponseVerified: boolean;
}): SetupProgress {
  const connect: SetupStepState = input.providerReady ? "complete" : "active";
  const confirm: SetupStepState = !input.providerReady ? "pending" : input.defaultPlanCompleted ? "complete" : "active";
  const firstChat: SetupStepState = confirm !== "complete" ? "pending" : input.firstResponseVerified ? "complete" : "active";
  const needsRecheck = input.firstResponseVerified && !input.providerReady;
  const firstResponseLabel = needsRecheck
    ? "Verified before · recheck the connection"
    : firstChat === "complete"
      ? "Verified"
      : input.firstResponseVerified
        ? "Verified before"
        : "Not yet";
  return { steps: [connect, confirm, firstChat], firstResponseLabel, needsRecheck };
}
