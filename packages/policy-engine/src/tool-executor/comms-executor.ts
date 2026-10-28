/* eslint-disable max-lines -- Channel and outbound connector execution is split from the policy orchestrator, but the provider family is still broad. */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomBytes, randomInt } from "node:crypto";
import type {
  ChannelDeliveryStatus,
  GmailMessageSummary,
  ToolInvokeRequest,
  ToolPolicyConfig,
} from "@goatcitadel/contracts";
import {
  GMAIL_SUMMARY_HEADERS,
  GMAIL_UNTRUSTED_CONTENT_NOTICE,
  NTFY_OUTBOUND_MARKER_TAG,
  clampInt,
  coerceRetryAfterMs,
  describeChannelPlatformUnsupported,
  describeRetiredChannel,
  sanitizeChannelOutboundMessage,
  summarizeGmailMessage,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { assertHostAllowed, fetchAllowlistedOnce, redactUrlForError } from "../sandbox/network-guard.js";
import { assertSafeRedirectTransition, isHttpRequestSafeToRetry } from "../sandbox/http-request-policy.js";
import { sanitizeForAudit } from "../tool-security.js";
import { assertNoRawRemoteApprovalBearer } from "../approval-action-secrets.js";
import {
  createCommsProviderReceipt,
  markCommsProviderFailed,
  markCommsProviderSent,
} from "./channel-delivery-part-execution.js";
import { CommsPreBoundaryProviderError } from "./comms-provider-errors.js";
import { smtpSend } from "./smtp-mail-executor.js";
import {
  GOOGLE_CHAT_MESSAGE_NAME_PATTERN,
  GOOGLE_CHAT_SPACE_NAME_PATTERN,
  GOOGLE_CHAT_THREAD_NAME_PATTERN,
  assertGoogleChatMessageName,
  deleteGoogleChatAppMessage,
  readGoogleChatMessageThread,
  sendGoogleChatAppMessage,
} from "./google-chat-service-account.js";
import {
  deriveMatrixTxnId,
  matrixReact,
  matrixRedact,
  matrixSendText,
  type MatrixClientContext,
} from "./matrix-client.js";
import { clearQqbotAccessToken, getQqbotAccessToken, qqbotPassiveReplyLimit, qqbotSendText } from "./qqbot-client.js";
import { clearWecomAccessToken, getWecomAccessToken, wecomSendText } from "./wecom-client.js";

const MAX_HTTP_REDIRECTS = 5;
const MAX_HTTP_RETRIES = 2;
const MAX_HTTP_RETRY_DELAY_MS = 50;
const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const commsRequestBoundaryContext = new AsyncLocalStorage<{
  mutationRequestStarted: boolean;
  mutationResponseReceived: boolean;
  externalBoundaryReported: boolean;
  beforeExternalSideEffect?: () => void | Promise<void>;
}>();

interface ApprovalActionSecretRuntime {
  resolveApprovalActionTokenSecret?: (secretRef: string) => string;
  deleteApprovalActionTokenSecret?: (secretRef: string) => void;
  isApprovalActionConnectorReady?: (connectionId: string) => Promise<boolean>;
  beforeExternalSideEffect?: () => void | Promise<void>;
  resolveGoogleWorkspaceAccessToken?: (input: { connectionId: string; toolName: string }) => Promise<string>;
  /** Reads the key a channel connection saved in secure storage; undefined when nothing is stored for it. */
  resolveChannelConnectionSecret?: (secretRef: string) => string | undefined;
}

/** Every GoatCitadel secure-storage reference starts here; on a send, such a value is never a credential itself. */
const KEYCHAIN_REF_PREFIX = "keychain:goatcitadel:";
/** Where the secure-storage references of a channel connection start; the connection id and a colon follow. */
const CHANNEL_CONNECTION_SECRET_REF_PREFIX = `${KEYCHAIN_REF_PREFIX}channel-connection:`;
/** A stored key with one of these cannot travel in a header, and the request layer would quote it in its error. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
/** Saved keys that are documents read on this machine (a Google service-account JSON), never sent as a header. */
const STRUCTURED_SECRET_FIELDS: ReadonlySet<string> = new Set(["serviceAccountKey"]);

export async function executeCommsTool(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  grantAllowlist?: string[],
  approvalActionSecrets: ApprovalActionSecretRuntime = {},
): Promise<Record<string, unknown>> {
  return commsRequestBoundaryContext.run(
    {
      mutationRequestStarted: false,
      mutationResponseReceived: false,
      externalBoundaryReported: false,
      beforeExternalSideEffect: approvalActionSecrets.beforeExternalSideEffect,
    },
    () => executeCommsToolWithBoundaryTracking(request, config, storage, grantAllowlist, approvalActionSecrets),
  );
}

async function executeCommsToolWithBoundaryTracking(
  request: ToolInvokeRequest,
  config: ToolPolicyConfig,
  storage: AsyncStorage,
  grantAllowlist?: string[],
  approvalActionSecrets: ApprovalActionSecretRuntime = {},
): Promise<Record<string, unknown>> {
  const toolName = request.toolName;
  const args = request.args;
  assertNoRawRemoteApprovalBearer(args);
  const connectionId = required(args.connectionId, "connectionId");
  const connection = await storage.integrationConnections.get(connectionId);
  const scopedKey =
    (toolName === "channel.send" || toolName === "channel.unsend") && connection.key === "ntfy"
      ? "ntfy"
      : (toolName === "channel.send" || toolName === "channel.unsend" || toolName === "channel.react") &&
          connection.key === "matrix"
        ? "matrix"
        : undefined;
  if (
    scopedKey &&
    (connection.kind !== "channel" ||
      (connection.workspaceId !== undefined && connection.workspaceId !== request.workspaceId))
  ) {
    throw new Error(`The canonical ${scopedKey} connection scope changed before dispatch.`);
  }
  const connectionConfig = record(connection.config);
  const target =
    asString(args.target) ?? resolveDefaultChannelTarget(connection.key, connectionConfig) ?? connection.key;
  const message = asString(args.message) ?? "";
  const receipt = await createCommsProviderReceipt(storage, request, {
    connectionId,
    channelKey: connection.key,
    target,
    // Provider execution keeps the raw in-memory arguments, but the delivery
    // ledger must never retain bearer material embedded in interactive actions.
    payload: sanitizeForAudit({ toolName, args }),
  });
  const queued = receipt.delivery;
  let providerMessageId: string | undefined;
  let protectedApprovalTokenRef: string | undefined;
  try {
    assertIntegrationConnectionAvailable(connection);
    if (toolName === "gmail.read") {
      const accessToken = await resolveGoogleWorkspaceToken(approvalActionSecrets, connectionId, toolName);
      const read = await gmailRead(accessToken, args, config.sandbox.networkAllowlist, grantAllowlist);
      await markCommsProviderSent(storage, receipt, "gmail-read");
      return { ...queued, status: "sent", deliveryStatus: "sent", providerMessageId: "gmail-read", ...read };
    }
    if (toolName === "calendar.list") {
      const accessToken = await resolveGoogleWorkspaceToken(approvalActionSecrets, connectionId, toolName);
      const records = await calendarList(accessToken, args, config.sandbox.networkAllowlist, grantAllowlist);
      await markCommsProviderSent(storage, receipt, "calendar-list");
      return { ...queued, status: "sent", deliveryStatus: "sent", providerMessageId: "calendar-list", records };
    }
    const providerRequest = await hydrateProtectedApprovalActionAtProviderBoundary(
      request,
      connection.connectionId,
      connection.key,
      storage,
      approvalActionSecrets,
    );
    protectedApprovalTokenRef = providerRequest.secretRef;
    // Resolved before any provider request, so a missing or refused sign-in stays pre-boundary.
    const googleAccessToken = isGoogleWorkspaceWriteTool(toolName)
      ? await resolveGoogleWorkspaceToken(approvalActionSecrets, connectionId, toolName)
      : undefined;
    // Held only for this provider call; the stored connection and everything recorded below keep the references.
    // Gmail and Calendar writes use the Google sign-in above and never read the config's saved keys.
    const providerConfig = googleAccessToken
      ? connectionConfig
      : resolveSavedChannelSecrets(connection, connectionConfig, approvalActionSecrets);
    providerMessageId = await executeCommsProviderTool(
      toolName,
      connection.key,
      providerConfig,
      providerRequest.args,
      config.sandbox.networkAllowlist,
      grantAllowlist,
      target,
      message,
      googleAccessToken,
    );
    await markCommsProviderSent(storage, receipt, providerMessageId);
    deleteApprovalActionTokenBestEffort(approvalActionSecrets, protectedApprovalTokenRef);
    return {
      ...queued,
      status: "sent",
      deliveryStatus: "sent",
      providerMessageId,
      updatedAt: new Date().toISOString(),
    };
  } catch (error) {
    let errorMessage = (error as Error).message;
    const boundaryState = commsRequestBoundaryContext.getStore();
    // A provider that proves its failure preceded any delivery is pre-boundary even
    // when the boundary was already marked (SMTP spans connect/auth/data in one call).
    const mutationRequestStarted =
      boundaryState?.mutationRequestStarted === true && !(error instanceof CommsPreBoundaryProviderError);
    const initialStatus = classifyChannelDeliveryFailure(errorMessage);
    const failureProviderMessageId = readChannelFailureProviderMessageId(error);
    providerMessageId = failureProviderMessageId ?? providerMessageId;
    if (providerMessageId && !failureProviderMessageId) {
      errorMessage =
        `post_send_bookkeeping_failed: provider dispatch completed as ${providerMessageId}, but delivery ledger finalization failed; ` +
        `manual reconciliation required. ${errorMessage}`;
    } else if (
      !isReadOnlyCommsTool(toolName) &&
      mutationRequestStarted &&
      (boundaryState?.mutationResponseReceived || (initialStatus !== "blocked" && initialStatus !== "not_available")) &&
      initialStatus !== "manual_reconciliation_required"
    ) {
      errorMessage = channelUnknownAfterSendError(toolName, errorMessage).message;
    }
    const classifiedStatus = classifyChannelDeliveryFailure(errorMessage);
    const deliveryStatus =
      !isReadOnlyCommsTool(toolName) && !mutationRequestStarted && classifiedStatus === "degraded"
        ? "not_available"
        : classifiedStatus;
    if (protectedApprovalTokenRef && (providerMessageId || deliveryStatus === "manual_reconciliation_required")) {
      deleteApprovalActionTokenBestEffort(approvalActionSecrets, protectedApprovalTokenRef);
    }
    try {
      await markCommsProviderFailed(storage, receipt, { error: errorMessage, deliveryStatus, providerMessageId });
    } catch (persistenceError) {
      const detail = persistenceError instanceof Error ? persistenceError.message : String(persistenceError);
      errorMessage = `${errorMessage} Failed to persist the delivery failure state: ${detail}`;
    }
    return {
      ...queued,
      status: "failed",
      deliveryStatus,
      providerMessageId,
      error: errorMessage,
      fallbackReason: errorMessage,
      updatedAt: new Date().toISOString(),
    };
  }
}

async function hydrateProtectedApprovalActionAtProviderBoundary(
  request: ToolInvokeRequest,
  connectionId: string,
  connectionKey: string,
  storage: AsyncStorage,
  runtime: ApprovalActionSecretRuntime,
): Promise<{ args: Record<string, unknown>; secretRef?: string }> {
  const templateValue = request.args.interactiveActionTemplate;
  if (templateValue === undefined) {
    assertNoRawRemoteApprovalBearer(request.args);
    return { args: request.args };
  }
  if (request.args.interactiveActions !== undefined) {
    throw new Error("blocked: Protected approval actions cannot include pre-hydrated callback data.");
  }
  if (request.toolName !== "channel.send" && request.toolName !== "telegram.send") {
    throw new Error("Protected approval actions are only supported for channel sends.");
  }
  if (connectionKey !== "telegram") {
    throw new Error(`Inline approval actions are not supported by ${connectionKey}.`);
  }
  if (!templateValue || typeof templateValue !== "object" || Array.isArray(templateValue)) {
    throw new Error("blocked: Protected approval action template is invalid.");
  }
  const template = templateValue as Record<string, unknown>;
  const platform = asString(template.platform);
  const tokenId = asString(template.tokenId);
  const tokenRef = asString(template.tokenRef);
  const expiresAt = asString(template.expiresAt);
  const expectedPrefix = "keychain:goatcitadel:approval-remote-action:";
  if (
    platform !== "telegram" ||
    !tokenId ||
    !tokenRef?.startsWith(expectedPrefix) ||
    tokenRef.slice(expectedPrefix.length) !== tokenId ||
    !expiresAt ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    request.authContext?.boundary !== "tool_host_boundary" ||
    request.authContext.secretRefs?.includes(tokenRef) !== true ||
    !hasCanonicalApprovalButtons(template.buttons)
  ) {
    throw new Error("blocked: Protected approval action template is invalid or mismatched.");
  }
  if ((await runtime.isApprovalActionConnectorReady?.(connectionId)) !== true) {
    throw new Error("blocked: Authenticated Telegram approval callback ingress is not currently ready.");
  }
  const tokenRecord = await storage.remoteActionTokens.get(tokenId);
  if (
    tokenRecord.actionType !== "approval.resolve" ||
    tokenRecord.connectorId !== `integration:${connectionId}` ||
    tokenRecord.expiresAt !== expiresAt
  ) {
    throw new Error("blocked: Protected approval action token binding is invalid or mismatched.");
  }
  if (tokenRecord.state !== "pending") {
    deleteApprovalActionTokenBestEffort(runtime, tokenRef);
    throw new Error(`blocked: Protected approval action token is ${tokenRecord.state}.`);
  }
  if (Date.parse(expiresAt) <= Date.now()) {
    deleteApprovalActionTokenBestEffort(runtime, tokenRef);
    throw new Error("blocked: Approval interactive-action token expired before provider dispatch.");
  }
  const rawToken = runtime.resolveApprovalActionTokenSecret?.(tokenRef)?.trim();
  if (!rawToken || !/^grat_[A-Za-z0-9_-]{43}$/.test(rawToken)) {
    throw new Error("Approval interactive-action token is unavailable or invalid.");
  }
  return {
    secretRef: tokenRef,
    args: {
      ...request.args,
      interactiveActionTemplate: undefined,
      interactiveActions: {
        platform: "telegram",
        tokenId,
        buttons: [
          { label: "Approve", callbackData: `gca:${rawToken}:a` },
          { label: "Deny", callbackData: `gca:${rawToken}:r` },
        ],
      },
    },
  };
}

function hasCanonicalApprovalButtons(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 2) {
    return false;
  }
  const expected = [
    { label: "Approve", decision: "a" },
    { label: "Deny", decision: "r" },
  ];
  return value.every((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return false;
    }
    const recordValue = item as Record<string, unknown>;
    return recordValue.label === expected[index]?.label && recordValue.decision === expected[index]?.decision;
  });
}

