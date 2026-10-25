import { isSubscriptionAuthMode, type ChatUsageCostSource } from "@goatcitadel/contracts";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { formatMoney } from "@goatcitadel/mission-control-shared/content/format";

/**
 * An unqualified zero is unknown; a positive unqualified value is a lower bound ("at least $0.25", as Spend says).
 * `includedIn` names the subscription a turn billed against; it replaces only an unknown cost, never a recorded one.
 */
export function recordedCostLabel(
  value: number | undefined,
  source: ChatUsageCostSource | undefined,
  includedIn?: string,
): string {
  const unknown = includedIn ?? "Unknown";
  if (value === undefined || !Number.isFinite(value) || value < 0) return unknown;
  if (source === "provider_reported") return formatCostUsd(value);
  if (source === "estimated" || source === "mixed") return `About ${formatCostUsd(value)}`;
  return value > 0 ? formatMoney(value, { atLeast: true }) : unknown;
}

/** "Included in Claude subscription" for a sign-in mode that bills a subscription (the gateway's usage pool). */
export function subscriptionCostLabel(authMode: string | undefined): string | undefined {
  if (!isSubscriptionAuthMode(authMode)) return undefined;
  return authMode === "codex-oauth" ? "Included in ChatGPT subscription" : "Included in Claude subscription";
}
