import { randomUUID } from "node:crypto";
import type { IntegrationConnection, ToolInvokeRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commsCalendarCreate, commsGmailSend, commsSmtpSend, type CommsHost } from "./comms-service.js";
import {
  COMMUNICATIONS_IDEMPOTENCY_PREFIX,
  computeCommunicationsPayloadHash,
  type CalendarCreateApprovalInput,
  type MailSendApprovalInput,
} from "./communications-approval-payload.js";
import {
  CommunicationsApprovalEffectError,
  CommunicationsApprovalEffectService,
} from "./communications-approval-effect-service.js";

const openStorages: Storage[] = [];

afterEach(() => {
  for (const storage of openStorages.splice(0)) storage.close();
});

const CONNECTIONS: Record<string, Pick<IntegrationConnection, "catalogId" | "key" | "label">> = {
  "conn-gmail": { catalogId: "automation.gmail", key: "gmail", label: "Gmail" },
  "conn-smtp": { catalogId: "automation.imap-smtp", key: "imap-smtp", label: "Work mail" },
  "conn-manual": { catalogId: "automation.mailbox", key: "mailbox", label: "Notes mailbox" },
  "conn-calendar": { catalogId: "automation.google-calendar", key: "google-calendar", label: "Calendar" },
  "conn-caldav": { catalogId: "automation.caldav", key: "caldav", label: "Work CalDAV" },
};

function createHarness(respond?: (request: ToolInvokeRequest) => Record<string, unknown>) {
  const raw = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  openStorages.push(raw);
  const storage = createSqliteAsyncStorage(raw);
  const invokes: ToolInvokeRequest[] = [];
  const host: CommsHost = {
    // Stands in for the policy engine's approval bypass: it only executes a presented
    // `approval:<id>` consent and settles that approval's pending action as executed.
    invokeAndUnwrap: async (request) => {
      invokes.push(request);
      const approvalId = request.consentContext?.reason?.replace(/^approval:/, "");
      if (approvalId) await storage.pendingApprovalActions.markResolved(approvalId, "executed");
      if (respond) return respond(request);
      return request.toolName === "calendar.create_event"
        ? { status: "sent", providerMessageId: "calendar-event-1" }
        : { status: "sent", deliveryStatus: "sent", providerMessageId: "provider-message-1" };
    },
    readChatAttachmentContent: vi.fn(),
    getIntegrationConnection: async (connectionId) => {
      const known = CONNECTIONS[connectionId];
      if (!known) throw new Error(`Unknown integration connection ${connectionId}`);
      return { connectionId, kind: "automation", enabled: true, status: "connected", config: {}, ...known } as never;
    },
    emitDiscordTyping: vi.fn(),
    emitTelegramTyping: vi.fn(),
    emitChannelActivity: vi.fn(),
    mutationStore: storage.mutationIdempotency,
    sideEffectRunStore: storage.externalSideEffectRuns,
  };
  const service = new CommunicationsApprovalEffectService({
    storage,
    getIntegrationConnection: (connectionId) => host.getIntegrationConnection(connectionId),
    commsGmailSend: (input, preApproval) => commsGmailSend(host, input, preApproval),
    commsSmtpSend: (input, preApproval) => commsSmtpSend(host, input, preApproval),
    commsCalendarCreate: (input, preApproval) => commsCalendarCreate(host, input, preApproval),
  });
  return { raw, storage, invokes, service };
}

async function seedApprovedMailSend(storage: AsyncStorage, accountId = "conn-gmail") {
  const now = new Date().toISOString();
  const hashed: MailSendApprovalInput = {
    draftId: `mail_draft_${randomUUID()}`,
    accountId,
    to: ["dest@example.test"],
    cc: [],
    bcc: [],
    subject: "Status",
    bodyText: "All good",
  };
  await storage.mailDrafts.create({ ...hashed, status: "approval_required", createdAt: now, updatedAt: now });
  const approval = await storage.approvals.create({
    kind: "communications.mail.send",
    riskLevel: "danger",
    payload: {
      action: "mail_send",
      ...hashed,
      payloadHash: computeCommunicationsPayloadHash(hashed),
      idempotencyKeyPrefix: COMMUNICATIONS_IDEMPOTENCY_PREFIX,
    },
    preview: {},
  });
  await storage.mailDrafts.transition(hashed.draftId, ["approval_required"], {
    status: "approval_required",
    approvalId: approval.approvalId,
    updatedAt: now,
  });
  await storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
  return { draftId: hashed.draftId, approvalId: approval.approvalId };
}

