/**
 * Safe JSON parsing for provider HTTP responses.
 *
 * Providers — and the proxies/CDNs in front of them — sometimes return a 200
 * carrying an HTML or plain-text error page instead of JSON. Calling
 * `response.json()` on that throws a bare `SyntaxError` with no context; this
 * helper instead surfaces a provider-attributed error including the HTTP status
 * and a body snippet (the "S19" hardening).
 *
 * Kept in its own module (rather than `llm-service.ts`) so provider adapters can
 * use it without importing the service and forming an import cycle.
 */
export async function parseProviderJsonResponse<T = Record<string, unknown>>(
  action: string,
  response: Response,
): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const snippet = text.slice(0, 400).replace(/\s+/g, " ").trim();
    const detail = error instanceof Error ? error.message : String(error);
    const suffix = snippet ? ` — body: ${snippet}` : "";
    throw new Error(
      `${action} returned malformed JSON (${response.status} ${response.statusText}): ${detail}${suffix}`,
      { cause: error },
    );
  }
}
