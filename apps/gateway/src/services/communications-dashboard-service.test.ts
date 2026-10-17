import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalCreateInput,
  ApprovalRequest,
  IntegrationConnection,
  MailDraftRecord,
} from "@goatcitadel/contracts";
import {
  computeCommunicationsPayloadHash,
  readCalendarCreateApprovalInput,
  readMailSendApprovalInput,
} from "./communications-approval-payload.js";
import {
  createCommunicationsDashboardService,
  INTERRUPTED_SEND_RELEASE_GRACE_MS,
  MailDraftRecoveryUnavailableError,
  type CommunicationsMailDraftRecovery,
  type CommunicationsMailDraftStore,
} from "./communications-dashboard-service.js";

const NOW = "2026-06-05T12:00:00.000Z";

function createConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "11111111-1111-4111-8111-111111111111",
    catalogId: "automation.gmail",
    kind: "automation",
    key: "gmail",
    label: "Primary Gmail",
    enabled: true,
    status: "connected",
    config: {
      address: "operator@example.test",
      refreshTokenHandle: "gmail-primary",
      accessToken: "raw-token-that-must-not-leak",
    },
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
    lastSyncAt: "2026-06-05T11:00:00.000Z",
    ...overrides,
  };
}

describe("communications dashboard service", () => {
  it("builds account, inbox, agenda, and contact summaries from safe runtime adapters", async () => {
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      listIntegrationConnections: () => [createConnection()],
      commsGmailRead: vi.fn(async () => ({
        outcome: "executed",
        auditEventId: "audit-1",
        policyReason: "allowed",
        result: {
          output: {
            items: [
              {
                id: "msg-1",
                threadId: "thread-1",
                from: "sender@example.test",
                to: ["operator@example.test"],
                subject: "Status",
                snippet: "Ready",
                labelIds: ["INBOX"],
              },
            ],
          },
        },
      })),
      commsCalendarList: vi.fn(async () => ({
        items: [
          {
            id: "evt-1",
            summary: "Planning",
            start: { dateTime: "2026-06-06T10:00:00.000Z" },
            end: { dateTime: "2026-06-06T10:30:00.000Z" },
            attendees: ["operator@example.test"],
          },
        ],
      })),
    });

    const dashboard = await service.getDashboard({ workspaceId: "workspace-1" });

    expect(dashboard.mailAccounts).toEqual([
      expect.objectContaining({
        accountId: "11111111-1111-4111-8111-111111111111",
        workspaceId: "workspace-1",
        provider: "gmail",
        connectionId: "11111111-1111-4111-8111-111111111111",
        secretRef: "gmail-primary",
        syncStatus: "ready",
      }),
    ]);
    expect(dashboard.messages).toEqual([
      expect.objectContaining({
        messageId: "msg-1",
        accountId: "11111111-1111-4111-8111-111111111111",
        subject: "Status",
      }),
    ]);
    expect(dashboard.events).toEqual([
      expect.objectContaining({
        eventId: "evt-1",
        title: "Planning",
        startIso: "2026-06-06T10:00:00.000Z",
      }),
    ]);
    expect(dashboard.contacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contactId: "email:sender@example.test",
          workspaceId: "workspace-1",
          emailAddresses: ["sender@example.test"],
        }),
      ]),
    );
  });

  it("redacts raw connection secrets while retaining secret references", async () => {
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      listIntegrationConnections: () => [
        createConnection({
          config: {
            address: "operator@example.test",
            accessToken: "raw-access-token",
            token: "raw-token",
            clientSecret: "raw-client-secret",
            refreshTokenHandle: "gmail-primary",
          },
        }),
      ],
    });

    const dashboard = await service.getDashboard();
    const serialized = JSON.stringify(dashboard);

    expect(dashboard.mailAccounts[0]).toMatchObject({
      connectionId: "11111111-1111-4111-8111-111111111111",
      secretRef: "gmail-primary",
    });
    expect(serialized).not.toContain("raw-access-token");
    expect(serialized).not.toContain("raw-token");
    expect(serialized).not.toContain("raw-client-secret");
  });

  it("fetches inbox messages and calendar events concurrently", async () => {
    const calls: string[] = [];
    let releaseGmail = (): void => undefined;
    let gmailStarted = (): void => undefined;
    const gmailStartedPromise = new Promise<void>((resolve) => {
      gmailStarted = resolve;
    });
    const gmailReleasePromise = new Promise<void>((resolve) => {
      releaseGmail = resolve;
    });
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      listIntegrationConnections: () => [createConnection()],
      commsGmailRead: vi.fn(async () => {
        calls.push("gmail:start");
        gmailStarted();
        await gmailReleasePromise;
        calls.push("gmail:end");
        return { items: [] };
      }),
      commsCalendarList: vi.fn(async () => {
        calls.push("calendar:start");
        calls.push("calendar:end");
        return { items: [] };
      }),
    });

    const dashboardPromise = service.getDashboard();
    await gmailStartedPromise;
    await Promise.resolve();
    const calendarStartedBeforeGmailRelease = calls.includes("calendar:start");
    releaseGmail();
    await dashboardPromise;

    expect(calendarStartedBeforeGmailRelease).toBe(true);
    expect(calls.indexOf("calendar:start")).toBeLessThan(calls.indexOf("gmail:end"));
  });

  it("marks send draft as approval required without invoking Gmail send", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      accountId: "11111111-1111-4111-8111-111111111111",
      to: ["operator@example.test"],
      subject: "Approval check",
      bodyText: "Ready to send after approval.",
    });

    const result = await service.sendDraft(draft.draftId);

    expect(result).toMatchObject({
      draftId: draft.draftId,
      status: "approval_required",
      approvalId: "22222222-2222-4222-8222-222222222222",
      updatedAt: NOW,
    });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "communications.mail.send",
        riskLevel: "danger",
        payload: expect.objectContaining({ action: "mail_send", draftId: draft.draftId }),
      }),
    );
  });

  it("binds the send approval to the draft workspace and replays an exact repeated send without a second approval", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      workspaceId: "workspace-mail",
      accountId: "11111111-1111-4111-8111-111111111111",
      to: ["operator@example.test"],
      subject: "Scoped approval",
      bodyText: "Bound to its workspace.",
    });
    expect(draft.workspaceId).toBe("workspace-mail");
    const first = await service.sendDraft(draft.draftId);
    // A lost response must be safely replayable by exact draft ID.
    const replay = await service.sendDraft(draft.draftId);
    expect(createApproval).toHaveBeenCalledOnce();
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        linkage: expect.objectContaining({ workspaceId: "workspace-mail", actionType: "communications.mail.send" }),
      }),
    );
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      status: "approval_required",
      approvalId: "22222222-2222-4222-8222-222222222222",
      workspaceId: "workspace-mail",
    });
  });

  it("server-binds the default workspace for a draft created without one", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      accountId: "acct-unscoped",
      to: ["operator@example.test"],
      subject: "Unscoped",
      bodyText: "Classic path.",
    });
    await service.sendDraft(draft.draftId);
    expect(draft.workspaceId).toBe("default");
    expect(createApproval.mock.calls[0]![0].linkage).toEqual({
      actionType: "communications.mail.send",
      connectorId: "acct-unscoped",
      workspaceId: "default",
    });
  });

  it("binds the mail account's connection revision into the hashed send approval", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      listIntegrationConnections: () => [createConnection({ revision: "rev-at-approval" })],
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      workspaceId: "workspace-1",
      accountId: createConnection().connectionId,
      to: ["operator@example.test"],
      subject: "Bound",
      bodyText: "Revision bound.",
    });
    await service.sendDraft(draft.draftId);
    const payload = createApproval.mock.calls[0]![0].payload;
    expect(payload.connectionRevision).toBe("rev-at-approval");
    const hashed = readMailSendApprovalInput(payload)!;
    expect(hashed.connectionRevision).toBe("rev-at-approval");
    expect(payload.payloadHash).toBe(computeCommunicationsPayloadHash(hashed));
    expect(computeCommunicationsPayloadHash({ ...hashed, connectionRevision: "rev-other" })).not.toBe(
      payload.payloadHash,
    );
  });

  it("binds the calendar account's revision and the default workspace into a calendar approval", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      listIntegrationConnections: () => [
        createConnection({
          connectionId: "cal-1",
          catalogId: "automation.google-calendar",
          key: "google-calendar",
          revision: "rev-cal",
        }),
      ],
    });
    await service.createCalendarEventPlaceholder({
      accountId: "cal-1",
      title: "Planning",
      startIso: "2026-10-20T15:00:00.000Z",
      endIso: "2026-10-20T15:30:00.000Z",
      attendees: [],
    } as never);
    const request = createApproval.mock.calls[0]![0];
    expect(request.payload.connectionRevision).toBe("rev-cal");
    expect(request.linkage).toMatchObject({ workspaceId: "default" });
  });

  it("shares one in-flight send so a concurrent replay never requests a second approval", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => {
      await gate;
      return createApprovalRecord(input);
    });
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      workspaceId: "workspace-mail",
      accountId: "acct-a",
      to: ["operator@example.test"],
      subject: "Concurrent",
      bodyText: "Once.",
    });
    const first = service.sendDraft(draft.draftId);
    const replay = service.sendDraft(draft.draftId);
    release();
    const results = await Promise.all([first, replay]);
    expect(createApproval).toHaveBeenCalledOnce();
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({ status: "approval_required" });
  });

  it("treats an uncertain approval request as terminal so no replay can create a second approval", async () => {
    const createApproval = vi.fn(async () => {
      throw new Error("storage write outcome unknown");
    });
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      workspaceId: "workspace-mail",
      accountId: "acct-a",
      to: ["operator@example.test"],
      subject: "Uncertain",
      bodyText: "Do not repeat.",
    });
    await expect(service.sendDraft(draft.draftId)).rejects.toThrow("storage write outcome unknown");
    const replay = await service.sendDraft(draft.draftId);
    expect(replay).toMatchObject({ draftId: draft.draftId, status: "failed" });
    expect(replay.failureReason).toContain("storage write outcome unknown");
    expect(replay.approvalId).toBeUndefined();
    expect(createApproval).toHaveBeenCalledOnce();
  });

  it("never requests an approval for a draft the Gateway does not hold, even when sent twice", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    expect(await service.sendDraft("mail_draft_missing")).toMatchObject({ status: "failed" });
    expect(await service.sendDraft("mail_draft_missing")).toMatchObject({ status: "failed" });
    expect(createApproval).not.toHaveBeenCalled();
    expect(await service.getDraft("mail_draft_missing")).toBeUndefined();
  });

  it("hashes the exact send payload and states that approving sends it", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      accountId: "acct-a",
      to: ["operator@example.test"],
      cc: ["cc@example.test"],
      subject: "Hashed",
      bodyText: "Exact body.",
    });

    await service.sendDraft(draft.draftId);

    const request = createApproval.mock.calls[0]![0];
    const input = readMailSendApprovalInput(request.payload);
    expect(input).toEqual({
      draftId: draft.draftId,
      accountId: "acct-a",
      to: ["operator@example.test"],
      cc: ["cc@example.test"],
      bcc: [],
      subject: "Hashed",
      bodyText: "Exact body.",
    });
    expect(request.payload).toMatchObject({
      action: "mail_send",
      payloadHash: computeCommunicationsPayloadHash(input!),
      idempotencyKeyPrefix: "communications:",
    });
    expect(request.preview).toMatchObject({
      execution: "Approving sends this exact message once through the connected account.",
    });
    expect(JSON.stringify(request.preview)).not.toMatch(/does not (send|mutate)/u);
  });

  it("hashes the exact calendar payload and binds the approval to the workspace", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval });

    const event = await service.createCalendarEventPlaceholder({
      workspaceId: "workspace-cal",
      accountId: "acct-cal",
      title: "Planning",
      startIso: "2026-06-06T10:00:00.000Z",
      endIso: "2026-06-06T10:30:00.000Z",
      attendees: ["a@example.test"],
      location: "Room 1",
    });

    const request = createApproval.mock.calls[0]![0];
    const input = readCalendarCreateApprovalInput(JSON.parse(JSON.stringify(request.payload)));
    expect(input).toEqual({
      eventId: event.eventId,
      accountId: "acct-cal",
      title: "Planning",
      startIso: "2026-06-06T10:00:00.000Z",
      endIso: "2026-06-06T10:30:00.000Z",
      attendees: ["a@example.test"],
      location: "Room 1",
    });
    expect(request.payload).toMatchObject({
      action: "calendar_event_create",
      payloadHash: computeCommunicationsPayloadHash(input!),
      idempotencyKeyPrefix: "communications:",
    });
    expect(request.preview).toMatchObject({
      location: "Room 1",
      execution: "Approving creates this exact event once on the connected calendar.",
    });
    expect(JSON.stringify(request.preview)).not.toMatch(/does not (send|mutate)/u);
    expect(request.linkage).toEqual({
      actionType: "communications.calendar.create",
      connectorId: "acct-cal",
      workspaceId: "workspace-cal",
    });
  });

  it("persists drafts so a restarted service replays the recorded approval instead of requesting another", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const mailDrafts = createMailDraftStore();
    const serviceA = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval, mailDrafts });
    const draft = await serviceA.createDraft({
      workspaceId: "workspace-mail",
      accountId: "acct-a",
      to: ["operator@example.test"],
      subject: "Restart",
      bodyText: "Survives.",
    });
    const first = await serviceA.sendDraft(draft.draftId);

    const serviceB = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval, mailDrafts });
    const replay = await serviceB.sendDraft(draft.draftId);

    expect(first).toMatchObject({ status: "approval_required", approvalId: "22222222-2222-4222-8222-222222222222" });
    expect(replay).toMatchObject({ status: "approval_required", approvalId: first.approvalId });
    expect(createApproval).toHaveBeenCalledOnce();
    expect(await serviceB.getDraft(draft.draftId)).toEqual(replay);
  });

  it("gives identical drafts created at the same instant distinct random ids", async () => {
    const mailDrafts = createMailDraftStore();
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), mailDrafts });
    const input = { accountId: "acct-a", to: ["operator@example.test"], subject: "Twice", bodyText: "Double click." };

    const first = await service.createDraft(input);
    const second = await service.createDraft(input);

    expect(first.draftId).not.toBe(second.draftId);
    expect(first.draftId).toMatch(/^mail_draft_[0-9a-f-]{36}$/u);
    expect(await service.getDraft(first.draftId)).toMatchObject({ status: "draft", subject: "Twice" });
    expect(await service.getDraft(second.draftId)).toMatchObject({ status: "draft", subject: "Twice" });
  });

  it("never requests a second approval for a draft fenced by a request that died mid-flight", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const mailDrafts = createMailDraftStore();
    // As if a previous process claimed the draft, then crashed before recording the approval id.
    const fenced = await mailDrafts.create({
      draftId: "mail_draft_fenced",
      accountId: "acct-a",
      to: ["operator@example.test"],
      cc: [],
      bcc: [],
      subject: "Fenced",
      bodyText: "Claimed before the crash.",
      status: "approval_required",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval, mailDrafts });

    const replay = await service.sendDraft("mail_draft_fenced");

    expect(createApproval).not.toHaveBeenCalled();
    expect(replay).toEqual(fenced);
    expect(replay.approvalId).toBeUndefined();
  });

  it("fences the draft before the approval exists so a send racing the request returns the claim", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => {
      await gate;
      return createApprovalRecord(input);
    });
    const mailDrafts = createMailDraftStore();
    const serviceA = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval, mailDrafts });
    const serviceB = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval, mailDrafts });
    const draft = await serviceA.createDraft({
      accountId: "acct-a",
      to: ["operator@example.test"],
      subject: "Raced",
      bodyText: "Other process.",
    });

    const first = serviceA.sendDraft(draft.draftId);
    await vi.waitFor(() => expect(createApproval).toHaveBeenCalledOnce());
    const other = await serviceB.sendDraft(draft.draftId);
    release();

    expect(other).toMatchObject({ status: "approval_required" });
    expect(other.approvalId).toBeUndefined();
    expect(await first).toMatchObject({
      status: "approval_required",
      approvalId: "22222222-2222-4222-8222-222222222222",
    });
    expect(createApproval).toHaveBeenCalledOnce();
  });

  it("projects only unbound connections and connections bound to the requested workspace", async () => {
    const gmailRead = vi.fn(async (_input: { connectionId: string }) => ({ messages: [] }));
    const calendarList = vi.fn(async (_input: { connectionId: string }) => ({ items: [] }));
    const readConnections = (mock: typeof gmailRead) => mock.mock.calls.map(([input]) => input.connectionId);
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      listIntegrationConnections: () => [
        createConnection({
          connectionId: "conn-unbound",
          label: "Unbound",
          config: { address: "unbound@example.test", contacts: [{ displayName: "Unbound contact" }] },
        }),
        createConnection({
          connectionId: "conn-own",
          label: "Own",
          workspaceId: "workspace-1",
          config: { address: "own@example.test" },
        }),
        createConnection({
          connectionId: "conn-foreign",
          label: "Foreign",
          workspaceId: "workspace-2",
          config: { address: "foreign@example.test", contacts: [{ displayName: "Foreign contact" }] },
        }),
      ],
      commsGmailRead: gmailRead,
      commsCalendarList: calendarList,
    });

    const dashboard = await service.getDashboard({ workspaceId: "workspace-1" });

    expect(dashboard.mailAccounts.map((account) => account.accountId).sort()).toEqual(["conn-own", "conn-unbound"]);
    expect(dashboard.calendarAccounts.map((account) => account.accountId)).not.toContain("conn-foreign");
    expect(dashboard.contacts.map((contact) => contact.displayName)).toEqual(["Unbound contact"]);
    expect(await service.isMailAccountVisible("workspace-1", "conn-own")).toBe(true);
    expect(await service.isMailAccountVisible("workspace-1", "conn-unbound")).toBe(true);
    expect(await service.isMailAccountVisible("workspace-1", "conn-foreign")).toBe(false);
    expect(await service.isMailAccountVisible("workspace-1", "conn-missing")).toBe(false);
    expect(readConnections(gmailRead)).not.toContain("conn-foreign");
    expect(readConnections(calendarList)).not.toContain("conn-foreign");
    expect(readConnections(gmailRead).sort()).toEqual(["conn-own", "conn-unbound"]);
  });

  // The composed gateway port resolves connections asynchronously. Treating it
  // as synchronous made `/api/v1/communications` answer 500 with
  // "connections.flatMap is not a function".
  it("resolves an asynchronous integration connection port", async () => {
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      listIntegrationConnections: async () => [createConnection()],
      commsGmailRead: vi.fn(async () => ({ messages: [] })),
      commsCalendarList: vi.fn(async () => ({ items: [] })),
    });

    const dashboard = await service.getDashboard({ workspaceId: "workspace-1" });

    expect(dashboard.mailAccounts).toHaveLength(1);
    expect(dashboard.mailAccounts[0]).toMatchObject({ provider: "gmail", address: "operator@example.test" });
  });

  it("keeps credential values and references out of the hashed send approval", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const smtp = createConnection({
      connectionId: "smtp-conn",
      catalogId: "automation.imap-smtp",
      key: "imap-smtp",
      revision: "rev-smtp",
      config: {
        smtpHost: "smtp.example.test",
        smtpUser: "ops@example.test",
        smtpPassword: "direct-password-value",
        smtpPasswordEnv: "SMTP_PASSWORD_ENV_NAME",
        fromAddress: "ops@example.test",
      },
    });
    const service = createCommunicationsDashboardService({
      now: () => new Date(NOW),
      createApproval,
      listIntegrationConnections: () => [smtp],
      mailDrafts: createMailDraftStore(),
    });
    const draft = await service.createDraft({
      accountId: "smtp-conn",
      to: ["a@example.test"],
      subject: "Hi",
      bodyText: "Body",
    });

    await service.sendDraft(draft.draftId);

    // The revision is the binding; a stored secret or secret reference never reaches the approval.
    const request = JSON.stringify(createApproval.mock.calls[0]![0]);
    expect(createApproval.mock.calls[0]![0].payload.connectionRevision).toBe("rev-smtp");
    expect(request).not.toContain("direct-password-value");
    expect(request).not.toContain("SMTP_PASSWORD_ENV_NAME");
  });
});

