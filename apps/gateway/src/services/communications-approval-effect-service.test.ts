import { randomUUID } from "node:crypto";
import { NotFoundError, type IntegrationConnection, type ToolInvokeRequest } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commsCalendarCreate, commsGmailSend, commsSmtpSend, type CommsHost } from "./comms-service.js";
import {
  COMMUNICATIONS_IDEMPOTENCY_PREFIX,
  computeCommunicationsPayloadHash,
  readMailSendApprovalInput,
  type CalendarCreateApprovalInput,
  type MailSendApprovalInput,
} from "./communications-approval-payload.js";
import {
  CommunicationsApprovalEffectError,
  CommunicationsApprovalEffectService,
  buildCommunicationsApprovalEffectUpsert,
  runCommunicationsApprovalEffect,
  type CommunicationsApprovalEffectSettlement,
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

/** The connection revision the seeded approvals were requested against. */
const APPROVED_REVISION = "rev-approved";

function createHarness(respond?: (request: ToolInvokeRequest) => Record<string, unknown>) {
  const raw = new Storage({ dbPath: ":memory:", transcriptsDir: ".", auditDir: "." });
  openStorages.push(raw);
  const storage = createSqliteAsyncStorage(raw);
  const invokes: ToolInvokeRequest[] = [];
  /** Current connection revisions; an edit after approval changes one. */
  const revisions: Record<string, string> = {};
  /** Errors the next connection reads reject with, in order; empty reads the fixture. */
  const connectionReadFailures: unknown[] = [];
  /** Workspace bindings per connection; unbound connections serve every workspace. */
  const connectionWorkspaces: Record<string, string> = {};
  const connectionCatalogs: Record<string, string> = {};
  /** Errors the next ledger run reads reject with, in order. */
  const ledgerReadFailures: unknown[] = [];
  const draftSentFailures: unknown[] = [];
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
      const failure = connectionReadFailures.shift();
      if (failure) throw failure;
      if (!known) throw new NotFoundError({ entity: "Integration connection", id: connectionId });
      const revision = revisions[connectionId] ?? APPROVED_REVISION;
      return {
        connectionId,
        revision,
        kind: "automation",
        enabled: true,
        status: "connected",
        config: {},
        ...known,
        catalogId: connectionCatalogs[connectionId] ?? known.catalogId,
        ...(connectionWorkspaces[connectionId] ? { workspaceId: connectionWorkspaces[connectionId] } : {}),
      } as never;
    },
    emitDiscordTyping: vi.fn(),
    emitTelegramTyping: vi.fn(),
    emitChannelActivity: vi.fn(),
    mutationStore: storage.mutationIdempotency,
    sideEffectRunStore: storage.externalSideEffectRuns,
  };
  /** Errors the next approval reads reject with, in order; empty reads storage. */
  const approvalReadFailures: unknown[] = [];
  const service = new CommunicationsApprovalEffectService({
    storage: {
      approvals: {
        get: (approvalId: string) =>
          approvalReadFailures.length
            ? Promise.reject(approvalReadFailures.shift())
            : storage.approvals.get(approvalId),
      } as AsyncStorage["approvals"],
      mailDrafts: {
        transition: async (...args: Parameters<AsyncStorage["mailDrafts"]["transition"]>) => {
          if (args[2].status === "sent" && draftSentFailures.length) throw draftSentFailures.shift();
          return await storage.mailDrafts.transition(...args);
        },
      } as AsyncStorage["mailDrafts"],
      pendingApprovalActions: storage.pendingApprovalActions,
      externalSideEffectRuns: {
        findByIdempotencyKey: (key: string) =>
          ledgerReadFailures.length
            ? Promise.reject(ledgerReadFailures.shift())
            : storage.externalSideEffectRuns.findByIdempotencyKey(key),
        get: (runId: string) =>
          ledgerReadFailures.length
            ? Promise.reject(ledgerReadFailures.shift())
            : storage.externalSideEffectRuns.get(runId),
      } as AsyncStorage["externalSideEffectRuns"],
    },
    getIntegrationConnection: (connectionId) => host.getIntegrationConnection(connectionId),
    commsGmailSend: (input, preApproval) => commsGmailSend(host, input, preApproval),
    commsSmtpSend: (input, preApproval) => commsSmtpSend(host, input, preApproval),
    commsCalendarCreate: (input, preApproval) => commsCalendarCreate(host, input, preApproval),
  });
  return {
    raw,
    storage,
    invokes,
    service,
    revisions,
    approvalReadFailures,
    connectionReadFailures,
    connectionWorkspaces,
    connectionCatalogs,
    ledgerReadFailures,
    draftSentFailures,
  };
}

