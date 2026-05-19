import type { AuthConfig } from "./config.js";

export const INSECURE_LOCAL_ONLY_OVERRIDE_ENV = "GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY";

export function resolveWarnUnauthNonLoopback(rawValue = process.env.GOATCITADEL_WARN_UNAUTH_NON_LOOPBACK): boolean {
  const raw = rawValue?.trim().toLowerCase();
  if (!raw) {
    return true;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function resolveAllowUnauthNetwork(rawValue = process.env[INSECURE_LOCAL_ONLY_OVERRIDE_ENV]): boolean {
  const raw = rawValue?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function shouldWarnUnauthNonLoopbackBind(bindHost: string, auth: AuthConfig): boolean {
  if (isLoopbackHost(bindHost)) {
    return false;
  }
  if (auth.mode === "none") {
    return true;
  }
  if (auth.mode === "token") {
    return !auth.token.value?.trim();
  }
  return !(auth.basic.username?.trim() && auth.basic.password?.trim());
}

export function isLoopbackHost(value: string): boolean {
  const hostValue = value.trim().toLowerCase();
  if (!hostValue) {
    return false;
  }
  return hostValue === "127.0.0.1" || hostValue === "localhost" || hostValue === "::1" || hostValue === "[::1]";
}

// SECURITY (codex finding #1): The gateway must refuse to boot in token
// mode if `auth.token.value` matches a known-bad placeholder. The Docker
// compose snippet shipped a default token, and operators frequently leave
// example tokens in place when iterating locally. This guard makes that
// failure fast and loud instead of accepting the request and treating the
// placeholder as a real operator credential.
const PLACEHOLDER_AUTH_TOKENS = new Set<string>([
  "change-this-goatcitadel-token",
  "change-this-token",
  "change-me",
  "changeme",
  "goatcitadel",
  "password",
  "secret",
  "token",
  "admin",
  "test",
  "example",
  "placeholder",
]);

const MIN_AUTH_TOKEN_LENGTH = 24;

export interface AuthTokenSafetyResult {
  ok: boolean;
  reason?: string;
}

export function evaluateAuthTokenSafety(value: string | undefined): AuthTokenSafetyResult {
  const trimmed = value?.trim();
  if (!trimmed) {
    return { ok: false, reason: "auth.token.value is empty." };
  }
  if (trimmed.length < MIN_AUTH_TOKEN_LENGTH) {
    return {
      ok: false,
      reason: `auth.token.value must be at least ${MIN_AUTH_TOKEN_LENGTH} characters (got ${trimmed.length}).`,
    };
  }
  if (PLACEHOLDER_AUTH_TOKENS.has(trimmed.toLowerCase())) {
    return {
      ok: false,
      reason: "auth.token.value matches a known placeholder; generate a fresh random token.",
    };
  }
  // Reject trivially-repeated values like "aaaaaaaa...".
  const distinctChars = new Set(trimmed).size;
  if (distinctChars < 6) {
    return {
      ok: false,
      reason: `auth.token.value lacks entropy (only ${distinctChars} distinct characters); generate a fresh random token.`,
    };
  }
  return { ok: true };
}

export function assertAuthTokenIsNotPlaceholder(auth: AuthConfig): void {
  if (auth.mode !== "token") {
    return;
  }
  const result = evaluateAuthTokenSafety(auth.token.value);
  if (!result.ok) {
    throw new Error(`Refusing to start in token auth mode: ${result.reason}`);
  }
}
