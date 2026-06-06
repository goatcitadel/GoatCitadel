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
