import nodemailer from "nodemailer";
import { assertHostAllowed } from "../sandbox/network-guard.js";
import { markCommsMutationRequestStarted, secretFrom } from "./comms-executor.js";

const DEFAULT_SMTP_PORT = 587;
const IMPLICIT_TLS_SMTP_PORT = 465;
const SMTP_CONNECTION_TIMEOUT_MS = 20_000;
const SMTP_GREETING_TIMEOUT_MS = 20_000;
const SMTP_SOCKET_TIMEOUT_MS = 60_000;
const SMTP_HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/iu;

export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
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

/**
 * Default transport: nodemailer pinned to exactly the configured host. STARTTLS is
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
    requireTLS: !options.secure,
    connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
    greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
    socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

/**
 * Sends one plain-text message through the IMAP/SMTP account's configured SMTP
 * server and returns the provider messageId. Every validation runs before the
 * transport exists; the comms mutation boundary is marked immediately before
 * `sendMail`, so any failure after that point is an unknown external outcome.
 */
export async function smtpSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
  createTransport: SmtpTransportFactory = createNodemailerTransport,
): Promise<string> {
  const host = resolveSmtpHost(config);
  assertSmtpHostAllowed(host, allowlist, grantAllowlist);
  const port = resolveSmtpPort(config.smtpPort);
  const secure = typeof config.smtpSecure === "boolean" ? config.smtpSecure : port === IMPLICIT_TLS_SMTP_PORT;
  const user = readString(config.smtpUser);
  const pass = secretFrom(config, "smtpPassword", "smtpPasswordEnv");
  if (user && !pass) {
    throw new Error("Missing SMTP password: smtpPassword or smtpPasswordEnv is not configured.");
  }
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
  const message: SmtpOutboundMessage = {
    from,
    to,
    ...(cc.length > 0 ? { cc } : {}),
    ...(bcc.length > 0 ? { bcc } : {}),
    subject,
    text,
  };

  const transport = createTransport({ host, port, secure, ...(user && pass ? { auth: { user, pass } } : {}) });
  await markCommsMutationRequestStarted();
  const info = await transport.sendMail(message);
  return readString(info.messageId) ?? `smtp-${Date.now()}`;
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