async function seedApprovedCalendarCreate(
  storage: AsyncStorage,
  overrides: Partial<Pick<CalendarCreateApprovalInput, "accountId" | "location">> = {},
) {
  const hashed: CalendarCreateApprovalInput = {
    eventId: `calendar_event_${randomUUID()}`,
    accountId: "conn-calendar",
    title: "Planning",
    startIso: "2026-10-20T15:00:00.000Z",
    endIso: "2026-10-20T15:30:00.000Z",
    attendees: ["ops@example.test"],
    ...overrides,
  };
  const approval = await storage.approvals.create({
    kind: "communications.calendar.create",
    riskLevel: "caution",
    payload: {
      action: "calendar_event_create",
      ...hashed,
      payloadHash: computeCommunicationsPayloadHash(hashed),
      idempotencyKeyPrefix: COMMUNICATIONS_IDEMPOTENCY_PREFIX,
    },
    preview: {},
  });
  await storage.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
  return { eventId: hashed.eventId, approvalId: approval.approvalId };
}

async function expectEffectError(promise: Promise<unknown>, code: CommunicationsApprovalEffectError["code"]) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CommunicationsApprovalEffectError);
  expect((error as CommunicationsApprovalEffectError).code).toBe(code);
  return error as CommunicationsApprovalEffectError;
}

describe("CommunicationsApprovalEffectService mail send", () => {
  it("sends an approved draft once with the approval's consent and marks the draft sent", async () => {
    const { storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);

    const result = await service.executeApprovedMailSend({ approvalId });

    expect(result).toEqual({ disposition: "sent", providerMessageId: "provider-message-1", replayed: false });
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({
      toolName: "gmail.send",
      args: { connectionId: "conn-gmail", to: ["dest@example.test"], subject: "Status", bodyText: "All good" },
      consentContext: { source: "ui", reason: `approval:${approvalId}` },
    });
    const draft = await storage.mailDrafts.get(draftId);
    expect(draft).toMatchObject({ status: "sent", approvalId });
    expect(draft.sentAt).toEqual(expect.any(String));
    expect(await storage.approvals.list()).toHaveLength(1);
  });

  it("replays a completed send on a second run without invoking the provider again", async () => {
    const { storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);

    await service.executeApprovedMailSend({ approvalId });
    const second = await service.executeApprovedMailSend({ approvalId });

    expect(invokes).toHaveLength(1);
    expect(second).toMatchObject({ disposition: "sent", replayed: true });
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "sent" });
  });

  it("routes an IMAP/SMTP account through smtp.send", async () => {
    const { storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage, "conn-smtp");

    await expect(service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ disposition: "sent" });

    expect(invokes.map((request) => request.toolName)).toEqual(["smtp.send"]);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "sent" });
  });

  it("refuses a payload tampered after approval and fails the draft without invoking", async () => {
    const { raw, storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    const approval = await storage.approvals.get(approvalId);
    raw.db
      .prepare("UPDATE approvals SET payload_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ ...approval.payload, subject: "Wire the money" }), approvalId);

    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "payload_hash_mismatch");

    expect(invokes).toHaveLength(0);
    const draft = await storage.mailDrafts.get(draftId);
    expect(draft.status).toBe("failed");
    expect(draft.failureReason).toMatch(/no longer matches/i);
  });

  it("refuses an account that cannot send with a readable reason on the draft", async () => {
    const { storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage, "conn-manual");

    const error = await expectEffectError(service.executeApprovedMailSend({ approvalId }), "provider_unavailable");

    expect(error.message).toBe("This mail account (manual) cannot send; connect Gmail or an SMTP account.");
    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "failed", failureReason: error.message });
  });

  it("fails closed with outcome_unknown when the provider may have sent", async () => {
    const { storage, invokes, service } = createHarness(() => ({
      status: "failed",
      deliveryStatus: "manual_reconciliation_required",
      error: "socket closed after DATA",
    }));
    const { draftId, approvalId } = await seedApprovedMailSend(storage);

    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "outcome_unknown");
    // A second run never reaches the provider: the ledger run crossed the boundary.
    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "outcome_unknown");

    expect(invokes).toHaveLength(1);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({
      status: "failed",
      failureReason: "Delivery outcome is unknown; check the mailbox before retrying.",
    });
  });

  it("fails a pre-boundary provider refusal as delivery_failed", async () => {
    const { storage, service } = createHarness(() => ({
      status: "failed",
      deliveryStatus: "blocked",
      error: "Gmail token missing",
    }));
    const { draftId, approvalId } = await seedApprovedMailSend(storage);

    const error = await expectEffectError(service.executeApprovedMailSend({ approvalId }), "delivery_failed");

    expect(error.message).toContain("Gmail token missing");
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "failed", failureReason: error.message });
  });

  it("fails closed without invoking when the approval's pending action is already settled", async () => {
    const { storage, invokes, service } = createHarness();
    const { approvalId } = await seedApprovedMailSend(storage);
    await storage.pendingApprovalActions.upsertPending({
      approvalId,
      actionType: "tool.invoke",
      request: { toolName: "gmail.send", args: {} },
    });
    await storage.pendingApprovalActions.markResolved(approvalId, "failed");

    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "approval_not_approved");

    expect(invokes).toHaveLength(0);
  });

  it("refuses an approval that is not approved", async () => {
    const { storage, invokes, service } = createHarness();
    const pending = await storage.approvals.create({
      kind: "communications.mail.send",
      riskLevel: "danger",
      payload: {},
      preview: {},
    });

    await expectEffectError(
      service.executeApprovedMailSend({ approvalId: pending.approvalId }),
      "approval_not_approved",
    );
    expect(invokes).toHaveLength(0);
  });

  it("records a rejected send on the draft without invoking any provider", async () => {
    const { storage, invokes, service } = createHarness();
    const now = new Date().toISOString();
    const draftId = `mail_draft_${randomUUID()}`;
    await storage.mailDrafts.create({
      draftId,
      accountId: "conn-gmail",
      to: ["dest@example.test"],
      cc: [],
      bcc: [],
      subject: "Status",
      bodyText: "All good",
      status: "approval_required",
      createdAt: now,
      updatedAt: now,
    });
    const approval = await storage.approvals.create({
      kind: "communications.mail.send",
      riskLevel: "danger",
      payload: { action: "mail_send", draftId },
      preview: {},
    });
    await storage.approvals.resolve(approval.approvalId, { decision: "reject", resolvedBy: "operator" });

    await expect(service.recordMailSendRejected({ approvalId: approval.approvalId })).resolves.toEqual({
      disposition: "rejected",
    });

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({
      status: "failed",
      failureReason: "Send approval was rejected; nothing was sent.",
    });
  });

  it("records an expired send approval with the expiry wording", async () => {
    const { storage, invokes, service } = createHarness();
    const now = new Date().toISOString();
    const draftId = `mail_draft_${randomUUID()}`;
    await storage.mailDrafts.create({
      draftId,
      accountId: "conn-gmail",
      to: ["dest@example.test"],
      cc: [],
      bcc: [],
      subject: "Status",
      bodyText: "All good",
      status: "approval_required",
      createdAt: now,
      updatedAt: now,
    });
    const approval = await storage.approvals.create({
      kind: "communications.mail.send",
      riskLevel: "danger",
      payload: { action: "mail_send", draftId },
      preview: {},
    });
    await storage.approvals.resolve(approval.approvalId, { decision: "reject", resolvedBy: "system" });

    await service.recordMailSendRejected({ approvalId: approval.approvalId, expired: true });

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({
      status: "failed",
      failureReason: "Send approval expired; nothing was sent.",
    });
  });
});

