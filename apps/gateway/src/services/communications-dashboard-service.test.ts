import { describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, IntegrationConnection } from "@goatcitadel/contracts";
import { createCommunicationsDashboardService } from "./communications-dashboard-service.js";

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
    });
    const draft = service.createDraft({
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
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval });
    const draft = service.createDraft({
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

  it("keeps the exact unscoped send linkage for drafts without a workspace", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval });
    const draft = service.createDraft({
      accountId: "acct-unscoped",
      to: ["operator@example.test"],
      subject: "Unscoped",
      bodyText: "Classic path.",
    });
    await service.sendDraft(draft.draftId);
    expect(createApproval.mock.calls[0]![0].linkage).toEqual({
      actionType: "communications.mail.send",
      connectorId: "acct-unscoped",
    });
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
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval });
    const draft = service.createDraft({
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
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval });
    const draft = service.createDraft({
      workspaceId: "workspace-mail",
      accountId: "acct-a",
      to: ["operator@example.test"],
      subject: "Uncertain",
      bodyText: "Do not repeat.",
    });
    await expect(service.sendDraft(draft.draftId)).rejects.toThrow("storage write outcome unknown");
    const replay = await service.sendDraft(draft.draftId);
    expect(replay).toMatchObject({ draftId: draft.draftId, status: "failed" });
    expect(replay.approvalId).toBeUndefined();
    expect(createApproval).toHaveBeenCalledOnce();
  });

  it("never requests an approval for a draft the Gateway does not hold, even when sent twice", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => createApprovalRecord(input));
    const service = createCommunicationsDashboardService({ now: () => new Date(NOW), createApproval });
    expect(await service.sendDraft("mail_draft_missing")).toMatchObject({ status: "failed" });
    expect(await service.sendDraft("mail_draft_missing")).toMatchObject({ status: "failed" });
    expect(createApproval).not.toHaveBeenCalled();
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
