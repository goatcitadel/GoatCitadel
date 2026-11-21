import { ConflictError, type ModelUsageEventRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { LlmDispatchGuard, LlmDispatchGuardInput } from "./llm-dispatch-guard.js";

export const DEFAULT_AUTOMATIC_BACKGROUND_DAILY_USD = 0.25;
const SETTING_PREFIX = "automatic_background_budget_v1:";
const MAX_PENDING = 2048;
const MAX_WRITE_ATTEMPTS = 12;
const USD_EPSILON = 1e-10;

interface DailyBudget {
  spentUsd: number;
  pending: Record<string, number>;
}

export interface AutomaticBackgroundBudgetSnapshot {
  utcDay: string;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  pendingCount: number;
}

interface AutomaticBackgroundBudgetDeps {
  storage: Pick<AsyncStorage, "systemSettings" | "modelUsageEvents" | "costLedger">;
  getLimits(): { automaticUsd: number; totalUsd: number };
  runWithDispatchGuard<T>(guard: LlmDispatchGuard, operation: () => Promise<T>): Promise<T>;
  onReconciliationFailure?(error: unknown): void;
  now?: () => Date;
}

export class AutomaticBackgroundBudgetError extends Error {
  public constructor(
    public readonly reason:
      | "pricing_unavailable"
      | "background_budget_exhausted"
      | "installation_budget_exhausted"
      | "budget_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "AutomaticBackgroundBudgetError";
  }
}

/**
 * Meters automatic inference at the provider-attempt boundary. A single
 * installation-wide row per UTC day serializes reservations across Gateway
 * processes and workspaces. Canonical usage is the settlement authority.
 */
export class AutomaticBackgroundBudget {
  public constructor(private readonly deps: AutomaticBackgroundBudgetDeps) {}

  public async snapshot(): Promise<AutomaticBackgroundBudgetSnapshot> {
    const utcDay = this.now().slice(0, 10);
    const retained = await this.read(utcDay);
    const book = applySettledCosts(retained, await this.readSettlements(retained));
    return {
      utcDay,
      limitUsd: Math.min(this.deps.getLimits().automaticUsd, this.deps.getLimits().totalUsd),
      spentUsd: book.spentUsd,
      reservedUsd: sumPending(book),
      pendingCount: Object.keys(book.pending).length,
    };
  }

  public async run<T>(operation: () => Promise<T>, assertAuthority?: () => Promise<void>): Promise<T> {
    const days = new Set<string>();
    try {
      return await this.deps.runWithDispatchGuard(async (input) => {
        await assertAuthority?.();
        const day = await this.reserve(input);
        if (day) {
          days.add(day);
          await assertAuthority?.();
        }
      }, operation);
    } finally {
      await Promise.all(
        [...days].map(async (day) => {
          try {
            await this.reconcile(day);
          } catch (error) {
            this.deps.onReconciliationFailure?.(error);
          }
        }),
      );
    }
  }

  private async reserve(input: LlmDispatchGuardInput): Promise<string | undefined> {
    const estimateUsd = estimateAutomaticDispatchUsd(input);
    if (estimateUsd === 0) return undefined;
    const now = this.now();
    const day = now.slice(0, 10);
    await this.reconcile(day);
    const from = `${day}T00:00:00.000Z`;
    const [cost, availability] = await Promise.all([
      this.deps.storage.costLedger.summary("day", from, now),
      this.deps.storage.costLedger.usageAvailability(from, now),
    ]);
    if (availability.totalAgentEvents > 0 && !availability.metricAvailability.costUsd.complete) {
      throw new AutomaticBackgroundBudgetError("budget_unavailable", "Installation model usage needs reconciliation.");
    }
    const installationSpend = cost.reduce((total, item) => total + item.costUsd, 0);
    await this.update(day, (book) => {
      if (Object.hasOwn(book.pending, input.usageEventId)) {
        throw new ConflictError({ message: "This automatic model attempt already has a budget reservation." });
      }
      if (Object.keys(book.pending).length >= MAX_PENDING) {
        throw new AutomaticBackgroundBudgetError(
          "budget_unavailable",
          "Automatic background usage needs reconciliation.",
        );
      }
      const pending = sumPending(book);
      const limits = this.deps.getLimits();
      if (book.spentUsd + pending + estimateUsd > limits.automaticUsd + USD_EPSILON) {
        throw new AutomaticBackgroundBudgetError(
          "background_budget_exhausted",
          "The daily automatic background budget is exhausted.",
        );
      }
      if (Math.max(installationSpend, book.spentUsd) + pending + estimateUsd > limits.totalUsd + USD_EPSILON) {
        throw new AutomaticBackgroundBudgetError(
          "installation_budget_exhausted",
          "The daily installation model budget is exhausted.",
        );
      }
      return { ...book, pending: { ...book.pending, [input.usageEventId]: estimateUsd } };
    });
    return day;
  }

  private async reconcile(day: string): Promise<void> {
    const observed = await this.readSettlements(await this.read(day));
    if (observed.length) await this.update(day, (book) => applySettledCosts(book, observed));
  }

  private async readSettlements(book: DailyBudget): Promise<(readonly [string, number])[]> {
    const costs = await Promise.all(
      Object.keys(book.pending).map(async (eventId) => {
        const record = await this.deps.storage.modelUsageEvents.findByEventId(eventId);
        return [eventId, settledCost(record)] as const;
      }),
    );
    return costs.filter((entry): entry is readonly [string, number] => entry[1] !== undefined);
  }

  private async read(day: string): Promise<DailyBudget> {
    const row = await this.deps.storage.systemSettings.get<DailyBudget>(SETTING_PREFIX + day);
    return validateBook(row?.value);
  }

  private async update(day: string, transform: (book: DailyBudget) => DailyBudget): Promise<void> {
    const settings = this.deps.storage.systemSettings;
    const key = SETTING_PREFIX + day;
    for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
      const row = await settings.get<DailyBudget>(key);
      const next = transform(validateBook(row?.value));
      if (await settings.compareAndSet(key, row, next)) return;
    }
    throw new AutomaticBackgroundBudgetError(
      "budget_unavailable",
      "The automatic background budget changed concurrently.",
    );
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}

function applySettledCosts(book: DailyBudget, settlements: readonly (readonly [string, number])[]): DailyBudget {
  if (!settlements.length) return book;
  const next = { spentUsd: book.spentUsd, pending: { ...book.pending } };
  for (const [eventId, actualUsd] of settlements) {
    if (!Object.hasOwn(next.pending, eventId)) continue;
    next.spentUsd += actualUsd;
    delete next.pending[eventId];
  }
  return next;
}

function validateBook(value: DailyBudget | undefined): DailyBudget {
  if (value === undefined) return { spentUsd: 0, pending: {} };
  if (
    !value ||
    !Number.isFinite(value.spentUsd) ||
    value.spentUsd < 0 ||
    !value.pending ||
    Array.isArray(value.pending) ||
    typeof value.pending !== "object" ||
    Object.values(value.pending).some((usd) => !Number.isFinite(usd) || usd < 0)
  ) {
    throw new AutomaticBackgroundBudgetError(
      "budget_unavailable",
      "The automatic background budget needs reconciliation.",
    );
  }
  return value;
}

function sumPending(book: DailyBudget): number {
  return Object.values(book.pending).reduce((total, value) => total + value, 0);
}

function settledCost(record: ModelUsageEventRecord | undefined): number | undefined {
  if (record?.dispatchReconciliation === "confirmed_not_dispatched") return 0;
  if (record?.transportStatus !== "accepted" || record.terminalOutcome === "in_flight") return undefined;
  return record.costUsd !== undefined && Number.isFinite(record.costUsd) && record.costUsd >= 0
    ? record.costUsd
    : undefined;
}

export function estimateAutomaticDispatchUsd({
  route,
  effectiveOutputTokenCap,
  requestInputBytes,
  localTransport,
}: LlmDispatchGuardInput): number {
  if (route.credential.usagePool === "local") {
    if (localTransport) return 0;
    throw new AutomaticBackgroundBudgetError(
      "pricing_unavailable",
      "Automatic work needs verified pricing for a hosted model.",
    );
  }
  // For a textual JSON request, the full UTF-8 body plus framing comfortably
  // bounds the provider's tokenization of the message and tool payload. Use
  // the advertised context limit when only the normalized route is known.
  const bodyBound = requestInputBytes === undefined ? undefined : requestInputBytes + 1024;
  const inputTokens =
    bodyBound === undefined
      ? route.configuredContextWindowTokens
      : Math.min(bodyBound, route.configuredContextWindowTokens ?? bodyBound);
  const price = route.pricing;
  const inputRate = price?.inputRateUsdPerMillion;
  const outputRate = price?.outputRateUsdPerMillion;
  if (
    inputTokens === undefined ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens <= 0 ||
    effectiveOutputTokenCap === undefined ||
    !Number.isSafeInteger(effectiveOutputTokenCap) ||
    effectiveOutputTokenCap <= 0 ||
    inputRate === undefined ||
    outputRate === undefined ||
    !Number.isFinite(inputRate) ||
    !Number.isFinite(outputRate) ||
    inputRate < 0 ||
    outputRate < 0
  ) {
    throw new AutomaticBackgroundBudgetError(
      "pricing_unavailable",
      "Automatic background work needs a priced model with known token limits.",
    );
  }
  return (inputTokens * inputRate + effectiveOutputTokenCap * outputRate) / 1_000_000;
}