describe("CommunicationsApprovalEffectService calendar create", () => {
  it("creates an approved event once and replays the second run", async () => {
    const { storage, invokes, service } = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(storage);

    const first = await service.executeApprovedCalendarCreate({ approvalId });
    const second = await service.executeApprovedCalendarCreate({ approvalId });

    expect(first).toEqual({ disposition: "created", providerEventId: "calendar-event-1", replayed: false });
    expect(second).toMatchObject({ disposition: "created", replayed: true });
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toMatchObject({
      toolName: "calendar.create_event",
      args: { connectionId: "conn-calendar", title: "Planning", attendees: ["ops@example.test"] },
      consentContext: { reason: `approval:${approvalId}` },
    });
  });

  it("carries the approved location into the calendar create", async () => {
    const { storage, invokes, service } = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(storage, { location: "Room 4" });

    await service.executeApprovedCalendarCreate({ approvalId });

    expect(invokes[0]).toMatchObject({ toolName: "calendar.create_event", args: { location: "Room 4" } });
  });

  it("refuses a calendar account that cannot create events", async () => {
    const { storage, invokes, service } = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(storage, { accountId: "conn-caldav" });

    const error = await expectEffectError(
      service.executeApprovedCalendarCreate({ approvalId }),
      "provider_unavailable",
    );

    expect(error.message).toBe("This calendar account (caldav) cannot create events; connect Google Calendar.");
    expect(invokes).toHaveLength(0);
  });
});
