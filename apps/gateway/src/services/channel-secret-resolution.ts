import type { ChannelSetupDraft, IntegrationConnection } from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { ChannelEnvSecretRequest, ChannelEnvSecretResolution } from "@goatcitadel/policy-engine";
import { parseChannelSecretRef } from "./channel-secret-custody-service.js";
import {
  envNameForLog,
  isPermittedIntegrationSecretEnvVarName,
  refusedEnvVarNameMessage,
} from "./gateway/integration-secret-envvar-guard.js";

const log = logger.child("channel-secret-resolution");

const CHANNEL_SECRET_ENV_PATTERNS: readonly RegExp[] = [
  /^(?:SLACK|DISCORD|TELEGRAM|WHATSAPP|LINE|NEXTCLOUD|QQBOT|WECOM)(?:_[A-Z0-9]+)*_(?:WEBHOOK_SECRET|AES_KEY|SIGNING_SECRET|CHANNEL_SECRET|BOT_SECRET|APP_SECRET|VERIFY_TOKEN|SECRET_TOKEN|TOKEN|SECRET)$/,
  /^(?:WEBHOOK_SECRET|CHANNEL_SECRET)(?:_[A-Z0-9]+)?$/,
  /^(?:GOATCITADEL|GC)_(?:SLACK|DISCORD|TELEGRAM|WHATSAPP|LINE|NEXTCLOUD|QQBOT|WECOM)(?:_[A-Z0-9]+)*_(?:WEBHOOK_SECRET|AES_KEY|SIGNING_SECRET|CHANNEL_SECRET|BOT_SECRET|APP_SECRET|VERIFY_TOKEN|SECRET_TOKEN|TOKEN|SECRET)$/,
];

const TELEGRAM_BOT_TOKEN_ENV_PATTERNS: readonly RegExp[] = [
  /^TELEGRAM_BOT_TOKEN$/,
  /^TELEGRAM(?:_[A-Z0-9]+)*_TOKEN$/,
  /^TELEGRAM_[A-Z0-9]+_BOT_TOKEN$/,
  /^GOATCITADEL_TELEGRAM_BOT_TOKEN$/,
  /^GOATCITADEL_TELEGRAM(?:_[A-Z0-9]+)*_TOKEN$/,
  /^GOATCITADEL_TELEGRAM_[A-Z0-9]+_BOT_TOKEN$/,
  /^GC_TELEGRAM_BOT_TOKEN$/,
  /^GC_TELEGRAM(?:_[A-Z0-9]+)*_TOKEN$/,
  /^GC_TELEGRAM_[A-Z0-9]+_BOT_TOKEN$/,
];

/** Reads the key a reference points to in secure storage; undefined when the reference cannot be used. */
export type ChannelSecretReferenceResolver = (secretRef: string) => string | undefined;

/**
 * Whose saved keys a read may return. A connection owns the references saved under its id. A setup draft owns the
 * ones saved under its draft id as well, and an edit draft is both: its saved connection and itself. Nobody owns a
 * reference that names someone else, and a read with no owner returns no key.
 *
 * A connection is its own owner, so a caller that holds one can pass it as is.
 */
export interface ChannelSecretOwner {
  readonly connectionId: string;
  readonly draftId?: string;
}

/** Reads the key a reference points to for its owner; the owner has already been checked against the reference. */
export type ChannelSecretReferenceReader = (secretRef: string, owner: ChannelSecretOwner) => string | undefined;

/** Where every secure-storage reference starts. A value that starts this way is a pointer, never a secret. */
const SECRET_REFERENCE_PREFIX = "keychain:goatcitadel:";
/** Where every reference the channel setup saves starts: a connection's own, or a setup draft's temporary one. */
const CHANNEL_SECRET_REFERENCE_PREFIX = `${SECRET_REFERENCE_PREFIX}channel-`;

/** Whether a config value points into secure storage. Such a value is a pointer, never a secret, whatever it says. */
export function isSecureStorageReference(value: string): boolean {
  return value.trim().startsWith(SECRET_REFERENCE_PREFIX);
}

/**
 * Whether a config value is a reference the channel setup saved. This is the only kind of reference a channel read
 * resolves: every other secure-storage reference (a provider key, an approval token) is nobody's to read here.
 */
export function isChannelSecretReference(value: string): boolean {
  return value.trim().startsWith(CHANNEL_SECRET_REFERENCE_PREFIX);
}

/** The owner a setup draft reads as: the connection it will have (or already has), and itself. */
export function channelSecretOwnerForDraft(
  draft: Pick<ChannelSetupDraft, "draftId" | "connectionId">,
): ChannelSecretOwner {
  // The setup test's connection takes this id (`buildEphemeralChannelConnection`), and a new draft's id is the id its
  // connection will have, so the two always agree.
  return { connectionId: draft.connectionId ?? draft.draftId, draftId: draft.draftId };
}

