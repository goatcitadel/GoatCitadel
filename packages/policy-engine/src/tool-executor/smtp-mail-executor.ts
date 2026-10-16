import { lookup as nodeDnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import { assertHostAllowed, createGuardedDnsLookup, type DnsLookupFunction } from "../sandbox/network-guard.js";
import { CommsPreBoundaryProviderError } from "./comms-provider-errors.js";

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_SMTP_PORT = 465;
const SMTP_CONNECTION_TIMEOUT_MS = 20_000;
const SMTP_GREETING_TIMEOUT_MS = 20_000;
const SMTP_SOCKET_TIMEOUT_MS = 60_000;
const SMTP_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;
/** nodemailer error codes that are only raised before the DATA command, so nothing was sent. */
const SMTP_PRE_DATA_ERROR_CODES = new Set(["EDNS", "ETLS", "EAUTH", "ENOAUTH", "EENVELOPE"]);
const SMTP_AUTH_ERROR_CODES = new Set(["EAUTH", "ENOAUTH"]);
const MAX_SMTP_ERROR_DETAIL_CHARS = 300;

export interface SmtpTransportOptions {
  /** The resolved, guard-checked address the transport connects to. */
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  /** Keeps SNI and certificate verification bound to the configured hostname. */
  tls?: { servername: string };
}

export interface SmtpOutboundMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
}

export interface SmtpTransportFactory {
  (options: SmtpTransportOptions): { sendMail(message: SmtpOutboundMessage): Promise<{ messageId?: string }> };
}

