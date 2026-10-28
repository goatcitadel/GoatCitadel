import { describe, expect, it, vi } from "vitest";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type {
  CalendarCreateEventInput,
  ChatAttachmentRecord,
  ExternalSideEffectRunRecord,
  GmailSendInput,
  IntegrationConnection,
  PendingApprovalAction,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import {
  buildCommsPreApproval,
  CommsPreApprovalSettledError,
  commsActivity,
  commsCalendarCreate,
  commsGmailSend,
  commsReact,
  commsSend,
  commsSmtpSend,
  commsTyping,
  commsUnsend,
  type CommsHost,
  type CommsPreApproval,
} from "./comms-service.js";
import {
  DEFAULT_EXTERNAL_SIDE_EFFECT_CLAIM_LEASE_MS,
  type ExternalSideEffectRunStore,
} from "./external-side-effect-runner-service.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";

function createHost(): CommsHost & { invokeAndUnwrap: ReturnType<typeof vi.fn> } {
  return {
    invokeAndUnwrap: vi.fn(
      async (): Promise<ToolInvokeResult> => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: { status: "sent" },
      }),
    ),
    readChatAttachmentContent: vi.fn(async () => ({
      record: { attachmentId: "attachment-1", fileName: "a.txt", mimeType: "text/plain" } as ChatAttachmentRecord,
      bytes: Buffer.from("hello"),
    })),
    getIntegrationConnection: vi.fn(
      () =>
        ({
          connectionId: "conn-1",
          kind: "channel",
          key: "telegram",
          label: "Telegram",
          config: {},
        }) as IntegrationConnection,
    ),
    emitDiscordTyping: vi.fn(),
    emitProviderTyping: vi.fn(),
    emitChannelActivity: vi.fn(async () => [{ effect: "mission_control", supported: true, status: "sent" }]),
  };
}

describe("comms service governance", () => {
  it("preserves executable channel arguments through approval JSON storage", async () => {
    const host = createHost();
    const supplied = { connectionId: "conn-1", target: "-123456", messageId: "message-1" };
    await commsSend(host, { connectionId: "conn-1", target: "-123456", message: "hello" });
    await commsSend(host, {
      connectionId: "conn-1",
      target: "-123456",
      message: "with attachment",
      attachments: [{ url: "https://example.com/a.txt", title: "a.txt" }],
      replyToMessageId: "message-1",
      replyToPartIndex: 0,
    });
    await commsReact(host, { ...supplied, reaction: "👍", partIndex: 0, messageText: "" });
    await commsUnsend(host, supplied);

    const requests = host.invokeAndUnwrap.mock.calls.map(([request]) => request as ToolInvokeRequest);
    for (const request of requests) {
      // Approval storage uses JSON, and the policy engine requires exact equality
      // with the executable request after loading the approved payload.
      expect(JSON.parse(JSON.stringify(request.args))).toStrictEqual(request.args);
    }
    expect(requests[1]!.args).toMatchObject({
      attachments: [{ url: "https://example.com/a.txt", title: "a.txt" }],
      replyToPartIndex: 0,
      replyToMessageId: "message-1",
    });
    expect(requests[2]!.args).toMatchObject({ partIndex: 0, messageText: "", reaction: "👍" });
    expect(supplied).toStrictEqual({ connectionId: "conn-1", target: "-123456", messageId: "message-1" });
  });

  it("carries channel governance into the final channel.send tool request", async () => {
    const host = createHost();

    await commsSend(host, {
      connectionId: "conn-1",
      target: "#ops",
      message: "hello",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      runId: "run-1",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "cowork",
    });

    const request = host.invokeAndUnwrap.mock.calls[0]![0] as ToolInvokeRequest;
    expect(request).toMatchObject({
      toolName: "channel.send",
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      runId: "run-1",
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "cowork",
      consentContext: {
        operatorId: "operator-1",
        source: "agent",
      },
      policyContext: {
        operatorId: "operator-1",
        authActorId: "actor-1",
        authActorSource: "loopback",
        workspaceId: "workspace-1",
        sessionId: "session-1",
        taskId: "task-1",
        runId: "run-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        surface: "cowork",
      },
    });
  });

  it("keeps approval action bearers sealed while carrying the protected template through policy", async () => {
    const host = createHost();
    const rawToken = `grat_${"t".repeat(43)}`;
    const tokenRef = "keychain:goatcitadel:approval-remote-action:rat_template";

    await commsSend(host, {
      connectionId: "conn-1",
      target: "-1001234567890",
      message: "Approval requested.",
      interactiveActionTemplate: {
        platform: "telegram",
        tokenId: "rat_template",
        tokenRef,
        expiresAt: "2099-07-10T00:15:00.000Z",
        buttons: [
          { label: "Approve", decision: "a" },
          { label: "Deny", decision: "r" },
        ],
      },
    });

    const request = host.invokeAndUnwrap.mock.calls[0]![0] as ToolInvokeRequest;
    expect(request.args).toMatchObject({
      interactiveActionTemplate: {
        platform: "telegram",
        tokenId: "rat_template",
        tokenRef,
      },
    });
    expect(request.args.interactiveActions).toBeUndefined();
    expect(request.authContext).toEqual({
      boundary: "tool_host_boundary",
      secretRefs: [tokenRef],
    });
    expect(JSON.stringify(request)).not.toContain(rawToken);
  });

  it("strips hidden reasoning blocks before final channel delivery, including fenced-code delivery text", async () => {
    const host = createHost();
    host.getIntegrationConnection = vi.fn(
      () =>
        ({
          connectionId: "conn-1",
          kind: "channel",
          key: "discord",
          label: "Discord",
          config: {},
        }) as IntegrationConnection,
    );

    await commsSend(host, {
      connectionId: "conn-1",
      target: "#ops",
      message: [
        "Visible answer.",
        "<thinking>private chain of thought</thinking>",
        "authorization: Bearer secret-token-value-1234567890",
        "```xml",
        "<thinking>literal example with sk-abcdefghijklmnopqrstuvwx</thinking>",
        "@everyone should not page from code fences",
        "```",
        '[tool_call]{"name":"secret"}[/tool_call]',
        "Done.",
      ].join("\n"),
    });

    const request = host.invokeAndUnwrap.mock.calls[0]![0] as ToolInvokeRequest;
    expect(request.args).toMatchObject({
      message: [
        "Visible answer.",
        "",
        "authorization: [REDACTED]",
        "```xml",
        "",
        "@ everyone should not page from code fences",
        "```",
        "",
        "Done.",
      ].join("\n"),
      outboundSanitizer: {
        removedBlockCount: 3,
        redactedSecretCount: 1,
        neutralizedMentionCount: 1,
        policy: "strip_internal_reasoning_blocks_redact_secrets",
      },
    });
  });

  it("preserves attachment reader host context while hydrating channel attachments", async () => {
    const host = {
      ...createHost(),
      contentPrefix: "bound",
      async readChatAttachmentContent(this: { contentPrefix: string }, attachmentId: string) {
        return {
          record: {
            attachmentId,
            fileName: `${this.contentPrefix}.txt`,
            mimeType: "text/plain",
          } as ChatAttachmentRecord,
          bytes: Buffer.from(`${this.contentPrefix}:hello`),
        };
      },
    };

    await commsSend(host, {
      connectionId: "conn-1",
      target: "#ops",
      message: "with attachment",
      attachmentIds: ["attachment-1"],
    });

    const request = host.invokeAndUnwrap.mock.calls[0]![0] as ToolInvokeRequest;
    expect(request.args).toMatchObject({
      attachments: [
        {
          attachmentId: "attachment-1",
          title: "bound.txt",
          mimeType: "text/plain",
          dataBase64: Buffer.from("bound:hello").toString("base64"),
        },
      ],
    });
  });

  it("keeps ordinary discussion of thinking when it is not a hidden provider block", () => {
    expect(sanitizeChannelOutboundMessage("We should think through rollback before sending.")).toMatchObject({
      message: "We should think through rollback before sending.",
      removedBlockCount: 0,
    });
  });

  it("carries channel governance into reaction and unsend requests", async () => {
    const host = createHost();
    const governance = {
      workspaceId: "workspace-1",
      sessionId: "session-1",
      agentId: "agent-1",
      taskId: "task-1",
      runId: "run-1",
      operatorId: "operator-1",
      authActorId: "actor-1",
      authActorSource: "loopback" as const,
      permissionProfileId: "profile-1",
      localOperatorOverrideId: "override-1",
      surface: "chat" as const,
    };

    await commsReact(host, {
      connectionId: "conn-1",
      messageId: "message-1",
      reaction: "+1",
      ...governance,
    });
    await commsUnsend(host, {
      connectionId: "conn-1",
      messageId: "message-1",
      ...governance,
    });

    for (const [request] of host.invokeAndUnwrap.mock.calls) {
      expect(request).toMatchObject({
        workspaceId: "workspace-1",
        runId: "run-1",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        policyContext: expect.objectContaining({
          operatorId: "operator-1",
          authActorId: "actor-1",
          runId: "run-1",
        }),
      });
    }
  });

  it("routes shared channel activity through the activity host", async () => {
    const host = createHost();

    const result = await commsActivity(host, {
      connectionId: "conn-1",
      target: "chat-1",
      messageId: "message-1",
      phase: "thinking",
      sessionId: "session-1",
    });

    expect(host.emitChannelActivity).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1", kind: "channel" }),
      expect.objectContaining({ phase: "thinking", messageId: "message-1" }),
      expect.objectContaining({ emoji: "🧠", typing: true }),
    );
    expect(result).toMatchObject({
      connectionId: "conn-1",
      messageId: "message-1",
      phase: "thinking",
      emoji: "🧠",
      status: "sent",
    });
  });
});

