/** The approval kind for one risky errand action; the errand's gate polls these records itself. */
export const ERRAND_APPROVAL_KIND = "browser.errand.action";
/** True for an approval its own requester polls: nothing parks on it, so it gets no approval wait run and no wake. */
export function isSelfPolledApprovalKind(kind: string): boolean {
  return kind === ERRAND_APPROVAL_KIND;
}
export const ERRAND_MAX_STEPS = 60;
export const ERRAND_MAX_ACTIVE_MS = 20 * 60_000;
export const ERRAND_APPROVAL_TTL_MS = 10 * 60_000;
export const ERRAND_DEFAULT_PROVIDER_ID = "openai-codex";
export const ERRAND_DEFAULT_MODEL = "gpt-6.1-sol";