function assertIntegrationConnectionAvailable(connection: { key: string; enabled?: boolean; status?: string }): void {
  const retiredReason = describeRetiredChannel(connection.key);
  if (retiredReason) {
    throw new Error(`blocked: ${retiredReason}`);
  }
  if (connection.enabled === false || (connection.status !== undefined && connection.status !== "connected")) {
    throw new Error("blocked: Integration connection is disabled or disconnected.");
  }
}

function deleteApprovalActionTokenBestEffort(runtime: ApprovalActionSecretRuntime, secretRef?: string): void {
  if (!secretRef) {
    return;
  }
  try {
    runtime.deleteApprovalActionTokenSecret?.(secretRef);
  } catch {
    // Provider delivery is already terminal. Cleanup failure must not trigger a
    // duplicate external send; the expiry reconciler will retry removal.
  }
}

function isReadOnlyCommsTool(toolName: string): boolean {
  return toolName === "gmail.read" || toolName === "calendar.list";
}

function isGoogleWorkspaceWriteTool(toolName: string): boolean {
  return toolName === "gmail.send" || toolName === "calendar.create_event";
}

/** The Gateway's Google sign-in owns tokens; a pasted access token in connection config is never read. */
async function resolveGoogleWorkspaceToken(
  runtime: ApprovalActionSecretRuntime,
  connectionId: string,
  toolName: string,
): Promise<string> {
  if (!runtime.resolveGoogleWorkspaceAccessToken) {
    throw new Error(`blocked: ${toolName} requires Google sign-in, which is not available in this runtime.`);
  }
  const token = (await runtime.resolveGoogleWorkspaceAccessToken({ connectionId, toolName })).trim();
  if (!token) {
    throw new Error(`blocked: Google sign-in returned no access token for ${toolName}.`);
  }
  return token;
}

/**
 * Copies the connection config with each of this connection's secure-storage references swapped for the stored
 * key. Setup saves every secret field as a top-level reference, so only top-level strings are read. A reference
 * to another connection or to a draft, one nobody can read, a missing reader and a stored value that holds a control
 * character all fail the send before any request: reference text is never a credential, and no part of a stored
 * key is sent, quoted or recorded (the request layer quotes a rejected header value in its error). A structured key
 * (a service-account JSON) may hold line breaks: it is parsed and signed here, never put in a header.
 */
function resolveSavedChannelSecrets(
  connection: { connectionId: string; key: string; label?: string },
  config: Record<string, unknown>,
  runtime: ApprovalActionSecretRuntime,
): Record<string, unknown> {
  const ownPrefix = `${CHANNEL_CONNECTION_SECRET_REF_PREFIX}${connection.connectionId}:`;
  const resolveValue = (field: string, value: unknown): unknown => {
    const reference = typeof value === "string" ? value.trim() : "";
    if (!reference.startsWith(KEYCHAIN_REF_PREFIX)) return value;
    const secret = reference.startsWith(ownPrefix) ? runtime.resolveChannelConnectionSecret?.(reference)?.trim() : "";
    if (!secret || (!STRUCTURED_SECRET_FIELDS.has(field) && CONTROL_CHARACTER_PATTERN.test(secret))) {
      throw new Error(
        `The saved ${asString(connection.label) ?? connection.key} credential is unavailable from secure storage.`,
      );
    }
    return secret;
  };
  return Object.fromEntries(Object.entries(config).map(([field, value]) => [field, resolveValue(field, value)]));
}

function classifyChannelDeliveryFailure(message: string): ChannelDeliveryStatus {
  const normalized = message.toLowerCase();
  if (
    [
      "partial_channel_delivery_sent",
      "unknown_after_send",
      "unknown external outcome",
      "unknown_external_outcome",
      "manual reconciliation",
      "manual_reconciliation_required",
      "may have been sent",
      "external boundary may have been crossed",
      "external boundary crossed",
    ].some((term) => normalized.includes(term))
  ) {
    return "manual_reconciliation_required";
  }
  if (["408", "429", "502", "503", "504"].some((status) => normalized.includes(status))) {
    return "degraded";
  }
  if (
    ["allowlist", "blocked", "unsafe", "forbidden", "unauthorized", "http or https"].some((term) =>
      normalized.includes(term),
    )
  ) {
    return "blocked";
  }
  if (
    (normalized.includes("missing") && normalized.includes("url")) ||
    (normalized.includes("missing") &&
      ["token", "target", "channel", "chat", "recipient", "phone number"].some((term) => normalized.includes(term))) ||
    ["not supported", "does not support", "do not support", "only support", "unavailable", "not configured"].some(
      (term) => normalized.includes(term),
    )
  ) {
    return "not_available";
  }
  return "degraded";
}

function channelUnknownAfterSendError(operation: string, detail: string, providerMessageId?: string): Error {
  const error = new Error(
    `${operation} unknown_after_send: external boundary may have been crossed; manual reconciliation required. ${detail}`,
  );
  if (providerMessageId?.trim()) {
    Object.assign(error, { providerMessageId: providerMessageId.trim() });
  }
  return error;
}

function throwChannelUnknownAfterSend(operation: string, detail: string, providerMessageId?: string): never {
  throw channelUnknownAfterSendError(operation, detail, providerMessageId);
}

function readChannelFailureProviderMessageId(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("providerMessageId" in error)) {
    return undefined;
  }
  const providerMessageId = (error as { providerMessageId?: unknown }).providerMessageId;
  return typeof providerMessageId === "string" && providerMessageId.trim() ? providerMessageId.trim() : undefined;
}

function throwChannelProviderFailure(operation: string, response: Response, detail?: string): never {
  const suffix = detail?.trim() ? `: ${detail.trim()}` : "";
  const message = `${operation} failed (${response.status})${suffix}`;
  if (response.status >= 500) {
    throwChannelUnknownAfterSend(operation, message);
  }
  throw new Error(message);
}

function throwChannelBoundaryError(operation: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CommsResponseBoundaryError) {
    throwChannelUnknownAfterSend(operation, message);
  }
  if (isPreChannelBoundaryError(message)) {
    throw error instanceof Error ? error : new Error(message);
  }
  throwChannelUnknownAfterSend(operation, message);
}

class CommsResponseBoundaryError extends Error {
  public constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "CommsResponseBoundaryError";
  }
}

function isPreChannelBoundaryError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "allowlist",
    "blocked",
    "unsafe",
    "forbidden",
    "unauthorized",
    "http or https",
    "missing",
    "not supported",
    "does not support",
    "requires",
    "invalid",
  ].some((term) => normalized.includes(term));
}

async function executeCommsProviderTool(
  toolName: string,
  connectionKey: string,
  connectionConfig: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist: string[] | undefined,
  target: string,
  message: string,
  googleAccessToken?: string,
): Promise<string | undefined> {
  if (toolName === "gmail.send") {
    return gmailSend(required(googleAccessToken, "Google access token"), args, allowlist, grantAllowlist);
  }
  if (toolName === "smtp.send") {
    return smtpSend(connectionConfig, args, allowlist, grantAllowlist, {
      resolveSecret: secretFrom,
      markMutationRequestStarted: markCommsMutationRequestStarted,
    });
  }
  if (toolName === "calendar.create_event") {
    return calendarCreate(required(googleAccessToken, "Google access token"), args, allowlist, grantAllowlist);
  }
  if (toolName.endsWith(".react") || toolName === "channel.react") {
    return commsReact(toolName, connectionKey, connectionConfig, args, allowlist, target, grantAllowlist);
  }
  if (toolName.endsWith(".unsend") || toolName === "channel.unsend") {
    return commsUnsend(toolName, connectionKey, connectionConfig, args, allowlist, target, grantAllowlist);
  }
  const channelKey = toolName === "channel.send" ? connectionKey : toolName.slice(0, -".send".length);
  const sanitizedMessage = sanitizeCommsMessageForChannel(message, channelKey);
  const attachments = normalizeChannelAttachments(args.attachments);
  const renderedMessage = renderChannelMessage(sanitizedMessage, attachments);
  switch (channelKey) {
    case "slack":
      return slackSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "discord":
      return discordSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "line":
      return lineSend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    case "mattermost":
      return mattermostSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "matrix":
      if (attachments.length > 0) {
        throw new Error("Matrix channel delivery is text-only; attachments are not supported.");
      }
      return matrixSend(connectionConfig, args, allowlist, target, sanitizedMessage, grantAllowlist);
    case "qqbot":
      if (attachments.length > 0) {
        throw new Error("QQBot channel delivery is text-only; attachments are not supported.");
      }
      return qqbotSend(connectionConfig, args, allowlist, target, sanitizedMessage, grantAllowlist);
    case "wecom":
      if (attachments.length > 0) {
        throw new Error("WeCom channel delivery is text-only; attachments are not supported.");
      }
      return wecomSend(connectionConfig, args, allowlist, target, sanitizedMessage, grantAllowlist);
    case "nextcloud-talk":
      return nextcloudTalkSend(
        connectionConfig,
        args,
        allowlist,
        target,
        sanitizedMessage,
        attachments,
        grantAllowlist,
      );
    case "telegram":
      return telegramSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "ntfy":
      return ntfySend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    case "teams":
      return teamsSend(connectionConfig, args, allowlist, sanitizedMessage, attachments, grantAllowlist);
    case "google-chat":
      return googleChatSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "whatsapp":
      return whatsappSend(connectionConfig, args, allowlist, target, sanitizedMessage, attachments, grantAllowlist);
    case "zalo":
      return zaloSend(connectionConfig, args, allowlist, target, renderedMessage, grantAllowlist);
    default:
      break;
  }
  const webhookUrl =
    asString(args.url) ??
    secretFrom(connectionConfig, "webhookUrl", "webhookUrlEnv") ??
    secretFrom(connectionConfig, "url", "urlEnv");
  if (!webhookUrl) {
    throw new Error("Missing webhook URL");
  }
  const payload = { text: renderedMessage, target, payload: record(args.payload) };
  let res: { response: Response; finalUrl: string };
  try {
    res = await fetchAllowlisted(
      webhookUrl,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      allowlist,
      undefined,
      grantAllowlist,
    );
  } catch (error) {
    throwChannelBoundaryError(toolName, error);
  }
  if (!res.response.ok) {
    throwChannelProviderFailure(toolName, res.response);
  }
  return `${toolName}-${Date.now()}`;
}

function sanitizeCommsMessageForChannel(message: string, channelKey: string): string {
  return sanitizeChannelOutboundMessage(message, {
    neutralizeMentions: ["discord", "google-chat", "mattermost", "slack", "teams", "webhook"].includes(channelKey),
    maxLength: channelKey === "discord" ? 2000 : undefined,
  }).message;
}

async function commsReact(
  toolName: string,
  connectionKey: string,
  connectionConfig: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const channelKey = toolName === "channel.react" ? connectionKey : toolName.slice(0, -".react".length);
  switch (channelKey) {
    case "slack":
      return slackReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "discord":
      return discordReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "mattermost":
      return mattermostReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "matrix":
      return matrixReactAction(connectionConfig, args, allowlist, target, grantAllowlist);
    case "nextcloud-talk":
      return nextcloudTalkReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "telegram":
      return telegramReact(connectionConfig, args, allowlist, target, grantAllowlist);
    case "whatsapp":
      return whatsappReact(connectionConfig, args, allowlist, target, grantAllowlist);
    default:
      throw new Error(
        describeChannelPlatformUnsupported(channelKey, "channel.react") ??
          `${toolName} is not supported for ${channelKey}`,
      );
  }
}

async function commsUnsend(
  toolName: string,
  connectionKey: string,
  connectionConfig: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const channelKey = toolName === "channel.unsend" ? connectionKey : toolName.slice(0, -".unsend".length);
  switch (channelKey) {
    case "slack":
      return slackUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "discord":
      return discordUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "telegram":
      return telegramUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "mattermost":
      return mattermostUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "matrix":
      return matrixUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    case "google-chat":
      return googleChatUnsend(connectionConfig, args, allowlist, grantAllowlist);
    case "ntfy":
      return ntfyUnsend(connectionConfig, args, allowlist, target, grantAllowlist);
    default:
      throw new Error(
        describeChannelPlatformUnsupported(channelKey, "channel.unsend") ??
          `${toolName} is not supported for ${channelKey}`,
      );
  }
}

