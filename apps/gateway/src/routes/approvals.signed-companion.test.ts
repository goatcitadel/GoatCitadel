import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonString } from "@goatcitadel/contracts";
import { createSqliteAsyncStorage, Storage, type AsyncStorage } from "@goatcitadel/storage";
import { COMPANION_APPROVE_REFUSED_MESSAGE } from "../services/companion-signed-approval.js";
import {
  buildMobileApprovalDecisionSigningPayload,
  MobileApprovalKeyService,
} from "../services/mobile-approval-key-service.js";
import { createMobileRoutePort } from "../services/mobile-route-service.js";
import { approvalsRoutes } from "./approvals.js";

const GRANT_ID = "grant-phone-1";
const COMPANION_SESSION_ID = "companion-phone-1";
const COMPANION_HEADERS = {
  "x-auth-source": "companion",
  "x-auth-purpose": "general_companion",
  "x-companion-session-id": COMPANION_SESSION_ID,
  "x-grant-id": GRANT_ID,
} as const;

const tempDirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** One Gateway "process": a storage handle over the database file and an app with the real key service. */
async function startGateway(dbDir: string, options: { signedApprovals?: boolean } = {}) {
  const sync = new Storage({
    dbPath: path.join(dbDir, "gateway.db"),
    transcriptsDir: path.join(dbDir, "transcripts"),
    auditDir: path.join(dbDir, "audit"),
  });
  const storage = createSqliteAsyncStorage(sync);
  const keys = new MobileApprovalKeyService({ storage, isGrantActive: async () => true });
  const resolveApproval = vi.fn(
    async (approvalId: string, input: Parameters<AsyncStorage["approvals"]["resolve"]>[1]) => ({
      approval: await storage.approvals.resolve(approvalId, input),
    }),
  );
  const app = Fastify();
  app.decorate("services", {
    approvals: { getApproval: (approvalId: string) => storage.approvals.get(approvalId), resolveApproval },
    mobile: createMobileRoutePort({
      storage: { audit: {} } as never,
      mobilePush: {} as never,
      mobileApprovalKeys: keys,
      publishRealtime: vi.fn(),
      signedCompanionApprovalsEnabled: options.signedApprovals ?? true,
    }),
  } as never);
  app.decorate("requireOperatorAuth", (async () => undefined) as never);
  app.decorateRequest("idempotencyKey", "");
  app.addHook("onRequest", async (request) => {
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    request.authActorSource = (header("x-auth-source") ?? "none") as never;
    request.authPrincipalPurpose = header("x-auth-purpose") as never;
    request.authCompanionSessionId = header("x-companion-session-id");
    request.authGrantId = header("x-grant-id");
  });
  await app.register(approvalsRoutes);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    sync.close();
  };
  closers.push(close);
  return { sync, storage, keys, app, resolveApproval, close };
}

async function setUp(options: { signedApprovals?: boolean } = {}) {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-signed-phone-"));
  tempDirs.push(dbDir);
  const gateway = await startGateway(dbDir, options);
  seedActiveGrant(gateway.sync, GRANT_ID);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await gateway.keys.register(
    {
      enabled: true,
      algorithm: "ed25519",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      keyProvenance: "secure_hardware",
    },
    { grantId: GRANT_ID, companionSessionId: COMPANION_SESSION_ID },
  );
  const createApproval = (kind = "browser.errand.action") =>
    gateway.sync.approvals.create({ kind, riskLevel: "caution", payload: { step: 1 }, preview: { summary: "Buy" } });
  return { dbDir, gateway, privateKey, createApproval };
}

function signDecision(
  privateKey: KeyObject,
  input: {
    approvalId: string;
    decision: "approve" | "edit";
    editedPayload?: Record<string, unknown>;
    signedAt?: string;
    nonce?: string;
  },
) {
  const signedAt = input.signedAt ?? new Date().toISOString();
  const nonce = input.nonce ?? `nonce-${Math.random().toString(36).slice(2)}`;
  const payload = buildMobileApprovalDecisionSigningPayload({
    approvalId: input.approvalId,
    decision: input.decision,
    decisionPayloadSha256: sha256(input.decision === "edit" ? canonicalJsonString(input.editedPayload ?? {}) : ""),
    signedAt,
    companionSessionId: COMPANION_SESSION_ID,
    nonce,
  });
  return { signedAt, nonce, signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url") };
}

function resolve(app: FastifyInstance, approvalId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: `/api/v1/approvals/${approvalId}/resolve`,
    headers: COMPANION_HEADERS,
    payload,
  });
}