/**
 * In-memory fake mirroring packages/storage/src/mutation-idempotency-repo.ts claim()
 * semantics exactly: payload-hash mismatch is checked BEFORE the failed-record revive,
 * and a still-"pending" existing row yields "in_progress" rather than "duplicate". A
 * stateful fake (rather than a one-shot vi.fn() outcome) lets the duplicate-block and
 * reopened-after-failure tests prove real claim() state transitions across repeated
 * commsGmailSend calls, not a canned mock.
 */
function createInMemoryMutationStore(): MutationIdempotencyStore {
  type Row = { payloadHash: string; status: "pending" | "completed" | "failed" };
  const rows = new Map<string, Row>();
  const toKey = (input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }) =>
    [input.method, input.routePath, input.idempotencyKey, input.actorScope ?? ""].join("|");
  const toRecord = (
    input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string; now?: string },
    row: Row,
  ) => ({
    method: input.method,
    routePath: input.routePath,
    idempotencyKey: input.idempotencyKey,
    actorScope: input.actorScope ?? "",
    payloadHash: row.payloadHash,
    status: row.status,
    createdAt: input.now ?? "",
    updatedAt: input.now ?? "",
  });

  return {
    claim: (input) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (!existing) {
        const row: Row = { payloadHash: input.payloadHash, status: "pending" };
        rows.set(key, row);
        return { outcome: "claimed", claimKind: "new", record: toRecord(input, row) };
      }
      if (existing.payloadHash !== input.payloadHash) {
        return { outcome: "payload_mismatch", record: toRecord(input, existing) };
      }
      if (existing.status === "failed") {
        const row: Row = { payloadHash: input.payloadHash, status: "pending" };
        rows.set(key, row);
        return { outcome: "claimed", claimKind: "retry_after_failure", record: toRecord(input, row) };
      }
      return {
        outcome: existing.status === "pending" ? "in_progress" : "duplicate",
        record: toRecord(input, existing),
      };
    },
    markCompleted: (input) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, status: "completed" });
      }
    },
    markFailed: (input) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, status: "failed" });
      }
    },
  };
}

