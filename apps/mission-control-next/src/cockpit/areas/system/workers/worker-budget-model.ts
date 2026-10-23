export interface BudgetDraft {
  requests: string;
  cost: string;
  minutes: string;
}

const INVALID = "Enter a request limit of at least 2 and a dollar limit.";

/** The same limits the Classic budget form accepted: at least 2 requests and a whole number of micro-dollars. */
export function validateBudgetDraft(
  draft: BudgetDraft,
):
  | { ok: true; limits: { maxRequests: number; maxCostMicrousd: number; minutes: number } }
  | { ok: false; message: string } {
  const maxRequests = Number(draft.requests),
    maxCostMicrousd = Math.round(Number(draft.cost) * 1_000_000),
    minutes = Number(draft.minutes);
  if (
    !draft.requests ||
    !draft.cost ||
    !Number.isSafeInteger(maxRequests) ||
    maxRequests < 2 ||
    !Number.isSafeInteger(maxCostMicrousd) ||
    maxCostMicrousd < 0 ||
    !Number.isFinite(minutes) ||
    minutes <= 0
  )
    return { ok: false, message: INVALID };
  return { ok: true, limits: { maxRequests, maxCostMicrousd, minutes } };
}

/** The server must echo every reviewed field exactly and report a saved version of at least 1. */
export function acknowledgementMatches(request: object, response: object | null | undefined): boolean {
  if (!response) return false;
  const echoed = response as Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(echoed.revision) || (echoed.revision as number) < 1) return false;
  return Object.entries(request).every(([key, value]) => echoed[key] === value);
}

/** Micro-dollars as the shared money formatter reads them. */
export const microusdToUsd = (microusd: number) => microusd / 1_000_000;