function resolveDefaultChannelTarget(connectionKey: string, config: Record<string, unknown>): string | undefined {
  const keys = CHANNEL_TARGET_KEYS[connectionKey] ?? ["target", "defaultTarget"];
  for (const key of keys) {
    const value = asString(config[key]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function renderChannelMessage(message: string, attachmentsRaw: unknown): string {
  const attachments = normalizeChannelAttachments(attachmentsRaw);
  if (attachments.length === 0) {
    return message;
  }
  const lines = attachments
    .map((attachment) => {
      const title = attachment.title;
      const url = attachment.url;
      if (title && url) {
        return `- ${title}: ${url}`;
      }
      if (url) {
        return `- ${url}`;
      }
      if (title) {
        return `- ${title}`;
      }
      if (attachment.attachmentId) {
        return `- attachment ${attachment.attachmentId}`;
      }
      if (attachment.dataBase64) {
        return "- inline attachment";
      }
      return null;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return message;
  }
  return `${message}\n\nAttachments:\n${lines.join("\n")}`;
}

type ChannelAttachment = {
  url?: string;
  title?: string;
  mimeType?: string;
  dataBase64?: string;
  attachmentId?: string;
};

function normalizeChannelAttachments(attachmentsRaw: unknown): ChannelAttachment[] {
  if (!Array.isArray(attachmentsRaw)) {
    return [];
  }
  return attachmentsRaw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((attachment) => ({
      url: asString(attachment.url),
      title: asString(attachment.title),
      mimeType: asString(attachment.mimeType),
      dataBase64: asString(attachment.dataBase64),
      attachmentId: asString(attachment.attachmentId),
    }))
    .filter((attachment) =>
      Boolean(
        attachment.url || attachment.title || attachment.mimeType || attachment.dataBase64 || attachment.attachmentId,
      ),
    );
}

async function slackSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "slack");
  const urlAttachments = attachments.filter((attachment) => Boolean(attachment.url));
  const inlineAttachments = attachments.filter((attachment) => Boolean(attachment.dataBase64));
  const renderedMessage = renderChannelMessage(message, urlAttachments);
  const blocks = buildSlackMessageBlocks(message, urlAttachments);
  const webhookUrl = secretFrom(config, "webhookUrl", "webhookUrlEnv");
  if (webhookUrl) {
    if (inlineAttachments.length > 0) {
      throw new Error(
        "Slack webhook connections do not support inline attachments; use a bot token connection instead",
      );
    }
    let res: { response: Response; finalUrl: string };
    try {
      res = await fetchAllowlisted(
        webhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: renderedMessage,
            ...(blocks ? { blocks } : {}),
          }),
        },
        allowlist,
        undefined,
        grantAllowlist,
      );
    } catch (error) {
      throwChannelBoundaryError("slack.send", error);
    }
    if (!res.response.ok) {
      throwChannelProviderFailure("slack.send", res.response);
    }
    return `slack-webhook-${Date.now()}`;
  }

  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channel = asString(args.target) ?? resolvedTarget ?? asString(config.defaultChannel);
  const threadTs =
    asString(args.threadTs) ??
    asString(args.replyToMessageId) ??
    asString(args.replyTo) ??
    asString(config.defaultThreadTs);
  if (!token) {
    throw new Error("Missing Slack bot token");
  }
  if (!channel) {
    throw new Error("Missing Slack channel target");
  }
  let parentTs: string | undefined;
  let uploadChannelId = channel;
  if (message.trim() || urlAttachments.length > 0) {
    let res: { response: Response; finalUrl: string };
    try {
      res = await fetchAllowlisted(
        "https://slack.com/api/chat.postMessage",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=utf-8",
          },
          body: JSON.stringify({
            channel,
            text: renderedMessage,
            ...(blocks ? { blocks } : {}),
            ...(threadTs ? { thread_ts: threadTs } : {}),
          }),
        },
        allowlist,
        undefined,
        grantAllowlist,
      );
    } catch (error) {
      throwChannelBoundaryError("slack.send", error);
    }
    const bodyText = await res.response.text();
    const body = parseJsonRecord(bodyText);
    if (!res.response.ok || body.ok === false) {
      if (!res.response.ok) {
        throwChannelProviderFailure("slack.send", res.response, asString(body.error));
      }
      throw new Error(`slack.send failed (${res.response.status})${body.error ? `: ${body.error}` : ""}`);
    }
    parentTs = asString(body.ts) ?? parentTs;
    uploadChannelId = asString(body.channel) ?? uploadChannelId;
  }

  if (inlineAttachments.length > 0 && !isSlackConversationId(uploadChannelId)) {
    throw new Error(
      "Slack inline attachment uploads require a channel ID target or a text/url message that can resolve one",
    );
  }
  let uploadedFileId: string | undefined;
  for (const [index, attachment] of inlineAttachments.entries()) {
    try {
      uploadedFileId = await slackUploadAttachment(
        token,
        uploadChannelId,
        attachment,
        index,
        allowlist,
        grantAllowlist,
        threadTs ?? parentTs,
      );
    } catch (error) {
      if (parentTs) {
        const detail = error instanceof Error ? error.message : String(error);
        throwChannelUnknownAfterSend(
          "slack.send",
          `partial_channel_delivery_sent: message ${parentTs} was sent before attachment ${index + 1} failed. ${detail}`,
          parentTs,
        );
      }
      throw error;
    }
  }

  return parentTs ?? uploadedFileId ?? `slack-${Date.now()}`;
}

async function slackReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channel = asString(args.target) ?? normalizeChannelTarget(target, "slack") ?? asString(config.defaultChannel);
  const timestamp = required(args.messageId, "Slack messageId");
  const reaction = normalizeSlackReaction(args.reaction);
  if (!token) {
    throw new Error("Missing Slack bot token");
  }
  if (!channel) {
    throw new Error("Missing Slack channel target");
  }
  const res = await fetchAllowlisted(
    "https://slack.com/api/reactions.add",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        timestamp,
        name: reaction,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`slack.react failed (${res.response.status})${body.error ? `: ${body.error}` : ""}`);
  }
  return timestamp;
}

async function slackUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channel = asString(args.target) ?? normalizeChannelTarget(target, "slack") ?? asString(config.defaultChannel);
  const timestamp = required(args.messageId, "Slack messageId");
  if (!token) {
    throw new Error("Missing Slack bot token");
  }
  if (!channel) {
    throw new Error("Missing Slack channel target");
  }
  const res = await fetchAllowlisted(
    "https://slack.com/api/chat.delete",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel,
        ts: timestamp,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`slack.unsend failed (${res.response.status})${body.error ? `: ${body.error}` : ""}`);
  }
  return timestamp;
}

async function discordSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "discord");
  const webhookUrl = secretFrom(config, "webhookUrl", "webhookUrlEnv");
  const discordRequest = await buildDiscordMessageRequest(message, attachments, allowlist, grantAllowlist);
  if (webhookUrl) {
    let res: { response: Response; finalUrl: string };
    try {
      res = await fetchAllowlisted(
        appendDiscordWebhookQuery(webhookUrl, "wait", "true"),
        {
          method: "POST",
          headers: discordRequest.headers,
          body: discordRequest.body,
        },
        allowlist,
        undefined,
        grantAllowlist,
      );
    } catch (error) {
      throwChannelBoundaryError("discord.send", error);
    }
    if (!res.response.ok) {
      throwChannelProviderFailure("discord.send", res.response);
    }
    const body = parseJsonRecord(await res.response.text());
    return asString(body.id) ?? `discord-webhook-${Date.now()}`;
  }

  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channelId = asString(args.target) ?? resolvedTarget ?? asString(config.defaultChannelId);
  if (!token) {
    throw new Error("Missing Discord bot token");
  }
  if (!channelId) {
    throw new Error("Missing Discord channel target");
  }
  let res: { response: Response; finalUrl: string };
  try {
    res = await fetchAllowlisted(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bot ${token}`,
          ...(discordRequest.headers ?? {}),
        },
        body: discordRequest.body,
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
  } catch (error) {
    throwChannelBoundaryError("discord.send", error);
  }
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throwChannelProviderFailure("discord.send", res.response, bodyText);
  }
  const body = parseJsonRecord(bodyText);
  return asString(body.id) ?? `discord-${Date.now()}`;
}

async function discordReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const channelId =
    asString(args.target) ?? normalizeChannelTarget(target, "discord") ?? asString(config.defaultChannelId);
  const messageId = required(args.messageId, "Discord messageId");
  const emoji = required(args.reaction, "Discord reaction");
  if (!token) {
    throw new Error("Missing Discord bot token");
  }
  if (!channelId) {
    throw new Error("Missing Discord channel target");
  }
  const res = await fetchAllowlisted(
    `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeDiscordEmoji(emoji)}/@me`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${token}`,
      },
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (!res.response.ok) {
    const bodyText = await res.response.text();
    throw new Error(`discord.react failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  return messageId;
}

async function discordUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const messageId = required(args.messageId, "Discord messageId");
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const webhookUrl = secretFrom(config, "webhookUrl", "webhookUrlEnv");
  if (token) {
    const channelId =
      asString(args.target) ?? normalizeChannelTarget(target, "discord") ?? asString(config.defaultChannelId);
    if (!channelId) {
      throw new Error("Missing Discord channel target");
    }
    const res = await fetchAllowlisted(
      `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `Bot ${token}`,
        },
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    if (!res.response.ok) {
      const bodyText = await res.response.text();
      throw new Error(`discord.unsend failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
    }
    return messageId;
  }
  if (!webhookUrl) {
    throw new Error("Missing Discord bot token or webhook URL");
  }
  const deleteUrl = `${appendDiscordWebhookQuery(webhookUrl.replace(/\/+$/, ""), "wait", "true").replace(/\?wait=true$/, "")}/messages/${encodeURIComponent(messageId)}`;
  const res = await fetchAllowlisted(deleteUrl, { method: "DELETE" }, allowlist, undefined, grantAllowlist);
  if (!res.response.ok) {
    const bodyText = await res.response.text();
    throw new Error(`discord.unsend failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  return messageId;
}

async function buildDiscordMessageRequest(
  message: string,
  attachments: ChannelAttachment[],
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<{ headers?: Record<string, string>; body: BodyInit }> {
  const embeds = buildDiscordEmbeds(attachments);
  const uploadableAttachments = attachments.filter((attachment) => Boolean(attachment.dataBase64));
  const payload: Record<string, unknown> = {};
  if (message.trim()) {
    payload.content = message;
  }
  payload.allowed_mentions = { parse: [] };
  if (embeds.length > 0) {
    payload.embeds = embeds;
  }
  if (uploadableAttachments.length === 0) {
    return {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    };
  }

  const formData = new FormData();
  formData.append("payload_json", JSON.stringify(payload));
  for (const [index, attachment] of uploadableAttachments.entries()) {
    const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Discord", grantAllowlist);
    const fileName = resolveChannelAttachmentName(attachment, index);
    const blobBytes = new Uint8Array(attachmentData.bytes.length);
    blobBytes.set(attachmentData.bytes);
    formData.append(
      `files[${index}]`,
      new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
      fileName,
    );
  }
  return { body: formData };
}

function buildDiscordEmbeds(attachments: ChannelAttachment[]): Array<Record<string, unknown>> {
  return attachments
    .filter((attachment) => Boolean(attachment.url))
    .slice(0, 10)
    .map((attachment) => {
      const url = required(attachment.url, "Discord embed attachment URL");
      const embed: Record<string, unknown> = {};
      const title = asString(attachment.title);
      if (title) {
        embed.title = title;
      }
      if (title || !isImageChannelAttachment(attachment)) {
        embed.url = url;
      }
      if (isImageChannelAttachment(attachment)) {
        embed.image = { url };
      } else {
        embed.description = url;
      }
      return embed;
    });
}

function buildSlackMessageBlocks(
  message: string,
  attachments: ChannelAttachment[],
): Array<Record<string, unknown>> | undefined {
  const blocks: Array<Record<string, unknown>> = [];
  if (message.trim()) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: message,
      },
    });
  }

  for (const [index, attachment] of attachments.entries()) {
    const url = attachment.url?.trim();
    const title = attachment.title?.trim() || resolveChannelAttachmentName(attachment, index);
    if (isImageChannelAttachment(attachment)) {
      const imageBlock: Record<string, unknown> = {
        type: "image",
        image_url: url,
        alt_text: title || "attachment",
      };
      if (title) {
        imageBlock.title = { type: "plain_text", text: title };
      }
      blocks.push(imageBlock);
      continue;
    }
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: title && title !== url ? `*<${url}|${title}>*` : `<${url}>`,
      },
    });
  }

  return blocks.length > 0 ? blocks : undefined;
}

function buildTeamsWebhookPayload(
  title: string,
  message: string,
  attachments: ChannelAttachment[],
): Record<string, unknown> {
  const unsupportedInline = attachments.some((attachment) => Boolean(attachment.dataBase64));
  if (unsupportedInline) {
    throw new Error("Teams webhook connections only support URL-backed attachments");
  }

  const body: Array<Record<string, unknown>> = [{ type: "TextBlock", text: title, weight: "Bolder", wrap: true }];
  if (message.trim()) {
    body.push({ type: "TextBlock", text: message, wrap: true });
  }

  for (const [index, attachment] of attachments.entries()) {
    const url = attachment.url?.trim();
    if (!url) {
      continue;
    }
    const label = attachment.title?.trim() || resolveChannelAttachmentName(attachment, index);
    if (isImageChannelAttachment(attachment)) {
      body.push({
        type: "Image",
        url,
        altText: label,
        size: "Medium",
      });
      continue;
    }
    body.push({
      type: "TextBlock",
      text: `[${label}](${url})`,
      wrap: true,
    });
  }

  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          type: "AdaptiveCard",
          version: "1.4",
          body,
        },
      },
    ],
  };
}