/**
 * In-memory fake mirroring packages/storage/src/external-side-effect-run-repo.ts:
 * createOrGet() finds-or-inserts by (routePath, idempotencyKey, actorScope) and returns
 * the EXISTING row untouched on a repeat call (it never overwrites status) — exactly
 * like the real repo, so a duplicate-blocked second call still resolves to the first
 * call's completed run row rather than fabricating a second one.
 */
function createInMemorySideEffectRunStore(): ExternalSideEffectRunStore & {
  runs: Map<string, ExternalSideEffectRunRecord>;
} {
  const runs = new Map<string, ExternalSideEffectRunRecord>();
  let counter = 0;
  const findExisting = (routePath: string, idempotencyKey: string, actorScope: string) =>
    [...runs.values()].find(
      (run) => run.routePath === routePath && run.idempotencyKey === idempotencyKey && run.actorScope === actorScope,
    );

  return {
    runs,
    createOrGet: (input, now = "2026-01-01T00:00:00.000Z") => {
      const actorScope = input.actorScope?.trim() ?? "";
      const existing = findExisting(input.routePath, input.idempotencyKey, actorScope);
      if (existing) {
        return existing;
      }
      counter += 1;
      const record: ExternalSideEffectRunRecord = {
        runId: `extfx-test-${counter}`,
        workspaceId: input.workspaceId ?? "default",
        boundary: input.boundary,
        routePath: input.routePath,
        catalogId: input.catalogId,
        connectionId: input.connectionId,
        actionId: input.actionId,
        actorScope,
        idempotencyKey: input.idempotencyKey,
        payloadHash: input.payloadHash,
        status: input.status ?? "claimed_not_sent",
        replayPolicy: "idempotent_external",
        replayOutcome: input.replayOutcome,
        replayAttempt: input.replayAttempt,
        resumeState: "not_resumable",
        requestPayload: input.requestPayload,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      runs.set(record.runId, record);
      return record;
    },
    markExternalCallStarted: (runId, _input, now = "2026-01-01T00:00:01.000Z") => {
      const existing = runs.get(runId);
      if (!existing) {
        throw new Error(`Unknown external side-effect run ${runId}`);
      }
      const updated: ExternalSideEffectRunRecord = { ...existing, status: "external_call_started", updatedAt: now };
      runs.set(runId, updated);
      return updated;
    },
    markCompleted: (runId, input = {}, now = "2026-01-01T00:00:02.000Z") => {
      const existing = runs.get(runId);
      if (!existing) {
        throw new Error(`Unknown external side-effect run ${runId}`);
      }
      const updated: ExternalSideEffectRunRecord = {
        ...existing,
        status: "completed",
        resumeState: "completed",
        replayOutcome: input.replayOutcome,
        responsePayload: input.responsePayload,
        externalReferenceId: input.externalReferenceId,
        updatedAt: now,
      };
      runs.set(runId, updated);
      return updated;
    },
    markFailure: (runId, input, now = "2026-01-01T00:00:02.000Z") => {
      const existing = runs.get(runId);
      if (!existing) {
        throw new Error(`Unknown external side-effect run ${runId}`);
      }
      const updated: ExternalSideEffectRunRecord = {
        ...existing,
        status: input.status,
        errorText: input.errorText,
        responsePayload: input.responsePayload,
        updatedAt: now,
      };
      runs.set(runId, updated);
      return updated;
    },
  };
}

function createGmailHost(overrides: Partial<CommsHost & { invokeAndUnwrap: ReturnType<typeof vi.fn> }> = {}): {
  host: CommsHost & { invokeAndUnwrap: ReturnType<typeof vi.fn> };
  mutationStore: MutationIdempotencyStore;
  sideEffectRunStore: ExternalSideEffectRunStore & { runs: Map<string, ExternalSideEffectRunRecord> };
} {
  const mutationStore = createInMemoryMutationStore();
  const sideEffectRunStore = createInMemorySideEffectRunStore();
  const host: CommsHost & { invokeAndUnwrap: ReturnType<typeof vi.fn> } = {
    invokeAndUnwrap: vi.fn(
      async () => ({ status: "sent", deliveryStatus: "sent", providerMessageId: "gmail-1" }) as Record<string, unknown>,
    ),
    readChatAttachmentContent: vi.fn(),
    getIntegrationConnection: vi.fn(
      () =>
        ({
          connectionId: "conn-gmail",
          catalogId: "automation.gmail",
          kind: "channel",
          key: "gmail",
          label: "Gmail",
          enabled: true,
          status: "connected",
          config: {},
        }) as IntegrationConnection,
    ),
    emitDiscordTyping: vi.fn(),
    emitProviderTyping: vi.fn(),
    emitChannelActivity: vi.fn(),
    mutationStore,
    sideEffectRunStore,
    ...overrides,
  };
  return { host, mutationStore, sideEffectRunStore };
}

function gmailInput(overrides: Partial<GmailSendInput> = {}): GmailSendInput {
  return {
    connectionId: "conn-gmail",
    to: ["dest@example.test"],
    subject: "Status",
    bodyText: "All good",
    ...overrides,
  };
}

describe("comms gmail send external side-effect ledger", () => {
  it("claims idempotency and records a completed run for a successful send", async () => {
    const { host, sideEffectRunStore } = createGmailHost();

    const result = await commsGmailSend(host, gmailInput());

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "sent",
      deliveryStatus: "sent",
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      idempotencyKey: expect.any(String),
      payloadHash: expect.any(String),
    });

    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ boundary: "comms_gmail_send", status: "completed" });
    expect(JSON.stringify(runs[0]!.requestPayload ?? {})).not.toContain("All good");
  });

  it("blocks a duplicate identical send without invoking the tool", async () => {
    const { host } = createGmailHost();

    const first = await commsGmailSend(host, gmailInput());
    const second = await commsGmailSend(host, gmailInput());

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(first).toMatchObject({ status: "sent" });
    expect(second).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
      replayOutcome: "duplicate",
    });
  });

  it("records policy refusals as failed before the boundary", async () => {
    const refusal: ToolInvokeResult = {
      outcome: "blocked",
      policyReason: "denied by ward",
      auditEventId: "audit-refusal-1",
    };
    const { host, sideEffectRunStore } = createGmailHost({
      invokeAndUnwrap: vi.fn(async () => refusal),
    });

    const result = await commsGmailSend(host, gmailInput());

    expect(result).toEqual(refusal);
    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs[0]).toMatchObject({ status: "failed_before_boundary" });

    // The mutation claim must be reopened (not left stuck "in progress") so a retry
    // of the exact same send is allowed to invoke the tool again.
    await commsGmailSend(host, gmailInput());
    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(2);
  });

  it("records not_available delivery failures as failed before the boundary", async () => {
    const failure = { status: "failed", deliveryStatus: "not_available", error: "channel not configured" };
    const { host, sideEffectRunStore } = createGmailHost({
      invokeAndUnwrap: vi.fn(async () => failure),
    });

    const result = await commsGmailSend(host, gmailInput());

    expect(result).toEqual(failure);
    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs[0]).toMatchObject({ status: "failed_before_boundary" });
  });

  it("records degraded delivery failures as unknown external outcome", async () => {
    const failure = { status: "failed", deliveryStatus: "degraded", error: "gateway timeout (503)" };
    const { host, sideEffectRunStore } = createGmailHost({
      invokeAndUnwrap: vi.fn(async () => failure),
    });

    const result = await commsGmailSend(host, gmailInput());

    expect(result).toEqual(failure);
    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs[0]).toMatchObject({ status: "unknown_external_outcome" });
  });

  it("blocks with idempotency_unavailable when the host has no mutation store", async () => {
    const { host } = createGmailHost({ mutationStore: undefined });

    const result = await commsGmailSend(host, gmailInput());

    expect(host.invokeAndUnwrap).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
      replayOutcome: "idempotency_unavailable",
    });
  });

  it("honors a caller-supplied idempotency key", async () => {
    const { host } = createGmailHost();

    const first = await commsGmailSend(host, gmailInput({ idempotencyKey: "key-1" }));
    const second = await commsGmailSend(host, gmailInput({ idempotencyKey: "key-2" }));

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ status: "sent" });
    expect(second).toMatchObject({ status: "sent" });
  });
});

