import { describeChannelCapabilities } from "@goatcitadel/gateway-core";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type {
  CalendarCreateEventInput,
  CalendarListQuery,
  ChannelActivityEffectResult,
  ChannelActivityInput,
  ChannelActivityResult,
  ChannelReactInput,
  ChannelReplyInput,
  ChannelSendInput,
  ChannelTypingInput,
  ChannelTypingResult,
  ChannelUnsendInput,
  ChatAttachmentRecord,
  GmailReadQuery,
  GmailSendInput,
  IntegrationConnection,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { resolveChannelSendAttachments } from "./channel-attachment-payload.js";
import {
  buildExternalSideEffectReplayOutput,
  runIdempotentExternalSideEffect,
  type ExternalSideEffectExecutionContext,
  type ExternalSideEffectRunStore,
  type IdempotentExternalSideEffectRunResult,
} from "./external-side-effect-runner-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

export interface CommsHost {
  invokeAndUnwrap(
    request: ToolInvokeRequest,
    realtimeType: string,
  ): Promise<ToolInvokeResult | Record<string, unknown>>;
  readChatAttachmentContent(attachmentId: string): Promise<{
    record: ChatAttachmentRecord;
    bytes: Buffer;
  }>;
  getIntegrationConnection(connectionId: string): Promise<IntegrationConnection>;
  emitDiscordTyping(connection: IntegrationConnection, input: ChannelTypingInput): Promise<ChannelTypingResult>;
  emitTelegramTyping(connection: IntegrationConnection, input: ChannelTypingInput): Promise<ChannelTypingResult>;
  emitChannelActivity(
    connection: IntegrationConnection,
    input: ChannelActivityInput,
    options: {
      emoji?: string;
      activityReactions: string[];
      typing: boolean;
    },
  ): Promise<ChannelActivityEffectResult[]>;
  /**
   * Optional external side-effect idempotency ledger members. A host that omits either
   * one still works — `runIdempotentExternalSideEffect` fails closed with a blocking
   * `idempotency_unavailable` outcome rather than sending the Gmail message unledgered.
   */
  mutationStore?: MutationIdempotencyStore;
  sideEffectRunStore?: ExternalSideEffectRunStore;
}

const COMMS_SESSION = "session:operator:comms";
const KNOWLEDGE_AGENT = "operator";
const CHANNEL_ACTIVITY_EMOJI: Partial<Record<ChannelActivityInput["phase"], string>> = {
  seen: "👀",
  thinking: "🧠",
  tooling: "🔧",
  waiting_approval: "⚠️",
  failed: "❌",
};
const CHANNEL_ACTIVITY_TYPING_PHASES = new Set<ChannelActivityInput["phase"]>(["thinking", "tooling"]);

/**
 * An operator approval that already authorizes this exact comms invoke. The policy
 * engine's approval bypass (`consentContext.reason === "approval:<id>"`) only honors a
 * fresh `pending` tool.invoke row whose stored request matches the presented one, so
 * the request is recorded first and then presented with that consent.
 */
export interface CommsPreApproval {
  approvalId: string;
  /** Persist the exact normalized tool request as the approval's pending action; must throw if that row is not still `pending`. */
  recordPendingAction(request: ToolInvokeRequest): Promise<void>;
}

const COMMS_PRE_APPROVAL_TTL_MS = 15 * 60_000;
const COMMS_PRE_APPROVAL_SETTLED_MESSAGE = "Approved communications action already settled; refusing to invoke again.";

export function buildCommsPreApproval(
  storage: Pick<AsyncStorage, "pendingApprovalActions">,
  approvalId: string,
  now: () => Date = () => new Date(),
): CommsPreApproval {
  return {
    approvalId,
    async recordPendingAction(request) {
      const recordedAt = now();
      // The upsert only rewrites a row that is still pending, so a settled approval
      // keeps its resolution and the re-read below refuses a second invoke.
      await storage.pendingApprovalActions.upsertPending({
        approvalId,
        actionType: "tool.invoke",
        request: request as unknown as Record<string, unknown>,
        createdAt: recordedAt.toISOString(),
        expiresAt: new Date(recordedAt.getTime() + COMMS_PRE_APPROVAL_TTL_MS).toISOString(),
      });
      const row = await storage.pendingApprovalActions.find(approvalId);
      if (row?.resolutionStatus !== "pending") {
        throw new Error(COMMS_PRE_APPROVAL_SETTLED_MESSAGE);
      }
    },
  };
}

async function invokeCommsTool(
  host: CommsHost,
  request: ToolInvokeRequest,
  realtimeType: string,
  preApproval?: CommsPreApproval,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  // Native optional fields (including normalized attachments) must have the same
  // shape before admission and after approval storage's JSON round trip.
  const normalized: ToolInvokeRequest = {
    ...request,
    args: omitAbsentCommsFields(request.args) as ToolInvokeRequest["args"],
  };
  if (!preApproval) {
    return host.invokeAndUnwrap(normalized, realtimeType);
  }
  // The approval bypass ignores consentContext when matching, so the recorded request
  // is the presented one without it.
  const { consentContext: _callerConsent, ...recorded } = normalized;
  await preApproval.recordPendingAction(recorded);
  return host.invokeAndUnwrap(
    { ...recorded, consentContext: { source: "ui", reason: `approval:${preApproval.approvalId}` } },
    realtimeType,
  );
}

function omitAbsentCommsFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitAbsentCommsFields);
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .map(([key, field]) => [key, omitAbsentCommsFields(field)]),
  );
}

