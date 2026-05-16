import { isIP } from "node:net";
import type { EgressDecision } from "@goatcitadel/contracts";

const DISALLOWED_HOSTS = new Set(["0.0.0.0", "169.254.169.254", "metadata.google.internal", "100.100.100.200"]);

export function isHostAllowed(hostOrUrl: string, allowlist: string[]): boolean {
  return evaluateHostEgress(hostOrUrl, allowlist).allowed;
}

export function evaluateHostEgress(hostOrUrl: string, allowlist: string[]): EgressDecision {
  const parsed = parseHost(hostOrUrl);
  const host = parsed.host.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();

  if (parsed.invalidReason) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: "blocked",
      reason: parsed.invalidReason,
    };
  }

  if (!host && !hostname) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: "blocked",
      reason: "Host is empty.",
    };
  }

  const isPrivateOrReserved = isPrivateOrReservedHost(hostname);
  const matchedPattern = allowlist.find(
    (pattern) => matchesAllowlistPattern(host, pattern) || matchesAllowlistPattern(hostname, pattern),
  );

  if (!matchedPattern) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: isPrivateOrReserved ? "blocked" : "approval_required",
      reason: isPrivateOrReserved
        ? `Private, loopback, or reserved host is blocked: ${hostOrUrl}`
        : `Host is not yet allowlisted: ${hostOrUrl}`,
    };
  }

  if (!isPrivateOrReserved) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: true,
      approvalState: "not_required",
      reason: "Host matches network allowlist.",
      matchedAllowlistPattern: matchedPattern,
    };
  }

  if (isExplicitLoopbackPattern(matchedPattern, hostname)) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: true,
      approvalState: "not_required",
      reason: "Loopback host explicitly allowlisted.",
      matchedAllowlistPattern: matchedPattern,
    };
  }

  return {
    target: hostOrUrl,
    hostname,
    allowed: false,
    approvalState: "blocked",
    reason: `Private, metadata, or reserved host is blocked: ${hostOrUrl}`,
    matchedAllowlistPattern: matchedPattern,
  };
}

export function assertHostAllowed(hostOrUrl: string, allowlist: string[]): void {
  const decision = evaluateHostEgress(hostOrUrl, allowlist);
  if (!decision.allowed) {
    throw new Error(decision.reason);
  }
}

export function evaluateDangerousHostBypass(
  hostOrUrl: string,
  allowlist: string[],
): {
  blocked: boolean;
  shouldAudit: boolean;
  hostname: string;
  reason: string;
} {
  const decision = evaluateHostEgress(hostOrUrl, allowlist);
  if (decision.allowed) {
    return {
      blocked: false,
      shouldAudit: false,
      hostname: decision.hostname,
      reason: decision.reason,
    };
  }
  if (decision.approvalState === "blocked") {
    return {
      blocked: true,
      shouldAudit: false,
      hostname: decision.hostname,
      reason: decision.reason,
    };
  }
  return {
    blocked: false,
    shouldAudit: true,
    hostname: decision.hostname,
    reason: `Danger profile bypassed network allowlist for ${hostOrUrl}`,
  };
}

export function assertHostAllowedInDangerProfile(hostOrUrl: string, allowlist: string[]): void {
  const decision = evaluateDangerousHostBypass(hostOrUrl, allowlist);
  if (decision.blocked) {
    throw new Error(decision.reason);
  }
}