function calendarInput(
  overrides: Partial<CalendarCreateEventInput & { idempotencyKey?: string }> = {},
): CalendarCreateEventInput & { idempotencyKey?: string } {
  return {
    connectionId: "conn-calendar",
    calendarId: "primary",
    title: "Planning",
    startIso: "2026-10-20T15:00:00.000Z",
    endIso: "2026-10-20T15:30:00.000Z",
    attendees: ["guest@example.test"],
    ...overrides,
  };
}

function createCalendarHost(): ReturnType<typeof createGmailHost> {
  return createGmailHost({
    invokeAndUnwrap: vi.fn(async () => ({ status: "created", eventId: "event-1" }) as Record<string, unknown>),
    getIntegrationConnection: vi.fn(
      async () =>
        ({
          connectionId: "conn-calendar",
          catalogId: "automation.google-calendar",
          kind: "automation",
          key: "google-calendar",
          label: "Google Calendar",
          enabled: true,
          status: "connected",
          config: {},
        }) as IntegrationConnection,
    ),
  });
}

function createRecordingPreApproval(
  approvalId = "ap-1",
  record: (request: ToolInvokeRequest) => Promise<void> = async () => undefined,
): CommsPreApproval & { recordPendingAction: ReturnType<typeof vi.fn> } {
  return { approvalId, recordPendingAction: vi.fn(record) };
}

describe("comms calendar create external side-effect ledger", () => {
  it("calendar create with the same idempotency key twice invokes calendar.create_event once", async () => {
    const { host, sideEffectRunStore } = createCalendarHost();

    const first = await commsCalendarCreate(host, calendarInput({ idempotencyKey: "cal-key-1" }));
    const second = await commsCalendarCreate(host, calendarInput({ idempotencyKey: "cal-key-1" }));

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(host.invokeAndUnwrap.mock.calls[0]?.[0]).toMatchObject({ toolName: "calendar.create_event" });
    expect(first).toMatchObject({
      status: "created",
      eventId: "event-1",
      replayPolicy: "idempotent_external",
      replayOutcome: "claimed",
      idempotencyKey: "cal-key-1",
    });
    expect(second).toMatchObject({
      status: "failed",
      deliveryStatus: "blocked",
      replayOutcome: "duplicate",
      idempotencyKey: "cal-key-1",
    });
    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      boundary: "comms_calendar_create",
      actionId: "calendar.create_event",
      status: "completed",
    });
  });

  it("keeps two keyless identical calendar creates distinct", async () => {
    const { host, sideEffectRunStore } = createCalendarHost();

    const first = await commsCalendarCreate(host, calendarInput());
    const second = await commsCalendarCreate(host, calendarInput());

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ status: "created", replayOutcome: "claimed" });
    expect(second).toMatchObject({ status: "created", replayOutcome: "claimed" });
    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.boundary === "comms_calendar_create" && run.status === "completed")).toBe(true);
  });

  it("records calendar policy refusals as failed before the boundary", async () => {
    const refusal: ToolInvokeResult = {
      outcome: "approval_required",
      policyReason: "needs approval",
      auditEventId: "audit-cal-1",
      approvalId: "approval-cal-1",
    };
    const { host, sideEffectRunStore } = createCalendarHost();
    host.invokeAndUnwrap.mockImplementation(async () => refusal);

    const result = await commsCalendarCreate(host, calendarInput());

    expect(result).toEqual(refusal);
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "failed_before_boundary" });
  });
});

