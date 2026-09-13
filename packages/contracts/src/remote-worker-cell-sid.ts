/** Canonical account/service SID subset shared by the native provisioning owners. */
export function normalizeRemoteWorkerCellSid(input: unknown, controller: boolean): string {
  const invalid = () => new TypeError("Native worker provisioning metadata is invalid.");
  if (typeof input !== "string" || input.length > 184 || !/^S-1-5-(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*))*$/u.test(input)) throw invalid();
  const parts = input.split("-").slice(3).map(Number);
  if (parts.some((value) => !Number.isSafeInteger(value) || value > 0xffffffff) || !(
    (parts.length === 1 && parts[0] === 18) || (parts.length === 5 && parts[0] === 21) ||
    (controller && parts.length === 6 && parts[0] === 80)
  )) throw invalid();
  return input;
}
