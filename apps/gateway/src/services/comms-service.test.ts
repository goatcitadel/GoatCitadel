import { describe, expect, it, vi } from "vitest";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type {
  ChatAttachmentRecord,
  ExternalSideEffectRunRecord,
  GmailSendInput,
  IntegrationConnection,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { commsActivity, commsGmailSend, commsReact, commsSend, commsUnsend, type CommsHost } from "./comms-service.js";
import type { ExternalSideEffectRunStore } from "./external-side-effect-runner-service.js";
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
    emitTelegramTyping: vi.fn(),
    emitChannelActivity: vi.fn(async () => [{ effect: "mission_control", supported: true, status: "sent" }]),
  };
}

describe("comms service governance", () => {
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
    emitTelegramTyping: vi.fn(),
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