function createSmtpHost(): ReturnType<typeof createGmailHost> {
  return createGmailHost({
    invokeAndUnwrap: vi.fn(
      async () =>
        ({ status: "sent", deliveryStatus: "sent", providerMessageId: "<smtp-1@x>" }) as Record<string, unknown>,
    ),
    getIntegrationConnection: vi.fn(
      async () =>
        ({
          connectionId: "conn-smtp",
          catalogId: "automation.imap-smtp",
          kind: "automation",
          key: "imap-smtp",
          label: "Work mail",
          enabled: true,
          status: "connected",
          config: {},
        }) as IntegrationConnection,
    ),
  });
}

describe("comms smtp send external side-effect ledger", () => {
  it("smtp send with the same idempotency key twice invokes smtp.send once", async () => {
    const { host, sideEffectRunStore } = createSmtpHost();
    const input = gmailInput({ connectionId: "conn-smtp", cc: ["cc@example.test"], idempotencyKey: "smtp-key-1" });

    const first = await commsSmtpSend(host, input);
    const second = await commsSmtpSend(host, input);

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(host.invokeAndUnwrap.mock.calls[0]).toEqual([
      expect.objectContaining({
        toolName: "smtp.send",
        args: {
          connectionId: "conn-smtp",
          to: ["dest@example.test"],
          cc: ["cc@example.test"],
          subject: "Status",
          bodyText: "All good",
        },
      }),
      "comms_smtp_send",
    ]);
    expect(first).toMatchObject({
      status: "sent",
      providerMessageId: "<smtp-1@x>",
      replayOutcome: "claimed",
      idempotencyKey: "smtp-key-1",
    });
    expect(second).toMatchObject({ status: "failed", deliveryStatus: "blocked", replayOutcome: "duplicate" });
    const runs = [...sideEffectRunStore.runs.values()];
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      boundary: "comms_smtp_send",
      actionId: "smtp.send",
      catalogId: "automation.imap-smtp",
      status: "completed",
    });
  });

  it("keeps the IMAP/SMTP catalog identity when the connection lookup fails", async () => {
    const { host, sideEffectRunStore } = createSmtpHost();
    host.getIntegrationConnection = vi.fn(async () => {
      throw new Error("connection store unavailable");
    });

    await commsSmtpSend(host, gmailInput({ connectionId: "conn-smtp", idempotencyKey: "smtp-key-lookup" }));

    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ catalogId: "automation.imap-smtp" });
  });

  it("carries pre-approval consent into smtp.send", async () => {
    const { host } = createSmtpHost();
    const preApproval = createRecordingPreApproval("ap-smtp");

    await commsSmtpSend(host, gmailInput({ connectionId: "conn-smtp", idempotencyKey: "smtp-key-2" }), preApproval);

    expect(host.invokeAndUnwrap.mock.calls[0]?.[0]).toMatchObject({
      toolName: "smtp.send",
      consentContext: { source: "ui", reason: "approval:ap-smtp" },
    });
    expect(preApproval.recordPendingAction.mock.calls[0]?.[0]).toMatchObject({ toolName: "smtp.send" });
  });

  it.each([
    ["blocked", "blocked: SMTP server rejected the configured credentials (EAUTH); nothing was sent."],
    ["not_available", "smtp.send failed before the message was sent (ETLS); nothing was sent."],
  ])("records an SMTP pre-DATA %s failure as failed before the boundary", async (deliveryStatus, error) => {
    const failure = { status: "failed", deliveryStatus, error };
    const { host, sideEffectRunStore } = createSmtpHost();
    host.invokeAndUnwrap.mockImplementation(async () => failure);

    const result = await commsSmtpSend(host, gmailInput({ connectionId: "conn-smtp" }));

    expect(result).toEqual(failure);
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({
      boundary: "comms_smtp_send",
      status: "failed_before_boundary",
    });
  });

  it("records a possibly-sent SMTP failure as an unknown external outcome", async () => {
    const failure = {
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      error: "smtp.send unknown_after_send: external boundary may have been crossed; manual reconciliation required.",
    };
    const { host, sideEffectRunStore } = createSmtpHost();
    host.invokeAndUnwrap.mockImplementation(async () => failure);

    await commsSmtpSend(host, gmailInput({ connectionId: "conn-smtp" }));

    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "unknown_external_outcome" });
  });
});