/** Executor-owned capabilities the comms dispatcher passes in, so this module never imports it back. */
export interface SmtpSendRuntime {
  resolveSecret(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined;
  /** Marks the comms mutation boundary; called once, after every validation, immediately before sending. */
  markMutationRequestStarted(): Promise<void>;
  createTransport?: SmtpTransportFactory;
  dnsLookup?: DnsLookupFunction;
}

/**
 * Default transport: nodemailer connected to the guard-resolved address. STARTTLS is
 * mandatory on non-implicit-TLS ports so credentials and mail never cross in clear
 * text, and message-level file/URL access is disabled so no content can pull local
 * files or remote URLs into the outbound message.
 */
const createNodemailerTransport: SmtpTransportFactory = (options) =>
  nodemailer.createTransport({
    host: options.host,
    port: options.port,
    secure: options.secure,
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.tls ? { tls: options.tls } : {}),
    requireTLS: !options.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

/**
 * Sends one plain-text message through the IMAP/SMTP account's configured SMTP
 * server and returns the provider messageId. Every validation, including the
 * guarded DNS resolution, runs before the transport exists; the comms mutation
 * boundary is marked immediately before `sendMail`. A failure nodemailer reports
 * before DATA is a pre-boundary failure; any other failure is an unknown outcome.
 */
export async function smtpSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist: string[] | undefined,
  runtime: SmtpSendRuntime,
): Promise<string> {
  const host = resolveSmtpHost(config);
  assertSmtpHostAllowed(host, allowlist, grantAllowlist);
  const port = resolveSmtpPort(config.smtpPort);
  const secure = typeof config.smtpSecure === "boolean" ? config.smtpSecure : port === IMPLICIT_TLS_SMTP_PORT;
  const user = readString(config.smtpUser);
  const pass = runtime.resolveSecret(config, "smtpPassword", "smtpPasswordEnv");
  if (user && !pass) {
    throw new Error("Missing SMTP password: smtpPassword or smtpPasswordEnv is not configured.");
  }
  const message = buildSmtpMessage(config, args);
  const address = await resolveGuardedSmtpAddress(host, allowlist, runtime.dnsLookup ?? nodeDnsLookup);

  const createTransport = runtime.createTransport ?? createNodemailerTransport;
  const transport = createTransport({
    host: address,
    port,
    secure,
    ...(user && pass ? { auth: { user, pass } } : {}),
    ...(isIP(host) === 0 ? { tls: { servername: host } } : {}),
  });
  await runtime.markMutationRequestStarted();
  let info: { messageId?: string };
  try {
    info = await transport.sendMail(message);
  } catch (error) {
    throw classifySmtpSendFailure(error);
  }
  return readString(info.messageId) ?? `smtp-${Date.now()}`;
}

function buildSmtpMessage(config: Record<string, unknown>, args: Record<string, unknown>): SmtpOutboundMessage {
  const from = readString(config.fromAddress) ?? readString(config.address) ?? readString(config.email);
  if (!from) {
    throw new Error("smtp.send requires a configured from address (fromAddress, address, or email).");
  }
  const to = readStringList(args.to);
  if (to.length === 0) {
    throw new Error("smtp.send requires args.to");
  }
  const subject = requireString(args.subject, "subject");
  const text = requireString(args.bodyText, "bodyText");
  const cc = readStringList(args.cc);
  const bcc = readStringList(args.bcc);
  return {
    from,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    subject,
    text,
  };
}

function resolveSmtpHost(config: Record<string, unknown>): string {
  const host = readString(config.smtpHost);
  if (!host) {
    throw new Error("Missing SMTP host: smtpHost is not configured.");
  }
  if (!SMTP_HOSTNAME_PATTERN.test(host)) {
    throw new Error("Invalid smtpHost: expected a bare hostname or IPv4 address without port, path, or credentials.");
  }
  return host.toLowerCase();
}

function assertSmtpHostAllowed(host: string, allowlist: string[], grantAllowlist?: string[]): void {
  // Same host matcher fetchAllowlisted applies to every HTTP hop, evaluated against
  // the SMTP host as an https origin so allowlist patterns mean the same thing here.
  const origin = `https://${host}/`;
  try {
    assertHostAllowed(origin, allowlist);
    if (grantAllowlist && grantAllowlist.length > 0) {
      assertHostAllowed(origin, grantAllowlist);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`blocked: smtp.send host is not allowlisted. ${detail}`, { cause: error });
  }
}

/**
 * Resolves the SMTP host through the same guarded lookup the HTTP egress dispatcher
 * uses (DNS-rebinding and private/metadata-address defense), so the transport only
 * ever connects to an address that passed the guard.
 */
function resolveGuardedSmtpAddress(host: string, allowlist: string[], dnsLookup: DnsLookupFunction): Promise<string> {
  const guardedLookup = createGuardedDnsLookup(`https://${host}/`, allowlist, dnsLookup);
  return new Promise<string>((resolve, reject) => {
    guardedLookup(host, { all: true }, (error, address) => {
      const resolved = Array.isArray(address) ? (address as LookupAddress[])[0]?.address : address;
      if (error || !resolved) {
        const detail = error ? error.message : "no address returned";
        reject(new Error(`blocked: smtp.send host failed guarded DNS resolution. ${detail}`, { cause: error }));
        return;
      }
      resolve(resolved);
    });
  });
}

function classifySmtpSendFailure(error: unknown): unknown {
  if (!error || typeof error !== "object") {
    return error;
  }
  // ECONNECTION is deliberately absent: nodemailer raises ECONNECTION/CONN for any
  // unexpected close, including one after the body was streamed, so it may have sent.
  const { code } = error as { code?: unknown };
  if (typeof code !== "string" || !SMTP_PRE_DATA_ERROR_CODES.has(code)) {
    return error;
  }
  const detail = truncate(error instanceof Error ? error.message : String(error));
  const message = SMTP_AUTH_ERROR_CODES.has(code)
    ? `blocked: SMTP server rejected the configured credentials (${String(code)}); nothing was sent. ${detail}`
    : `smtp.send failed before the message was sent (${String(code)}); nothing was sent. ${detail}`;
  return new CommsPreBoundaryProviderError(message, { cause: error });
}

function truncate(value: string): string {
  return value.length > MAX_SMTP_ERROR_DETAIL_CHARS ? `${value.slice(0, MAX_SMTP_ERROR_DETAIL_CHARS)}…` : value;
}

function resolveSmtpPort(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_SMTP_PORT;
  }
  const port = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid smtpPort: expected an integer between 1 and 65535.");
  }
  return port;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requireString(value: unknown, field: string): string {
  const parsed = readString(value);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry)).filter((entry): entry is string => Boolean(entry));
}
