import type { UiActionState } from "@goatcitadel/contracts";

export interface ActionState {
  state: UiActionState;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

export const IDLE_ACTION_STATE: ActionState = {
  state: "idle",
};

export function isPending(state: ActionState): boolean {
  return state.state === "pending";
}