describe("comms pre-approved invocation", () => {
  it("pre-approval records the exact request and presents approval:<id> consent", async () => {
    const { host } = createGmailHost();
    const preApproval = createRecordingPreApproval("ap-1");

    const result = await commsGmailSend(host, gmailInput({ idempotencyKey: "mail-key-1" }), preApproval);

    expect(result).toMatchObject({ status: "sent" });
    expect(preApproval.recordPendingAction).toHaveBeenCalledTimes(1);
    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    const invoked = host.invokeAndUnwrap.mock.calls[0]?.[0] as ToolInvokeRequest;
    expect(invoked.consentContext).toEqual({ source: "ui", reason: "approval:ap-1" });
    const { consentContext: _consent, ...invokedWithoutConsent } = invoked;
    expect(preApproval.recordPendingAction.mock.calls[0]?.[0]).toEqual(invokedWithoutConsent);
    expect(preApproval.recordPendingAction.mock.invocationCallOrder[0]).toBeLessThan(
      host.invokeAndUnwrap.mock.invocationCallOrder[0]!,
    );
  });

  it("records the Gateway-normalized request in the approval's workspace and invokes exactly that", async () => {
    const { host } = createGmailHost();
    const normalizeToolInvokeRequest = vi.fn(
      async (request: ToolInvokeRequest): Promise<ToolInvokeRequest> =>
        ({
          ...request,
          citadelId: "citadel-1",
          policyContext: { workspaceId: request.workspaceId, permissionProfileId: "safe", surface: "chat" },
          consentContext: { source: "ui", reason: "must not be recorded" },
        }) as unknown as ToolInvokeRequest,
    );
    const normalizingHost = Object.assign(host, { normalizeToolInvokeRequest });
    const preApproval = { ...createRecordingPreApproval("ap-ws"), workspaceId: "workspace-ops" };

    await commsGmailSend(normalizingHost, gmailInput({ idempotencyKey: "mail-key-ws" }), preApproval);

    expect(normalizeToolInvokeRequest).toHaveBeenCalledTimes(1);
    expect(normalizeToolInvokeRequest.mock.calls[0]?.[0]).toMatchObject({ workspaceId: "workspace-ops" });
    expect(normalizeToolInvokeRequest.mock.calls[0]?.[0]).not.toHaveProperty("consentContext");
    const recorded = preApproval.recordPendingAction.mock.calls[0]?.[0] as ToolInvokeRequest;
    expect(recorded).toMatchObject({
      toolName: "gmail.send",
      workspaceId: "workspace-ops",
      citadelId: "citadel-1",
      policyContext: { permissionProfileId: "safe", surface: "chat" },
    });
    expect(recorded).not.toHaveProperty("consentContext");
    const invoked = host.invokeAndUnwrap.mock.calls[0]?.[0] as ToolInvokeRequest;
    expect(invoked).toEqual({ ...recorded, consentContext: { source: "ui", reason: "approval:ap-ws" } });
  });

  it("pre-approval carries approval consent into calendar create", async () => {
    const { host } = createCalendarHost();
    const preApproval = createRecordingPreApproval("ap-cal");

    await commsCalendarCreate(host, calendarInput({ idempotencyKey: "cal-key-2" }), preApproval);

    const invoked = host.invokeAndUnwrap.mock.calls[0]?.[0] as ToolInvokeRequest;
    expect(invoked).toMatchObject({
      toolName: "calendar.create_event",
      consentContext: { source: "ui", reason: "approval:ap-cal" },
    });
    expect(preApproval.recordPendingAction.mock.calls[0]?.[0]).toMatchObject({ toolName: "calendar.create_event" });
    expect(preApproval.recordPendingAction.mock.calls[0]?.[0]).not.toHaveProperty("consentContext");
  });

  it("marks the external boundary started after recording and before a pre-approved invoke", async () => {
    const { host, sideEffectRunStore } = createGmailHost();
    const order: string[] = [];
    const preApproval = createRecordingPreApproval("ap-1", async () => {
      order.push(`record:${[...sideEffectRunStore.runs.values()][0]?.status}`);
    });
    host.invokeAndUnwrap.mockImplementation(async () => {
      order.push(`invoke:${[...sideEffectRunStore.runs.values()][0]?.status}`);
      return { status: "sent", deliveryStatus: "sent", providerMessageId: "gmail-1" };
    });

    const result = await commsGmailSend(host, gmailInput(), preApproval);

    expect(result).toMatchObject({ status: "sent" });
    expect(order).toEqual(["record:claimed_not_sent", "invoke:external_call_started"]);
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "completed" });
  });

  it("treats a pre-approved invoke that crashes as an unknown external outcome, not a retryable claim", async () => {
    const { host, sideEffectRunStore } = createCalendarHost();
    host.invokeAndUnwrap.mockImplementation(async () => {
      throw new Error("provider connection reset");
    });
    const preApproval = createRecordingPreApproval("ap-cal");

    await expect(
      commsCalendarCreate(host, calendarInput({ idempotencyKey: "cal-crash" }), preApproval),
    ).rejects.toThrow("provider connection reset");
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "unknown_external_outcome" });

    const retry = await commsCalendarCreate(host, calendarInput({ idempotencyKey: "cal-crash" }), preApproval);
    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
  });

  it.each([
    ["a policy denial", { outcome: "blocked", policyReason: "denied by ward", auditEventId: "audit-pre-1" }],
    ["a blocked provider failure", { status: "failed", deliveryStatus: "blocked", error: "SMTP auth rejected" }],
    ["an unavailable connection", { status: "failed", deliveryStatus: "not_available", error: "not configured" }],
  ])("keeps %s on the pre-approved path failed before the boundary", async (_label, failure) => {
    const { host, sideEffectRunStore } = createGmailHost({ invokeAndUnwrap: vi.fn(async () => failure) });

    const result = await commsGmailSend(host, gmailInput({ idempotencyKey: "mail-pre" }), createRecordingPreApproval());

    expect(result).toEqual(failure);
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "failed_before_boundary" });
  });

  it.each([
    ["a degraded failure", { status: "failed", deliveryStatus: "degraded", error: "gateway timeout (503)" }],
    [
      "a blocked failure that carries a provider message id",
      { status: "failed", deliveryStatus: "blocked", error: "late refusal", providerMessageId: "gmail-9" },
    ],
  ])("keeps %s on the pre-approved path an unknown outcome that never re-sends", async (_label, failure) => {
    const { host, sideEffectRunStore } = createGmailHost({ invokeAndUnwrap: vi.fn(async () => failure) });
    const preApproval = createRecordingPreApproval();

    await commsGmailSend(host, gmailInput({ idempotencyKey: "mail-unknown" }), preApproval);
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "unknown_external_outcome" });

    const retry = await commsGmailSend(host, gmailInput({ idempotencyKey: "mail-unknown" }), preApproval);
    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(retry).toMatchObject({ status: "failed", deliveryStatus: "blocked" });
  });

  it("a settled pending action stops the invoke", async () => {
    const { host, sideEffectRunStore } = createGmailHost();
    const preApproval = createRecordingPreApproval("ap-1", async () => {
      throw new CommsPreApprovalSettledError();
    });

    const outcome = await commsGmailSend(host, gmailInput(), preApproval).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: String(error) }),
    );

    expect(host.invokeAndUnwrap).not.toHaveBeenCalled();
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).toContain("already settled");
    expect(JSON.stringify(outcome)).not.toContain("approval_required");
    expect([...sideEffectRunStore.runs.values()][0]).toMatchObject({ status: "failed_before_boundary" });
  });
});

