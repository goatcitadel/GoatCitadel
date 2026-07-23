import { isIP } from "node:net";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as nodeDnsLookup } from "node:dns";
import { assertNotPrivateOrReservedHost, redactUrlForError, type DnsLookupFunction } from "./sandbox/network-guard.js";

/**
 * HX-505 worker-cell kernel-isolated egress proxy (policy-enforced worker
 * egress). It mirrors the HX-415 network-guard SSRF posture but is STRICTER
 * than the browser proxy: it accepts an exact host/IP plus port authority only,
 * rejects wildcard/userinfo/encoded/noncanonical authorities and every
 * loopback/link-local/metadata/private/multicast/reserved destination, rejects
 * mixed public/private DNS answers with no loopback exception, pins the checked
 * IP and rechecks it on every connection, applies all workspace/grant
 * allowlists conjunctively, and bounds connections/deadlines/bytes. Nonempty
 * egress fails closed unless the platform proves a direct-socket bypass is
 * impossible.
 */

export const WORKER_CELL_EGRESS_MAX_CONNECTIONS_LIMIT = 512;
export const WORKER_CELL_EGRESS_MAX_DEADLINE_MS = 120_000;
export const WORKER_CELL_EGRESS_MAX_BYTES_LIMIT = 1_073_741_824;

export interface WorkerCellEgressBounds {
  readonly maxConnections: number;
  readonly connectDeadlineMs: number;
  readonly maxBytesPerConnection: number;
}

export interface WorkerCellEgressConfig extends WorkerCellEgressBounds {
  /**
   * Conjunctive allowlists: a target must match at least one exact `host:port`
   * entry in EVERY non-empty allowlist (workspace ∧ grant ∧ …). An empty outer
   * array is a deny-all posture.
   */
  readonly allowlists: readonly (readonly string[])[];
  /** The platform proved that a direct socket cannot bypass this proxy. */
  readonly directSocketBypassProven: boolean;
}

export interface CanonicalEgressAuthority {
  readonly authority: string;
  readonly host: string;
  readonly port: number;
  readonly family: 0 | 4 | 6;
}

export interface PinnedEgressTarget {
  readonly authority: string;
  readonly host: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
}

export type WorkerCellEgressEvaluation =
  | { readonly allowed: true; readonly authority: CanonicalEgressAuthority }
  | { readonly allowed: false; readonly reason: string };

export class WorkerCellEgressDeniedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkerCellEgressDeniedError";
  }
}

