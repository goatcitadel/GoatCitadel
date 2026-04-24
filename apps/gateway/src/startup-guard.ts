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
