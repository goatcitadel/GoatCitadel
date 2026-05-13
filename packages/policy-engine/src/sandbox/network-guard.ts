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
  const isPrivateOrReserved = isPrivateOrReservedHost(hostname);

  if (!host && !hostname) {
    return {
      target: hostOrUrl,
      hostname,
      allowed: false,
      approvalState: "blocked",
      reason: "Host is empty.",
    };
  }

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
  const firstSegment = segments[0] ?? "";
  if (firstSegment && !normalizedCandidate.startsWith(firstSegment)) {
    return false;
  }
  let cursor = firstSegment.length;

  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    if (!segment) {
      continue;
    }
    const nextIndex = normalizedCandidate.indexOf(segment, cursor);
    if (nextIndex < 0) {
      return false;
    }
    cursor = nextIndex + segment.length;
  }

  const lastSegment = segments.at(-1) ?? "";
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
