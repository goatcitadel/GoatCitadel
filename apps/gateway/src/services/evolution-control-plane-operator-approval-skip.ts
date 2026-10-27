import type { ChangePlanRecord } from "@goatcitadel/contracts";

/** The approval-skip part of `EvolutionControlPlaneServiceDependencies`. */
export interface Dependencies {
  /**
   * Whether the operator has chosen to apply their own Settings saves and Capabilities installs without a separate
   * approval (the runtime flag and the deployment profile). Consulted only for a Settings- or Capabilities-origin
   * caution or danger plan confirmed by that surface's own server-owned save route.
   */
  readonly allowsOperatorApprovalSkip?: (plan: ChangePlanRecord) => boolean | Promise<boolean>;
}

/** Options for `EvolutionControlPlaneService.confirm`. */
export interface ConfirmOptions {
  /**
   * Set only by a server-owned operator save route (the Settings save, the Capabilities install); never accepted from
   * a request body.
   */
  readonly operatorSettingsSave?: boolean;
}

/** The plan event that starts apply; the operator's approval skip records its own. */
export interface ApplyStartEvent {
  readonly eventType: string;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
}

/** The origin surfaces whose own save routes may ask for the operator's skip. Chat and system plans never may. */
const OPERATOR_SAVE_SURFACES: ReadonlySet<string> = new Set(["settings", "capabilities"]);

/**
 * The apply-start event for a confirmed caution or danger plan whose separate approval the operator's
 * opt-in skips, or undefined when the plan keeps its approval (or is safe and never needed one).
 */
export async function eventFor(
  plan: ChangePlanRecord,
  options: ConfirmOptions,
  deps: Dependencies,
): Promise<ApplyStartEvent | undefined> {
  if (
    plan.risk === "safe" ||
    options.operatorSettingsSave !== true ||
    !OPERATOR_SAVE_SURFACES.has(plan.origin.surface)
  ) {
    return undefined;
  }
  if ((await deps.allowsOperatorApprovalSkip?.(plan)) !== true) return undefined;
  return {
    eventType: "operator_approval_skipped",
    eventPayload: { risk: plan.risk, reason: "settings_approval_skip_enabled" },
  };
}