export async function commsSend(
  host: CommsHost,
  input: ChannelSendInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  const connection = await host.getIntegrationConnection(input.connectionId);
  const sanitized = sanitizeChannelOutboundMessage(input.message ?? "", {
    neutralizeMentions: shouldNeutralizeChannelMentions(connection.key),
    maxLength: connection.key === "discord" ? 2000 : undefined,
  });
  const readChatAttachmentContent = (
    Reflect.get(host, "readChatAttachmentContent") as CommsHost["readChatAttachmentContent"]
  ).bind(host);
  const attachments = await resolveChannelSendAttachments(
    { attachments: input.attachments, attachmentIds: input.attachmentIds },
    { readChatAttachmentContent },
  );
  throwIfCommsAborted(input.signal);
  return invokeCommsTool(
    host,
    {
      toolName: "channel.send",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        message: sanitized.message,
        attachments,
        interactiveActions: input.interactiveActionTemplate ? undefined : input.interactiveActions,
        interactiveActionTemplate: input.interactiveActionTemplate,
        outboundSanitizer: hasOutboundSanitizerEffect(sanitized)
          ? {
              removedBlockCount: sanitized.removedBlockCount,
              redactedSecretCount: sanitized.redactedSecretCount,
              neutralizedMentionCount: sanitized.neutralizedMentionCount,
              truncated: sanitized.truncated,
              policy: "strip_internal_reasoning_blocks_redact_secrets",
            }
          : undefined,
        replyTo: input.replyToMessageId,
        replyToMessageId: input.replyToMessageId,
        replyToMessageGuid: input.replyToMessageId,
        replyToPartIndex: input.replyToPartIndex,
        effectId: input.effectId,
        subject: input.subject,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
      authContext: input.interactiveActionTemplate
        ? {
            boundary: "tool_host_boundary",
            secretRefs: [input.interactiveActionTemplate.tokenRef],
          }
        : undefined,
      ...buildChannelToolGovernance(input),
      signal: input.signal,
    },
    "comms_send",
  );
}

function shouldNeutralizeChannelMentions(channelKey: string): boolean {
  return ["discord", "google-chat", "mattermost", "slack", "teams", "webhook"].includes(channelKey);
}

function hasOutboundSanitizerEffect(result: ReturnType<typeof sanitizeChannelOutboundMessage>): boolean {
  return (
    result.removedBlockCount > 0 ||
    result.redactedSecretCount > 0 ||
    result.neutralizedMentionCount > 0 ||
    result.truncated
  );
}

export async function commsReply(
  host: CommsHost,
  input: ChannelReplyInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  if (!input.replyToMessageId?.trim()) {
    throw new Error("replyToMessageId is required for channel replies.");
  }
  return commsSend(host, input);
}

export async function commsReact(
  host: CommsHost,
  input: ChannelReactInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  return invokeCommsTool(
    host,
    {
      toolName: "channel.react",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        messageId: input.messageId,
        reaction: input.reaction,
        partIndex: input.partIndex,
        messageText: input.messageText,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
      ...buildChannelToolGovernance(input),
      signal: input.signal,
    },
    "comms_react",
  );
}

