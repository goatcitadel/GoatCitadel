import type { ChangePlanRecord } from "@goatcitadel/contracts";

/** The approval-skip part of `EvolutionControlPlaneServiceDependencies`. */
export interface Dependencies {
  /**
   * Whether the operator has chosen to apply their own Settings saves without a separate approval
   * (the runtime flag and the deployment profile). Consulted only for a Settings-origin caution or
   * danger plan confirmed by the Settings save route itself.
   */
  readonly allowsOperatorApprovalSkip?: (plan: ChangePlanRecord) => boolean | Promise<boolean>;
}

/** Options for `EvolutionControlPlaneService.confirm`. */
export interface ConfirmOptions {
  /** Set only by the server-owned Settings save route; never accepted from a request body. */
  readonly operatorSettingsSave?: boolean;
}

/** The plan event that starts apply; the operator's approval skip records its own. */
export interface ApplyStartEvent {
  readonly eventType: string;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
}

/**
 * The apply-start event for a confirmed caution or danger plan whose separate approval the operator's
 * opt-in skips, or undefined when the plan keeps its approval (or is safe and never needed one).
 */
export async function eventFor(
  plan: ChangePlanRecord,
  options: ConfirmOptions,
  deps: Dependencies,
): Promise<ApplyStartEvent | undefined> {
  if (plan.risk === "safe" || options.operatorSettingsSave !== true || plan.origin.surface !== "settings") {
    return undefined;
  }
  if ((await deps.allowsOperatorApprovalSkip?.(plan)) !== true) return undefined;
  return {
    eventType: "operator_approval_skipped",
    eventPayload: { risk: plan.risk, reason: "settings_approval_skip_enabled" },
  };
}