const approvedLinkage = (actionType: string, connectorId: string) => ({
  actionType,
  connectorId,
  workspaceId: "default",
});

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
    connectionRevision: APPROVED_REVISION,
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
    linkage: approvedLinkage("communications.mail.send", accountId),
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
    connectionRevision: APPROVED_REVISION,
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
    linkage: approvedLinkage("communications.calendar.create", hashed.accountId),
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

describe("completed communications receipt recovery", () => {
  it.each([
    { account: "conn-gmail", drift: "revision" }, { account: "conn-gmail", drift: "removed" },
    { account: "conn-smtp", drift: "revision" }, { account: "conn-smtp", drift: "removed" },
  ])("recovers $account completed delivery after draft settlement fails and connection $drift", async ({ account, drift }) => {
    const f = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(f.storage, account);
    const outage = new Error("draft sent settlement unavailable");
    f.draftSentFailures.push(outage);
    await expect(f.service.executeApprovedMailSend({ approvalId })).rejects.toBe(outage);
    expect(f.invokes).toHaveLength(1);
    expect((await f.storage.externalSideEffectRuns.listByWorkspace("default"))[0]?.status).toBe("completed");
    expect((await f.storage.mailDrafts.get(draftId)).status).toBe("approval_required");
    if (drift === "revision") f.revisions[account] = "rotated-after-delivery";
    else f.connectionReadFailures.push(new NotFoundError({ entity: "Integration connection", id: account }));

    await expect(f.service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ disposition: "sent", replayed: true });

    expect(f.invokes).toHaveLength(1);
    const draft = await f.storage.mailDrafts.get(draftId);
    expect(draft.status).toBe("sent");
    expect(draft.failureReason).toBeUndefined();
  });

  it.each(["revision", "removed"])("settles a completed calendar receipt after effect completion fails and connection %s", async (drift) => {
    const f = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(f.storage);
    const approval = await f.storage.approvals.get(approvalId);
    const effect = await f.storage.approvalEffects.upsert({ ...buildCommunicationsApprovalEffectUpsert(approval, "approve")!,
      status: "running", claimedBy: "receipt-worker", claimedAt: new Date().toISOString(),
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), version: 1 });
    const outage = new Error("effect completion unavailable");
    let failOnce = true;
    const deferred = vi.fn(async (_error: unknown) => undefined);
    const settlement: CommunicationsApprovalEffectSettlement = {
      workerId: "receipt-worker",
      approvalEffects: {
        completeEffect: async (...args: Parameters<AsyncStorage["approvalEffects"]["completeEffect"]>) => {
          if (failOnce) { failOnce = false; throw outage; }
          return await f.storage.approvalEffects.completeEffect(...args);
        },
        failEffect: (...args) => f.storage.approvalEffects.failEffect(...args),
      },
      isEffectStillClaimed: async (id) => (await f.storage.approvalEffects.get(id)).status === "running",
      deferForRetry: deferred,
    };
    const execute = { executeApprovedCommunicationsCalendarCreate: (input: { approvalId: string }) => f.service.executeApprovedCalendarCreate(input) };
    await runCommunicationsApprovalEffect(effect, execute, settlement);
    expect(deferred).toHaveBeenCalledWith(outage);
    expect((await f.storage.approvalEffects.get(effect.effectId)).status).toBe("running");
    expect((await f.storage.externalSideEffectRuns.listByWorkspace("default"))[0]?.status).toBe("completed");
    if (drift === "revision") f.revisions["conn-calendar"] = "rotated-after-create";
    else f.connectionReadFailures.push(new NotFoundError({ entity: "Integration connection", id: "conn-calendar" }));

    await runCommunicationsApprovalEffect(effect, execute, settlement);

    expect(f.invokes).toHaveLength(1);
    expect(await f.storage.approvalEffects.get(effect.effectId)).toMatchObject({ status: "completed", result: { disposition: "created", replayed: true } });
  });

  it.each(["workspace", "account", "operation", "payload", "approval key", "pending request", "unknown", "in progress", "route", "actor scope", "unconfirmed completion", "ambiguity"])("never completes or resends when historical %s evidence differs", async (drift) => {
    const f = createHarness();
    const { approvalId, draftId } = await seedApprovedMailSend(f.storage);
    f.draftSentFailures.push(new Error("sent projection unavailable"));
    await expect(f.service.executeApprovedMailSend({ approvalId })).rejects.toThrow("sent projection unavailable");
    const receipt = (await f.storage.externalSideEffectRuns.listByWorkspace("default"))[0]!;
    if (drift === "workspace") f.raw.db.prepare("UPDATE external_side_effect_runs SET workspace_id = 'foreign' WHERE run_id = ?").run(receipt.runId);
    if (drift === "account") f.raw.db.prepare("UPDATE external_side_effect_runs SET connection_id = 'other-account' WHERE run_id = ?").run(receipt.runId);
    if (drift === "operation") f.raw.db.prepare("UPDATE external_side_effect_runs SET action_id = 'calendar.create_event' WHERE run_id = ?").run(receipt.runId);
    if (drift === "route") f.raw.db.prepare("UPDATE external_side_effect_runs SET route_path = 'unrelated-route' WHERE run_id = ?").run(receipt.runId);
    if (drift === "actor scope") f.raw.db.prepare("UPDATE external_side_effect_runs SET actor_scope = 'unrelated-account' WHERE run_id = ?").run(receipt.runId);
    if (drift === "unconfirmed completion") f.raw.db.prepare("UPDATE external_side_effect_runs SET response_payload_json = ? WHERE run_id = ?")
      .run(JSON.stringify({ workflowRunStatus: "unknown" }), receipt.runId);
    if (drift === "ambiguity") await f.storage.externalSideEffectRuns.createOrGet({ workspaceId: "default", boundary: receipt.boundary,
      routePath: `${receipt.routePath}:other`, catalogId: receipt.catalogId, connectionId: receipt.connectionId, actionId: receipt.actionId,
      actorScope: receipt.actorScope, idempotencyKey: receipt.idempotencyKey, payloadHash: receipt.payloadHash });
    if (drift === "payload") f.raw.db.prepare("UPDATE external_side_effect_runs SET payload_hash = ? WHERE run_id = ?").run("f".repeat(64), receipt.runId);
    if (drift === "approval key") f.raw.db.prepare("UPDATE external_side_effect_runs SET idempotency_key = 'communications:another-approval' WHERE run_id = ?").run(receipt.runId);
    if (drift === "unknown") f.raw.db.prepare("UPDATE external_side_effect_runs SET status = 'unknown_external_outcome' WHERE run_id = ?").run(receipt.runId);
    if (drift === "in progress") f.raw.db.prepare("UPDATE external_side_effect_runs SET status = 'external_call_started' WHERE run_id = ?").run(receipt.runId);
    if (drift === "pending request") {
      const pending = await f.storage.pendingApprovalActions.find(approvalId);
      const request = { ...pending!.request, args: { ...(pending!.request.args as object), subject: "different approved send" } };
      f.raw.db.prepare("UPDATE pending_approval_actions SET request_json = ? WHERE approval_id = ?").run(JSON.stringify(request), approvalId);
    }
    f.revisions["conn-gmail"] = "changed-after-external-boundary";

    await expectEffectError(f.service.executeApprovedMailSend({ approvalId }), "outcome_unknown");

    expect(f.invokes).toHaveLength(1);
    expect((await f.storage.mailDrafts.get(draftId)).status).toBe("outcome_unknown");
  });

  it("recovers the original custom-catalog receipt after the account is removed", async () => {
    const f = createHarness(); f.connectionCatalogs["conn-gmail"] = "custom.gmail";
    const { approvalId } = await seedApprovedMailSend(f.storage);
    f.draftSentFailures.push(new Error("sent projection unavailable"));
    await expect(f.service.executeApprovedMailSend({ approvalId })).rejects.toThrow("sent projection unavailable");
    expect((await f.storage.externalSideEffectRuns.listByWorkspace("default"))[0]?.catalogId).toBe("custom.gmail");
    f.connectionReadFailures.push(new NotFoundError({ entity: "Integration connection", id: "conn-gmail" }));
    await expect(f.service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ disposition: "sent", replayed: true });
    expect(f.invokes).toHaveLength(1);
  });

  it("binds a fresh receipt to the approval workspace and recognizes it after connection drift", async () => {
    const f = createHarness(); const { approvalId } = await seedApprovedMailSend(f.storage);
    f.raw.db.prepare("UPDATE approvals SET linkage_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ ...approvedLinkage("communications.mail.send", "conn-gmail"), workspaceId: "workspace-ops" }), approvalId);
    await f.service.executeApprovedMailSend({ approvalId });
    expect((await f.storage.externalSideEffectRuns.listByWorkspace("workspace-ops"))[0]?.status).toBe("completed");
    expect(await f.storage.externalSideEffectRuns.listByWorkspace("default")).toEqual([]);
    f.revisions["conn-gmail"] = "changed-after-delivery";
    await expect(f.service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ disposition: "sent", replayed: true });
    expect(f.invokes).toHaveLength(1);
  });
  it("does not replay or resend a historical default-workspace receipt for a nondefault approval", async () => {
    const f = createHarness(); const { approvalId, draftId } = await seedApprovedMailSend(f.storage);
    f.raw.db.prepare("UPDATE approvals SET linkage_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ ...approvedLinkage("communications.mail.send", "conn-gmail"), workspaceId: "workspace-ops" }), approvalId);
    f.draftSentFailures.push(new Error("sent projection unavailable"));
    await expect(f.service.executeApprovedMailSend({ approvalId })).rejects.toThrow("sent projection unavailable");
    // Reproduce the historical comms writer's missing workspace binding even
    // after the new writer starts recording the actual approved workspace.
    f.raw.db.prepare("UPDATE external_side_effect_runs SET workspace_id = 'default' WHERE idempotency_key = ?")
      .run(`communications:${approvalId}`);

    await expectEffectError(f.service.executeApprovedMailSend({ approvalId }), "outcome_unknown");

    expect(f.invokes).toHaveLength(1);
    expect((await f.storage.mailDrafts.get(draftId)).status).toBe("outcome_unknown");
  });
});
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

  it("clears a stale failure reason when a failed draft's approved send succeeds", async () => {
    const { storage, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    await storage.mailDrafts.transition(draftId, ["approval_required"], {
      status: "failed",
      failureReason: "Delivery outcome is unknown; check the mailbox before retrying.",
      updatedAt: new Date().toISOString(),
    });

    await expect(service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ disposition: "sent" });

    const draft = await storage.mailDrafts.get(draftId);
    expect(draft.status).toBe("sent");
    expect(draft.failureReason).toBeUndefined();
  });

  it("runs the approved send in the approval's linked workspace", async () => {
    const { raw, storage, invokes, service } = createHarness();
    const { approvalId } = await seedApprovedMailSend(storage);
    raw.db
      .prepare("UPDATE approvals SET linkage_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ actionType: "communications.mail.send", workspaceId: "workspace-ops" }), approvalId);

    await service.executeApprovedMailSend({ approvalId });

    expect(invokes[0]).toMatchObject({ toolName: "gmail.send", workspaceId: "workspace-ops" });
    const pending = await storage.pendingApprovalActions.find(approvalId);
    expect(pending?.request).toMatchObject({ workspaceId: "workspace-ops" });
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
    // The provider may have delivered, so the draft is never reported as failed (not sent).
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({
      status: "outcome_unknown",
      failureReason: "Delivery outcome is unknown; check the mailbox before retrying.",
    });
  });

  it("keeps an outcome_unknown draft unknown on a ledger replay and never promotes it to sent", async () => {
    let calls = 0;
    const { storage, invokes, service } = createHarness(() => {
      calls += 1;
      return calls === 1
        ? { status: "failed", deliveryStatus: "manual_reconciliation_required" }
        : { status: "sent", deliveryStatus: "sent", providerMessageId: "provider-message-2" };
    });
    const { draftId, approvalId } = await seedApprovedMailSend(storage);

    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "outcome_unknown");
    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "outcome_unknown");

    expect(invokes).toHaveLength(1);
    const draft = await storage.mailDrafts.get(draftId);
    expect(draft.status).toBe("outcome_unknown");
    expect(draft.sentAt).toBeUndefined();
  });

  it("maps a deleted mail account to provider_unavailable and fails the draft", async () => {
    const { storage, invokes, service, connectionReadFailures } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    connectionReadFailures.push(new NotFoundError({ entity: "Integration connection", id: "conn-gmail" }));

    const error = await expectEffectError(service.executeApprovedMailSend({ approvalId }), "provider_unavailable");

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "failed", failureReason: error.message });
  });

  it("rethrows a transient connection read failure so the effect retries", async () => {
    const { storage, invokes, service, connectionReadFailures } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    const outage = new Error("database is locked");
    connectionReadFailures.push(outage);

    await expect(service.executeApprovedMailSend({ approvalId })).rejects.toBe(outage);

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "approval_required" });
    // The retry reads the connection again and sends exactly once.
    await expect(service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ disposition: "sent" });
    expect(invokes).toHaveLength(1);
  });

  it("rethrows a transient ledger read on replay so a delivered send is never settled unknown", async () => {
    const { storage, invokes, service, ledgerReadFailures } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    await service.executeApprovedMailSend({ approvalId });
    const outage = new Error("database is locked");
    ledgerReadFailures.push(outage);

    await expect(service.executeApprovedMailSend({ approvalId })).rejects.toBe(outage);

    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "sent" });
    await expect(service.executeApprovedMailSend({ approvalId })).resolves.toMatchObject({ replayed: true });
    expect(invokes).toHaveLength(1);
  });

  it("refuses a mail account bound to another workspace and sends from one bound to the approval's", async () => {
    const { storage, invokes, service, connectionWorkspaces } = createHarness();
    const foreign = await seedApprovedMailSend(storage);
    connectionWorkspaces["conn-gmail"] = "workspace-other";

    const error = await expectEffectError(
      service.executeApprovedMailSend({ approvalId: foreign.approvalId }),
      "invalid_payload",
    );

    expect(error.message).toBe(
      "The mail account belongs to a different workspace than this approval; nothing was sent.",
    );
    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(foreign.draftId)).toMatchObject({
      status: "failed",
      failureReason: error.message,
    });

    connectionWorkspaces["conn-gmail"] = "default";
    const bound = await seedApprovedMailSend(storage);
    await expect(service.executeApprovedMailSend({ approvalId: bound.approvalId })).resolves.toMatchObject({
      disposition: "sent",
    });
    expect(invokes).toHaveLength(1);
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

  it("keeps a proven pre-boundary failure with a retained marker behind the settled pending-action guard", async () => {
    const f = createHarness(() => ({ status: "failed", deliveryStatus: "blocked", error: "Gmail token missing" }));
    const { approvalId, draftId } = await seedApprovedMailSend(f.storage);
    await expectEffectError(f.service.executeApprovedMailSend({ approvalId }), "delivery_failed");
    const receipt = (await f.storage.externalSideEffectRuns.listByWorkspace("default"))[0]!;
    expect(receipt.status).toBe("failed_before_boundary");
    // The real preapproved comms path conservatively marks before invocation;
    // its explicit non-dispatch proof settles status without deleting that marker.
    expect(receipt.externalCallStartedAt).toEqual(expect.any(String));
    expect((await f.storage.pendingApprovalActions.find(approvalId))?.resolutionStatus).toBe("executed");
    expect((await f.storage.mailDrafts.get(draftId)).status).toBe("failed");

    await expectEffectError(f.service.executeApprovedMailSend({ approvalId }), "approval_not_approved");

    expect(f.invokes).toHaveLength(1);
    expect((await f.storage.mailDrafts.get(draftId)).status).toBe("failed");
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

  it("refuses a send whose mail account changed after approval and fails the draft", async () => {
    const { storage, invokes, service, revisions } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage, "conn-smtp");
    revisions["conn-smtp"] = "rev-edited";

    const error = await expectEffectError(service.executeApprovedMailSend({ approvalId }), "connection_changed");

    expect(error.message).toBe("The mail account changed after approval; nothing was sent. Request approval again.");
    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "failed", failureReason: error.message });
  });

  it("refuses an approval that recorded no connection revision as a changed connection", async () => {
    const { raw, storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    const approval = await storage.approvals.get(approvalId);
    const legacy: Record<string, unknown> = { ...approval.payload };
    delete legacy.connectionRevision;
    const legacyHashed = readMailSendApprovalInput(legacy)!;
    raw.db
      .prepare("UPDATE approvals SET payload_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ ...legacy, payloadHash: computeCommunicationsPayloadHash(legacyHashed) }), approvalId);

    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "connection_changed");

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "failed" });
  });

  it("refuses an approval without workspace linkage and fails the draft", async () => {
    const { raw, storage, invokes, service } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    raw.db
      .prepare("UPDATE approvals SET linkage_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ actionType: "communications.mail.send" }), approvalId);

    await expectEffectError(service.executeApprovedMailSend({ approvalId }), "invalid_payload");

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({
      status: "failed",
      failureReason: "The mail send approval names no workspace; nothing was sent.",
    });
  });

  it("rethrows a transient approval read failure so the effect retries", async () => {
    const { storage, invokes, service, approvalReadFailures } = createHarness();
    const { draftId, approvalId } = await seedApprovedMailSend(storage);
    const outage = new Error("database is locked");
    approvalReadFailures.push(outage);

    await expect(service.executeApprovedMailSend({ approvalId })).rejects.toBe(outage);

    expect(invokes).toHaveLength(0);
    expect(await storage.mailDrafts.get(draftId)).toMatchObject({ status: "approval_required" });
  });

  it("maps only a missing approval to approval_not_approved", async () => {
    const { service, approvalReadFailures } = createHarness();
    approvalReadFailures.push(new NotFoundError({ entity: "Approval", id: "approval-missing" }));

    await expectEffectError(
      service.executeApprovedMailSend({ approvalId: "approval-missing" }),
      "approval_not_approved",
    );
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

  it("refuses a create whose calendar account changed after approval", async () => {
    const { storage, invokes, service, revisions } = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(storage);
    revisions["conn-calendar"] = "rev-edited";

    const error = await expectEffectError(service.executeApprovedCalendarCreate({ approvalId }), "connection_changed");

    expect(error.message).toBe(
      "The calendar account changed after approval; nothing was created. Request approval again.",
    );
    expect(invokes).toHaveLength(0);
  });

  it("refuses a calendar account bound to another workspace", async () => {
    const { storage, invokes, service, connectionWorkspaces } = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(storage);
    connectionWorkspaces["conn-calendar"] = "workspace-other";

    const error = await expectEffectError(service.executeApprovedCalendarCreate({ approvalId }), "invalid_payload");

    expect(error.message).toBe(
      "The calendar account belongs to a different workspace than this approval; nothing was created.",
    );
    expect(invokes).toHaveLength(0);
  });

  it("refuses a calendar approval without workspace linkage", async () => {
    const { raw, storage, invokes, service } = createHarness();
    const { approvalId } = await seedApprovedCalendarCreate(storage);
    raw.db
      .prepare("UPDATE approvals SET linkage_json = ? WHERE approval_id = ?")
      .run(JSON.stringify({ actionType: "communications.calendar.create" }), approvalId);

    await expectEffectError(service.executeApprovedCalendarCreate({ approvalId }), "invalid_payload");
    expect(invokes).toHaveLength(0);
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