const PORT_PATTERN = /^[1-9][0-9]{0,4}$/u;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/** Parse an exact `host:port` authority, rejecting every non-canonical form. */
export function parseWorkerCellEgressAuthority(input: string): CanonicalEgressAuthority | undefined {
  if (typeof input !== "string" || input.length < 3 || input.length > 273) return undefined;
  // Reject scheme, userinfo, path/query/fragment, wildcard, percent-encoding,
  // backslash, and any whitespace or control character outright.
  if (/[\s*%@/?#\\]/u.test(input) || input.includes("://") || /\p{Cc}/u.test(input)) return undefined;

  if (input.startsWith("[")) {
    const end = input.indexOf("]");
    if (end < 0 || input[end + 1] !== ":") return undefined;
    const inner = input.slice(1, end);
    const portText = input.slice(end + 2);
    if (isIP(inner) !== 6 || !PORT_PATTERN.test(portText)) return undefined;
    const port = Number(portText);
    if (port < 1 || port > 65_535) return undefined;
    // Canonical bracketed IPv6: the lower-case compressed form must round-trip.
    const canonical = canonicalIpv6(inner);
    if (canonical === undefined || `[${canonical}]:${portText}` !== input.toLowerCase()) return undefined;
    return Object.freeze({ authority: `[${canonical}]:${port}`, host: canonical, port, family: 6 });
  }

  const colon = input.lastIndexOf(":");
  if (colon <= 0) return undefined;
  const host = input.slice(0, colon);
  const portText = input.slice(colon + 1);
  if (host.includes(":")) return undefined; // bare IPv6 without brackets is rejected
  if (!PORT_PATTERN.test(portText)) return undefined;
  const port = Number(portText);
  if (port < 1 || port > 65_535) return undefined;

  const ipFamily = isIP(host);
  if (ipFamily === 4) {
    // Canonical dotted-quad only (no leading zeros / shorthand forms).
    if (host !== host.toLowerCase() || !isCanonicalIpv4(host)) return undefined;
    return Object.freeze({ authority: `${host}:${port}`, host, port, family: 4 });
  }
  if (ipFamily === 6) {
    return undefined; // unbracketed IPv6 literal is not a canonical authority
  }
  const lowerHost = host.toLowerCase();
  if (host !== lowerHost || host.length > 253) return undefined;
  // A dotted all-numeric host that is not a canonical IPv4 literal is a
  // malformed IP alias (e.g. `01.2.3.4`, `1.2.3`), never a valid hostname.
  if (/^\d+(?:\.\d+)+$/u.test(host)) return undefined;
  const labels = host.split(".");
  if (labels.length < 1 || !labels.every((label) => HOSTNAME_LABEL.test(label))) return undefined;
  return Object.freeze({ authority: `${lowerHost}:${port}`, host: lowerHost, port, family: 0 });
}

/** True only when the authority matches at least one exact entry in EVERY non-empty allowlist. */
export function workerCellEgressAllowlistsAdmit(
  authority: CanonicalEgressAuthority,
  allowlists: readonly (readonly string[])[],
): boolean {
  const nonEmpty = allowlists.filter((list) => list.length > 0);
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every((list) =>
    list.some((entry) => {
      const parsed = parseWorkerCellEgressAuthority(entry);
      return parsed !== undefined && parsed.authority === authority.authority;
    }),
  );
}

/** Nonempty egress fails closed unless the platform proves a direct-socket bypass impossible. */
export function assertWorkerCellDirectSocketBypassImpossible(config: WorkerCellEgressConfig): void {
  const hasEgress = config.allowlists.some((list) => list.length > 0);
  if (hasEgress && !config.directSocketBypassProven) {
    throw new WorkerCellEgressDeniedError(
      "Worker cell nonempty egress fails closed: the platform has not proven a direct-socket bypass is impossible.",
    );
  }
}

function assertBounds(config: WorkerCellEgressConfig): void {
  if (
    !Number.isInteger(config.maxConnections) ||
    config.maxConnections < 1 ||
    config.maxConnections > WORKER_CELL_EGRESS_MAX_CONNECTIONS_LIMIT ||
    !Number.isInteger(config.connectDeadlineMs) ||
    config.connectDeadlineMs < 1 ||
    config.connectDeadlineMs > WORKER_CELL_EGRESS_MAX_DEADLINE_MS ||
    !Number.isInteger(config.maxBytesPerConnection) ||
    config.maxBytesPerConnection < 1 ||
    config.maxBytesPerConnection > WORKER_CELL_EGRESS_MAX_BYTES_LIMIT
  ) {
    throw new WorkerCellEgressDeniedError("Worker cell egress bounds (connections/deadline/bytes) are invalid.");
  }
}

/** Synchronous, DNS-free decision: exact authority, conjunctive allowlists, SSRF, bounds, fail-closed. */
export function evaluateWorkerCellEgressAuthority(
  target: string,
  config: WorkerCellEgressConfig,
): WorkerCellEgressEvaluation {
  try {
    assertBounds(config);
    assertWorkerCellDirectSocketBypassImpossible(config);
  } catch (error) {
    return { allowed: false, reason: error instanceof Error ? error.message : "Worker cell egress is misconfigured." };
  }
  const authority = parseWorkerCellEgressAuthority(target);
  if (!authority) {
    return {
      allowed: false,
      reason: `Worker cell egress target is not an exact canonical authority: ${redactUrlForError(target)}`,
    };
  }
  try {
    assertNotPrivateOrReservedHost(authority.host);
  } catch {
    return {
      allowed: false,
      reason: `Worker cell egress target is a private, loopback, metadata, or reserved host: ${redactUrlForError(target)}`,
    };
  }
  if (!workerCellEgressAllowlistsAdmit(authority, config.allowlists)) {
    return {
      allowed: false,
      reason: `Worker cell egress target is not admitted by all allowlists: ${redactUrlForError(target)}`,
    };
  }
  return { allowed: true, authority };
}

export function assertWorkerCellEgressAllowed(
  target: string,
  config: WorkerCellEgressConfig,
): CanonicalEgressAuthority {
  const evaluation = evaluateWorkerCellEgressAuthority(target, config);
  if (!evaluation.allowed) throw new WorkerCellEgressDeniedError(evaluation.reason);
  return evaluation.authority;
}

/**
 * Resolve the authority once, reject any mixed public/private DNS answer with no
 * loopback exception, and pin the checked IP. The caller dials the pinned
 * address directly and re-runs the policy check on every connection.
 */
export async function resolveAndPinWorkerCellEgressTarget(
  target: string,
  config: WorkerCellEgressConfig,
  dnsLookup: DnsLookupFunction = nodeDnsLookup,
): Promise<PinnedEgressTarget> {
  const authority = assertWorkerCellEgressAllowed(target, config);
  if (authority.family === 4 || authority.family === 6) {
    return Object.freeze({
      authority: authority.authority,
      host: authority.host,
      port: authority.port,
      address: authority.host,
      family: authority.family,
    });
  }
  const addresses = await resolveAllAddresses(authority.host, dnsLookup);
  if (addresses.length === 0) {
    throw new WorkerCellEgressDeniedError(
      `Worker cell egress target did not resolve to any address: ${redactUrlForError(target)}`,
    );
  }
  for (const entry of addresses) {
    try {
      assertNotPrivateOrReservedHost(entry.address);
    } catch {
      throw new WorkerCellEgressDeniedError(
        `Worker cell egress DNS answer mixes a private, metadata, or reserved address: ${redactUrlForError(target)}`,
      );
    }
  }
  const pinned = addresses[0]!;
  const family = pinned.family === 4 || pinned.family === 6 ? pinned.family : isIP(pinned.address);
  if (family !== 4 && family !== 6) {
    throw new WorkerCellEgressDeniedError(
      `Worker cell egress target resolved to a non-IP address: ${redactUrlForError(target)}`,
    );
  }
  return Object.freeze({
    authority: authority.authority,
    host: authority.host,
    port: authority.port,
    address: pinned.address,
    family,
  });
}

function resolveAllAddresses(host: string, dnsLookup: DnsLookupFunction): Promise<LookupAddress[]> {
  const options: LookupOptions = { all: true, verbatim: true };
  return new Promise((resolve, reject) => {
    dnsLookup(host, options, (error, address) => {
      if (error) {
        reject(
          new WorkerCellEgressDeniedError(`Worker cell egress DNS resolution failed for ${redactUrlForError(host)}.`),
        );
        return;
      }
      resolve(Array.isArray(address) ? address : [{ address: address as string, family: isIP(address as string) }]);
    });
  });
}

function isCanonicalIpv4(host: string): boolean {
  return host
    .split(".")
    .every(
      (octet) =>
        octet.length >= 1 && octet.length <= 3 && (octet === "0" || !octet.startsWith("0")) && Number(octet) <= 255,
    );
}

function canonicalIpv6(host: string): string | undefined {
  // Node normalizes an IPv6 literal by round-tripping through a URL host.
  try {
    const url = new URL(`http://[${host}]`);
    const normalized = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "").toLowerCase();
    return isIP(normalized) === 6 ? normalized : undefined;
  } catch {
    return undefined;
  }
}
