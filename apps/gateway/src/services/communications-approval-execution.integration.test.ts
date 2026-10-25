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

  async function startGatewayWithGmail() {
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

    gateway = new GatewayService(await loadGatewayConfig(root));
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
      createApproval: (input) => live.createApproval(input),
      listIntegrationConnections: (kind, limit) =>
        live.routeServices.integrations.listIntegrationConnections(kind, limit),
      mailDrafts: live.storage.mailDrafts,
    });
    return { live, connection, dashboard, gmailCalls };
  }

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