describe("releasing an interrupted send", () => {
  const AFTER_GRACE = new Date(Date.parse(NOW) + INTERRUPTED_SEND_RELEASE_GRACE_MS + 1_000);

  async function fencedDraft(mailDrafts: CommunicationsMailDraftStore, overrides: Partial<MailDraftRecord> = {}) {
    return mailDrafts.create({
      draftId: "mail_draft_fenced",
      workspaceId: "workspace-1",
      accountId: "acct-a",
      to: ["operator@example.test"],
      cc: [],
      bcc: ["hidden@example.test"],
      subject: "Private subject",
      bodyText: "Private body.",
      status: "approval_required",
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    });
  }

  function recovery(approvals: ApprovalRequest[] = []) {
    return {
      findMailSendApprovals: vi.fn(async (_draftId: string) => approvals),
      recordAudit: vi.fn(async (_event: Record<string, unknown>) => undefined),
    } satisfies CommunicationsMailDraftRecovery;
  }

  it("waits out the grace period before checking for an approval", async () => {
    const mailDrafts = createMailDraftStore();
    const fenced = await fencedDraft(mailDrafts);
    const mailDraftRecovery = recovery();
    const service = createCommunicationsDashboardService({
      now: () => new Date(Date.parse(NOW) + 60_000),
      mailDrafts,
      mailDraftRecovery,
    });

    const result = await service.releaseInterruptedDraft(fenced.draftId);

    expect(result).toEqual({ outcome: "too_recent", draft: fenced, retryAfterSeconds: 540 });
    expect(mailDraftRecovery.findMailSendApprovals).not.toHaveBeenCalled();
    expect(await mailDrafts.find(fenced.draftId)).toEqual(fenced);
  });

  it("releases a draft no approval names, audits it without content, then allows exactly one approval", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const mailDrafts = createMailDraftStore();
    const fenced = await fencedDraft(mailDrafts, { failureReason: "stale" });
    const mailDraftRecovery = recovery();
    const service = createCommunicationsDashboardService({
      now: () => AFTER_GRACE,
      createApproval,
      mailDrafts,
      mailDraftRecovery,
    });

    const result = await service.releaseInterruptedDraft(fenced.draftId);

    expect(result.outcome).toBe("released");
    expect(result.draft).toMatchObject({ status: "draft", updatedAt: AFTER_GRACE.toISOString() });
    expect(result.draft.failureReason).toBeUndefined();
    expect(result.draft.approvalId).toBeUndefined();
    expect(mailDraftRecovery.findMailSendApprovals).toHaveBeenCalledExactlyOnceWith(fenced.draftId);
    expect(mailDraftRecovery.recordAudit).toHaveBeenCalledExactlyOnceWith({
      event: "mail_draft_send_released",
      draftId: fenced.draftId,
      workspaceId: "workspace-1",
      accountId: "acct-a",
      interruptedAt: NOW,
    });

    const sent = await service.sendDraft(fenced.draftId);
    const replay = await service.sendDraft(fenced.draftId);
    expect(sent).toMatchObject({ status: "approval_required", approvalId: "22222222-2222-4222-8222-222222222222" });
    expect(replay).toEqual(sent);
    expect(createApproval).toHaveBeenCalledOnce();
  });

  it("re-links an approval that did persist instead of releasing, so no second approval is requested", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const mailDrafts = createMailDraftStore();
    const fenced = await fencedDraft(mailDrafts);
    const persisted: ApprovalRequest = {
      ...createApprovalRecord({ kind: "communications.mail.send", riskLevel: "danger", payload: {}, preview: {} }),
      approvalId: "approval-persisted",
    };
    const mailDraftRecovery = recovery([persisted]);
    const service = createCommunicationsDashboardService({
      now: () => AFTER_GRACE,
      createApproval,
      mailDrafts,
      mailDraftRecovery,
    });

    const result = await service.releaseInterruptedDraft(fenced.draftId);

    expect(result).toMatchObject({
      outcome: "relinked",
      draft: { status: "approval_required", approvalId: "approval-persisted" },
    });
    expect(mailDraftRecovery.recordAudit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: "mail_draft_send_relinked", approvalId: "approval-persisted" }),
    );
    expect(await service.sendDraft(fenced.draftId)).toMatchObject({ approvalId: "approval-persisted" });
    expect(createApproval).not.toHaveBeenCalled();
  });

  it("leaves a draft that is not interrupted unchanged", async () => {
    const mailDrafts = createMailDraftStore();
    const linked = await fencedDraft(mailDrafts, { approvalId: "approval-1" });
    const mailDraftRecovery = recovery();
    const service = createCommunicationsDashboardService({ now: () => AFTER_GRACE, mailDrafts, mailDraftRecovery });

    expect(await service.releaseInterruptedDraft(linked.draftId)).toEqual({
      outcome: "not_interrupted",
      draft: linked,
    });
    expect(mailDraftRecovery.findMailSendApprovals).not.toHaveBeenCalled();
    expect(mailDraftRecovery.recordAudit).not.toHaveBeenCalled();
  });

  it("does not release while this process still has the send request in flight", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let now = new Date(NOW);
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => {
      await gate;
      return createApprovalRecord(input);
    });
    const mailDrafts = createMailDraftStore();
    const mailDraftRecovery = recovery();
    const service = createCommunicationsDashboardService({
      now: () => now,
      createApproval,
      mailDrafts,
      mailDraftRecovery,
    });
    const draft = await service.createDraft({
      accountId: "acct-a",
      to: ["a@example.test"],
      subject: "S",
      bodyText: "B",
    });

    const sending = service.sendDraft(draft.draftId);
    await vi.waitFor(() => expect(createApproval).toHaveBeenCalledOnce());
    now = AFTER_GRACE;
    const result = await service.releaseInterruptedDraft(draft.draftId);
    finish();

    expect(result.outcome).toBe("too_recent");
    expect(mailDraftRecovery.findMailSendApprovals).not.toHaveBeenCalled();
    expect(await sending).toMatchObject({ approvalId: "22222222-2222-4222-8222-222222222222" });
  });

  it("fails closed when the approval lookup is not composed", async () => {
    const mailDrafts = createMailDraftStore();
    const fenced = await fencedDraft(mailDrafts);
    const service = createCommunicationsDashboardService({ now: () => AFTER_GRACE, mailDrafts });

    await expect(service.releaseInterruptedDraft(fenced.draftId)).rejects.toBeInstanceOf(
      MailDraftRecoveryUnavailableError,
    );
    expect(await mailDrafts.find(fenced.draftId)).toEqual(fenced);
  });
});