function buildGoogleChatWebhookPayload(message: string, attachments: ChannelAttachment[]): Record<string, unknown> {
  const unsupportedInline = attachments.some((attachment) => Boolean(attachment.dataBase64));
  if (unsupportedInline) {
    throw new Error("Google Chat webhook connections only support URL-backed attachments");
  }
  const widgets: Array<Record<string, unknown>> = [];
  if (message.trim()) {
    widgets.push({
      textParagraph: { text: message },
    });
  }
  for (const [index, attachment] of attachments.entries()) {
    const url = attachment.url?.trim();
    if (!url) {
      continue;
    }
    const label = attachment.title?.trim() || resolveChannelAttachmentName(attachment, index);
    if (isImageChannelAttachment(attachment)) {
      widgets.push({
        image: {
          imageUrl: url,
          altText: label,
        },
      });
      continue;
    }
    widgets.push({
      buttonList: {
        buttons: [
          {
            text: label,
            onClick: {
              openLink: { url },
            },
          },
        ],
      },
    });
  }

  if (widgets.length === 0) {
    return { text: message };
  }

  return {
    text: message || "Attachment update",
    cardsV2: [
      {
        cardId: "goatcitadel-delivery",
        card: {
          sections: [
            {
              widgets,
            },
          ],
        },
      },
    ],
  };
}

async function lineSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeLineTarget(
    asString(args.target) ?? normalizeChannelTarget(target, "line") ?? resolveDefaultChannelTarget("line", config),
  );
  const channelAccessToken =
    secretFrom(config, "channelAccessToken", "channelAccessTokenEnv") ??
    secretFrom(config, "accessToken", "accessTokenEnv") ??
    secretFrom(config, "token", "tokenEnv");
  if (!channelAccessToken) {
    throw new Error("Missing LINE channel access token");
  }
  if (!resolvedTarget) {
    throw new Error("Missing LINE target");
  }

  const chunks = chunkText(message, 5000, 0, 20);
  if (chunks.length === 0) {
    throw new Error("Missing LINE message");
  }

  let requestId: string | undefined;
  for (let index = 0; index < chunks.length; index += 5) {
    const messages = chunks.slice(index, index + 5).map((text) => ({ type: "text", text }));
    const res = await fetchAllowlisted(
      "https://api.line.me/v2/bot/message/push",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${channelAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: resolvedTarget,
          messages,
        }),
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    if (!res.response.ok) {
      throw new Error(`line.send failed (${res.response.status})`);
    }
    requestId = res.response.headers.get("x-line-request-id") ?? requestId;
  }

  return requestId ?? `line-${Date.now()}`;
}

async function telegramSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "telegram");
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = asString(args.target) ?? resolvedTarget ?? asString(config.defaultChatId);
  const replyToMessageId = parseOptionalIntegerLike(args.replyToMessageId ?? args.replyTo);
  const replyMarkup = normalizeTelegramInlineKeyboard(args.interactiveActions);
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }
  if (!chatId) {
    throw new Error("Missing Telegram chat target");
  }

  if (attachments.length === 0) {
    return telegramSendText(config, allowlist, token, chatId, message, replyToMessageId, replyMarkup, grantAllowlist);
  }

  let lastMessageId: string | undefined;
  let caption = message.trim() || undefined;
  if (caption && caption.length > 1024) {
    lastMessageId = await telegramSendText(
      config,
      allowlist,
      token,
      chatId,
      message,
      replyToMessageId,
      undefined,
      grantAllowlist,
    );
    caption = undefined;
  }
  for (const [index, attachment] of attachments.entries()) {
    try {
      lastMessageId = await telegramSendAttachment(
        config,
        allowlist,
        token,
        chatId,
        attachment,
        index,
        caption,
        index === 0 ? replyToMessageId : undefined,
        grantAllowlist,
      );
    } catch (error) {
      if (lastMessageId) {
        const detail = error instanceof Error ? error.message : String(error);
        throwChannelUnknownAfterSend(
          "telegram.send",
          `partial_channel_delivery_sent: message ${lastMessageId} was sent before attachment ${index + 1} failed. ${detail}`,
          lastMessageId,
        );
      }
      throw error;
    }
    caption = undefined;
  }
  return lastMessageId ?? `telegram-${Date.now()}`;
}

async function telegramUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = asString(args.target) ?? normalizeChannelTarget(target, "telegram") ?? asString(config.defaultChatId);
  const messageId = required(args.messageId, "Telegram messageId");
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }
  if (!chatId) {
    throw new Error("Missing Telegram chat target");
  }
  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/deleteMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: Number.parseInt(messageId, 10),
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(
      `telegram.unsend failed (${res.response.status})${body.description ? `: ${body.description}` : ""}`,
    );
  }
  return messageId;
}

async function telegramReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const token = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = asString(args.target) ?? normalizeChannelTarget(target, "telegram") ?? asString(config.defaultChatId);
  const messageId = required(args.messageId, "Telegram messageId");
  const reaction = required(args.reaction, "Telegram reaction").trim();
  if (!token) {
    throw new Error("Missing Telegram bot token");
  }
  if (!chatId) {
    throw new Error("Missing Telegram chat target");
  }
  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/setMessageReaction`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: Number.parseInt(messageId, 10),
        reaction: [{ type: "emoji", emoji: reaction }],
        is_big: args.isBig === true ? true : undefined,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    throw new Error(`telegram.react failed (${res.response.status})${body.description ? `: ${body.description}` : ""}`);
  }
  return messageId;
}

function normalizeTelegramInlineKeyboard(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const recordValue = value as Record<string, unknown>;
  if (recordValue.platform !== undefined && asString(recordValue.platform) !== "telegram") {
    return undefined;
  }
  if (!Array.isArray(recordValue.buttons)) {
    return undefined;
  }
  const buttons = recordValue.buttons
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map((item) => {
      const button = item as Record<string, unknown>;
      const text = asString(button.label);
      const callbackData = asString(button.callbackData);
      return text && callbackData ? { text, callback_data: callbackData } : undefined;
    })
    .filter((item): item is { text: string; callback_data: string } => Boolean(item))
    .slice(0, 8);
  return buttons.length > 0 ? { inline_keyboard: [buttons] } : undefined;
}

async function telegramSendText(
  config: Record<string, unknown>,
  allowlist: string[],
  token: string,
  chatId: string,
  message: string,
  replyToMessageId?: number,
  replyMarkup?: Record<string, unknown>,
  grantAllowlist?: string[],
): Promise<string> {
  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: asString(config.parseMode) ?? undefined,
        reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
        reply_markup: replyMarkup,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || body.ok === false) {
    if (!res.response.ok) {
      throwChannelProviderFailure("telegram.send", res.response, asString(body.description));
    }
    throw new Error(`telegram.send failed (${res.response.status})${body.description ? `: ${body.description}` : ""}`);
  }
  const result = record(body.result);
  return providerMessageIdFromValue(result.message_id) ?? `telegram-${Date.now()}`;
}

async function telegramSendAttachment(
  config: Record<string, unknown>,
  allowlist: string[],
  token: string,
  chatId: string,
  attachment: ChannelAttachment,
  index: number,
  caption: string | undefined,
  replyToMessageId?: number,
  grantAllowlist?: string[],
): Promise<string> {
  const parseMode = asString(config.parseMode) ?? undefined;
  const isImage = isImageChannelAttachment(attachment);
  const method = isImage ? "sendPhoto" : "sendDocument";
  const field = isImage ? "photo" : "document";
  let body: BodyInit;
  let headers: Record<string, string> | undefined;

  if (attachment.dataBase64) {
    const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Telegram", grantAllowlist);
    const fileName = resolveChannelAttachmentName(attachment, index);
    const blobBytes = new Uint8Array(attachmentData.bytes.length);
    blobBytes.set(attachmentData.bytes);
    const formData = new FormData();
    formData.set("chat_id", chatId);
    formData.set(
      field,
      new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
      fileName,
    );
    if (caption) {
      formData.set("caption", caption);
    }
    if (parseMode) {
      formData.set("parse_mode", parseMode);
    }
    if (replyToMessageId) {
      formData.set("reply_parameters", JSON.stringify({ message_id: replyToMessageId }));
    }
    body = formData;
  } else {
    body = JSON.stringify({
      chat_id: chatId,
      [field]: required(attachment.url, "Telegram attachment URL"),
      caption,
      parse_mode: parseMode,
      reply_parameters: replyToMessageId ? { message_id: replyToMessageId } : undefined,
    });
    headers = { "Content-Type": "application/json" };
  }

  const res = await fetchAllowlisted(
    `https://api.telegram.org/bot${token}/${method}`,
    {
      method: "POST",
      headers,
      body,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const payload = parseJsonRecord(bodyText);
  if (!res.response.ok || payload.ok === false) {
    if (!res.response.ok) {
      throwChannelProviderFailure("telegram.send", res.response, asString(payload.description));
    }
    throw new Error(
      `telegram.send failed (${res.response.status})${payload.description ? `: ${payload.description}` : ""}`,
    );
  }
  const result = record(payload.result);
  return providerMessageIdFromValue(result.message_id) ?? `telegram-${Date.now()}`;
}

/** Caller tags first, then the self-echo marker the ntfy inbound stream drops. */
function mergeNtfyTags(value: unknown): string {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tags = raw
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter((tag) => tag.length > 0 && tag !== NTFY_OUTBOUND_MARKER_TAG);
  return [...tags, NTFY_OUTBOUND_MARKER_TAG].join(",");
}

async function ntfySend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = asString(config.baseUrl) ?? "https://ntfy.sh";
  const topic = asString(args.target) ?? normalizeChannelTarget(target, "ntfy") ?? asString(config.topic);
  if (!topic) {
    throw new Error("Missing ntfy topic");
  }
  if (isEnabledFlag(args.dryRun) || isEnabledFlag(config.dryRun)) {
    return `ntfy-dry-run-${Date.now()}`;
  }
  const token = secretFrom(config, "token", "tokenEnv");
  const priority = clampInt(args.priority ?? config.priority, 3, 1, 5);
  const title = asString(args.title) ?? asString(config.title) ?? "GoatCitadel";
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Priority: String(priority),
    Title: title,
  };
  headers["X-Tags"] = mergeNtfyTags(args.tags ?? config.tags);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetchAllowlisted(
    buildNtfyPublishUrl(baseUrl, topic),
    {
      method: "POST",
      headers,
      body: message,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`ntfy.send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const messageId = res.response.headers.get("x-message-id") ?? asString(parseJsonRecord(bodyText).id);
  return messageId ?? `ntfy-${Date.now()}`;
}

const NTFY_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const NTFY_RESPONSE_MAX_BYTES = 16 * 1024;

/**
 * Deletes a published ntfy notification: DELETE /<topic>/<sequence id>. GoatCitadel
 * publishes without a sequence id, so the message id ntfy returned on publish is the
 * sequence id (docs.ntfy.sh/publish, "Updating + deleting notifications").
 */
async function ntfyUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const messageId = required(args.messageId, "ntfy messageId");
  if (!NTFY_MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error("ntfy messageId must be the message id ntfy returned on publish");
  }
  const baseUrl = asString(config.baseUrl) ?? "https://ntfy.sh";
  const topic = asString(args.target) ?? normalizeChannelTarget(target, "ntfy") ?? asString(config.topic);
  if (!topic) {
    throw new Error("Missing ntfy topic");
  }
  if (isEnabledFlag(args.dryRun) || isEnabledFlag(config.dryRun)) {
    return messageId;
  }
  const token = secretFrom(config, "token", "tokenEnv");
  let res: { response: Response; finalUrl: string };
  try {
    res = await fetchAllowlisted(
      `${buildNtfyPublishUrl(baseUrl, topic)}/${encodeURIComponent(messageId)}`,
      { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} },
      allowlist,
      undefined,
      grantAllowlist,
    );
  } catch (error) {
    throwChannelBoundaryError("ntfy.unsend", error);
  }
  const bodyText = await readCappedResponseText(res.response, NTFY_RESPONSE_MAX_BYTES);
  if (!res.response.ok) {
    throwChannelProviderFailure("ntfy.unsend", res.response, bodyText.trim().slice(0, 200));
  }
  return messageId;
}

/** Reads at most maxBytes of a response body, then cancels the rest of the stream. */
async function readCappedResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return "";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = maxBytes - total;
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function buildNtfyPublishUrl(baseUrl: string, topic: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/${encodeURIComponent(topic)}`;
}

function isEnabledFlag(value: unknown): boolean {
  return value === true || asString(value)?.toLowerCase() === "true";
}

function parseOptionalIntegerLike(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const parsed = parseIntegerLike(value);
  if (parsed === undefined) {
    throw new Error("Expected an integer-like reply target");
  }
  return parsed;
}

async function teamsSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const webhookUrl =
    asString(args.url) ?? secretFrom(config, "webhookUrl", "webhookUrlEnv") ?? secretFrom(config, "url", "urlEnv");
  if (!webhookUrl) {
    throw new Error("Missing Teams webhook URL");
  }
  const title = asString(config.cardTitle) ?? "GoatCitadel";
  const payload = buildTeamsWebhookPayload(title, message, attachments);
  const res = await fetchAllowlisted(
    webhookUrl,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  if (!res.response.ok) {
    throw new Error(`teams.send failed (${res.response.status})`);
  }
  return `teams-${Date.now()}`;
}

async function googleChatSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const resolvedTarget = normalizeChannelTarget(target, "google-chat");
  const serviceAccountKey = resolveGoogleChatServiceAccountKey(config);
  if (serviceAccountKey) {
    return googleChatAppSend(
      serviceAccountKey,
      config,
      args,
      resolvedTarget,
      message,
      attachments,
      googleChatFetchers(allowlist, grantAllowlist),
    );
  }
  const webhookUrl =
    asString(args.url) ?? secretFrom(config, "webhookUrl", "webhookUrlEnv") ?? secretFrom(config, "url", "urlEnv");
  if (!webhookUrl) {
    throw new Error("Missing Google Chat webhook URL");
  }
  const url = new URL(webhookUrl);
  const threadKey = asString(args.target) ?? resolvedTarget ?? asString(config.defaultThreadKey);
  if (threadKey) {
    url.searchParams.set("threadKey", threadKey);
  }
  const res = await fetchAllowlisted(
    url.toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildGoogleChatWebhookPayload(message, attachments)),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`google-chat.send failed (${res.response.status})`);
  }
  const body = parseJsonRecord(bodyText);
  return asString(body.name) ?? `google-chat-${Date.now()}`;
}

