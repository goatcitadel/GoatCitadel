import type { OnboardingState } from "@goatcitadel/contracts";

export const BUDGET_MODE_OPTIONS: Array<OnboardingState["settings"]["budgetMode"]> = ["saver", "balanced", "power"];

export function normalizeBudgetMode(value: string | undefined): OnboardingState["settings"]["budgetMode"] {
  return BUDGET_MODE_OPTIONS.includes(value as OnboardingState["settings"]["budgetMode"])
    ? (value as OnboardingState["settings"]["budgetMode"])
    : "balanced";
}

export function describeBudgetMode(value: OnboardingState["settings"]["budgetMode"]): string {
  if (value === "saver") {
    return "Store a lower-cost budget preference for cost evidence and operator review.";
  }
  if (value === "power") {
    return "Store a quality-first budget preference for cost evidence and operator review.";
  }
  return "Store a balanced budget preference for everyday cost evidence.";
}

export function labelForBudgetMode(value: OnboardingState["settings"]["budgetMode"]): string {
  if (value === "saver") {
    return "Saver";
  }
  if (value === "power") {
    return "Power";
  }
  return "Balanced";
}