function createApprovalRecord(input: ApprovalCreateInput): ApprovalRequest {
  return {
    approvalId: "22222222-2222-4222-8222-222222222222",
    kind: input.kind,
    riskLevel: input.riskLevel,
    status: "pending",
    payload: input.payload,
    preview: input.preview,
    linkage: input.linkage,
    rollbackNote: input.rollbackNote,
    createdAt: NOW,
    explanationStatus: "not_requested",
  };
}

/** In-memory stand-in for the storage repo: duplicate create throws, transition is compare-and-set with COALESCE. */
function createMailDraftStore(): CommunicationsMailDraftStore {
  const rows = new Map<string, MailDraftRecord>();
  return {
    create: async (record) => {
      if (rows.has(record.draftId)) {
        throw new Error(`duplicate mail draft ${record.draftId}`);
      }
      rows.set(record.draftId, { ...record });
      return { ...record };
    },
    find: async (draftId) => {
      const row = rows.get(draftId);
      return row ? { ...row } : undefined;
    },
    transition: async (draftId, from, patch) => {
      const row = rows.get(draftId);
      if (!row || !from.includes(row.status)) {
        return undefined;
      }
      const next: MailDraftRecord = {
        ...row,
        status: patch.status,
        updatedAt: patch.updatedAt,
        ...(patch.approvalId === undefined ? {} : { approvalId: patch.approvalId }),
        ...(patch.failureReason === undefined ? {} : { failureReason: patch.failureReason }),
        ...(patch.sentAt === undefined ? {} : { sentAt: patch.sentAt }),
      };
      if (patch.clearFailureReason) delete next.failureReason;
      rows.set(draftId, next);
      return { ...next };
    },
  };
}