function resolveGoogleChatServiceAccountKey(config: Record<string, unknown>): string | undefined {
  return secretFrom(config, "serviceAccountKey", "serviceAccountKeyEnv");
}

function googleChatFetchers(allowlist: string[], grantAllowlist?: string[]) {
  return {
    // Token minting is not an external side effect; Chat API mutations are.
    tokenFetch: async (url: string, init: RequestInit) =>
      (await fetchAllowlisted(url, init, allowlist, undefined, grantAllowlist, { crossesExternalSideEffect: false }))
        .response,
    apiFetch: async (url: string, init: RequestInit) =>
      (await fetchAllowlisted(url, init, allowlist, undefined, grantAllowlist)).response,
  };
}

async function googleChatAppSend(
  keyJson: string,
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  resolvedTarget: string | undefined,
  message: string,
  attachments: ChannelAttachment[],
  fetchers: ReturnType<typeof googleChatFetchers>,
): Promise<string> {
  const space = [asString(args.target), resolvedTarget, asString(config.defaultSpace)].find(
    (candidate): candidate is string => Boolean(candidate && GOOGLE_CHAT_SPACE_NAME_PATTERN.test(candidate)),
  );
  if (!space) {
    throw new Error("Google Chat app sends require a space target (spaces/{space}); set config.defaultSpace");
  }
  const replyRef = [args.threadName, args.threadId, args.replyToMessageId, args.replyTo]
    .map((value) => asString(value))
    .find((value): value is string => Boolean(value));
  let threadName: string | undefined;
  if (replyRef && GOOGLE_CHAT_THREAD_NAME_PATTERN.test(replyRef)) {
    threadName = replyRef;
  } else if (replyRef && GOOGLE_CHAT_MESSAGE_NAME_PATTERN.test(replyRef)) {
    // Throws (before any Chat mutation) when the thread cannot be read: a reply never silently goes top-level.
    threadName = await readGoogleChatMessageThread({ keyJson, messageName: replyRef, ...fetchers });
  } else if (replyRef) {
    throw new Error(
      "Google Chat reply reference must be a thread (spaces/{space}/threads/{thread}) or message (spaces/{space}/messages/{message}) resource name",
    );
  }
  return sendGoogleChatAppMessage({
    keyJson,
    space,
    threadName,
    body: attachments.length > 0 ? buildGoogleChatWebhookPayload(message, attachments) : { text: message },
    ...fetchers,
  });
}

async function googleChatUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const messageName = required(args.messageId, "Google Chat messageId");
  // Validate before any token or API fetch.
  assertGoogleChatMessageName(messageName);
  const keyJson = resolveGoogleChatServiceAccountKey(config);
  if (!keyJson) {
    throw new Error("google-chat.unsend requires Chat app (service-account) mode; webhook messages cannot be deleted");
  }
  return deleteGoogleChatAppMessage({ keyJson, messageName, ...googleChatFetchers(allowlist, grantAllowlist) });
}

async function whatsappSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const phoneNumberId = asString(config.phoneNumberId) ?? asString(config.senderId);
  const resolvedTarget = normalizeWhatsAppTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "whatsapp") ??
      resolveDefaultChannelTarget("whatsapp", config),
  );
  const baseUrl = normalizeWhatsAppBaseUrl(asString(config.baseUrl), asString(config.apiVersion));
  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }
  if (!phoneNumberId) {
    throw new Error("Missing WhatsApp phone number id");
  }
  if (!resolvedTarget) {
    throw new Error("Missing WhatsApp target");
  }
  if (isWhatsAppGroupTarget(resolvedTarget)) {
    throw new Error("WhatsApp Cloud API sender only supports direct recipients, not group JIDs");
  }

  const richAttachments = attachments.filter((attachment) => Boolean(attachment.url || attachment.dataBase64));
  const inlineOnlyAttachments = attachments.filter((attachment) => !attachment.url && !attachment.dataBase64);
  const outboundMessage = renderChannelMessage(message, inlineOnlyAttachments);
  const recipient = normalizeWhatsAppRecipient(resolvedTarget);

  let providerMessageId: string | undefined;
  if (outboundMessage.trim()) {
    providerMessageId = await whatsappSendPayload(
      baseUrl,
      phoneNumberId,
      accessToken,
      {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: recipient,
        type: "text",
        text: { body: outboundMessage },
      },
      allowlist,
      grantAllowlist,
    );
  }

  for (let index = 0; index < richAttachments.length; index += 1) {
    const attachment = richAttachments[index] as ChannelAttachment;
    try {
      providerMessageId = await whatsappSendAttachment(
        baseUrl,
        phoneNumberId,
        accessToken,
        recipient,
        attachment,
        index,
        allowlist,
        grantAllowlist,
      );
    } catch (error) {
      if (providerMessageId) {
        const detail = error instanceof Error ? error.message : String(error);
        throwChannelUnknownAfterSend(
          "whatsapp.send",
          `partial_channel_delivery_sent: message ${providerMessageId} was sent before attachment ${index + 1} failed. ${detail}`,
          providerMessageId,
        );
      }
      throw error;
    }
  }

  if (!providerMessageId) {
    throw new Error("WhatsApp send requires a message or attachment");
  }
  return providerMessageId;
}

async function whatsappReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const phoneNumberId = asString(config.phoneNumberId) ?? asString(config.senderId);
  const resolvedTarget = normalizeWhatsAppTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "whatsapp") ??
      resolveDefaultChannelTarget("whatsapp", config),
  );
  const messageId = required(asString(args.messageId), "WhatsApp messageId");
  const reaction = required(asString(args.reaction), "WhatsApp reaction").trim();
  const baseUrl = normalizeWhatsAppBaseUrl(asString(config.baseUrl), asString(config.apiVersion));
  if (!accessToken) {
    throw new Error("Missing WhatsApp access token");
  }
  if (!phoneNumberId) {
    throw new Error("Missing WhatsApp phone number id");
  }
  if (!resolvedTarget) {
    throw new Error("Missing WhatsApp target");
  }
  if (isWhatsAppGroupTarget(resolvedTarget)) {
    throw new Error("WhatsApp Cloud API sender only supports direct recipients, not group JIDs");
  }

  return whatsappSendPayload(
    baseUrl,
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeWhatsAppRecipient(resolvedTarget),
      type: "reaction",
      reaction: {
        message_id: messageId,
        emoji: reaction,
      },
    },
    allowlist,
    grantAllowlist,
  );
}

const MATTERMOST_POST_ID_PATTERN = /^[a-z0-9]{26}$/;

/**
 * Threads a reply under a Mattermost root post. Only a real Mattermost post id
 * (26 lowercase alphanumerics) is used; generic reply fallbacks such as an
 * internal GoatCitadel event id are ignored so the post stays top-level
 * instead of being rejected by the server.
 */
function resolveMattermostRootId(args: Record<string, unknown>): string | undefined {
  return [args.rootId, args.threadId, args.replyToMessageId, args.replyTo]
    .map((value) => asString(value))
    .find((value): value is string => Boolean(value && MATTERMOST_POST_ID_PATTERN.test(value)));
}

async function mattermostSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const serverUrl = asString(config.serverUrl) ?? asString(config.baseUrl);
  const botToken = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const resolvedTarget =
    asString(args.target) ??
    normalizeChannelTarget(target, "mattermost") ??
    resolveDefaultChannelTarget("mattermost", config);
  if (!serverUrl) {
    throw new Error("Missing Mattermost server URL");
  }
  if (!botToken) {
    throw new Error("Missing Mattermost bot token");
  }
  if (!resolvedTarget) {
    throw new Error("Missing Mattermost target");
  }

  const parsedTarget = parseMattermostTarget(resolvedTarget);
  const rootId = resolveMattermostRootId(args);
  const botUser = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/users/me",
    allowlist,
    undefined,
    grantAllowlist,
  );
  const botUserId = required(botUser.id, "Mattermost bot user id");
  const channelId = await resolveMattermostChannelId(
    serverUrl,
    botToken,
    parsedTarget,
    botUserId,
    asString(args.team) ?? asString(config.defaultTeam),
    allowlist,
    grantAllowlist,
  );

  let fileIds: string[] | undefined;
  if (attachments.length > 0) {
    fileIds = [];
    for (const [index, attachment] of attachments.entries()) {
      const fileId = await mattermostUploadAttachment(
        serverUrl,
        botToken,
        channelId,
        attachment,
        index,
        allowlist,
        grantAllowlist,
      );
      fileIds.push(fileId);
    }
  }

  const post = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/posts",
    allowlist,
    {
      method: "POST",
      body: JSON.stringify({
        channel_id: channelId,
        message,
        ...(rootId ? { root_id: rootId } : {}),
        ...(fileIds && fileIds.length > 0 ? { file_ids: fileIds } : {}),
      }),
    },
    grantAllowlist,
  );
  return asString(post.id) ?? `mattermost-${Date.now()}`;
}

async function mattermostReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  _target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const serverUrl = asString(config.serverUrl) ?? asString(config.baseUrl);
  const botToken = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const postId = required(args.messageId, "Mattermost messageId");
  const reaction = normalizeColonWrappedReaction(required(args.reaction, "Mattermost reaction"));
  if (!serverUrl) {
    throw new Error("Missing Mattermost server URL");
  }
  if (!botToken) {
    throw new Error("Missing Mattermost bot token");
  }
  const botUser = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/users/me",
    allowlist,
    undefined,
    grantAllowlist,
  );
  const botUserId = required(botUser.id, "Mattermost bot user id");
  await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    "/reactions",
    allowlist,
    {
      method: "POST",
      body: JSON.stringify({
        user_id: botUserId,
        post_id: postId,
        emoji_name: reaction,
      }),
    },
    grantAllowlist,
  );
  return postId;
}

async function mattermostUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  _target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const serverUrl = asString(config.serverUrl) ?? asString(config.baseUrl);
  const botToken = secretFrom(config, "botToken", "botTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const postId = required(args.messageId, "Mattermost messageId");
  if (!serverUrl) {
    throw new Error("Missing Mattermost server URL");
  }
  if (!botToken) {
    throw new Error("Missing Mattermost bot token");
  }
  await mattermostApiRequest<void>(
    serverUrl,
    botToken,
    `/posts/${encodeURIComponent(postId)}`,
    allowlist,
    {
      method: "DELETE",
    },
    grantAllowlist,
  );
  return postId;
}

const MATRIX_ROOM_ID_PATTERN = /^![^\s:]+(?::\S+)?$/;
const MATRIX_EVENT_ID_PATTERN = /^\$\S+$/;

function resolveMatrixClient(
  config: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
): MatrixClientContext {
  const homeserverUrl = asString(config.homeserverUrl);
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv");
  if (!homeserverUrl) {
    throw new Error("Missing Matrix homeserver URL");
  }
  if (!accessToken) {
    throw new Error("Missing Matrix access token");
  }
  return {
    homeserverUrl,
    accessToken,
    allowlist,
    grantAllowlist,
    fetcher: async (url, init) => (await fetchAllowlisted(url, init, allowlist, undefined, grantAllowlist)).response,
  };
}

function resolveMatrixRoomId(config: Record<string, unknown>, args: Record<string, unknown>, target: string): string {
  const raw =
    asString(args.target) ??
    asString(args.roomId) ??
    normalizeChannelTarget(target, "matrix") ??
    resolveDefaultChannelTarget("matrix", config);
  if (!raw) {
    throw new Error("Missing Matrix room id");
  }
  const roomId = raw.replace(/^(?:matrix|room):/i, "");
  if (!MATRIX_ROOM_ID_PATTERN.test(roomId)) {
    throw new Error("Matrix target must be a room id like !room or !room:example.com");
  }
  return roomId;
}

function resolveMatrixEventId(value: unknown, field: string): string {
  const eventId = required(value, field);
  if (!MATRIX_EVENT_ID_PATTERN.test(eventId)) {
    throw new Error(`${field} must be a Matrix event id starting with a dollar sign`);
  }
  return eventId;
}

/** Returns the first present id; a present but non-event id throws instead of silently dropping the reply/thread. */
function optionalMatrixEventId(field: string, ...values: unknown[]): string | undefined {
  const present = values.map((value) => asString(value)).find((value): value is string => Boolean(value));
  if (present === undefined) return undefined;
  if (!MATRIX_EVENT_ID_PATTERN.test(present)) {
    throw new Error(`${field} must be a Matrix event id starting with a dollar sign`);
  }
  return present;
}

