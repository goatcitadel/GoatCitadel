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
    const host = parsed.hostname.trim().toLowerCase();
    return host === "localhost"
      || host === "127.0.0.1"
      || host === "::1";
  } catch {
    return false;
  }
}

export function isTailnetOrPrivateHost(hostname: string, shortHostAllowlist: Set<string>): boolean {
  const host = hostname.trim().toLowerCase();
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

export function resolveTailnetShortHostAllowlist(env: Record<string, string | undefined> = process.env): Set<string> {
  const out = new Set<string>();
  const fromEnv = env.GOATCITADEL_TAILNET_DEV_HOSTS
    ?.split(",")
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