describe("comms reserved communications idempotency prefix", () => {
  const reserved = "communications:ap-1";
  const blocked = {
    status: "failed",
    deliveryStatus: "blocked",
    error: "The communications: idempotency key prefix is reserved for approved sends.",
  };

  it("blocks plain gmail send, smtp send and calendar create before any claim or invoke", async () => {
    const gmail = createGmailHost();
    const smtp = createSmtpHost();
    const calendar = createCalendarHost();

    await expect(commsGmailSend(gmail.host, gmailInput({ idempotencyKey: reserved }))).resolves.toEqual(blocked);
    await expect(
      commsSmtpSend(smtp.host, gmailInput({ connectionId: "conn-smtp", idempotencyKey: reserved })),
    ).resolves.toEqual(blocked);
    await expect(commsCalendarCreate(calendar.host, calendarInput({ idempotencyKey: reserved }))).resolves.toEqual(
      blocked,
    );

    for (const { host, sideEffectRunStore } of [gmail, smtp, calendar]) {
      expect(host.invokeAndUnwrap).not.toHaveBeenCalled();
      expect(sideEffectRunStore.runs.size).toBe(0);
    }
  });

  it("blocks a reserved key padded with whitespace before any claim or invoke", async () => {
    const { host, sideEffectRunStore } = createGmailHost();

    await expect(commsGmailSend(host, gmailInput({ idempotencyKey: ` ${reserved}` }))).resolves.toEqual(blocked);

    expect(host.invokeAndUnwrap).not.toHaveBeenCalled();
    expect(sideEffectRunStore.runs.size).toBe(0);
  });

  it("ledgers the trimmed key so a padded replay matches the original send", async () => {
    const { host } = createGmailHost();

    await commsGmailSend(host, gmailInput({ idempotencyKey: "mail-key-pad" }));
    const replay = await commsGmailSend(host, gmailInput({ idempotencyKey: "  mail-key-pad  " }));

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({ replayOutcome: "duplicate", idempotencyKey: "mail-key-pad" });
  });

  it("still lets a pre-approved send use the communications: key", async () => {
    const { host } = createGmailHost();

    const result = await commsGmailSend(
      host,
      gmailInput({ idempotencyKey: reserved }),
      createRecordingPreApproval("ap-1"),
    );

    expect(host.invokeAndUnwrap).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "sent" });
  });
});

describe("comms claim takeover lease", () => {
  // A store with the dispatch marker would otherwise give every claim the default lease.
  function createLeaseRecordingHost(base: ReturnType<typeof createGmailHost>) {
    const claim = vi.fn(base.mutationStore.claim);
    const host = { ...base.host, mutationStore: { ...base.mutationStore, claim, markDispatched: vi.fn() } };
    return { host, claim };
  }

  it("never leases a plain send or create claim, whose boundary is marked only after dispatch", async () => {
    const gmail = createLeaseRecordingHost(createGmailHost());
    await commsGmailSend(gmail.host, gmailInput({ idempotencyKey: "lease-gmail" }));
    const smtp = createLeaseRecordingHost(createSmtpHost());
    await commsSmtpSend(smtp.host, gmailInput({ connectionId: "conn-smtp", idempotencyKey: "lease-smtp" }));
    const calendar = createLeaseRecordingHost(createCalendarHost());
    await commsCalendarCreate(calendar.host, calendarInput({ idempotencyKey: "lease-cal" }));

    const claims = [gmail, smtp, calendar].flatMap(({ claim }) => claim.mock.calls.map(([input]) => input));
    expect(claims).toHaveLength(3);
    for (const input of claims) expect(input).not.toHaveProperty("leaseDurationMs");
  });

  it("keeps the default takeover lease for a pre-approved invoke, which marks before dispatch", async () => {
    const { host, claim } = createLeaseRecordingHost(createGmailHost());

    await commsGmailSend(
      host,
      gmailInput({ idempotencyKey: "lease-approved" }),
      createRecordingPreApproval("ap-lease"),
    );

    expect(claim.mock.calls[0]?.[0]).toMatchObject({ leaseDurationMs: DEFAULT_EXTERNAL_SIDE_EFFECT_CLAIM_LEASE_MS });
  });
});

describe("buildCommsPreApproval", () => {
  type UpsertInput = {
    approvalId: string;
    actionType: PendingApprovalAction["actionType"];
    request: Record<string, unknown>;
    createdAt?: string;
    expiresAt?: string;
  };

  function createPendingActionsFake(initial?: PendingApprovalAction) {
    const rows = new Map<string, PendingApprovalAction>();
    if (initial) rows.set(initial.approvalId, initial);
    const upsertPending = vi.fn(async (input: UpsertInput) => {
      const existing = rows.get(input.approvalId);
      if (!existing || existing.resolutionStatus === "pending") {
        rows.set(input.approvalId, {
          approvalId: input.approvalId,
          actionType: input.actionType,
          request: JSON.parse(JSON.stringify(input.request)) as Record<string, unknown>,
          createdAt: input.createdAt ?? "2026-10-16T00:00:00.000Z",
          expiresAt: input.expiresAt,
          resolutionStatus: "pending",
        });
      }
      return rows.get(input.approvalId)!;
    });
    const find = vi.fn(async (approvalId: string) => rows.get(approvalId));
    return { rows, pendingApprovalActions: { upsertPending, find } };
  }

  const request: ToolInvokeRequest = {
    toolName: "gmail.send",
    args: { connectionId: "conn-gmail", to: ["dest@example.test"], subject: "Status", bodyText: "All good" },
    sessionId: "session:operator:comms",
    agentId: "operator",
  };

  it("records a fresh pending tool.invoke row with a 15 minute expiry", async () => {
    const fake = createPendingActionsFake();
    const now = new Date("2026-10-16T12:00:00.000Z");
    const preApproval = buildCommsPreApproval(fake as never, "ap-1", () => now);

    await expect(preApproval.recordPendingAction(request)).resolves.toBeUndefined();

    expect(preApproval.approvalId).toBe("ap-1");
    expect(fake.pendingApprovalActions.upsertPending).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "ap-1",
        actionType: "tool.invoke",
        request,
        expiresAt: "2026-10-16T12:15:00.000Z",
      }),
    );
    expect(fake.rows.get("ap-1")).toMatchObject({ resolutionStatus: "pending", request });
  });

  it("refuses to invoke again when the pending action row is already resolved", async () => {
    const fake = createPendingActionsFake({
      approvalId: "ap-1",
      actionType: "tool.invoke",
      request: request as unknown as Record<string, unknown>,
      createdAt: "2026-10-16T11:00:00.000Z",
      resolvedAt: "2026-10-16T11:01:00.000Z",
      resolutionStatus: "executed",
    });
    const preApproval = buildCommsPreApproval(fake as never, "ap-1");

    await expect(preApproval.recordPendingAction(request)).rejects.toBeInstanceOf(CommsPreApprovalSettledError);
    expect(fake.rows.get("ap-1")).toMatchObject({ resolutionStatus: "executed" });
  });
});