/**
 * The transaction id is deterministic only when the caller passes idempotencyKey (and chunkIndex); the gateway does
 * not pass one yet, so a retried send gets a fresh id and the homeserver cannot dedupe it. No automatic resend
 * happens after an unknown outcome.
 */
function resolveMatrixTxnId(args: Record<string, unknown>): string {
  const chunkIndex = typeof args.chunkIndex === "number" && Number.isInteger(args.chunkIndex) ? args.chunkIndex : 0;
  return deriveMatrixTxnId(asString(args.idempotencyKey), chunkIndex);
}

async function matrixSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const client = resolveMatrixClient(config, allowlist, grantAllowlist);
  const roomId = resolveMatrixRoomId(config, args, target);
  const { eventId } = await matrixSendText(client, {
    roomId,
    body: message,
    txnId: resolveMatrixTxnId(args),
    replyToEventId: optionalMatrixEventId("replyToMessageId", args.replyToMessageId, args.replyTo),
    threadRootId: optionalMatrixEventId("threadId", args.threadId, args.rootId),
  });
  return eventId;
}

/** Token mint is not an external side effect; the message POST is. */
function chinaPlatformFetchers(allowlist: string[], grantAllowlist?: string[]) {
  return {
    tokenFetch: async (url: string, init: RequestInit) =>
      (await fetchAllowlisted(url, init, allowlist, undefined, grantAllowlist, { crossesExternalSideEffect: false }))
        .response,
    apiFetch: async (url: string, init: RequestInit) =>
      (await fetchAllowlisted(url, init, allowlist, undefined, grantAllowlist)).response,
  };
}

async function qqbotSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const appId = asString(config.appId);
  const appSecret = secretFrom(config, "appSecret", "appSecretEnv");
  if (!appId) {
    throw new Error("Missing QQBot app id");
  }
  if (!appSecret) {
    throw new Error("Missing QQBot app secret");
  }
  const resolvedTarget = normalizeChannelTarget(target, "qqbot") ?? resolveDefaultChannelTarget("qqbot", config);
  if (!resolvedTarget) {
    throw new Error("Missing QQBot target");
  }
  const partIndex = Math.max(0, parseIntegerLike(args.replyToPartIndex) ?? 0);
  const replyMsgId = asString(args.replyAnchorMessageId) ?? asString(args.replyToMessageId) ?? asString(args.replyTo);
  // The passive-reply cap only applies when a msg_id anchor makes this a passive reply; active sends are quota-bound instead.
  const passiveLimit = qqbotPassiveReplyLimit(resolvedTarget);
  if (replyMsgId && partIndex >= passiveLimit) {
    throw new Error(`QQ allows at most ${passiveLimit} passive replies per message; shorten the reply`);
  }
  const { tokenFetch, apiFetch } = chinaPlatformFetchers(allowlist, grantAllowlist);
  const token = await getQqbotAccessToken({ appId, appSecret, fetcher: tokenFetch });
  // A random base per send keeps a later send (e.g. the final answer after an earlier channel.reply to the same
  // msg_id) from reusing seq 1 and being dropped by QQ's dedupe. The chunk index is added so chunks stay ordered.
  const msgSeq = randomInt(1, 2 ** 31 - 64) + partIndex;
  const { messageId } = await qqbotSendText({
    token,
    refreshToken: async () => {
      clearQqbotAccessToken({ appId, appSecret });
      return getQqbotAccessToken({ appId, appSecret, fetcher: tokenFetch });
    },
    sandbox: config.sandbox === true || asString(config.sandbox)?.toLowerCase() === "true",
    target: resolvedTarget,
    content: message,
    // Passive replies need the inbound message id; later chunks carry the previous QQ message id as
    // replyToMessageId, so the original anchor is read first.
    replyMsgId,
    msgSeq,
    fetcher: apiFetch,
  });
  return messageId;
}

async function wecomSend(
  config: Record<string, unknown>,
  _args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string | undefined> {
  const corpId = asString(config.corpId);
  const agentId = asString(config.agentId) ?? (typeof config.agentId === "number" ? String(config.agentId) : undefined);
  const secret = secretFrom(config, "secret", "secretEnv");
  if (!corpId) {
    throw new Error("Missing WeCom corp id");
  }
  if (!agentId) {
    throw new Error("Missing WeCom agent id");
  }
  if (!secret) {
    throw new Error("Missing WeCom application secret");
  }
  const resolvedTarget = normalizeChannelTarget(target, "wecom") ?? resolveDefaultChannelTarget("wecom", config);
  if (!resolvedTarget) {
    throw new Error("Missing WeCom target");
  }
  const { tokenFetch, apiFetch } = chinaPlatformFetchers(allowlist, grantAllowlist);
  const token = await getWecomAccessToken({ corpId, secret, fetcher: tokenFetch });
  const { messageId } = await wecomSendText({
    token,
    agentId,
    target: resolvedTarget,
    content: message,
    fetcher: apiFetch,
    refreshToken: async () => {
      clearWecomAccessToken({ corpId, secret });
      return getWecomAccessToken({ corpId, secret, fetcher: tokenFetch });
    },
  });
  return messageId;
}

async function matrixReactAction(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const client = resolveMatrixClient(config, allowlist, grantAllowlist);
  const roomId = resolveMatrixRoomId(config, args, target);
  const eventId = resolveMatrixEventId(args.messageId, "Matrix messageId");
  const key = required(args.reaction, "Matrix reaction");
  const result = await matrixReact(client, { roomId, eventId, key, txnId: resolveMatrixTxnId(args) });
  return result.eventId;
}

async function matrixUnsend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const client = resolveMatrixClient(config, allowlist, grantAllowlist);
  const roomId = resolveMatrixRoomId(config, args, target);
  const eventId = resolveMatrixEventId(args.messageId, "Matrix messageId");
  const result = await matrixRedact(client, {
    roomId,
    eventId,
    txnId: resolveMatrixTxnId(args),
    reason: asString(args.reason),
  });
  return result.eventId;
}

async function nextcloudTalkSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  attachments: ChannelAttachment[] = [],
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = asString(config.baseUrl);
  const secret =
    secretFrom(config, "token", "tokenEnv") ??
    secretFrom(config, "botSecret", "botSecretEnv") ??
    secretFrom(config, "secret", "secretEnv");
  const roomToken = normalizeNextcloudTalkTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "nextcloud-talk") ??
      resolveDefaultChannelTarget("nextcloud-talk", config),
  );
  const replyTo = asString(args.replyTo);
  const outboundMessage = required(message, "Nextcloud Talk message");
  if (!baseUrl) {
    throw new Error("Missing Nextcloud Talk base URL");
  }
  if (!secret) {
    throw new Error("Missing Nextcloud Talk token");
  }
  if (!roomToken) {
    throw new Error("Missing Nextcloud Talk target");
  }
  if (attachments.length > 0) {
    throw new Error("Nextcloud Talk does not support attachments in this adapter");
  }

  const payload: Record<string, unknown> = { message: outboundMessage };
  if (replyTo) {
    payload.replyTo = replyTo;
  }
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(random + outboundMessage)
    .digest("hex");
  const res = await fetchAllowlisted(
    `${baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(roomToken)}/message`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`nextcloud-talk.send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const body = parseJsonRecord(bodyText);
  const ocs = record(body.ocs);
  const data = record(ocs.data);
  return data.id != null ? String(data.id) : `nextcloud-talk-${Date.now()}`;
}

async function nextcloudTalkReact(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  grantAllowlist?: string[],
): Promise<string> {
  const baseUrl = asString(config.baseUrl);
  const secret =
    secretFrom(config, "token", "tokenEnv") ??
    secretFrom(config, "botSecret", "botSecretEnv") ??
    secretFrom(config, "secret", "secretEnv");
  const roomToken = normalizeNextcloudTalkTarget(
    asString(args.target) ??
      normalizeChannelTarget(target, "nextcloud-talk") ??
      resolveDefaultChannelTarget("nextcloud-talk", config),
  );
  const messageId = required(asString(args.messageId), "Nextcloud Talk messageId");
  const reaction = required(asString(args.reaction), "Nextcloud Talk reaction");
  if (!baseUrl) {
    throw new Error("Missing Nextcloud Talk base URL");
  }
  if (!secret) {
    throw new Error("Missing Nextcloud Talk token");
  }
  if (!roomToken) {
    throw new Error("Missing Nextcloud Talk target");
  }

  const payload = { reaction };
  const bodyText = JSON.stringify(payload);
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret)
    .update(random + bodyText)
    .digest("hex");
  const res = await fetchAllowlisted(
    `${baseUrl.replace(/\/+$/, "")}/ocs/v2.php/apps/spreed/api/v1/bot/${encodeURIComponent(roomToken)}/reaction/${encodeURIComponent(messageId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "OCS-APIRequest": "true",
        "X-Nextcloud-Talk-Bot-Random": random,
        "X-Nextcloud-Talk-Bot-Signature": signature,
      },
      body: bodyText,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const responseText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`nextcloud-talk.react failed (${res.response.status})${responseText ? `: ${responseText}` : ""}`);
  }
  return messageId;
}

async function zaloSend(
  config: Record<string, unknown>,
  args: Record<string, unknown>,
  allowlist: string[],
  target: string,
  message: string,
  grantAllowlist?: string[],
): Promise<string> {
  const accessToken = secretFrom(config, "accessToken", "accessTokenEnv") ?? secretFrom(config, "token", "tokenEnv");
  const chatId = normalizeZaloTarget(
    asString(args.target) ?? normalizeChannelTarget(target, "zalo") ?? resolveDefaultChannelTarget("zalo", config),
  );
  const outboundMessage = required(message, "Zalo message");
  if (!accessToken) {
    throw new Error("Missing Zalo access token");
  }
  if (!chatId) {
    throw new Error("Missing Zalo target");
  }

  const chunks = chunkText(outboundMessage, 2000, 0, 20);
  let messageId: string | undefined;
  for (const chunk of chunks) {
    const res = await fetchAllowlisted(
      "https://openapi.zalo.me/v2.0/oa/message",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", access_token: accessToken },
        body: JSON.stringify({
          recipient: { user_id: chatId },
          message: { text: chunk },
        }),
      },
      allowlist,
      undefined,
      grantAllowlist,
    );
    const bodyText = await res.response.text();
    const body = parseJsonRecord(bodyText);
    if (!res.response.ok || isZaloApiErrorPayload(body)) {
      const description = readZaloApiErrorDescription(body);
      throw new Error(`zalo.send failed (${res.response.status})${description ? `: ${description}` : ""}`);
    }
    messageId = readZaloMessageId(body) ?? messageId;
  }

  return messageId ?? `zalo-${Date.now()}`;
}

function parseJsonRecord(bodyText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    return record(parsed);
  } catch {
    return {};
  }
}

function appendDiscordWebhookQuery(webhookUrl: string, key: string, value: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set(key, value);
  return url.toString();
}

function encodeDiscordEmoji(value: string): string {
  return encodeURIComponent(value.trim());
}

function normalizeSlackReaction(value: unknown): string {
  return normalizeColonWrappedReaction(required(value, "Slack reaction"));
}

function isSlackConversationId(value: string): boolean {
  return /^[CDGU][A-Z0-9]+$/i.test(value.trim());
}

function normalizeColonWrappedReaction(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^:/, "").replace(/:$/, "");
}

function providerMessageIdFromValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function normalizeChannelTarget(target: string | undefined, channelKey: string): string | undefined {
  if (!target || target === channelKey) {
    return undefined;
  }
  return target;
}

const CHANNEL_TARGET_KEYS: Record<string, string[]> = {
  slack: ["defaultChannel", "defaultTarget", "target"],
  discord: ["defaultChannelId", "defaultTarget", "target"],
  telegram: ["defaultChatId", "defaultTarget", "target"],
  ntfy: ["topic", "defaultTopic", "defaultTarget", "target"],
  "google-chat": ["defaultSpace", "defaultThreadKey", "defaultTarget", "target"],
  whatsapp: ["defaultTarget", "defaultRecipient", "target"],
  mattermost: ["defaultChannel", "defaultTarget", "target"],
  matrix: ["defaultRoomId", "defaultTarget", "target"],
  qqbot: ["defaultTarget", "target"],
  wecom: ["defaultTarget", "target"],
  "nextcloud-talk": ["defaultRoomId", "defaultConversationId", "defaultTarget", "target"],
  line: ["defaultTarget", "defaultUserId", "defaultGroupId", "defaultRoomId", "target"],
  zalo: ["defaultRecipientId", "defaultTarget", "target"],
};

type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

function normalizeLineTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^line:(?:user|group|room):/i, "")
    .replace(/^line:/i, "")
    .trim();
}