function isUsableId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Whether a parsed reference names this owner: a connection reference by its connection id, a draft's by its draft id. */
function parsedReferenceBelongsTo(
  parsed: { custody: "temporary" | "connection"; ownerId: string },
  owner: ChannelSecretOwner | undefined,
): boolean {
  if (!isUsableId(owner?.connectionId)) {
    return false;
  }
  if (parsed.custody === "connection") {
    return parsed.ownerId === owner.connectionId.trim();
  }
  return isUsableId(owner.draftId) && parsed.ownerId === owner.draftId.trim();
}

/**
 * Whether a secure-storage reference was saved for this owner. Anything that is not a well-formed channel reference
 * (plain text, a reference with a bad or missing owner part, an approval token reference) is nobody's.
 */
export function isChannelSecretReferenceOwnedBy(reference: string, owner: ChannelSecretOwner | undefined): boolean {
  try {
    return parsedReferenceBelongsTo(parseChannelSecretRef(reference), owner);
  } catch {
    return false;
  }
}

export function resolveTelegramWebhookSecret(
  config: Record<string, unknown>,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  return (
    readConfigSecret(config, "webhookSecret", "webhookSecretEnv", resolveReference) ??
    readConfigSecret(config, "secretToken", "secretTokenEnv", resolveReference) ??
    readConfigSecret(config, "botSecret", "botSecretEnv", resolveReference)
  );
}

/**
 * Limits a reference reader to the keys one connection saved for itself (and, when a draft id is given, the ones that
 * draft saved). A reference to another connection or draft, one the reader cannot resolve, a failing read and a
 * missing reader all give no key: the reference text is never a credential, and a read failure is dropped so its
 * message cannot reach a response or a log. The reader is told the owner, so it can hand it to the shared read.
 */