describe("comms typing platform limits", () => {
  it("reports Slack typing as a platform limit instead of a generic gap", async () => {
    const host = createHost();
    host.getIntegrationConnection = vi.fn(
      () =>
        ({
          connectionId: "slack-1",
          kind: "channel",
          key: "slack",
          label: "Slack",
          config: { botTokenEnv: "SLACK_BOT_TOKEN" },
        }) as IntegrationConnection,
    );
    const result = await commsTyping(host, { connectionId: "slack-1", target: "C1" } as never);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/^Platform does not support this: Slack has no typing indicator for bot messages/);
  });

  it.each(["signal", "imessage"])(
    "refuses typing for a saved retired %s connection without calling the provider host",
    async (key) => {
      const host = createHost();
      host.getIntegrationConnection = vi.fn(
        () =>
          ({
            connectionId: "r-1",
            kind: "channel",
            key,
            label: key,
            config: { baseUrl: "http://127.0.0.1:8080", bridgeUrl: "http://127.0.0.1:1234", password: "p" },
          }) as unknown as IntegrationConnection,
      );
      host.emitProviderTyping = vi.fn();
      const result = await commsTyping(host, { connectionId: "r-1", target: "t" } as never);
      expect(result).toMatchObject({ status: "unsupported", supported: false });
      expect(host.emitProviderTyping).not.toHaveBeenCalled();
    },
  );

  it.each(["telegram", "mattermost", "whatsapp"])("routes %s typing to the provider host method", async (key) => {
    const host = createHost();
    host.getIntegrationConnection = vi.fn(
      () => ({ connectionId: "p-1", kind: "channel", key, label: key, config: {} }) as unknown as IntegrationConnection,
    );
    host.emitProviderTyping = vi.fn(async () => ({
      channelKey: key,
      connectionId: "p-1",
      target: "t",
      supported: true,
      status: "sent" as const,
    }));
    const input = { connectionId: "p-1", target: "t", messageId: "m-1" } as never;
    const result = await commsTyping(host, input);
    expect(result.status).toBe("sent");
    expect(host.emitProviderTyping).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.emitProviderTyping).mock.calls[0][1]).toMatchObject({ messageId: "m-1" });
  });

  it("routes Discord typing by runtime mode and declares the webhook limit", async () => {
    const host = createHost();
    const discord = (config: Record<string, unknown>) =>
      ({ connectionId: "d-1", kind: "channel", key: "discord", label: "Discord", config }) as IntegrationConnection;
    const sent = {
      channelKey: "discord",
      connectionId: "d-1",
      target: "1",
      supported: true,
      status: "sent" as const,
    };
    host.emitDiscordTyping = vi.fn(async () => sent);
    host.emitProviderTyping = vi.fn(async () => sent);

    host.getIntegrationConnection = vi.fn(() => discord({ runtimeMode: "gateway", botTokenEnv: "DISCORD_BOT_TOKEN" }));
    await commsTyping(host, { connectionId: "d-1", target: "1" } as never);
    expect(host.emitDiscordTyping).toHaveBeenCalledTimes(1);
    expect(host.emitProviderTyping).not.toHaveBeenCalled();

    host.getIntegrationConnection = vi.fn(() => discord({ runtimeMode: "bridge", botTokenEnv: "DISCORD_BOT_TOKEN" }));
    await commsTyping(host, { connectionId: "d-1", target: "1" } as never);
    expect(host.emitProviderTyping).toHaveBeenCalledTimes(1);
    expect(host.emitDiscordTyping).toHaveBeenCalledTimes(1);

    host.getIntegrationConnection = vi.fn(() => discord({ webhookUrl: "https://discord.com/api/webhooks/1/x" }));
    const webhook = await commsTyping(host, { connectionId: "d-1", target: "1" } as never);
    expect(webhook.reason).toBe("Platform does not support this: Discord webhooks cannot send typing indicators.");
  });

  it("keeps the generic text for actions that are merely not configured", async () => {
    const host = createHost();
    host.getIntegrationConnection = vi.fn(
      () =>
        ({
          connectionId: "d-1",
          kind: "channel",
          key: "discord",
          label: "Discord",
          config: {},
        }) as IntegrationConnection,
    );
    const result = await commsTyping(host, { connectionId: "d-1", target: "1" } as never);
    expect(result.status).toBe("unsupported");
    expect(result.reason).toMatch(/does not advertise typing support in the current runtime mode/);
    expect(result.reason).not.toMatch(/^Platform does not support this/);
  });
});