function validateWhatsAppBaseUrl(url: string): void {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const isAllowedMetaHost =
      hostname === "graph.facebook.com" ||
      hostname.endsWith(".facebook.com") ||
      hostname === "facebook.com" ||
      hostname.endsWith(".meta.com") ||
      hostname === "meta.com";

    const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";

    if (!isAllowedMetaHost && !isLoopback) {
      throw new Error(`WhatsApp outbound URL host "${parsed.hostname}" is not an allowed Meta or localhost domain.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not an allowed Meta or localhost domain")) {
      throw error;
    }
    throw new Error(`Invalid WhatsApp baseUrl: ${url}`, { cause: error });
  }
}

function normalizeWhatsAppBaseUrl(baseUrl: string | undefined, apiVersion: string | undefined): string {
  const trimmedBaseUrl = asString(baseUrl)?.trim();
  let result: string;
  if (trimmedBaseUrl) {
    result = trimmedBaseUrl.replace(/\/+$/, "");
  } else {
    const normalizedVersion = asString(apiVersion)?.trim() ?? "v23.0";
    result = `https://graph.facebook.com/${normalizedVersion.replace(/^\/+/, "").replace(/\/+$/, "")}`;
  }
  validateWhatsAppBaseUrl(result);
  return result;
}

function normalizeWhatsAppTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  let candidate = trimmed;
  for (;;) {
    const next = candidate.replace(/^whatsapp:/i, "").trim();
    if (next === candidate) {
      break;
    }
    candidate = next;
  }
  if (!candidate) {
    return undefined;
  }
  const lower = candidate.toLowerCase();
  if (lower.endsWith("@g.us")) {
    const localPart = candidate.slice(0, candidate.length - "@g.us".length);
    return /^[0-9]+(?:-[0-9]+)*$/u.test(localPart) ? `${localPart}@g.us` : undefined;
  }
  const userMatch = candidate.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/i) ?? candidate.match(/^(\d+)@lid$/i);
  if (userMatch) {
    return `+${userMatch[1]}`;
  }
  if (candidate.includes("@")) {
    return undefined;
  }
  const digits = candidate.replace(/[^\d]/g, "");
  return digits.length >= 2 ? `+${digits}` : undefined;
}

function isWhatsAppGroupTarget(target: string): boolean {
  return target.toLowerCase().endsWith("@g.us");
}

function normalizeWhatsAppRecipient(target: string): string {
  return target.replace(/[^\d]/g, "");
}

function resolveWhatsAppAttachmentType(attachment: ChannelAttachment): "audio" | "document" | "image" | "video" {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) {
    return "image";
  }
  if (mimeType?.startsWith("video/")) {
    return "video";
  }
  if (mimeType?.startsWith("audio/")) {
    return "audio";
  }

  const candidate = `${asString(attachment.title) ?? ""} ${asString(attachment.url) ?? ""}`.toLowerCase();
  if (/\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:$|[?#\s])/i.test(candidate)) {
    return "image";
  }
  if (/\.(mov|mp4|m4v|mkv|webm)(?:$|[?#\s])/i.test(candidate)) {
    return "video";
  }
  if (/\.(aac|m4a|mp3|oga|ogg|wav)(?:$|[?#\s])/i.test(candidate)) {
    return "audio";
  }
  return "document";
}

function normalizeNextcloudTalkTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^(nextcloud-talk|nc-talk|nc):/i, "")
    .replace(/^room:/i, "")
    .trim();
}

function normalizeZaloTarget(target: string | undefined): string | undefined {
  const trimmed = asString(target);
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^(zalo|zl):/i, "")
    .replace(/^group:/i, "")
    .trim();
}

function parseZaloErrorCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function isZaloApiErrorPayload(body: Record<string, unknown>): boolean {
  const code = parseZaloErrorCode(body.error);
  if (code !== undefined) {
    return code !== 0;
  }
  return body.error !== undefined && body.error !== null && body.error !== "";
}

function readZaloApiErrorDescription(body: Record<string, unknown>): string | undefined {
  const error = record(body.error);
  return asString(body.message) ?? asString(body.description) ?? asString(error.message) ?? asString(body.error);
}

function readZaloMessageId(body: Record<string, unknown>): string | undefined {
  const data = record(body.data);
  const result = record(body.result);
  const message = record(body.message);
  return (
    providerMessageIdFromValue(data.message_id) ??
    providerMessageIdFromValue(data.msg_id) ??
    providerMessageIdFromValue(result.message_id) ??
    providerMessageIdFromValue(message.message_id) ??
    providerMessageIdFromValue(body.message_id)
  );
}

async function resolveChannelAttachmentBytes(
  attachment: ChannelAttachment,
  allowlist: string[],
  providerLabel: string,
  grantAllowlist?: string[],
): Promise<{
  bytes: Buffer;
  contentType?: string;
}> {
  if (attachment.dataBase64) {
    return {
      bytes: Buffer.from(attachment.dataBase64, "base64"),
      contentType: attachment.mimeType,
    };
  }
  const sourceUrl = required(attachment.url, `${providerLabel} attachment URL`);
  const attachmentRes = await fetchAllowlisted(sourceUrl, { method: "GET" }, allowlist, undefined, grantAllowlist);
  if (!attachmentRes.response.ok) {
    throw new Error(`${providerLabel} attachment fetch failed (${attachmentRes.response.status})`);
  }
  return {
    bytes: Buffer.from(await attachmentRes.response.arrayBuffer()),
    contentType: attachmentRes.response.headers.get("content-type") ?? attachment.mimeType ?? undefined,
  };
}

function resolveChannelAttachmentName(attachment: ChannelAttachment, index: number): string {
  const explicitTitle = asString(attachment.title)?.trim();
  if (explicitTitle) {
    return explicitTitle;
  }

  const attachmentUrl = asString(attachment.url);
  if (attachmentUrl) {
    try {
      const pathname = new URL(attachmentUrl).pathname;
      const basename = pathname.split("/").pop()?.trim();
      if (basename) {
        return decodeURIComponent(basename);
      }
    } catch {
      // Ignore URL parsing failures and fall back to a generated name.
    }
  }

  const ext = inferAttachmentExtension(attachment.mimeType);
  return `attachment-${index + 1}${ext}`;
}

function isImageChannelAttachment(attachment: ChannelAttachment): boolean {
  const mimeType = attachment.mimeType?.trim().toLowerCase();
  if (mimeType?.startsWith("image/")) {
    return true;
  }
  const candidate = asString(attachment.title) ?? asString(attachment.url) ?? "";
  return /\.(avif|bmp|gif|heic|heif|jpe?g|png|svg|webp)(?:$|[?#])/i.test(candidate);
}

function inferAttachmentExtension(mimeType: string | undefined): string {
  const normalized = mimeType?.trim().toLowerCase();
  if (!normalized || !normalized.includes("/")) {
    return "";
  }
  const subtype = normalized.split("/", 2)[1]?.split(";", 1)[0]?.trim();
  if (!subtype) {
    return "";
  }
  if (subtype === "jpeg") {
    return ".jpg";
  }
  return `.${subtype.replace(/[^a-z0-9.+-]/g, "")}`;
}

function parseIntegerLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMattermostTarget(target: string): MattermostTarget {
  const trimmed = required(target, "Mattermost target");
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("channel:")) {
    const channelTarget = required(trimmed.slice("channel:".length), "Mattermost channel target");
    if (channelTarget.startsWith("#")) {
      return { kind: "channel-name", name: required(channelTarget.slice(1), "Mattermost channel name") };
    }
    return looksLikeMattermostId(channelTarget)
      ? { kind: "channel", id: channelTarget }
      : { kind: "channel-name", name: channelTarget };
  }
  if (lowered.startsWith("user:")) {
    return { kind: "user", id: required(trimmed.slice("user:".length), "Mattermost user id") };
  }
  if (lowered.startsWith("mattermost:")) {
    return { kind: "user", id: required(trimmed.slice("mattermost:".length), "Mattermost user id") };
  }
  if (trimmed.startsWith("@")) {
    return { kind: "user", username: required(trimmed.slice(1), "Mattermost username") };
  }
  if (trimmed.startsWith("#")) {
    return { kind: "channel-name", name: required(trimmed.slice(1), "Mattermost channel name") };
  }
  return looksLikeMattermostId(trimmed) ? { kind: "channel", id: trimmed } : { kind: "channel-name", name: trimmed };
}

function looksLikeMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/i.test(value.trim());
}

async function resolveMattermostChannelId(
  serverUrl: string,
  botToken: string,
  target: MattermostTarget,
  botUserId: string,
  defaultTeam: string | undefined,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  if (target.kind === "channel") {
    return target.id;
  }
  if (target.kind === "user") {
    const userId =
      target.id || (await resolveMattermostUserId(serverUrl, botToken, target.username, allowlist, grantAllowlist));
    const channel = await mattermostApiRequest<Record<string, unknown>>(
      serverUrl,
      botToken,
      "/channels/direct",
      allowlist,
      {
        method: "POST",
        body: JSON.stringify([botUserId, userId]),
      },
      grantAllowlist,
    );
    return required(channel.id, "Mattermost DM channel id");
  }

  const teamIds = defaultTeam
    ? [await resolveMattermostTeamId(serverUrl, botToken, defaultTeam, allowlist, grantAllowlist)]
    : await resolveMattermostTeamIds(serverUrl, botToken, botUserId, allowlist, grantAllowlist);

  for (const teamId of teamIds) {
    try {
      const channel = await mattermostApiRequest<Record<string, unknown>>(
        serverUrl,
        botToken,
        `/teams/${encodeURIComponent(teamId)}/channels/name/${encodeURIComponent(target.name)}`,
        allowlist,
        undefined,
        grantAllowlist,
      );
      return required(channel.id, "Mattermost channel id");
    } catch (error) {
      if (error instanceof Error && error.message.includes("(404)")) {
        continue;
      }
      throw error;
    }
  }

  if (teamIds.length === 0) {
    throw new Error("Mattermost bot is not a member of any team");
  }

  throw new Error(`Mattermost channel "#${target.name}" not found`);
}

async function resolveMattermostUserId(
  serverUrl: string,
  botToken: string,
  username: string | undefined,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const user = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    `/users/username/${encodeURIComponent(required(username, "Mattermost username"))}`,
    allowlist,
    undefined,
    grantAllowlist,
  );
  return required(user.id, "Mattermost user id");
}

async function resolveMattermostTeamId(
  serverUrl: string,
  botToken: string,
  teamName: string,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const team = await mattermostApiRequest<Record<string, unknown>>(
    serverUrl,
    botToken,
    `/teams/name/${encodeURIComponent(teamName)}`,
    allowlist,
    undefined,
    grantAllowlist,
  );
  return required(team.id, "Mattermost team id");
}

