const DURABLE_CONTROL_ERROR_NAMES = new Set([
  "DurableWorkerInterruptionError",
  "DurableWorkflowTimeoutError",
  "DurableRunPausedError",
  "DurableRunCancelledError",
]);

export function isDurableControlError(error: unknown): error is Error {
  return error instanceof Error && DURABLE_CONTROL_ERROR_NAMES.has(error.name);
}
