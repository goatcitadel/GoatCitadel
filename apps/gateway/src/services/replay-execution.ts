export class ReplayExecutionSkippedError extends Error {
  public readonly details?: Record<string, unknown>;

  public constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ReplayExecutionSkippedError";
    this.details = details;
  }
}
