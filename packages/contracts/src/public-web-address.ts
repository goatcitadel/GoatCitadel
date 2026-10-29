/**
 * GoatCitadel's public web address: the https address the internet uses to reach this installation, which a channel
 * such as WhatsApp needs to name as the place it sends messages to. The operator types it once, and every channel
 * setup page builds its own full address from it.
 *
 * The problems are fixed sentences written for the person typing the address. A problem never repeats what they typed.
 */

export const PUBLIC_WEB_ADDRESS_MAX_LENGTH = 200;

export const PUBLIC_WEB_ADDRESS_NOT_URL = "Enter a full address that starts with https://.";
export const PUBLIC_WEB_ADDRESS_NOT_HTTPS =
  "Use an https:// address. Meta and the other services send only to secure addresses.";
export const PUBLIC_WEB_ADDRESS_HAS_LOGIN = "Leave the user name and password out of the address.";
export const PUBLIC_WEB_ADDRESS_HAS_EXTRA = "Leave out anything after ? or #.";
export const PUBLIC_WEB_ADDRESS_NOT_PUBLIC =
  "Use an address the internet can reach, not one on this computer or your home network.";
export const PUBLIC_WEB_ADDRESS_TOO_LONG = "Use an address under 200 characters.";

export type PublicWebAddressCheck = { ok: true; address: string } | { ok: false; problem: string };

/**
 * Trims, checks and normalizes an operator's public web address. The normalized address is the origin and the path
 * with no trailing slash: lower-case host, no port the scheme assumes, and nothing after the path.
 */
export function checkPublicWebAddress(input: string): PublicWebAddressCheck {
  const typed = input.trim();
  if (typed.length > PUBLIC_WEB_ADDRESS_MAX_LENGTH) return refused(PUBLIC_WEB_ADDRESS_TOO_LONG);

  let url: URL;
  try {
    url = new URL(typed);
  } catch {
    return refused(PUBLIC_WEB_ADDRESS_NOT_URL);
  }

  if (url.protocol !== "https:") {
    // `localhost:8080` and `example.com:8443/goat` parse with their host as the scheme. Those are addresses typed
    // without a scheme, not addresses in another scheme.
    return refused(typed.includes("://") ? PUBLIC_WEB_ADDRESS_NOT_HTTPS : PUBLIC_WEB_ADDRESS_NOT_URL);
  }
  if (url.username !== "" || url.password !== "") return refused(PUBLIC_WEB_ADDRESS_HAS_LOGIN);
  // The typed text shows a bare "?" or "#"; the parsed `search` and `hash` are empty for both.
  if (/[?#]/.test(typed)) return refused(PUBLIC_WEB_ADDRESS_HAS_EXTRA);
  if (isHostNotPublic(url.hostname)) return refused(PUBLIC_WEB_ADDRESS_NOT_PUBLIC);

  const address = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  // Percent-encoding and punycode can write a short address out longer than it was typed.
  if (address.length > PUBLIC_WEB_ADDRESS_MAX_LENGTH) return refused(PUBLIC_WEB_ADDRESS_TOO_LONG);
  return { ok: true, address };
}

/**
 * The full address of a web-address route, or undefined when no public web address is set. `path` is a route path
 * such as `/api/v1/channels/whatsapp/webhook`; the address may carry a path prefix of its own.
 */
export function publicWebAddressFor(publicWebAddress: string | undefined, path: string): string | undefined {
  if (!publicWebAddress) return undefined;
  const base = publicWebAddress.replace(/\/+$/, "");
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The Change Plan operation that sets the address, or clears it with `null`. */
export interface PublicWebAddressRuntimeOperation {
  readonly operation: "public_web_address_configuration";
  readonly config: { readonly publicWebAddress: string | null };
}

/** What a plan may carry before the owner checks it; the owner's sentence is the answer for anything longer than this. */
const PLAN_ADDRESS_MAX_LENGTH = 400;

/**
 * Shape only. The owner runs `checkPublicWebAddress` and answers a problem with its own sentence, so an address that is
 * not public is refused there and not here as a generic bad request.
 */
export function isPublicWebAddressRuntimeOperation(value: unknown): value is PublicWebAddressRuntimeOperation {
  if (!isRecord(value) || !hasOnlyKeys(value, ["operation", "config"])) return false;
  const { config } = value;
  if (value.operation !== "public_web_address_configuration" || !isRecord(config)) return false;
  if (!hasOnlyKeys(config, ["publicWebAddress"])) return false;
  const address = config.publicWebAddress;
  return (
    address === null ||
    (typeof address === "string" &&
      address.trim().length > 0 &&
      address.length <= PLAN_ADDRESS_MAX_LENGTH &&
      !address.includes("\0"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function refused(problem: string): PublicWebAddressCheck {
  return { ok: false, problem };
}

// The ranges below follow `isPrivateOrReservedHost` in packages/policy-engine/src/sandbox/network-guard.ts, which
// contracts cannot import. That guard decides which hosts the Gateway will call; this decides which addresses an
// operator may name as theirs. Keep the two lists in step when a range is added to either.

/** `hostname` as `new URL` gives it: lower-case, an IPv4 host as dotted decimal, an IPv6 host in brackets. */
function isHostNotPublic(hostname: string): boolean {
  // `localhost.` is the same host as `localhost`; `new URL` keeps the dot.
  const host = hostname.replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.startsWith("[") && host.endsWith("]")) return isIpv6NotPublic(host.slice(1, -1));
  const octets = ipv4Octets(host);
  return octets !== undefined && isIpv4NotPublic(octets);
}

function ipv4Octets(host: string): readonly [number, number, number, number] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return undefined;
  const [a, b, c, d] = match.slice(1).map(Number);
  return a === undefined || b === undefined || c === undefined || d === undefined ? undefined : [a, b, c, d];
}

/** 0.0.0.0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12 and 192.168/16. */
function isIpv4NotPublic([a, b]: readonly [number, number, number, number]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

/** `::`, `::1`, fc00::/7, fe80::/10, and an IPv4-mapped address (::ffff:0:0/96) whose IPv4 address is not public. */
function isIpv6NotPublic(literal: string): boolean {
  const groups = ipv6Groups(literal);
  if (groups === undefined) return false;
  const [g0 = 0, , , , , g5 = 0, g6 = 0, g7 = 0] = groups;
  if (groups.slice(0, 7).every((group) => group === 0) && g7 <= 1) return true;
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if (groups.slice(0, 5).every((group) => group === 0) && g5 === 0xffff) {
    return isIpv4NotPublic([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  return false;
}

/**
 * The eight 16-bit groups of an IPv6 literal. `new URL` writes a host in hex with at most one "::", but a dotted
 * IPv4 tail (`::ffff:192.168.1.5`) is read too, in case one arrives from somewhere that has not been through it.
 */
function ipv6Groups(literal: string): readonly number[] | undefined {
  let text = literal.toLowerCase();
  const dotted = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted) {
    const octets = ipv4Octets(dotted[2] ?? "");
    if (octets === undefined || octets.some((octet) => octet > 255)) return undefined;
    text = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = hexGroups(halves[0] ?? "");
  const tail = halves.length === 2 ? hexGroups(halves[1] ?? "") : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? undefined : [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function hexGroups(side: string): number[] | undefined {
  if (side === "") return [];
  const groups: number[] = [];
  for (const part of side.split(":")) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}
