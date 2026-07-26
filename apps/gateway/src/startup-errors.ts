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
