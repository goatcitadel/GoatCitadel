import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError, type DurableRunRecord, type ExternalSideEffectRunRecord } from "@goatcitadel/contracts";
import { evidenceReceiptsRoutes } from "./evidence-receipts.js";
import {
  EvidenceReceiptService,
  type EvidenceReceiptDataPort,
  type EvidenceReceipt,
} from "../services/evidence-receipt-service.js";
import { InMemoryEvidenceReceiptSigningKeyProvider } from "../services/evidence-receipt-signing-key.js";

const FIXED_NOW = "2026-06-18T12:00:00.000Z";

function buildService(data: EvidenceReceiptDataPort): EvidenceReceiptService {
  return new EvidenceReceiptService({
    data,
    signingKeys: new InMemoryEvidenceReceiptSigningKeyProvider(),
    now: () => new Date(FIXED_NOW),
  });
}

/** A data port backed by a single in-memory run, with no code-mode/approval/side-effect lineage. */
function singleRunDataPort(runId: string): EvidenceReceiptDataPort {
  return {
    getDurableRun: (id) => {
      if (id !== runId) {
        throw new NotFoundError({ entity: "Durable run", id });
      }
      return {
        runId,
        workflowKey: "chat.turn",
        status: "completed",
        attemptCount: 1,
        maxAttempts: 3,
        version: 2,
        payload: {},
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      };
    },
    findCodeModeRun: () => undefined,
    listApprovalEffects: () => [],
    listSideEffectsForWorkspace: () => [],
  };
}

async function makeApp(service: {
  buildEvidenceReceipt: (runId: string) => EvidenceReceipt | Promise<EvidenceReceipt>;
  verifyEvidenceReceipt: (receipt: unknown) => { valid: boolean; reasons: string[] };
}): Promise<FastifyInstance> {
  const app = Fastify();
  // Operator auth is required by withRouteAccess("operator"); install a permissive handler.
  app.decorate("requireOperatorAuth", async () => undefined);
  app.decorate("services", { evidenceReceipts: service } as never);
  await app.register(evidenceReceiptsRoutes);
  await app.ready();
  return app;
}

describe("evidence-receipts routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("POST /api/v1/runs/:runId/evidence-receipt builds and returns a signed receipt", async () => {
    const service = buildService(singleRunDataPort("run-1"));
    app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/evidence-receipt",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as EvidenceReceipt;
    expect(body.manifest.runId).toBe("run-1");
    expect(body.signatureAlgorithm).toBe("ed25519");
    expect(body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.signature.length).toBeGreaterThan(0);
    expect(body.publicKey.length).toBeGreaterThan(0);
  });

  it("signs and returns a detached public projection of runtime errors and external references", async () => {
    const rawLastError =
      "Provider rejected Authorization: Bearer receipt-error-secret at https://user:password@example.test/fail?token=receipt-query-secret";
    const rawExternalReference =
      "url:https://ref-user:ref-password@example.test/result?access_token=receipt-external-secret";
    const run: DurableRunRecord = {
      runId: "run-secret",
      workflowKey: "chat.turn",
      status: "failed",
      attemptCount: 1,
      maxAttempts: 3,
      version: 2,
      payload: { workspaceId: "workspace-secret" },
      lastError: rawLastError,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    const sideEffect: ExternalSideEffectRunRecord = {
      runId: "extfx-secret",
      workspaceId: "workspace-secret",
      boundary: "integration.write",
      routePath: "/api/v1/integrations/webhook/send",
      actorScope: "operator",
      idempotencyKey: "idem-secret-projection",
      payloadHash: "payload-hash-secret-projection",
      status: "completed",
      replayPolicy: "audit_only",
      resumeState: "completed",
      externalReferenceId: rawExternalReference,
      attemptCount: 1,
      completedAt: FIXED_NOW,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    };
    const safeSideEffect: ExternalSideEffectRunRecord = {
      ...sideEffect,
      runId: "extfx-safe-reference",
      idempotencyKey: "idem-safe-reference",
      externalReferenceId: "messageId:provider-message-123",
    };
    const service = buildService({
      getDurableRun: () => run,
      findCodeModeRun: () => undefined,
      listApprovalEffects: () => [],
      listSideEffectsForWorkspace: () => [sideEffect, safeSideEffect],
    });
    app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-secret/evidence-receipt",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as EvidenceReceipt;
    expect(body.manifest.lineage.lastError).toBe("Provider rejected Authorization: [REDACTED]");
    expect(body.manifest.sideEffects[0]?.externalReferenceId).toBe(
      "url:https://[REDACTED]@example.test/result?access_token=[REDACTED]",
    );
    expect(body.manifest.sideEffects[1]?.externalReferenceId).toBe("messageId:provider-message-123");
    expect(response.body).not.toContain("receipt-error-secret");
    expect(response.body).not.toContain("receipt-query-secret");
    expect(response.body).not.toContain("receipt-external-secret");
    expect(service.verifyEvidenceReceipt(body).valid).toBe(true);
    expect(run.lastError).toBe(rawLastError);
    expect(sideEffect.externalReferenceId).toBe(rawExternalReference);
    expect(safeSideEffect.externalReferenceId).toBe("messageId:provider-message-123");
  });

  it("returns 404 when the run does not exist", async () => {
    const service = buildService(singleRunDataPort("run-1"));
    app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/missing/evidence-receipt",
    });

    expect(response.statusCode).toBe(404);
  });

  it("POST /api/v1/evidence-receipts/verify validates an untampered receipt", async () => {
    const service = buildService(singleRunDataPort("run-1"));
    app = await makeApp(service);
    const receipt = await service.buildEvidenceReceipt("run-1");

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/evidence-receipts/verify",
      payload: receipt,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ valid: true, reasons: [] });
  });

  it("verify returns valid:false with reasons for a tampered receipt", async () => {
    const service = buildService(singleRunDataPort("run-1"));
    app = await makeApp(service);
    const receipt = await service.buildEvidenceReceipt("run-1");
    const tampered: EvidenceReceipt = {
      ...receipt,
      manifest: { ...receipt.manifest, runId: "different-run" },
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/evidence-receipts/verify",
      payload: tampered,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { valid: boolean; reasons: string[] };
    expect(body.valid).toBe(false);
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it("verify rejects a non-object body with 400", async () => {
    const service = buildService(singleRunDataPort("run-1"));
    app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/evidence-receipts/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("not-an-object"),
    });

    expect(response.statusCode).toBe(400);
  });

  it("surfaces a 503 when the signing key store is unavailable", async () => {
    const service = {
      buildEvidenceReceipt: () => {
        const error = new Error("OS keychain is unavailable") as Error & { httpStatus: number };
        error.httpStatus = 503;
        throw error;
      },
      verifyEvidenceReceipt: () => ({ valid: true, reasons: [] }),
    };
    app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/runs/run-1/evidence-receipt",
    });

    expect(response.statusCode).toBe(503);
  });
});
