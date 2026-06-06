import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApprovalCreateInput } from "@goatcitadel/contracts";
import { communicationsRoutes } from "./communications.js";

function decorateServices(app: FastifyInstance, services: Record<string, unknown>) {
  app.decorate("services", services as never);
}

describe("communications routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (!app) {
      return;
    }
    await app.close();
    app = null;
  });

  it("returns dashboard summaries without leaking raw connection secrets", async () => {
    app = Fastify();
    decorateServices(app, {
      integrations: {
        listIntegrationConnections: vi.fn(() => [
          {
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
          },
        ]),
      },
      comms: {
        commsGmailRead: vi.fn(async () => ({ messages: [{ id: "msg-1", subject: "Status" }] })),
        commsCalendarList: vi.fn(async () => ({ items: [] })),
      },
    });
    await app.register(communicationsRoutes);

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/communications?workspaceId=workspace-1",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mailAccounts: [
        {
          accountId: "11111111-1111-4111-8111-111111111111",
          connectionId: "11111111-1111-4111-8111-111111111111",
          secretRef: "gmail-primary",
        },
      ],
      messages: [{ messageId: "msg-1", subject: "Status" }],
    });
    expect(response.body).not.toContain("raw-token-that-must-not-leak");
  });

  it("creates drafts and returns approval-required send placeholders", async () => {
    const gmailSend = vi.fn();
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => ({
      approvalId: "22222222-2222-4222-8222-222222222222",
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      payload: input.payload,
      preview: input.preview,
      linkage: input.linkage,
      createdAt: "2026-06-05T12:00:00.000Z",
      explanationStatus: "not_requested",
    }));
    app = Fastify();
    decorateServices(app, {
      integrations: { listIntegrationConnections: vi.fn(() => []) },
      approvals: { createApproval },
      comms: {
        commsGmailRead: vi.fn(async () => ({ messages: [] })),
        commsCalendarList: vi.fn(async () => ({ items: [] })),
        commsGmailSend: gmailSend,
      },
    });
    await app.register(communicationsRoutes);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: {
        accountId: "11111111-1111-4111-8111-111111111111",
        to: ["operator@example.test"],
        subject: "Status",
        bodyText: "Ready.",
      },
    });
    expect(created.statusCode).toBe(201);

    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${created.json().draftId}/send`,
      payload: {},
    });

    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      draftId: created.json().draftId,
      status: "approval_required",
      approvalId: "22222222-2222-4222-8222-222222222222",
    });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "communications.mail.send",
        riskLevel: "danger",
        payload: expect.objectContaining({ action: "mail_send", draftId: created.json().draftId }),
      }),
    );
    expect(gmailSend).not.toHaveBeenCalled();
  });
});
