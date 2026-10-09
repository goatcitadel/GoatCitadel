// Only Vite's development server supplies a reset ID. Production builds never reset storage.
export const DEV_RESET_STORAGE_KEY = "goatcitadel.dev-reset.v1";
type ResetStorage = Pick<Storage, "length" | "key" | "getItem" | "removeItem" | "setItem">;

export function resetDevBrowserStorage(resetId: string, storage: ResetStorage | null): boolean {
  if (!resetId || !storage) return false;
  try {
    if (storage.getItem(DEV_RESET_STORAGE_KEY) === resetId) return false;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const key of keys) {
      if (key && /^(?:goatcitadel[.:]|mc-next:)/u.test(key)) storage.removeItem(key);
    }
    // Write only after deletion succeeds, so an interrupted reset can retry.
    storage.setItem(DEV_RESET_STORAGE_KEY, resetId);
    return true;
  } catch {
    // eslint-disable-next-line no-console -- dev-only reset failure must stay visible to the developer.
    console.warn("GoatCitadel could not reset browser storage. Use a private window for a fresh test.");
    return false;
  }
}
