import { isIP } from "node:net";

const DISALLOWED_HOSTS = new Set([
  "0.0.0.0",
  "169.254.169.254",
  "metadata.google.internal",
  "100.100.100.200",
]);

function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function isHostAllowed(hostOrUrl: string, allowlist: string[]): boolean {
  const parsed = parseHost(hostOrUrl);
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const isPrivateOrReserved = isPrivateOrReservedHost(hostname);

  if (allowlist.length === 0) {
    return false;
  }

  const matched = allowlist.some((pattern) => {
    const regex = wildcardToRegex(pattern);
    return regex.test(host) || regex.test(hostname);
  });
  if (!matched) {
    return false;
  }

  if (!isPrivateOrReserved) {
    return true;
  }

  // Local loopback can be used when explicitly allowlisted.
  if (isLoopbackHost(hostname)) {
    return allowlist.some((pattern) => isExplicitLoopbackPattern(pattern, hostname));
  }

  // Never permit broader private/link-local/metadata ranges.
  return false;
}

export function assertHostAllowed(hostOrUrl: string, allowlist: string[]): void {
  if (!isHostAllowed(hostOrUrl, allowlist)) {
    throw new Error(`Host not on allowlist: ${hostOrUrl}`);
  }
}

function parseHost(hostOrUrl: string): { host: string; hostname: string } {
  try {
    const parsed = new URL(hostOrUrl);
    return {
      host: parsed.host || hostOrUrl,
      hostname: parsed.hostname || hostOrUrl,
    };
  } catch {
    const trimmed = hostOrUrl.trim();
    if (!trimmed) {
      return { host: "", hostname: "" };
    }

    if (trimmed.startsWith("[")) {
      const end = trimmed.indexOf("]");
      if (end > 0) {
        return {
          host: trimmed,
          hostname: trimmed.slice(1, end),
        };
      }
    }

    const firstSlash = trimmed.indexOf("/");
    const withoutPath = firstSlash >= 0 ? trimmed.slice(0, firstSlash) : trimmed;
    const colonCount = (withoutPath.match(/:/g) ?? []).length;
    if (colonCount === 1) {
      const [hostname] = withoutPath.split(":");
      return {
        host: withoutPath,
        hostname: hostname ?? withoutPath,
      };
    }

    return {
      host: withoutPath,
      hostname: withoutPath,
    };
  }
}

function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (!lower) {
    return true;
  }
  if (DISALLOWED_HOSTS.has(lower)) {
    return true;
  }
  if (lower === "localhost" || lower.endsWith(".local")) {
    return true;
  }

  const ipVersion = isIP(lower);
  if (ipVersion === 4) {
    return isPrivateOrReservedIpv4(lower);
  }
  if (ipVersion === 6) {
    return isBlockedIpv6(lower);
  }
  return false;
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }
  const [a = -1, b = -1] = parts;
  if (a === 10 || a === 127 || a === 0) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function isBlockedIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  );
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower === "127.0.0.1" || lower === "::1";
}

function isExplicitLoopbackPattern(pattern: string, hostname: string): boolean {
  const normalizedPattern = pattern.toLowerCase().trim();
  const normalizedHost = hostname.toLowerCase();
  if (normalizedHost === "localhost") {
    return normalizedPattern === "localhost" || normalizedPattern.startsWith("localhost:");
  }
  if (normalizedHost === "127.0.0.1") {
    return normalizedPattern === "127.0.0.1" || normalizedPattern.startsWith("127.0.0.1:");
  }
  if (normalizedHost === "::1") {
    return (
      normalizedPattern === "::1"
      || normalizedPattern === "[::1]"
      || normalizedPattern.startsWith("[::1]:")
    );
  }
  return false;
}
