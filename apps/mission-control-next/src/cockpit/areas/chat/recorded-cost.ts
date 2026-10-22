import type { ChatUsageCostSource } from "@goatcitadel/contracts";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { formatMoney } from "@goatcitadel/mission-control-shared/content/format";

/** An unqualified zero is unknown; a positive unqualified value is a lower bound ("at least $0.25", as Spend says). */
export function recordedCostLabel(value: number | undefined, source: ChatUsageCostSource | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "Unknown";
  if (source === "provider_reported") return formatCostUsd(value);
  if (source === "estimated" || source === "mixed") return `About ${formatCostUsd(value)}`;
  return value > 0 ? formatMoney(value, { atLeast: true }) : "Unknown";
}
