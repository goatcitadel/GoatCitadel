/**
 * True when a provider's base URL points at this machine. The Gateway's onboarding state treats such
 * an endpoint as ready without a key; the terminal wizard uses the same fact to decide that a
 * provider needs no key.
 */
export function isProviderLikelyLocal(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