export async function commsUnsend(
  host: CommsHost,
  input: ChannelUnsendInput,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  throwIfCommsAborted(input.signal);
  return invokeCommsTool(
    host,
    {
      toolName: "channel.unsend",
      args: {
        connectionId: input.connectionId,
        target: input.target,
        messageId: input.messageId,
        partIndex: input.partIndex,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
      ...buildChannelToolGovernance(input),
      signal: input.signal,
    },
    "comms_unsend",
  );
}

export async function commsTyping(host: CommsHost, input: ChannelTypingInput): Promise<ChannelTypingResult> {
  throwIfCommsAborted(input.signal);
  const connection = await host.getIntegrationConnection(input.connectionId);
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${input.connectionId} is not a channel connection.`);
  }
  const capabilities = describeChannelCapabilities(connection.key, connection.config ?? {});
  if (!capabilities.supportedActions.includes("channel.typing")) {
    return {
      channelKey: connection.key,
      connectionId: input.connectionId,
      target: input.target,
      supported: false,
      status: "unsupported",
      reason: `${connection.label} does not advertise typing support in the current runtime mode.`,
    };
  }

  if (connection.key === "discord") {
    return host.emitDiscordTyping(connection, input);
  }
  if (connection.key === "telegram") {
    return host.emitTelegramTyping(connection, input);
  }

  return {
    channelKey: connection.key,
    connectionId: input.connectionId,
    target: input.target,
    supported: false,
    status: "unsupported",
    reason: `${connection.label} has not wired a typing adapter yet.`,
  };
}

export async function commsActivity(host: CommsHost, input: ChannelActivityInput): Promise<ChannelActivityResult> {
  throwIfCommsAborted(input.signal);
  const connection = await host.getIntegrationConnection(input.connectionId);
  if (connection.kind !== "channel") {
    throw new Error(`Integration connection ${input.connectionId} is not a channel connection.`);
  }
  const capabilities = describeChannelCapabilities(connection.key, connection.config);
  const nativeEffects = new Set(capabilities.activityCapabilities.nativeEffects);
  const emoji = CHANNEL_ACTIVITY_EMOJI[input.phase];
  const activityReactions =
    nativeEffects.has("reaction") || nativeEffects.has("reaction_clear")
      ? Object.values(CHANNEL_ACTIVITY_EMOJI).filter((value): value is string => Boolean(value))
      : [];
  const effects = await host.emitChannelActivity(connection, input, {
    emoji,
    activityReactions,
    typing: nativeEffects.has("typing") && CHANNEL_ACTIVITY_TYPING_PHASES.has(input.phase),
  });

  return {
    channelKey: connection.key,
    connectionId: input.connectionId,
    target: input.target,
    messageId: input.messageId,
    phase: input.phase,
    status: summarizeChannelActivityStatus(input.phase, effects),
    ...(emoji ? { emoji } : {}),
    effects,
  };
}

function throwIfCommsAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === "string" ? signal.reason : "Comms delivery aborted.");
}

function buildChannelToolGovernance(
  input: ChannelSendInput | ChannelReactInput | ChannelUnsendInput | ChannelActivityInput,
): Partial<ToolInvokeRequest> {
  const sessionId = input.sessionId ?? COMMS_SESSION;
  const agentId = input.agentId ?? KNOWLEDGE_AGENT;
  const policyContext =
    input.operatorId ||
    input.authActorId ||
    input.authActorSource ||
    input.workspaceId ||
    input.taskId ||
    input.runId ||
    input.permissionProfileId ||
    input.localOperatorOverrideId ||
    input.surface
      ? {
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
          workspaceId: input.workspaceId,
          sessionId,
          taskId: input.taskId,
          runId: input.runId,
          permissionProfileId: input.permissionProfileId,
          localOperatorOverrideId: input.localOperatorOverrideId,
          surface: input.surface,
        }
      : undefined;
  return {
    workspaceId: input.workspaceId,
    runId: input.runId,
    permissionProfileId: input.permissionProfileId,
    localOperatorOverrideId: input.localOperatorOverrideId,
    surface: input.surface,
    policyContext,
    consentContext: input.operatorId
      ? {
          operatorId: input.operatorId,
          source: "agent",
          reason: `channel delivery ${agentId}`,
        }
      : undefined,
  };
}

function summarizeChannelActivityStatus(
  phase: ChannelActivityInput["phase"],
  effects: ChannelActivityEffectResult[],
): ChannelActivityResult["status"] {
  if (phase === "clear") {
    return effects.some((effect) => effect.status === "failed") ? "partial" : "cleared";
  }
  const failed = effects.some((effect) => effect.status === "failed");
  const sent = effects.some((effect) => effect.status === "sent" || effect.status === "cleared");
  if (failed && sent) {
    return "partial";
  }
  if (failed) {
    return "failed";
  }
  return sent ? "sent" : "unsupported";
}

export async function commsGmailRead(
  host: CommsHost,
  input: GmailReadQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return invokeCommsTool(
    host,
    {
      toolName: "gmail.read",
      args: {
        connectionId: input.connectionId,
        query: input.query,
        maxResults: input.maxResults,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "comms_gmail_read",
  );
}

/** Boundary keys for the comms external side-effect ledger (see comms-service test suite). */
const COMMS_GMAIL_SEND_BOUNDARY = "comms_gmail_send";
const COMMS_CALENDAR_CREATE_BOUNDARY = "comms_calendar_create";

/**
 * Carries a structured pre/post-boundary classification of a comms tool result out of
 * the runner's `execute` without losing its shape (same pattern as
 * `DryRunCommitInnerResultError` in integration-dry-run-gate.ts:52). The runner only
 * sees a thrown Error; the ledgered comms functions unwrap this back to the original
 * result so refusals and failures are returned byte-compatible with pre-ledger behavior.
 */
class CommsPreBoundaryResultError extends Error {
  public constructor(public readonly result: ToolInvokeResult | Record<string, unknown>) {
    super("comms_pre_boundary_result");
  }
}

/**
 * Classifies a ledgered comms tool result inside the runner's `execute`: returns the
 * record when the provider call completed, otherwise throws a
 * `CommsPreBoundaryResultError`, marking the boundary crossed first whenever the
 * provider call may have fired.
 */
async function classifyCommsSideEffectResult(
  result: ToolInvokeResult | Record<string, unknown>,
  claim: ExternalSideEffectExecutionContext,
): Promise<Record<string, unknown>> {
  // A ToolInvokeResult that never reached "executed" (policy refusal, approval
  // required) never crossed the external boundary — the tool executor's commsInvoke
  // was never entered.
  if (isPreBoundaryToolInvokeRefusal(result)) {
    throw new CommsPreBoundaryResultError(result);
  }

  const record = result as Record<string, unknown>;
  if (record.status === "failed") {
    const deliveryStatus = record.deliveryStatus;
    if (deliveryStatus === "blocked" || deliveryStatus === "not_available") {
      // These failures are classified before commsInvoke's provider call ever
      // fired (missing auth, disallowed host, unconfigured channel) — pre-boundary.
      throw new CommsPreBoundaryResultError(record);
    }
    // Any other failed deliveryStatus (degraded, retrying, manual_reconciliation_required,
    // or unclassified) means the provider call may have fired — the boundary must be
    // marked crossed before the ledger records this as an unknown external outcome.
    await claim.markExternalCallStarted();
    throw new CommsPreBoundaryResultError(record);
  }

  await claim.markExternalCallStarted();
  return record;
}

/** Maps a ledgered comms run back to the tool-shaped result callers already consume. */
function settleCommsSideEffectRun(
  runResult: IdempotentExternalSideEffectRunResult<Record<string, unknown>>,
): ToolInvokeResult | Record<string, unknown> {
  if (runResult.status === "executed") {
    return {
      ...runResult.value,
      ...buildExternalSideEffectReplayOutput(runResult.claim),
    };
  }
  if (runResult.status === "blocked") {
    return {
      status: "failed",
      deliveryStatus: "blocked",
      error: runResult.message,
      ...buildExternalSideEffectReplayOutput(runResult.claim),
    };
  }
  if (runResult.error instanceof CommsPreBoundaryResultError) {
    return runResult.error.result;
  }
  throw runResult.error;
}

async function findCommsConnection(host: CommsHost, connectionId: string): Promise<IntegrationConnection | undefined> {
  try {
    return await host.getIntegrationConnection(connectionId);
  } catch {
    // Preserve today's fail-inside-executor behavior for unknown connection ids: fall
    // back to a generic catalog id and let invokeCommsTool surface the real error.
    return undefined;
  }
}

function isPreBoundaryToolInvokeRefusal(
  result: ToolInvokeResult | Record<string, unknown>,
): result is ToolInvokeResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "outcome" in result &&
    (result as ToolInvokeResult).outcome !== "executed"
  );
}

export async function commsGmailSend(
  host: CommsHost,
  input: GmailSendInput,
  preApproval?: CommsPreApproval,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  const connection = await findCommsConnection(host, input.connectionId);
  const checkedAt = new Date().toISOString();
  const runResult = await runIdempotentExternalSideEffect<Record<string, unknown>>({
    mutationStore: host.mutationStore,
    sideEffectRunStore: host.sideEffectRunStore,
    boundary: COMMS_GMAIL_SEND_BOUNDARY,
    catalogId: connection?.catalogId ?? "automation.gmail",
    connectionId: input.connectionId,
    actionId: "gmail.send",
    checkedAt,
    idempotencyKey: input.idempotencyKey,
    payload: {
      provider: "gmail",
      connectionId: input.connectionId,
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
    },
    label: "Gmail send (comms)",
    execute: async (claim) => {
      const result = await invokeCommsTool(
        host,
        {
          toolName: "gmail.send",
          args: {
            connectionId: input.connectionId,
            to: input.to,
            cc: input.cc,
            bcc: input.bcc,
            subject: input.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml,
          },
          sessionId: input.sessionId ?? COMMS_SESSION,
          agentId: input.agentId ?? KNOWLEDGE_AGENT,
          taskId: input.taskId,
        },
        "comms_gmail_send",
        preApproval,
      );
      return classifyCommsSideEffectResult(result, claim);
    },
  });
  return settleCommsSideEffectRun(runResult);
}

export async function commsCalendarList(
  host: CommsHost,
  input: CalendarListQuery,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  return invokeCommsTool(
    host,
    {
      toolName: "calendar.list",
      args: {
        connectionId: input.connectionId,
        calendarId: input.calendarId,
        fromIso: input.fromIso,
        toIso: input.toIso,
        maxResults: input.maxResults,
      },
      sessionId: input.sessionId ?? COMMS_SESSION,
      agentId: input.agentId ?? KNOWLEDGE_AGENT,
      taskId: input.taskId,
    },
    "comms_calendar_list",
  );
}

export async function commsCalendarCreate(
  host: CommsHost,
  input: CalendarCreateEventInput & { idempotencyKey?: string },
  preApproval?: CommsPreApproval,
): Promise<ToolInvokeResult | Record<string, unknown>> {
  const connection = await findCommsConnection(host, input.connectionId);
  const eventFields = {
    connectionId: input.connectionId,
    calendarId: input.calendarId,
    title: input.title,
    description: input.description,
    startIso: input.startIso,
    endIso: input.endIso,
    attendees: input.attendees,
    timeZone: input.timeZone,
  };
  const runResult = await runIdempotentExternalSideEffect<Record<string, unknown>>({
    mutationStore: host.mutationStore,
    sideEffectRunStore: host.sideEffectRunStore,
    boundary: COMMS_CALENDAR_CREATE_BOUNDARY,
    catalogId: connection?.catalogId ?? "automation.google-calendar",
    connectionId: input.connectionId,
    actionId: "calendar.create_event",
    checkedAt: new Date().toISOString(),
    idempotencyKey: input.idempotencyKey,
    payload: eventFields,
    label: "Calendar create event (comms)",
    execute: async (claim) => {
      const result = await invokeCommsTool(
        host,
        {
          toolName: "calendar.create_event",
          args: eventFields,
          sessionId: input.sessionId ?? COMMS_SESSION,
          agentId: input.agentId ?? KNOWLEDGE_AGENT,
          taskId: input.taskId,
        },
        "comms_calendar_create",
        preApproval,
      );
      return classifyCommsSideEffectResult(result, claim);
    },
  });
  return settleCommsSideEffectRun(runResult);
}
