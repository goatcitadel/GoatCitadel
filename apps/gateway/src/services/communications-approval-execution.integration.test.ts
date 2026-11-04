import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "../config.js";
import { CommunicationsDashboardService } from "./communications-dashboard-service.js";
import { GatewayService } from "./gateway-service.js";

/**
 * WS2 end to end: an approved `communications.mail.send` approval runs through the real
 * Gateway tool path (coordinator normalization, real PolicyEngine approval bypass, real
 * comms executor). Only the Gmail HTTP boundary (global fetch) is stubbed.
 */
const ENV_KEYS = [
  "NODE_ENV",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
  "GOATCITADEL_WS2_TEST_GMAIL_TOKEN",
] as const;
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let gateway: GatewayService | undefined;

describe("communications approval execution through the real Gateway tool path", { timeout: 120_000 }, () => {
  afterEach(async () => {
    vi.unstubAllGlobals();
    await gateway?.close().catch(() => undefined);
    gateway = undefined;
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  async function startGatewayWithGmail(scopedPostgresUrl?: string) {
    const root = createIsolatedConfigRoot();
    process.env.NODE_ENV = "test";
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
    process.env.GOATCITADEL_ROOT_DIR = root;
    process.env.GOATCITADEL_WS2_TEST_GMAIL_TOKEN = "ws2-test-gmail-token";
    const gmailCalls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === GMAIL_SEND_URL) {
        gmailCalls.push(String(init?.body ?? ""));
        return new Response(JSON.stringify({ id: "gmail-provider-message-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    });

    const config = await loadGatewayConfig(root);
    if (scopedPostgresUrl) {
      const url = new URL(scopedPostgresUrl);
      if (url.hostname !== "127.0.0.1" || !/^-csearch_path=mail_fence_(fresh|upgrade)_[a-f0-9]{32}$/u.test(url.searchParams.get("options") ?? "")) {
        throw new Error("Mail approval PostgreSQL proof requires a disposable scoped loopback database.");
      }
      const database = config.assistant.database;
      database.driver = "postgres";
      database.postgres.mode = "managed";
      database.postgres.asyncGatewayEnabled = true;
      database.postgres.connectionString = scopedPostgresUrl;
      database.postgres.database = url.pathname.slice(1);
    }
    gateway = new GatewayService(config);
    await gateway.initCritical();
    const connection = await gateway.routeServices.integrations.createIntegrationConnection({
      catalogId: "automation.gmail",
      label: "WS2 Gmail integration test",
      enabled: true,
      status: "connected",
      config: { clientId: "1234567890-ws2.apps.googleusercontent.com", gmailSend: true },
    });
    // The OS keychain is not used in tests: stand in for the stored Google sign-in, keeping the real tool path.
    vi.spyOn(gateway.googleWorkspaceOAuth, "resolveAccessToken").mockResolvedValue("ws2-test-gmail-token");
    const live = gateway;
    const dashboard = new CommunicationsDashboardService({
      createApproval: (input, onCreated) => live.createApproval(input, onCreated),
      listIntegrationConnections: (kind, limit) =>
        live.routeServices.integrations.listIntegrationConnections(kind, limit),
      mailDrafts: live.storage.mailDrafts,
    });
    return { live, connection, dashboard, gmailCalls };
  }

  it("cannot persist a late original approval after a later mail-draft fence wins", async () => {
    const postgres = process.env.GOATCITADEL_TEST_MAIL_APPROVAL_POSTGRES_URL;
    const { live, connection, gmailCalls } = await startGatewayWithGmail(postgres);
    expect(live.storage.gatewaySql.dialect).toBe(postgres ? "postgres" : "sqlite");
    const outbound = vi.fn(async () => { throw new Error("Network is forbidden in the stale mail fence case."); });
    vi.stubGlobal("fetch", outbound);
    let oldSenderReachedCreate!: () => void;
    const atCreate = new Promise<void>((resolve) => { oldSenderReachedCreate = resolve; });
    let resumeOldSender!: () => void;
    const resume = new Promise<void>((resolve) => { resumeOldSender = resolve; });
    const oldNow = new Date("2026-06-05T12:00:00.000Z");
    const newerNow = new Date(oldNow.getTime() + 11 * 60 * 1000);
    const approvals = live.routeServices.approvals;
    const createCanonical = (...args: Parameters<typeof approvals.createApproval>) => approvals.createApproval(...args);
    const findMailSendApprovals = (draftId: string) =>
      live.storage.approvals.listByKindAndPayloadString("communications.mail.send", "draftId", draftId);
    const recovery = { findMailSendApprovals, recordAudit: vi.fn(async (_event: Record<string, unknown>) => {}) };
    // Separate request owners model processes with independent in-flight maps. The real approval
    // owner and repos remain unchanged, and the stall occurs before its transaction begins.
    const senderA = new CommunicationsDashboardService({
      now: () => oldNow,
      mailDrafts: live.storage.mailDrafts,
      createApproval: async (...args: Parameters<typeof approvals.createApproval>) => {
        oldSenderReachedCreate();
        await resume;
        return createCanonical(...args);
      },
    });
    const senderB = new CommunicationsDashboardService({
      now: () => newerNow,
      mailDrafts: live.storage.mailDrafts,
      createApproval: createCanonical,
    });
    const draft = await senderA.createDraft({
      workspaceId: "default", accountId: connection.connectionId,
      to: ["review@example.test"], subject: "Synthetic delayed approval", bodyText: "Never resolve this approval.",
    });
    const first = senderA.sendDraft(draft.draftId);
    // A broken or early-returning setup must not hang the proof.
    void first.catch(() => undefined);
    try {
      await Promise.race([atCreate, first.then(() => { throw new Error("Sender A did not reach the create barrier."); })]);
      const originalFence = await live.storage.mailDrafts.get(draft.draftId);
      expect(originalFence.status).toBe("approval_required");
      expect(originalFence.approvalId).toBeUndefined();
      expect(await findMailSendApprovals(draft.draftId)).toHaveLength(0);

      expect((await senderB.releaseInterruptedDraft(draft.draftId, recovery)).outcome).toBe("released");
      const current = await senderB.sendDraft(draft.draftId);
      expect(current.status).toBe("approval_required");
      expect(current.approvalId).toEqual(expect.any(String));
      expect((await findMailSendApprovals(draft.draftId)).map((item) => item.approvalId)).toEqual([current.approvalId]);

      resumeOldSender();
      await first;
      expect(await live.storage.mailDrafts.get(draft.draftId)).toEqual(current);
      expect((await findMailSendApprovals(draft.draftId)).map((item) => ({
        approvalId: item.approvalId, status: item.status,
      }))).toEqual([{ approvalId: current.approvalId, status: "pending" }]);
      expect(recovery.recordAudit).toHaveBeenCalledOnce();
      expect(outbound).not.toHaveBeenCalled();
      expect(gmailCalls).toHaveLength(0);
    } finally {
      resumeOldSender();
      await first.catch(() => undefined);
    }
  });

  it("sends an approved mail draft exactly once without minting a second approval", async () => {
    const { live, connection, dashboard, gmailCalls } = await startGatewayWithGmail();
    const draft = await dashboard.createDraft({
      workspaceId: "default",
      accountId: connection.connectionId,
      to: ["recipient@example.com"],
      subject: "WS2 approved send",
      bodyText: "Sent exactly once after approval.",
    });
    const requested = await dashboard.sendDraft(draft.draftId);
    expect(requested.status).toBe("approval_required");
    const approvalId = requested.approvalId!;
    expect(approvalId).toEqual(expect.any(String));

    await live.resolveApproval(approvalId, { decision: "approve", resolvedBy: "operator" });

    const settled = await pollFor(
      async () => await live.storage.mailDrafts.find(draft.draftId),
      (candidate) => candidate?.status === "sent" || candidate?.status === "failed",
      "the approved draft to settle",
    );
    const approvals = await live.storage.approvals.list(undefined, 100);
    const pendingAction = await live.storage.pendingApprovalActions.find(approvalId);

    expect(
      approvals.map((approval) => ({ approvalId: approval.approvalId, kind: approval.kind, status: approval.status })),
    ).toEqual([{ approvalId, kind: "communications.mail.send", status: "approved" }]);
    expect(gmailCalls).toHaveLength(1);
    // The approved send took its token from the connection's Google sign-in, checked for Send Gmail.
    expect(live.googleWorkspaceOAuth.resolveAccessToken).toHaveBeenCalledWith(connection.connectionId, "gmail.send");
    expect(pendingAction?.resolutionStatus).toBe("executed");
    // The recorded row is the Gateway-normalized request the policy engine matched.
    expect(pendingAction?.request).toMatchObject({ toolName: "gmail.send", workspaceId: "default" });
    expect(pendingAction?.request).toHaveProperty("policyContext");
    expect(settled).toMatchObject({ status: "sent" });
    expect(settled?.failureReason).toBeUndefined();
  });

  it("sends the operator's approved mail draft while Email and calendar is switched off", async () => {
    const { live, connection, dashboard, gmailCalls } = await startGatewayWithGmail();
    const draft = await dashboard.createDraft({
      accountId: connection.connectionId,
      to: ["recipient@example.com"],
      subject: "Approved with email off",
      bodyText: "The operator's own send.",
    });
    const approvalId = (await dashboard.sendDraft(draft.draftId)).approvalId!;
    // Switching the group off stops the AI's mail tools, not the operator's own approved draft.
    live.config.toolPolicy.tools.disabledGroups = ["email_and_calendar"];

    await live.resolveApproval(approvalId, { decision: "approve", resolvedBy: "operator" });

    const settled = await pollFor(
      async () => await live.storage.mailDrafts.find(draft.draftId),
      (candidate) => candidate?.status === "sent" || candidate?.status === "failed",
      "the approved draft to settle with Email and calendar off",
    );
    expect(settled?.failureReason).toBeUndefined();
    expect(settled).toMatchObject({ status: "sent" });
    expect(gmailCalls).toHaveLength(1);
    // The AI's own gmail.send is still switched off.
    const aiSend = await live.invokeTool({
      toolName: "gmail.send",
      args: { connectionId: connection.connectionId, to: ["x@example.com"], subject: "AI", bodyText: "AI" },
      agentId: "assistant",
      sessionId: "ai-mail-session",
    });
    expect(aiSend.outcome).toBe("blocked");
    expect(aiSend.policyReason).toContain("tool group switched off");
    expect(gmailCalls).toHaveLength(1);
  });

  it("sends nothing when the mail account changed between approval and execution", async () => {
    const { live, connection, dashboard, gmailCalls } = await startGatewayWithGmail();
    const draft = await dashboard.createDraft({
      accountId: connection.connectionId,
      to: ["recipient@example.com"],
      subject: "WS2 changed account",
      bodyText: "Must not be sent.",
    });
    expect(draft.workspaceId).toBe("default");
    const requested = await dashboard.sendDraft(draft.draftId);
    const approvalId = requested.approvalId!;
    expect((await live.storage.approvals.get(approvalId)).linkage).toMatchObject({ workspaceId: "default" });
    await live.storage.integrationConnections.update(connection.connectionId, { label: "Edited after approval" });

    await live.resolveApproval(approvalId, { decision: "approve", resolvedBy: "operator" });

    const settled = await pollFor(
      async () => await live.storage.mailDrafts.find(draft.draftId),
      (candidate) => candidate?.status === "sent" || candidate?.status === "failed",
      "the changed-account draft to settle",
    );
    expect(gmailCalls).toHaveLength(0);
    expect(settled).toMatchObject({
      status: "failed",
      failureReason: "The mail account changed after approval; nothing was sent. Request approval again.",
    });
  });
});

function createIsolatedConfigRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-ws2-comms-approval-"));
  tempRoots.push(root);
  fs.cpSync(path.join(findRepoRoot(), "config"), path.join(root, "config"), { recursive: true });
  const unifiedConfig = JSON.parse(
    fs.readFileSync(path.join(root, "config", "goatcitadel.example.json"), "utf8"),
  ) as Record<string, unknown>;
  appendGmailNetworkAllowlist(unifiedConfig);
  fs.writeFileSync(path.join(root, "config", "goatcitadel.json"), `${JSON.stringify(unifiedConfig, null, 2)}\n`);
  const toolPolicyPath = path.join(root, "config", "tool-policy.json");
  // config/tool-policy.json is gitignored, so a fresh checkout (CI) only carries the example.
  const toolPolicySourcePath = fs.existsSync(toolPolicyPath)
    ? toolPolicyPath
    : path.join(root, "config", "tool-policy.example.json");
  const toolPolicy = JSON.parse(fs.readFileSync(toolPolicySourcePath, "utf8")) as Record<string, unknown>;
  appendGmailNetworkAllowlist({ toolPolicy });
  fs.writeFileSync(toolPolicyPath, `${JSON.stringify(toolPolicy, null, 2)}\n`);
  return root;
}

function appendGmailNetworkAllowlist(config: Record<string, unknown>): void {
  const toolPolicy = asRecord(config.toolPolicy);
  const sandbox = asRecord(toolPolicy.sandbox);
  const networkAllowlist = Array.isArray(sandbox.networkAllowlist) ? sandbox.networkAllowlist : [];
  sandbox.networkAllowlist = [...new Set([...networkAllowlist, "gmail.googleapis.com"])];
  toolPolicy.sandbox = sandbox;
  config.toolPolicy = toolPolicy;
}

async function pollFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last).slice(0, 4_000)}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
