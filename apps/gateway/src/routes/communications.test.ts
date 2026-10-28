import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ApprovalCreateInput, MailDraftRecord } from "@goatcitadel/contracts";
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
              clientSecretEnv: "GMAIL_CLIENT_SECRET",
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
          secretRef: "GMAIL_CLIENT_SECRET",
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
      integrations: {
        listIntegrationConnections: vi.fn(() => [mailConnection("11111111-1111-4111-8111-111111111111")]),
      },
      approvals: { createApproval },
      mailDrafts: createMailDraftStore(),
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
      payload: { workspaceId: "default" },
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
      mailDrafts: createMailDraftStore(),
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
      payload: { workspaceId: "workspace-mail" },
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
      mailDrafts: createMailDraftStore(),
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

  it("reads a persisted draft back and answers 404 for an unknown draft", async () => {
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
      integrations: { listIntegrationConnections: vi.fn(() => [mailConnection("acct-a")]) },
      approvals: { createApproval },
      mailDrafts: createMailDraftStore(),
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { accountId: "acct-a", to: ["operator@example.test"], subject: "Status", bodyText: "Ready." },
    });
    const draftId = created.json().draftId as string;
    await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${draftId}/send`,
      payload: { workspaceId: "default" },
    });

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/mail/drafts/${encodeURIComponent(draftId)}?workspaceId=default`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      draftId,
      status: "approval_required",
      approvalId: "22222222-2222-4222-8222-222222222222",
    });

    const missing = await app.inject({
      method: "GET",
      url: "/api/v1/mail/drafts/mail_draft_missing?workspaceId=default",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "Mail draft not found." });
  });

  it("scopes draft reads and sends to the draft's workspace", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => ({
      approvalId: "33333333-3333-4333-8333-333333333333",
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
      integrations: { listIntegrationConnections: vi.fn(() => [mailConnection("acct-a")]) },
      approvals: { createApproval },
      mailDrafts: createMailDraftStore(),
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { accountId: "acct-a", to: ["operator@example.test"], subject: "Secret plan", bodyText: "Private." },
    });
    const draftId = encodeURIComponent(created.json().draftId as string);

    const unscoped = await app.inject({ method: "GET", url: `/api/v1/mail/drafts/${draftId}` });
    expect(unscoped.statusCode).toBe(400);
    expect(unscoped.body).not.toContain("Secret plan");
    const other = await app.inject({ method: "GET", url: `/api/v1/mail/drafts/${draftId}?workspaceId=workspace-2` });
    expect(other.statusCode).toBe(404);
    expect(other.json()).toEqual({ error: "Mail draft not found." });

    const sendQuery = await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${draftId}/send?workspaceId=workspace-2`,
      payload: {},
    });
    const sendBody = await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${draftId}/send`,
      payload: { workspaceId: "workspace-2" },
    });
    for (const response of [sendQuery, sendBody]) {
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Mail draft not found." });
    }
    const sendUnscoped = await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${draftId}/send`,
      payload: {},
    });
    expect(sendUnscoped.statusCode).toBe(400);
    expect(createApproval).not.toHaveBeenCalled();

    const sent = await app.inject({
      method: "POST",
      url: `/api/v1/mail/drafts/${draftId}/send`,
      payload: { workspaceId: "default" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: "approval_required", workspaceId: "default" });
  });

  it("answers 503 for draft routes when mail draft storage is not composed", async () => {
    app = Fastify();
    decorateServices(app, {
      integrations: { listIntegrationConnections: vi.fn(() => [mailConnection("acct-a")]) },
      approvals: { createApproval: vi.fn() },
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { accountId: "acct-a", to: ["operator@example.test"], subject: "Status", bodyText: "Ready." },
    });
    const read = await app.inject({ method: "GET", url: "/api/v1/mail/drafts/mail_draft_x?workspaceId=default" });
    const sent = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts/mail_draft_x/send",
      payload: { workspaceId: "default" },
    });
    const released = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts/mail_draft_x/release",
      payload: { workspaceId: "default" },
    });

    for (const response of [created, read, sent, released]) {
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "Mail draft storage is unavailable." });
    }
  });

  it("binds a draft or event without a workspace only to an account the default workspace can see", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => ({
      approvalId: "44444444-4444-4444-8444-444444444444",
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      payload: input.payload,
      preview: input.preview,
      linkage: input.linkage,
      createdAt: "2026-06-05T12:00:00.000Z",
      explanationStatus: "not_requested",
    }));
    const calendar = (connectionId: string, workspaceId?: string) => ({
      ...mailConnection(connectionId, workspaceId),
      catalogId: "automation.google-calendar",
      key: "google-calendar",
    });
    app = Fastify();
    decorateServices(app, {
      integrations: {
        listIntegrationConnections: vi.fn(() => [
          mailConnection("mail-foreign", "workspace-other"),
          mailConnection("mail-unbound"),
          calendar("cal-foreign", "workspace-other"),
          calendar("cal-unbound"),
        ]),
      },
      approvals: { createApproval },
      mailDrafts: createMailDraftStore(),
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    const draft = { to: ["operator@example.test"], subject: "Status", bodyText: "Ready." };
    const event = { title: "Planning", startIso: "2026-06-06T10:00:00.000Z", endIso: "2026-06-06T10:30:00.000Z" };

    const foreignDraft = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { ...draft, accountId: "mail-foreign" },
    });
    const foreignEvent = await app.inject({
      method: "POST",
      url: "/api/v1/calendar/events",
      payload: { ...event, accountId: "cal-foreign" },
    });
    for (const refused of [foreignDraft, foreignEvent]) {
      expect(refused.statusCode).toBe(404);
      expect(refused.body).not.toContain("draftId");
    }
    expect(createApproval).not.toHaveBeenCalled();

    const unboundDraft = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts",
      payload: { ...draft, accountId: "mail-unbound" },
    });
    expect(unboundDraft.statusCode).toBe(201);
    expect(unboundDraft.json()).toMatchObject({ workspaceId: "default" });
    const unboundEvent = await app.inject({
      method: "POST",
      url: "/api/v1/calendar/events",
      payload: { ...event, accountId: "cal-unbound" },
    });
    expect(unboundEvent.statusCode).toBe(202);
    expect(createApproval.mock.calls[0]![0].linkage).toMatchObject({ workspaceId: "default" });
  });

  it("releases an interrupted draft only in its own workspace and only after checking for an approval", async () => {
    const mailDrafts = createMailDraftStore();
    const findMailSendApprovals = vi.fn(async () => []);
    const recordAudit = vi.fn(async () => undefined);
    app = Fastify();
    decorateServices(app, {
      integrations: { listIntegrationConnections: vi.fn(() => [mailConnection("acct-a")]) },
      approvals: { createApproval: vi.fn() },
      mailDrafts,
      mailDraftRecovery: { findMailSendApprovals, recordAudit },
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    await mailDrafts.create({
      draftId: "mail_draft_stuck",
      workspaceId: "default",
      accountId: "acct-a",
      to: ["operator@example.test"],
      cc: [],
      bcc: [],
      subject: "Stuck subject",
      bodyText: "Stuck body.",
      status: "approval_required",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const unscoped = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts/mail_draft_stuck/release",
      payload: {},
    });
    const foreign = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts/mail_draft_stuck/release",
      payload: { workspaceId: "workspace-2" },
    });
    expect(unscoped.statusCode).toBe(400);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain("Stuck subject");
    expect(findMailSendApprovals).not.toHaveBeenCalled();

    const released = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts/mail_draft_stuck/release",
      payload: { workspaceId: "default" },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({
      outcome: "released",
      draft: { draftId: "mail_draft_stuck", status: "draft" },
    });
    expect(findMailSendApprovals).toHaveBeenCalledExactlyOnceWith("mail_draft_stuck");
    expect(recordAudit).toHaveBeenCalledOnce();
  });

  it("answers 503 for a release when the approval lookup is not composed", async () => {
    const mailDrafts = createMailDraftStore();
    app = Fastify();
    decorateServices(app, {
      integrations: { listIntegrationConnections: vi.fn(() => []) },
      approvals: { createApproval: vi.fn() },
      mailDrafts,
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    await mailDrafts.create({
      draftId: "mail_draft_stuck",
      workspaceId: "default",
      accountId: "acct-a",
      to: ["operator@example.test"],
      cc: [],
      bcc: [],
      subject: "Stuck",
      bodyText: "Stuck.",
      status: "approval_required",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const released = await app.inject({
      method: "POST",
      url: "/api/v1/mail/drafts/mail_draft_stuck/release",
      payload: { workspaceId: "default" },
    });

    expect(released.statusCode).toBe(503);
    expect((await mailDrafts.find("mail_draft_stuck"))?.status).toBe("approval_required");
  });

  it("binds a calendar approval to a workspace that can see the calendar account", async () => {
    const createApproval = vi.fn(async (input: ApprovalCreateInput) => ({
      approvalId: "33333333-3333-4333-8333-333333333333",
      kind: input.kind,
      riskLevel: input.riskLevel,
      status: "pending",
      payload: input.payload,
      preview: input.preview,
      linkage: input.linkage,
      createdAt: "2026-06-05T12:00:00.000Z",
      explanationStatus: "not_requested",
    }));
    const connection = (connectionId: string, workspaceId?: string) => ({
      connectionId,
      catalogId: "automation.google-calendar",
      kind: "automation",
      key: "google-calendar",
      label: connectionId,
      enabled: true,
      status: "connected",
      ...(workspaceId ? { workspaceId } : {}),
      config: {},
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-02T00:00:00.000Z",
    });
    app = Fastify();
    decorateServices(app, {
      integrations: {
        listIntegrationConnections: vi.fn(() => [
          connection("cal-own", "workspace-cal"),
          connection("cal-foreign", "other"),
        ]),
      },
      approvals: { createApproval },
      comms: { commsGmailRead: vi.fn(), commsCalendarList: vi.fn() },
    });
    await app.register(communicationsRoutes);
    const event = {
      workspaceId: "workspace-cal",
      title: "Planning",
      startIso: "2026-06-06T10:00:00.000Z",
      endIso: "2026-06-06T10:30:00.000Z",
    };

    const refused = await app.inject({
      method: "POST",
      url: "/api/v1/calendar/events",
      payload: { ...event, accountId: "cal-foreign" },
    });
    expect(refused.statusCode).toBe(404);
    expect(createApproval).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/calendar/events",
      payload: { ...event, accountId: "cal-own" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({ approvalId: "33333333-3333-4333-8333-333333333333" });
    expect(createApproval.mock.calls[0]![0].linkage).toEqual({
      actionType: "communications.calendar.create",
      connectorId: "cal-own",
      workspaceId: "workspace-cal",
    });
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
    // The Communications page reads are the operator's own, so they pass the own-delivery option.
    const own = { ownDelivery: true };
    expect(commsGmailRead).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: connection.connectionId }),
      own,
    );
    expect(commsCalendarList).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: connection.connectionId }),
      own,
    );
    expect(disabledResponse.body).not.toContain("Fixture inbox readiness");
    expect(disabledResponse.body).not.toContain("Fixture usability agenda");
  });
});

/** An enabled Gmail connection; unbound unless a workspace is named. */
function mailConnection(connectionId: string, workspaceId?: string) {
  return {
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
  };
}

/** In-memory stand-in for `storage.mailDrafts`: duplicate create throws, transition is compare-and-set. */
function createMailDraftStore() {
  const rows = new Map<string, MailDraftRecord>();
  return {
    create: async (record: MailDraftRecord) => {
      if (rows.has(record.draftId)) {
        throw new Error(`duplicate mail draft ${record.draftId}`);
      }
      rows.set(record.draftId, { ...record });
      return { ...record };
    },
    find: async (draftId: string) => {
      const row = rows.get(draftId);
      return row ? { ...row } : undefined;
    },
    transition: async (
      draftId: string,
      from: readonly MailDraftRecord["status"][],
      patch: Partial<MailDraftRecord> &
        Pick<MailDraftRecord, "status" | "updatedAt"> & { clearFailureReason?: boolean },
    ) => {
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
      };
      if (patch.clearFailureReason) delete next.failureReason;
      rows.set(draftId, next);
      return { ...next };
    },
  };
}