async function resolveMattermostTeamIds(
  serverUrl: string,
  botToken: string,
  botUserId: string,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string[]> {
  const teams = await mattermostApiRequest<Array<Record<string, unknown>>>(
    serverUrl,
    botToken,
    `/users/${encodeURIComponent(botUserId)}/teams`,
    allowlist,
    undefined,
    grantAllowlist,
  );
  return teams.map((team) => asString(team.id)).filter((teamId): teamId is string => Boolean(teamId));
}

async function mattermostApiRequest<T>(
  serverUrl: string,
  botToken: string,
  apiPath: string,
  allowlist: string[],
  init: RequestInit = {},
  grantAllowlist?: string[],
): Promise<T> {
  const url = `${serverUrl.replace(/\/+$/, "")}/api/v4${apiPath}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${botToken}`);
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetchAllowlisted(
    url,
    {
      ...init,
      headers,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    const detail = bodyText.trim();
    throw new Error(`mattermost.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (!bodyText) {
    return undefined as T;
  }
  return JSON.parse(bodyText) as T;
}

async function mattermostUploadAttachment(
  serverUrl: string,
  botToken: string,
  channelId: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Mattermost", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const blobBytes = new Uint8Array(attachmentData.bytes.length);
  blobBytes.set(attachmentData.bytes);
  const formData = new FormData();
  formData.set("channel_id", channelId);
  formData.append(
    "files",
    new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
    fileName,
  );
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${botToken}`);
  const res = await fetchAllowlisted(
    `${serverUrl.replace(/\/+$/, "")}/api/v4/files`,
    {
      method: "POST",
      headers,
      body: formData,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`mattermost.send failed (${res.response.status})${bodyText ? `: ${bodyText}` : ""}`);
  }
  const body = parseJsonRecord(bodyText);
  const fileInfos = Array.isArray(body.file_infos)
    ? body.file_infos.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  const firstFile = fileInfos[0];
  return required(firstFile?.id, "Mattermost uploaded file id");
}

async function slackUploadAttachment(
  token: string,
  channel: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
  threadTs?: string,
): Promise<string> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "Slack", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const metadataRes = await fetchAllowlisted(
    "https://slack.com/api/files.getUploadURLExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        filename: fileName,
        length: attachmentData.bytes.length,
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const metadataBodyText = await metadataRes.response.text();
  const metadataBody = parseJsonRecord(metadataBodyText);
  if (!metadataRes.response.ok || metadataBody.ok === false) {
    throw new Error(
      `slack.send failed (${metadataRes.response.status})${metadataBody.error ? `: ${metadataBody.error}` : ""}`,
    );
  }
  const uploadUrl = required(metadataBody.upload_url, "Slack upload URL");
  const fileId = required(metadataBody.file_id, "Slack file id");

  const uploadRes = await fetchAllowlisted(
    uploadUrl,
    {
      method: "POST",
      headers: attachmentData.contentType ? { "Content-Type": attachmentData.contentType } : undefined,
      body: new Uint8Array(attachmentData.bytes),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const uploadBodyText = await uploadRes.response.text();
  if (!uploadRes.response.ok) {
    throw new Error(`slack.send failed (${uploadRes.response.status})${uploadBodyText ? `: ${uploadBodyText}` : ""}`);
  }

  const completeRes = await fetchAllowlisted(
    "https://slack.com/api/files.completeUploadExternal",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        files: [
          {
            id: fileId,
            title: attachment.title?.trim() || fileName,
          },
        ],
        channel_id: channel,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const completeBodyText = await completeRes.response.text();
  const completeBody = parseJsonRecord(completeBodyText);
  if (!completeRes.response.ok || completeBody.ok === false) {
    throw new Error(
      `slack.send failed (${completeRes.response.status})${completeBody.error ? `: ${completeBody.error}` : ""}`,
    );
  }
  return fileId;
}

async function whatsappSendPayload(
  baseUrl: string,
  phoneNumberId: string,
  accessToken: string,
  payload: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const res = await fetchAllowlisted(
    `${baseUrl}/${encodeURIComponent(phoneNumberId)}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || Object.keys(record(body.error)).length > 0) {
    const errorBody = record(body.error);
    const detail = asString(errorBody.message) ?? bodyText.trim();
    if (!res.response.ok) {
      throwChannelProviderFailure("whatsapp.send", res.response, detail);
    }
    throw new Error(`whatsapp.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  const messages = Array.isArray(body.messages)
    ? body.messages.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
  return asString(messages[0]?.id) ?? `whatsapp-${Date.now()}`;
}

async function whatsappSendAttachment(
  baseUrl: string,
  phoneNumberId: string,
  accessToken: string,
  recipient: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const type = resolveWhatsAppAttachmentType(attachment);
  const attachmentField: Record<string, unknown> = {};
  if (attachment.dataBase64) {
    attachmentField.id = await whatsappUploadAttachment(
      baseUrl,
      phoneNumberId,
      accessToken,
      attachment,
      index,
      allowlist,
      grantAllowlist,
    );
  } else {
    attachmentField.link = required(attachment.url, "WhatsApp attachment URL");
  }
  if (type === "document") {
    attachmentField.filename = resolveChannelAttachmentName(attachment, index);
  }
  return whatsappSendPayload(
    baseUrl,
    phoneNumberId,
    accessToken,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type,
      [type]: attachmentField,
    },
    allowlist,
    grantAllowlist,
  );
}

async function whatsappUploadAttachment(
  baseUrl: string,
  phoneNumberId: string,
  accessToken: string,
  attachment: ChannelAttachment,
  index: number,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<string> {
  const attachmentData = await resolveChannelAttachmentBytes(attachment, allowlist, "WhatsApp", grantAllowlist);
  const fileName = resolveChannelAttachmentName(attachment, index);
  const blobBytes = new Uint8Array(attachmentData.bytes.length);
  blobBytes.set(attachmentData.bytes);
  const formData = new FormData();
  formData.set("messaging_product", "whatsapp");
  if (attachmentData.contentType) {
    formData.set("type", attachmentData.contentType);
  }
  formData.append(
    "file",
    new Blob([blobBytes], attachmentData.contentType ? { type: attachmentData.contentType } : undefined),
    fileName,
  );
  const headers = new Headers();
  headers.set("Authorization", `Bearer ${accessToken}`);
  const res = await fetchAllowlisted(
    `${baseUrl}/${encodeURIComponent(phoneNumberId)}/media`,
    {
      method: "POST",
      headers,
      body: formData,
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const bodyText = await res.response.text();
  const body = parseJsonRecord(bodyText);
  if (!res.response.ok || Object.keys(record(body.error)).length > 0) {
    const errorBody = record(body.error);
    const detail = asString(errorBody.message) ?? bodyText.trim();
    if (!res.response.ok) {
      throwChannelProviderFailure("whatsapp.send", res.response, detail);
    }
    throw new Error(`whatsapp.send failed (${res.response.status})${detail ? `: ${detail}` : ""}`);
  }
  return required(body.id, "WhatsApp uploaded media id");
}

function safeJsonParse<T>(body: string, fallback: T): T {
  try {
    return body ? (JSON.parse(body) as T) : fallback;
  } catch {
    return fallback;
  }
}

const GMAIL_MESSAGES_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages";
const GMAIL_READ_MAX_RESULTS = 25;
const GMAIL_READ_MAX_QUERY_CHARS = 512;
const GMAIL_READ_CONCURRENCY = 5;
const GMAIL_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Lists matching messages, then reads only their metadata (From, To, Subject, Date, snippet)
 * with `messages.get?format=metadata`. Bodies and attachments are never fetched, and every
 * field is bounded and marked as untrusted external content.
 */
async function gmailRead(
  accessToken: string,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
): Promise<Record<string, unknown>> {
  const maxResults = clampInt(args.maxResults, 10, 1, GMAIL_READ_MAX_RESULTS);
  const url = new URL(GMAIL_MESSAGES_URL);
  const query = asString(args.query);
  if (query) {
    url.searchParams.set("q", query.slice(0, GMAIL_READ_MAX_QUERY_CHARS));
  }
  url.searchParams.set("maxResults", String(maxResults));
  const list = await googleGetJson(url, accessToken, "gmail.read", allowlist, grantAllowlist);
  const ids = (Array.isArray(list.messages) ? list.messages : [])
    .map((item) => asString(record(item).id))
    .filter((id): id is string => Boolean(id && GMAIL_MESSAGE_ID_PATTERN.test(id)))
    .slice(0, maxResults);
  const batches: GmailMessageSummary[][] = [];
  for (let index = 0; index < ids.length; index += GMAIL_READ_CONCURRENCY) {
    const batch = await Promise.all(
      ids.slice(index, index + GMAIL_READ_CONCURRENCY).map(async (id) => {
        const messageUrl = new URL(`${GMAIL_MESSAGES_URL}/${encodeURIComponent(id)}`);
        messageUrl.searchParams.set("format", "metadata");
        for (const header of GMAIL_SUMMARY_HEADERS) messageUrl.searchParams.append("metadataHeaders", header);
        // A message deleted between the list and this read is skipped, not a failed read.
        const message = await googleGetJson(messageUrl, accessToken, "gmail.read", allowlist, grantAllowlist, {
          missingAsEmpty: true,
        });
        return summarizeGmailMessage(message);
      }),
    );
    batches.push(batch.filter((item): item is GmailMessageSummary => Boolean(item)));
  }
  return {
    records: batches.flat(),
    ...(asString(list.nextPageToken) ? { hasMore: true } : {}),
    contentTrust: "untrusted_external",
    notice: GMAIL_UNTRUSTED_CONTENT_NOTICE,
    sourceAttribution: [
      {
        sourceType: "text",
        sourceRef: "gmail:users/me/messages",
        title: "Gmail messages",
        trustLevel: "untrusted_external",
      },
    ],
  };
}

async function googleGetJson(
  url: URL,
  accessToken: string,
  operation: string,
  allowlist: string[],
  grantAllowlist?: string[],
  options: { missingAsEmpty?: boolean } = {},
): Promise<Record<string, unknown>> {
  const res = await fetchAllowlisted(
    url.toString(),
    { method: "GET", headers: { Authorization: `Bearer ${accessToken}` } },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (options.missingAsEmpty && res.response.status === 404) {
    return {};
  }
  if (!res.response.ok) {
    throw new Error(`${operation} failed (${res.response.status})`);
  }
  return parseJsonRecord(body);
}

async function gmailSend(
  accessToken: string,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const to = stringArray(args.to);
  if (to.length === 0) {
    throw new Error("gmail.send requires args.to");
  }
  const subject = required(args.subject, "subject");
  const bodyText = required(args.bodyText, "bodyText");
  const rawMessage = [
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    bodyText,
  ].join("\r\n");
  const raw = Buffer.from(rawMessage).toString("base64url");
  const res = await fetchAllowlisted(
    `${GMAIL_MESSAGES_URL}/send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ raw }),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`gmail.send failed (${res.response.status})`);
  }
  return safeJsonParse<{ id?: string }>(body, {}).id ?? `gmail-${Date.now()}`;
}

async function calendarList(
  accessToken: string,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const calendarId = encodeURIComponent(asString(args.calendarId) ?? "primary");
  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`);
  if (asString(args.fromIso)) url.searchParams.set("timeMin", asString(args.fromIso) as string);
  if (asString(args.toIso)) url.searchParams.set("timeMax", asString(args.toIso) as string);
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(clampInt(args.maxResults, 10, 1, 100)));
  const body = await googleGetJson(url, accessToken, "calendar.list", allowlist, grantAllowlist);
  return Array.isArray(body.items) ? body.items : [];
}

async function calendarCreate(
  accessToken: string,
  args: Record<string, unknown>,
  allowlist: string[],
  grantAllowlist?: string[],
) {
  const calendarId = encodeURIComponent(asString(args.calendarId) ?? "primary");
  const payload = {
    summary: required(args.title, "title"),
    description: asString(args.description),
    location: asString(args.location),
    start: { dateTime: required(args.startIso, "startIso"), timeZone: asString(args.timeZone) ?? "UTC" },
    end: { dateTime: required(args.endIso, "endIso"), timeZone: asString(args.timeZone) ?? "UTC" },
    attendees: stringArray(args.attendees).map((email) => ({ email })),
  };
  const res = await fetchAllowlisted(
    `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify(payload),
    },
    allowlist,
    undefined,
    grantAllowlist,
  );
  const body = await res.response.text();
  if (!res.response.ok) {
    throw new Error(`calendar.create_event failed (${res.response.status})`);
  }
  return safeJsonParse<{ id?: string }>(body, {}).id ?? `calendar-${Date.now()}`;
}

/**
 * Marks the active comms mutation as started for a non-HTTP provider transport,
 * awaiting the durable external-boundary hook first exactly as fetchAllowlisted does
 * before a non-retryable request. A later failure is then classified as an unknown
 * external outcome instead of a pre-boundary refusal.
 */
async function markCommsMutationRequestStarted(): Promise<void> {
  const boundaryState = commsRequestBoundaryContext.getStore();
  if (!boundaryState) {
    return;
  }
  if (!boundaryState.externalBoundaryReported) {
    await boundaryState.beforeExternalSideEffect?.();
    boundaryState.externalBoundaryReported = true;
  }
  boundaryState.mutationRequestStarted = true;
}

async function fetchAllowlisted(
  url: string,
  init: RequestInit,
  allowlist: string[],
  signal?: AbortSignal,
  grantAllowlist?: string[],
  boundaryOptions: { crossesExternalSideEffect?: boolean } = {},
): Promise<{ response: Response; finalUrl: string }> {
  const crossesExternalSideEffect = boundaryOptions.crossesExternalSideEffect ?? !isHttpRequestSafeToRetry(init);
  let current = url;
  for (let hop = 0; hop <= MAX_HTTP_REDIRECTS; hop += 1) {
    assertHostAllowed(current, allowlist);
    if (grantAllowlist && grantAllowlist.length > 0) {
      assertHostAllowed(current, grantAllowlist);
    }
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      const boundaryState = commsRequestBoundaryContext.getStore();
      if (boundaryState && crossesExternalSideEffect) {
        if (!boundaryState.externalBoundaryReported) {
          await boundaryState.beforeExternalSideEffect?.();
          boundaryState.externalBoundaryReported = true;
        }
        boundaryState.mutationRequestStarted = true;
      }
      response = await fetchAllowlistedOnce(current, {
        allowlist,
        init: {
          ...init,
          redirect: "manual",
          signal: composeAbortSignal(20000, signal),
        },
      });
      if (boundaryState && crossesExternalSideEffect) {
        boundaryState.mutationResponseReceived = true;
      }
      if (
        !isHttpRequestSafeToRetry(init) ||
        !RETRYABLE_HTTP_STATUSES.has(response.status) ||
        attempt >= MAX_HTTP_RETRIES
      ) {
        break;
      }
      await waitForHttpRetry(response, attempt, signal);
    }
    if (!(response.status >= 300 && response.status < 400)) {
      return { response, finalUrl: current };
    }
    try {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect missing location for ${redactUrlForError(current)}`);
      }
      const next = new URL(location, current).toString();
      assertSafeRedirectTransition(current, next, init);
      assertHostAllowed(next, allowlist);
      if (grantAllowlist && grantAllowlist.length > 0) {
        assertHostAllowed(next, grantAllowlist);
      }
      current = next;
    } catch (error) {
      throw new CommsResponseBoundaryError(error);
    }
  }
  throw new CommsResponseBoundaryError(`Too many redirects for ${redactUrlForError(url)}`);
}

async function waitForHttpRetry(response: Response, attempt: number, signal?: AbortSignal): Promise<void> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  const delayMs = Math.min(retryAfterMs ?? 25 * (attempt + 1), MAX_HTTP_RETRY_DELAY_MS);
  if (delayMs <= 0) {
    return;
  }
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("request aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
      },
      { once: true },
    );
  });
}

function parseRetryAfterMs(value: string | null): number | undefined {
  return coerceRetryAfterMs(value, { maxMs: MAX_HTTP_RETRY_DELAY_MS });
}

function composeAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function secretFrom(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined {
  const direct = asString(readOwn(config, directKey));
  if (direct) return direct;
  const envName = asString(readOwn(config, envKey));
  if (!envName) return undefined;
  const envValue = process.env[envName];
  return envValue?.trim() || undefined;
}

function chunkText(text: string, targetChars: number, overlap: number, maxChunks: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const out: string[] = [];
  let cursor = 0;
  while (cursor < trimmed.length && out.length < maxChunks) {
    const end = Math.min(trimmed.length, cursor + targetChars);
    const chunk = trimmed.slice(cursor, end).trim();
    if (chunk) out.push(chunk);
    if (end >= trimmed.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (UNSAFE_OBJECT_KEYS.has(key)) {
      continue;
    }
    out[key] = (value as Record<string, unknown>)[key];
  }
  return out;
}

function readOwn(config: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(config, key) ? config[key] : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function required(value: unknown, field: string): string {
  const parsed = asString(value);
  if (!parsed) throw new Error(`${field} is required`);
  return parsed;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
}
