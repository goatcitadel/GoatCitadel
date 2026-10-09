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

  it("carries a bounded draft workspace into the send approval linkage", async () => {
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
      integrations: {
        listIntegrationConnections: vi.fn(() => [
          {
            connectionId: "11111111-1111-4111-8111-111111111111",
            catalogId: "automation.gmail",
            kind: "automation",
            key: "gmail",
            label: "Bound mail",
            enabled: true,
            status: "connected",
            workspaceId: "workspace-mail",
            config: { address: "operator@example.test" },
            createdAt: "2026-06-01T00:00:00.000Z",
            updatedAt: "2026-06-02T00:00:00.000Z",
          },
        ]),
      },
      approvals: { createApproval },
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    const draft = {
      accountId: "11111111-1111-4111-8111-111111111111",
      to: ["operator@example.test"],
      subject: "Status",
      bodyText: "Ready.",
    };

    for (const workspaceId of ["", " ", "w".repeat(257)]) {
      const rejected = await app.inject({
        method: "POST",
        url: "/api/v1/mail/drafts",
        payload: { ...draft, workspaceId },
      });
      expect(rejected.statusCode).toBe(400);
    }
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { ...draft, workspaceId: "workspace-mail" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ workspaceId: "workspace-mail", status: "draft" });

    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${created.json().draftId}/send`,
      payload: {},
    });

    expect(sent.json()).toMatchObject({ status: "approval_required", workspaceId: "workspace-mail" });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        linkage: {
          actionType: "communications.mail.send",
          connectorId: draft.accountId,
          workspaceId: "workspace-mail",
        },
      }),
    );
  });

  it("refuses a workspace draft for a mail account bound to another workspace", async () => {
    const connection = (connectionId: string, workspaceId?: string) => ({
      connectionId,
      catalogId: "automation.gmail",
      kind: "automation",
      key: "gmail",
      label: connectionId,
      enabled: true,
      status: "connected",
      ...(workspaceId ? { workspaceId } : {}),
      config: { address: `${connectionId}@example.test` },
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    const createApproval = vi.fn();
    app = Fastify();
    decorateServices(app, {
      integrations: {
        listIntegrationConnections: vi.fn(() => [
          connection("acct-foreign", "workspace-other"),
          connection("acct-unbound"),
        ]),
      },
      approvals: { createApproval },
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    const draft = {
      to: ["operator@example.test"],
      subject: "Status",
      bodyText: "Ready.",
      workspaceId: "workspace-mail",
    };

    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { ...draft, accountId: "acct-foreign" },
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain("draftId");
    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { ...draft, accountId: "acct-unbound" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(createApproval).not.toHaveBeenCalled();
  });

  it("uses a disabled uncredentialed fixture only in dev verification without provider calls", async () => {
    const commsGmailRead = vi.fn(async () => ({ messages: [{ id: "real-message" }] }));
    const commsCalendarList = vi.fn(async () => ({ items: [{ id: "real-event" }] }));
    const connection = {
      connectionId: "33333333-3333-4333-8333-333333333333",
      catalogId: "automation.gmail",
      kind: "automation",
      key: "gmail",
      label: "Verification uncredentialed communications",
      enabled: false,
      status: "disconnected",
      config: {
        address: "verification-inbox@example.invalid",
        verificationCommunicationsFixture: {
          schemaVersion: 1,
          mode: "uncredentialed-read-only",
          messages: [
            {
              id: "fixture-message-1",
              from: "fixture-sender@example.invalid",
              to: ["verification-inbox@example.invalid"],
              subject: "Fixture inbox readiness",
              snippet: "Deterministic inbox content; no provider credential was configured.",
              receivedAt: "2026-07-29T15:00:00.000Z",
            },
          ],
          events: [
            {
              id: "fixture-event-1",
              title: "Fixture usability agenda",
              description: "Deterministic calendar content from the isolated verification fixture.",
              startIso: "2026-07-30T16:00:00.000Z",
              endIso: "2026-07-30T16:30:00.000Z",
              attendees: ["verification-inbox@example.invalid"],
            },
          ],
        },
      },
      createdAt: "2026-07-29T14:00:00.000Z",
      updatedAt: "2026-07-29T14:00:00.000Z",
    };
    app = Fastify();
    decorateServices(app, {
      integrations: { listIntegrationConnections: vi.fn(() => [connection]) },
      approvals: { createApproval: vi.fn() },
      comms: { commsGmailRead, commsCalendarList },
      devVerification: { isDevDiagnosticsEnabled: () => true },
    });
    await app.register(communicationsRoutes);

    const response = await app.inject({ method: "GET", url: "/api/v1/communications?workspaceId=workspace-1" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      mailAccounts: [
        {
          accountId: connection.connectionId,
          address: "verification-inbox@example.invalid",
          syncStatus: "not_configured",
        },
      ],
      messages: [
        {
          messageId: "fixture-message-1",
          subject: "Fixture inbox readiness",
          from: "fixture-sender@example.invalid",
        },
      ],
      events: [
        {
          eventId: "fixture-event-1",
          title: "Fixture usability agenda",
          startIso: "2026-07-30T16:00:00.000Z",
        },
      ],
    });
    expect(commsGmailRead).not.toHaveBeenCalled();
    expect(commsCalendarList).not.toHaveBeenCalled();
    expect(JSON.stringify(connection.config)).not.toMatch(/token|secret|password|apiKey/u);

    await app.close();
    app = null;
    commsGmailRead.mockClear();
    commsCalendarList.mockClear();
    app = Fastify();
    decorateServices(app, {
      integrations: { listIntegrationConnections: vi.fn(() => [connection]) },
      approvals: { createApproval: vi.fn() },
      comms: { commsGmailRead, commsCalendarList },
      devVerification: { isDevDiagnosticsEnabled: () => false },
    });
    await app.register(communicationsRoutes);

    const disabledResponse = await app.inject({
      method: "GET",
      url: "/api/v1/communications?workspaceId=workspace-1",
    });

    expect(disabledResponse.statusCode).toBe(200);
    expect(commsGmailRead).toHaveBeenCalledWith(expect.objectContaining({ connectionId: connection.connectionId }));
    expect(commsCalendarList).toHaveBeenCalledWith(expect.objectContaining({ connectionId: connection.connectionId }));
    expect(disabledResponse.body).not.toContain("Fixture inbox readiness");
    expect(disabledResponse.body).not.toContain("Fixture usability agenda");
  });
});
