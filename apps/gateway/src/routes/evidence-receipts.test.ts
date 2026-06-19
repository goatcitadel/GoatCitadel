import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError } from "@goatcitadel/contracts";
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
  buildEvidenceReceipt: (runId: string) => EvidenceReceipt;
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
    const receipt = service.buildEvidenceReceipt("run-1");

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
    const receipt = service.buildEvidenceReceipt("run-1");
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