export function createConnectionSecretReferenceResolver(
  connectionId: string,
  readReference: ChannelSecretReferenceReader | undefined,
  draftId?: string,
): ChannelSecretReferenceResolver {
  const owner: ChannelSecretOwner = draftId === undefined ? { connectionId } : { connectionId, draftId };
  return (secretRef) => {
    const reference = secretRef.trim();
    if (!readReference || !isChannelSecretReferenceOwnedBy(reference, owner)) {
      return undefined;
    }
    try {
      return readReference(reference, owner)?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
}

function readTrimmedConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Reads a saved channel reference for its owner: the stored key when the reference was saved for this owner, nothing
 * otherwise. A refusal is logged by kind only, never with the reference or a key. The log names the connection that was
 * reading (`owner.connectionId`), so an operator can find the one that holds a planted reference; the id the reference
 * names, which belongs to someone else, is never logged.
 */
function readOwnedChannelSecretReference(
  secrets: { getSecret(account: string): string | undefined },
  reference: string,
  owner: ChannelSecretOwner,
  logContext: { directKey: string; catalogId: string | undefined },
): string | undefined {
  const readerContext = { ...logContext, connectionId: owner?.connectionId };
  let parsed: ReturnType<typeof parseChannelSecretRef>;
  try {
    parsed = parseChannelSecretRef(reference);
  } catch {
    log.warn("Refusing to resolve an invalid channel credential reference.", readerContext);
    return undefined;
  }
  if (!parsedReferenceBelongsTo(parsed, owner)) {
    log.warn("Refusing to resolve a channel credential reference that belongs to another connection or draft.", {
      ...readerContext,
      referenceKind: parsed.custody === "temporary" ? "draft" : "connection",
    });
    return undefined;
  }
  try {
    return secrets.getSecret(parsed.account)?.trim() || undefined;
  } catch {
    // The store's error text is dropped: it could name the account or hold part of the key.
    log.warn("Could not read a saved channel credential from secure storage.", readerContext);
    return undefined;
  }
}

/**
 * The one read of a connection's secret from its config: the direct value, else the variable the config names.
 *
 * A direct value that is a channel secure-storage reference is replaced by the key it points to, but only when that
 * reference was saved for `owner` (the connection or setup draft this config belongs to). Any other secure-storage
 * reference (a provider key, an approval token) gives no key either. Neither falls back to the variable the config
 * names, and the reference text is never returned. With no owner, no reference is read.
 *
 * SECURITY (codex finding #13, #23): the `envKey` field on integration connections used to accept arbitrary env-var
 * names. Lower-privileged authenticated principals could create a productivity.apple-notes or Matrix connection with
 * `authTokenEnv: "OPENAI_API_KEY"` and then trigger an action/diagnostic that sent `Authorization: Bearer
 * <OPENAI_API_KEY>` to an attacker-controlled URL. Env-var names are therefore bound to the connection's catalog
 * convention, and broadly-scoped gateway/infra secrets are refused. The same principals could name another
 * connection's reference in their config and point the connection at a server they run; hence the owner check.
 */
export function resolveConnectionConfigSecret(
  secrets: { getSecret(account: string): string | undefined },
  config: Record<string, unknown>,
  directKey: string,
  envKey: string,
  catalogId: string | undefined,
  owner: ChannelSecretOwner,
): string | undefined {
  const direct = readTrimmedConfigString(config, directKey);
  if (direct) {
    if (isChannelSecretReference(direct)) {
      return readOwnedChannelSecretReference(secrets, direct, owner, { directKey, catalogId });
    }
    if (isSecureStorageReference(direct)) {
      // A pointer is never a credential: its text would go out as a bearer token, and nobody owns it here.
      log.warn("Refusing to resolve a secure-storage reference that is not a channel credential reference.", {
        directKey,
        catalogId,
        connectionId: owner?.connectionId,
        referenceKind: "other",
      });
      return undefined;
    }
    return direct;
  }
  const envName = readTrimmedConfigString(config, envKey);
  if (!envName) {
    return undefined;
  }
  if (!isPermittedIntegrationSecretEnvVarName(envName, catalogId)) {
    log.warn("Refusing to resolve integration secret from an unbound env var name (codex finding #13/#23).", {
      envName: envNameForLog(envName),
      directKey,
      envKey,
      catalogId,
    });
    return undefined;
  }
  return process.env[envName];
}

export function isTelegramApprovalActionConnectionReady(connection: IntegrationConnection): boolean {
  return (
    connection.kind === "channel" &&
    connection.key === "telegram" &&
    connection.enabled &&
    connection.status === "connected" &&
    Boolean(resolveTelegramWebhookSecret(connection.config))
  );
}

export async function isTelegramApprovalActionConnectorReady(
  connections: { get(connectionId: string): Promise<IntegrationConnection> },
  connectionId: string,
): Promise<boolean> {
  try {
    return isTelegramApprovalActionConnectionReady(await connections.get(connectionId));
  } catch {
    return false;
  }
}

export function isAllowedSecretEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim();
  return (
    trimmedEnvName === trimmedEnvName.toUpperCase() &&
    CHANNEL_SECRET_ENV_PATTERNS.some((pattern) => pattern.test(trimmedEnvName))
  );
}

export function isAllowedTelegramBotTokenEnvName(envName: string): boolean {
  const trimmedEnvName = envName.trim();
  return (
    trimmedEnvName === trimmedEnvName.toUpperCase() &&
    TELEGRAM_BOT_TOKEN_ENV_PATTERNS.some((pattern) => pattern.test(trimmedEnvName))
  );
}

/**
 * Resolve an environment-variable secret by name, but only when the name matches the
 * channel-secret allowlist. Use this whenever the env-var NAME can be influenced by a
 * request. Keep generic GOATCITADEL_* / GC_* names out of this path; field-specific
 * secrets must opt in to a narrower resolver such as resolveTelegramBotTokenEnvSecret.
 */
export function resolveAllowlistedEnvSecret(envName: string | undefined): string | undefined {
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  if (!isAllowedSecretEnvName(envName)) {
    return undefined;
  }
  const resolved = process.env[envName.trim()];
  return resolved?.trim() ? resolved.trim() : undefined;
}

/**
 * Reads the variable a channel connection names for a send, but only when the name passes the same credential rule the
 * setup test and the live probes use (`isPermittedIntegrationSecretEnvVarName`, bound to the connection's catalog entry).
 * A connection config must not be able to carry an LLM or Gateway key to the server address it names, so a refused name
 * gives a plain sentence that holds neither the name nor a value, and nothing is read.
 */
export function resolveChannelSendEnvSecret(input: ChannelEnvSecretRequest): ChannelEnvSecretResolution {
  const envName = input.envName.trim();
  if (!isPermittedIntegrationSecretEnvVarName(envName, input.catalogId)) {
    return { refusal: refusedEnvVarNameMessage(input.catalogId) };
  }
  return { value: process.env[envName]?.trim() || undefined };
}

export function resolveTelegramBotTokenEnvSecret(envName: string | undefined): string | undefined {
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  if (!isAllowedTelegramBotTokenEnvName(envName)) {
    return undefined;
  }
  const resolved = process.env[envName.trim()];
  return resolved?.trim() ? resolved.trim() : undefined;
}

/**
 * Reads a channel secret from its direct config field, else from an allowlisted env var. With a resolver, a direct
 * value that is a secure-storage reference is replaced by the key it points to, and is missing when the resolver
 * gives none; the reference is never returned as the secret. Without one, direct values come back as saved.
 */
export function readConfigSecret(
  config: Record<string, unknown>,
  key: string,
  envKey: string,
  resolveReference?: ChannelSecretReferenceResolver,
): string | undefined {
  const direct = config[key];
  if (typeof direct === "string" && direct.trim().length > 0) {
    const value = direct.trim();
    return resolveReference && value.startsWith(SECRET_REFERENCE_PREFIX) ? resolveReference(value) : value;
  }
  const envName = config[envKey];
  if (typeof envName !== "string" || envName.trim().length === 0) {
    return undefined;
  }
  return resolveAllowlistedEnvSecret(envName);
}