describe("signed phone approvals on POST /api/v1/approvals/:approvalId/resolve", () => {
  it("accepts a phone approve signed by the grant's active key, as the companion session", async () => {
    const { gateway, privateKey, createApproval } = await setUp();
    const approval = createApproval();
    const response = await resolve(gateway.app, approval.approvalId, {
      decision: "approve",
      signedDecision: signDecision(privateKey, { approvalId: approval.approvalId, decision: "approve" }),
    });
    expect(response.statusCode).toBe(200);
    const stored = await gateway.storage.approvals.get(approval.approvalId);
    expect(stored.status).toBe("approved");
    expect(stored.resolvedBy).toBe(`companion:${COMPANION_SESSION_ID}`);
    expect(gateway.resolveApproval).toHaveBeenCalledWith(approval.approvalId, {
      decision: "approve",
      resolvedBy: `companion:${COMPANION_SESSION_ID}`,
    });
  });

  it("accepts a phone edit whose edited payload is the one that was signed, and refuses a changed one", async () => {
    const { gateway, privateKey, createApproval } = await setUp();
    const tampered = createApproval();
    const tamperedResponse = await resolve(gateway.app, tampered.approvalId, {
      decision: "edit",
      editedPayload: { step: 3 },
      signedDecision: signDecision(privateKey, {
        approvalId: tampered.approvalId,
        decision: "edit",
        editedPayload: { step: 2 },
      }),
    });
    expect(tamperedResponse.statusCode).toBe(403);
    expect(tamperedResponse.json().error).toBe("The phone's signature does not match this approval and decision.");

    const approval = createApproval();
    const response = await resolve(gateway.app, approval.approvalId, {
      decision: "edit",
      editedPayload: { step: 2 },
      signedDecision: signDecision(privateKey, {
        approvalId: approval.approvalId,
        decision: "edit",
        editedPayload: { step: 2 },
      }),
    });
    expect(response.statusCode).toBe(200);
    expect((await gateway.storage.approvals.get(approval.approvalId)).status).toBe("edited");
  });

  it("refuses a replayed signed decision, also after a restart with a fresh service", async () => {
    const { dbDir, gateway, privateKey, createApproval } = await setUp();
    const approval = createApproval();
    const body = {
      decision: "approve",
      signedDecision: signDecision(privateKey, { approvalId: approval.approvalId, decision: "approve" }),
    };
    expect((await resolve(gateway.app, approval.approvalId, body)).statusCode).toBe(200);

    const replay = await resolve(gateway.app, approval.approvalId, body);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().error).toBe("This approval was already answered, so the phone's decision was not used.");

    await gateway.close();
    const restarted = await startGateway(dbDir);
    const afterRestart = await resolve(restarted.app, approval.approvalId, body);
    expect(afterRestart.statusCode).toBe(409);
    expect(restarted.resolveApproval).not.toHaveBeenCalled();
    expect((await restarted.storage.approvals.get(approval.approvalId)).status).toBe("approved");
  });

  it.each([
    ["stale", -10 * 60_000],
    ["future", 10 * 60_000],
  ])("refuses a %s signature time", async (_label, offsetMs) => {
    const { gateway, privateKey, createApproval } = await setUp();
    const approval = createApproval();
    const response = await resolve(gateway.app, approval.approvalId, {
      decision: "approve",
      signedDecision: signDecision(privateKey, {
        approvalId: approval.approvalId,
        decision: "approve",
        signedAt: new Date(Date.now() + offsetMs).toISOString(),
      }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe(
      "The phone's decision is too old or dated in the future. Try again on the phone.",
    );
    expect((await gateway.storage.approvals.get(approval.approvalId)).status).toBe("pending");
  });

  it("refuses a decision signed by a key that was turned off", async () => {
    const { gateway, privateKey, createApproval } = await setUp();
    await gateway.keys.register(
      { enabled: false, algorithm: "ed25519", publicKeyPem: "", keyProvenance: "software" } as never,
      { grantId: GRANT_ID, companionSessionId: COMPANION_SESSION_ID },
    );
    const approval = createApproval();
    const response = await resolve(gateway.app, approval.approvalId, {
      decision: "approve",
      signedDecision: signDecision(privateKey, { approvalId: approval.approvalId, decision: "approve" }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe(
      "This phone has no active approval key. Turn on phone approvals on the phone again.",
    );
    expect((await gateway.storage.approvals.get(approval.approvalId)).status).toBe("pending");
  });

  it("refuses a signature made for another approval or another decision", async () => {
    const { gateway, privateKey, createApproval } = await setUp();
    const target = createApproval();
    const other = createApproval();
    const wrongApproval = await resolve(gateway.app, target.approvalId, {
      decision: "approve",
      signedDecision: signDecision(privateKey, { approvalId: other.approvalId, decision: "approve" }),
    });
    expect(wrongApproval.statusCode).toBe(403);
    const wrongDecision = await resolve(gateway.app, target.approvalId, {
      decision: "edit",
      editedPayload: {},
      signedDecision: signDecision(privateKey, { approvalId: target.approvalId, decision: "approve" }),
    });
    expect(wrongDecision.statusCode).toBe(403);
    expect(wrongDecision.json().error).toBe("The phone's signature does not match this approval and decision.");
    expect((await gateway.storage.approvals.get(target.approvalId)).status).toBe("pending");
    expect((await gateway.storage.approvals.get(other.approvalId)).status).toBe("pending");
  });

  it("refuses an unsigned phone approve, and never approves a device access request from the phone", async () => {
    const { gateway, privateKey, createApproval } = await setUp();
    const approval = createApproval();
    const unsigned = await resolve(gateway.app, approval.approvalId, { decision: "approve" });
    expect(unsigned.statusCode).toBe(403);
    const deviceAccess = createApproval("auth.device_access");
    const signed = await resolve(gateway.app, deviceAccess.approvalId, {
      decision: "approve",
      signedDecision: signDecision(privateKey, { approvalId: deviceAccess.approvalId, decision: "approve" }),
    });
    expect(signed.statusCode).toBe(403);
    expect(signed.json().error).toBe("Device access requests are approved at the PC.");
    expect(gateway.resolveApproval).not.toHaveBeenCalled();
  });

  it("refuses a valid signed approve with today's message while the switch is off, and still takes an unsigned reject", async () => {
    const { gateway, privateKey, createApproval } = await setUp({ signedApprovals: false });
    const approval = createApproval();
    const approve = await resolve(gateway.app, approval.approvalId, {
      decision: "approve",
      signedDecision: signDecision(privateKey, { approvalId: approval.approvalId, decision: "approve" }),
    });
    expect(approve.statusCode).toBe(403);
    expect(approve.json().error).toBe(COMPANION_APPROVE_REFUSED_MESSAGE);
    expect((await gateway.storage.approvals.get(approval.approvalId)).status).toBe("pending");

    const reject = await resolve(gateway.app, approval.approvalId, { decision: "reject" });
    expect(reject.statusCode).toBe(200);
    expect((await gateway.storage.approvals.get(approval.approvalId)).status).toBe("rejected");
  });
});

function seedActiveGrant(storage: Storage, grantId: string): void {
  const requestId = `request-${sha256(grantId).slice(0, 24)}`;
  storage.db
    .prepare(
      `INSERT INTO auth_device_requests (
         request_id, approval_id, request_secret_hash, device_label, device_type, status,
         created_at, expires_at, resolved_at, resolved_by, principal_purpose
       ) VALUES (
         @requestId, @approvalId, @requestSecretHash, 'Phone', 'test', 'approved',
         @createdAt, @requestExpiresAt, @createdAt, 'operator:test', 'general_companion'
       )`,
    )
    .run({
      requestId,
      approvalId: `approval-${sha256(grantId).slice(0, 24)}`,
      requestSecretHash: sha256(`request-secret:${grantId}`),
      createdAt: "2026-08-11T00:00:00.000Z",
      requestExpiresAt: "2999-01-01T00:00:00.000Z",
    });
  storage.db
    .prepare(
      `INSERT INTO auth_device_grants (
         grant_id, request_id, token_hash, device_label, device_type, granted_by,
         created_at, expires_at, revoked_at, metadata_json, principal_purpose
       ) VALUES (
         @grantId, @requestId, @tokenHash, 'Phone', 'test', 'operator:test',
         @createdAt, NULL, NULL, '{}', 'general_companion'
       )`,
    )
    .run({
      grantId,
      requestId,
      tokenHash: sha256(`device-token:${grantId}`),
      createdAt: "2026-08-11T00:00:00.000Z",
    });
}
