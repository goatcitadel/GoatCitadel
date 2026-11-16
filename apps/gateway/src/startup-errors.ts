export const NON_RETRYABLE_STARTUP_EXIT_CODE = 78;

export class NonRetryableStartupError extends Error {
  public readonly startupFailureKind = "non_retryable_configuration" as const;

  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryableStartupError";
  }
}

export function isNonRetryableStartupError(error: unknown): error is NonRetryableStartupError {
  return (
    error instanceof Error &&
    (error as Error & { startupFailureKind?: unknown }).startupFailureKind === "non_retryable_configuration"
  );
}

export function resolveGatewayStartupExitCode(error: unknown): number {
  return isNonRetryableStartupError(error) ? NON_RETRYABLE_STARTUP_EXIT_CODE : 1;
}

const OPERATOR_SUMMARY_KEY = "operatorSummary";

/**
 * Attaches a plain-words sentence for the operator to a startup error. The
 * error keeps its technical message (for the log); the summary is what the
 * launcher and the desktop window may show.
 */
export function attachOperatorSummary<T extends Error>(error: T, summary: string): T {
  Object.defineProperty(error, OPERATOR_SUMMARY_KEY, {
    value: summary,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return error;
}

export function readOperatorSummary(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const value = (error as Error & { [OPERATOR_SUMMARY_KEY]?: unknown })[OPERATOR_SUMMARY_KEY];
  return typeof value === "string" && value.trim() ? value : undefined;
}
