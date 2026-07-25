import type { DurableRetryPolicy } from "@goatcitadel/contracts";

export const DURABLE_RETRY_POLICY_DEFAULT: Readonly<DurableRetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 5_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
});

export function normalizeDurableRetryPolicy(input: Partial<DurableRetryPolicy> | undefined): DurableRetryPolicy {
  return {
    maxAttempts: Math.max(1, Math.min(20, Math.floor(input?.maxAttempts ?? DURABLE_RETRY_POLICY_DEFAULT.maxAttempts))),
    baseDelayMs: Math.max(
      100,
      Math.min(300_000, Math.floor(input?.baseDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.baseDelayMs)),
    ),
    maxDelayMs: Math.max(
      100,
      Math.min(900_000, Math.floor(input?.maxDelayMs ?? DURABLE_RETRY_POLICY_DEFAULT.maxDelayMs)),
    ),
    backoffMultiplier: Math.max(
      1,
      Math.min(8, input?.backoffMultiplier ?? DURABLE_RETRY_POLICY_DEFAULT.backoffMultiplier),
    ),
  };
}

export function isExactDurableRetryPolicy(value: unknown, expected: DurableRetryPolicy): value is DurableRetryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "backoffMultiplier,baseDelayMs,maxAttempts,maxDelayMs" &&
    record.maxAttempts === expected.maxAttempts &&
    record.baseDelayMs === expected.baseDelayMs &&
    record.maxDelayMs === expected.maxDelayMs &&
    record.backoffMultiplier === expected.backoffMultiplier
  );
}

export function assertDurableRetryPolicyMatchesRun(
  retryPolicy: unknown,
  runMaxAttempts: number,
  expected: DurableRetryPolicy,
): void {
  if (!isExactDurableRetryPolicy(retryPolicy, expected) || runMaxAttempts !== expected.maxAttempts) {
    throw new Error("Durable run retry policy does not match its normalized retry authority.");
  }
}
