/** A terminal receipt acknowledges recent work; full plan history stays in Activity. */
export const TERMINAL_RECEIPT_FRESH_MS = 10 * 60 * 1000;
export const DISMISSED_CHANGE_PLAN_RECEIPTS_KEY = "goatcitadel.chat.dismissed-change-plan-receipts.v1";
const MAX_DISMISSED_KEYS = 50;

export function shouldShowTerminalChangePlanReceipt(input: {
  originTurnId?: string;
  latestTurnId?: string;
  settledAt: string;
  now: number;
}): boolean {
  if (input.originTurnId && input.originTurnId !== input.latestTurnId) return false;
  const settled = Date.parse(input.settledAt);
  return Number.isFinite(settled) && input.now >= settled && input.now - settled <= TERMINAL_RECEIPT_FRESH_MS;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readDismissedChangePlanReceiptKeys(storage?: Storage | null): Set<string> {
  const target = resolveStorage(storage);
  if (!target) return new Set();
  try {
    const parsed: unknown = JSON.parse(target.getItem(DISMISSED_CHANGE_PLAN_RECEIPTS_KEY) ?? "[]");
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === "string").slice(-MAX_DISMISSED_KEYS)
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeDismissedChangePlanReceiptKeys(keys: ReadonlySet<string>, storage?: Storage | null): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(DISMISSED_CHANGE_PLAN_RECEIPTS_KEY, JSON.stringify([...keys].slice(-MAX_DISMISSED_KEYS)));
  } catch {
    // Keep the dismissal in memory when its optional preference store is blocked or full.
  }
}