function parseHost(hostOrUrl: string): { host: string; hostname: string; invalidReason?: string } {
  const trimmed = hostOrUrl.trim();
  if (!trimmed) {
    return { host: "", hostname: "" };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.host || parsed.hostname) {
      // SECURITY: when the URL contains an IPv6 host (`http://[fc00::1]/`),
      // the WHATWG URL parser keeps the brackets in `hostname`. Strip them
      // here so the IPv6 family detection in isPrivateOrReservedHost sees
      // `fc00::1` (which `isIP()` recognises) instead of `[fc00::1]` (which
      // it does not). Without this, every bracketed IPv6 form bypasses the
      // SSRF guard — including ULA, link-local, loopback, and IPv4-mapped
      // metadata addresses.
      return {
        host: parsed.host,
        hostname: stripIpv6Brackets(parsed.hostname),
      };
    }
    if (trimmed.includes("://")) {
      return invalidHost(hostOrUrl, "Host URL is malformed.");
    }
  } catch {
    if (trimmed.includes("://")) {
      return invalidHost(hostOrUrl, "Host URL is malformed.");
    }
  }

  const firstSlash = trimmed.indexOf("/");
  const withoutPath = firstSlash >= 0 ? trimmed.slice(0, firstSlash) : trimmed;

  if (withoutPath.startsWith("[")) {
    const end = withoutPath.indexOf("]");
    if (end > 0) {
      const host = withoutPath.slice(0, end + 1);
      const portSuffix = withoutPath.slice(end + 1);
      if (portSuffix && !/^:\d+$/.test(portSuffix)) {
        return invalidHost(hostOrUrl, "Host port is malformed.");
      }
      return {
        host: `${host}${portSuffix}`,
        hostname: withoutPath.slice(1, end),
      };
    }
  }

  if (/\s/.test(withoutPath)) {
    return invalidHost(hostOrUrl, "Host contains invalid whitespace.");
  }
  const colonCount = (withoutPath.match(/:/g) ?? []).length;
  if (colonCount === 1) {
    const parts = withoutPath.split(":");
    const hostname = parts[0]!;
    const port = parts[1]!;
    if (port && !/^\d+$/.test(port)) {
      return invalidHost(hostOrUrl, "Host port is malformed.");
    }
    if (isMalformedIpv4Literal(hostname)) {
      return invalidHost(hostOrUrl, "IPv4 host is malformed.");
    }
    return {
      host: withoutPath,
      hostname,
    };
  }

  if (isMalformedIpv4Literal(withoutPath)) {
    return invalidHost(hostOrUrl, "IPv4 host is malformed.");
  }

  return {
    host: withoutPath,
    hostname: withoutPath,
  };
}

function invalidHost(input: string, reason: string): { host: string; hostname: string; invalidReason: string } {
  return {
    host: "",
    hostname: "",
    invalidReason: `${reason} ${input}`,
  };
}

function isMalformedIpv4Literal(hostname: string): boolean {
  return /^\d+(?:\.\d+)+$/.test(hostname) && isIP(hostname) !== 4;
}

function matchesAllowlistPattern(candidate: string, pattern: string): boolean {
  const normalizedCandidate = candidate.toLowerCase();
  const normalizedPattern = pattern.trim().toLowerCase();

  if (!normalizedPattern.includes("*")) {
    return normalizedCandidate === normalizedPattern;
  }

  if (normalizedPattern === "*") {
    return true;
  }

  const segments = normalizedPattern.split("*");
  const firstSegment = segments[0]!;
  if (firstSegment && !normalizedCandidate.startsWith(firstSegment)) {
    return false;
  }
  let cursor = firstSegment.length;

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (!segment) {
      continue;
    }
    const nextIndex = normalizedCandidate.indexOf(segment, cursor);
    if (nextIndex < 0) {
      return false;
    }
    cursor = nextIndex + segment.length;
  }

  const lastSegment = segments[segments.length - 1]!;
  return !lastSegment || normalizedCandidate.endsWith(lastSegment);
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
  if (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb")
  ) {
    return true;
  }
  // IPv4-mapped IPv6 (RFC 4291) — `::ffff:a.b.c.d` or the canonical
  // `::ffff:hhhh:hhhh` Node normalizes IPv4 octets into. Recurse through the
  // IPv4 reserved-range check so an attacker cannot reach 169.254.169.254
  // (AWS metadata), 100.100.100.200 (Alibaba), or any RFC1918 host via the
  // IPv4-mapped IPv6 form.
  const mapped = extractIpv4MappedAddress(lower);
  if (mapped) {
    return isPrivateOrReservedIpv4(mapped);
  }
  return false;
}

function extractIpv4MappedAddress(ipv6Lower: string): string | undefined {
  // Dotted-quad mapped form: `::ffff:169.254.169.254`
  const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(ipv6Lower);
  if (dottedMatch) {
    return dottedMatch[1];
  }
  // Hex-quad mapped form: `::ffff:a9fe:a9fe` (Node's canonical normalisation
  // of the dotted form, returned via `new URL().hostname`).
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ipv6Lower);
  if (hexMatch) {
    const high = Number.parseInt(hexMatch[1] ?? "", 16);
    const low = Number.parseInt(hexMatch[2] ?? "", 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      const octet = (value: number, shift: number) => (value >>> shift) & 0xff;
      return [octet(high, 8), octet(high, 0), octet(low, 8), octet(low, 0)].join(".");
    }
  }
  return undefined;
}

function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
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
    return normalizedPattern === "::1" || normalizedPattern === "[::1]" || normalizedPattern.startsWith("[::1]:");
  }
  return false;
}
