export const MAX_SHELL_EXEC_TIMEOUT_MS = 900_000;

export function resolveShellExecTimeout(value: unknown, defaultMs: number): number {
  if (value === undefined) return defaultMs;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1_000 || value > MAX_SHELL_EXEC_TIMEOUT_MS) {
    throw new Error(`shell.exec timeoutMs must be an integer between 1000 and ${MAX_SHELL_EXEC_TIMEOUT_MS}.`);
  }
  return value;
}
