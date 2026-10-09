import { request } from "./client-core";

export type MutationAttemptStatus = "completed" | "failed" | "pending" | "absent";
export interface MutationAttempt {
  status: MutationAttemptStatus;
  claimExpired?: boolean;
  updatedAt?: string;
}
/**
 * What a lost response means for the owner, from the Gateway's own record of that exact attempt:
 * - committed: the reviewed change happened; confirm it by the owner's canonical readback.
 * - failed_confirm_by_readback: the Gateway answered with an error and released the claim. That is NOT proof that
 *   nothing was applied (a handler can commit and then fail without marking the commit), so the owner must confirm the
 *   canonical state by readback before any retry, and a retry stays protected by the owner's expected revision.
 * - in_progress: the Gateway is still running it; keep the lock and read again.
 * - unknown: the claim expired while running; keep the lock (it may have committed).
 * - resend_same_key: no record yet for this caller; only re-sending with the SAME key is safe.
 */
export type MutationAttemptVerdict =
  | "committed"
  | "failed_confirm_by_readback"
  | "in_progress"
  | "unknown"
  | "resend_same_key";

export function createAttemptKey(): string {
  return crypto.randomUUID();
}

/** `routePattern` is the Gateway's registered route pattern (e.g. /api/v1/secrets/providers/:providerId). */
export async function fetchMutationAttempt(
  attemptKey: string,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  routePattern: string,
): Promise<MutationAttempt> {
  const query = new URLSearchParams({ method, route: routePattern });
  const response = await request<{ attempt: MutationAttempt }>(
    `/api/v1/mutation-attempts/${encodeURIComponent(attemptKey)}?${query.toString()}`,
    { cache: "no-store" },
  );
  return response.attempt;
}

/**
 * The owner's registered route pattern that a captured request path belongs to. Each `:param` matches exactly one
 * non-empty path segment; anything else must match literally. Undefined means the owner does not track this route.
 */
export function matchRoutePattern(path: string, patterns: readonly string[]): string | undefined {
  const segments = path.split("/");
  return patterns.find((pattern) => {
    const parts = pattern.split("/");
    return (
      parts.length === segments.length &&
      parts.every((part, index) => (part.startsWith(":") ? Boolean(segments[index]) : part === segments[index]))
    );
  });
}

export function classifyMutationAttempt(attempt: MutationAttempt): MutationAttemptVerdict {
  if (attempt.status === "completed") return "committed";
  if (attempt.status === "failed") return "failed_confirm_by_readback";
  if (attempt.status === "pending") return attempt.claimExpired ? "unknown" : "in_progress";
  return "resend_same_key";
}
