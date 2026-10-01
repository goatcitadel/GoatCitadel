export interface VaultAttempt {
  phase: "idle" | "checking" | "saving" | "uncertain";
  message?: string;
}
const idle: VaultAttempt = Object.freeze({ phase: "idle" });
const attempts = new Map<string, VaultAttempt>();
const listeners = new Set<() => void>();
export const vaultAttempt = (key: string) => attempts.get(key) ?? idle;
export const vaultLocked = (key: string) => vaultAttempt(key).phase !== "idle";
export function setVaultAttempt(key: string, value: VaultAttempt) {
  attempts.set(key, value);
  for (const listener of listeners) listener();
}
export function subscribeVaultAttempts(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function __resetCitadelVaultAttemptsForTests() {
  attempts.clear();
  for (const listener of listeners) listener();
}
