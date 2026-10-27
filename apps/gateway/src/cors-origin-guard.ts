import type { GatewayRuntimeConfig } from "./config.js";

export function isTailnetDevOrigin(origin: string, shortHostAllowlist: Set<string>): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    if (port !== "5173" && port !== "4173") {
      return false;
    }
    return isTailnetOrPrivateHost(parsed.hostname, shortHostAllowlist);
  } catch {
    return false;
  }
}

export function isLoopbackDevOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const host = normalizeOriginHostname(parsed.hostname);
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

export function isTailnetOrPrivateHost(hostname: string, shortHostAllowlist: Set<string>): boolean {
  const host = normalizeOriginHostname(hostname);
  if (!host) {
    return false;
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return true;
  }
  if (host.endsWith(".ts.net")) {
    return true;
  }
  if (!host.includes(".") && /^[a-z0-9-]+$/iu.test(host)) {
    // Support explicit MagicDNS short-name allowlist such as "bld".
    return shortHostAllowlist.has(host);
  }
  return isPrivateOrCarrierGradeIpv4(host);
}

function normalizeOriginHostname(hostname: string): string {
  const normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

export function resolveTailnetShortHostAllowlist(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>();
  const fromEnv =
    env.GOATCITADEL_TAILNET_DEV_HOSTS?.split(",")
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean) ?? [];
  for (const entry of fromEnv) {
    if (/^[a-z0-9-]+$/iu.test(entry) && !entry.includes(".")) {
      out.add(entry);
    }
  }

  const bindHost = env.GATEWAY_HOST?.trim().toLowerCase();
  if (bindHost && /^[a-z0-9-]+$/iu.test(bindHost) && !bindHost.includes(".")) {
    out.add(bindHost);
  }
  return out;
}

function isPrivateOrCarrierGradeIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (octets.some((octet) => !Number.isFinite(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 10 || a === 127) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  // Tailscale frequently uses CGNAT range 100.64.0.0/10.
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  return false;
}

export type GatewayAuthMode = GatewayRuntimeConfig["assistant"]["auth"]["mode"];

/**
 * Loopback origins on any port are trusted only outside production and only when the Gateway requires
 * auth. With auth.mode "none", any page served from localhost could otherwise drive the whole Gateway,
 * so only the explicit origins (env or defaults) are accepted.
 */
export function trustsLoopbackDevOrigins(
  authMode: GatewayAuthMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.NODE_ENV !== "production" && authMode !== undefined && authMode !== "none";
}

/**
 * The one Gateway origin policy: explicit origins (env or defaults), loopback dev origins outside
 * production when auth is required, and opt-in tailnet/private dev origins. CORS and the OAuth
 * return hand-off both use it.
 */
export function isAllowedGatewayOrigin(
  origin: string,
  authMode: GatewayAuthMode | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (resolveAllowedOrigins().has(origin)) return true;
  if (trustsLoopbackDevOrigins(authMode, env) && isLoopbackDevOrigin(origin)) return true;
  return resolveAllowTailnetDevOrigins() && isTailnetDevOrigin(origin, resolveTailnetShortHostAllowlist(env));
}

export function resolveAllowedOrigins(): Set<string> {
  const defaults = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://127.0.0.1:8787",
  ];
  const envRaw = process.env.GOATCITADEL_ALLOWED_ORIGINS;
  if (!envRaw?.trim()) {
    return new Set(defaults);
  }
  const fromEnv = envRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((origin) => normalizeConfiguredOrigin(origin, "GOATCITADEL_ALLOWED_ORIGINS"));
  return new Set(fromEnv.length > 0 ? fromEnv : defaults);
}

export function normalizeConfiguredOrigin(rawOrigin: string, envName: string): string {
  try {
    const origin = new URL(rawOrigin);
    if (origin.protocol !== "http:" && origin.protocol !== "https:") {
      throw new Error("origin must use http or https");
    }
    if (
      origin.username ||
      origin.password ||
      (origin.pathname && origin.pathname !== "/") ||
      origin.search ||
      origin.hash
    ) {
      throw new Error("origin must not include credentials, paths, query strings, or fragments");
    }
    return origin.origin;
  } catch (error) {
    throw new Error(
      `Invalid origin in ${envName}: "${rawOrigin}". Use a full http(s) origin such as https://example.com.`,
      { cause: error },
    );
  }
}

export function resolveAllowTailnetDevOrigins(): boolean {
  const raw = process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS?.trim().toLowerCase();
  if (!raw) {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
