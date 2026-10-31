import type { ChangePlanRecord } from "@goatcitadel/contracts";

/**
 * The Capabilities plans an operator save route may ask the skip for: the operator's own connector install and plugin
 * install and uninstall. Each was added here on purpose (R95, #572).
 */
export const OPERATOR_CAPABILITIES_PLAN_KINDS: ReadonlySet<ChangePlanRecord["kind"]> = new Set([
  "connector_install",
  "plugin_install",
  "plugin_uninstall",
]);

/** The approval-skip part of `EvolutionControlPlaneServiceDependencies`. */
export interface Dependencies {
  /**
   * Whether the operator has chosen to apply their own Settings saves and Capabilities installs without a separate
   * approval (the runtime flag and the deployment profile). Consulted only for a caution or danger plan from Settings,
   * or a connector or plugin install (or a plugin uninstall) from Capabilities, confirmed by that surface's own
   * server-owned route.
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

/**
 * Evidence a server-owned operator save route adds when its plan waits for approval. Approval reconciliation applies
 * a Settings plan only with it, so a plan that merely claims `surface: "settings"` keeps its explicit continuation.
 */
export const OPERATOR_SAVE_EVIDENCE = "operator-save:settings";

/** The evidence to record when this confirmation comes from the operator's own save route, or none. */
export function operatorSaveEvidence(plan: ChangePlanRecord, options: ConfirmOptions): string[] {
  return options.operatorSettingsSave === true && plan.origin.surface === "settings" ? [OPERATOR_SAVE_EVIDENCE] : [];
}

/** The plan event that starts apply; the operator's approval skip records its own. */
export interface ApplyStartEvent {
  readonly eventType: string;
  readonly eventPayload?: Readonly<Record<string, unknown>>;
}

/**
 * Whether the plan is one an operator save route may ask the skip for. Settings keeps every kind it saves. On
 * Capabilities only a connector install and a plugin install or uninstall may (R95), so a future Capabilities action
 * has to be added to `OPERATOR_CAPABILITIES_PLAN_KINDS` on purpose. Chat and system plans never may.
 */
function isOperatorSavePlan(plan: ChangePlanRecord): boolean {
  if (plan.origin.surface === "settings") return true;
  return plan.origin.surface === "capabilities" && OPERATOR_CAPABILITIES_PLAN_KINDS.has(plan.kind);
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
  if (plan.risk === "safe" || options.operatorSettingsSave !== true || !isOperatorSavePlan(plan)) {
    return undefined;
  }
  if ((await deps.allowsOperatorApprovalSkip?.(plan)) !== true) return undefined;
  return {
    eventType: "operator_approval_skipped",
    eventPayload: { risk: plan.risk, reason: "settings_approval_skip_enabled" },
  };
}
