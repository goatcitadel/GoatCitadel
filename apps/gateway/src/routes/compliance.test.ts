import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { NotFoundError, type DurableRunRecord } from "@goatcitadel/contracts";
import { complianceRoutes } from "./compliance.js";
import {
  ComplianceExportService,
  type ComplianceBundle,
  type ComplianceExportDataPort,
} from "../services/compliance-export-service.js";
import { InMemoryEvidenceReceiptSigningKeyProvider } from "../services/evidence-receipt-signing-key.js";

const FIXED_NOW = "2026-06-19T12:00:00.000Z";

function makeRun(runId: string, createdAt: string): DurableRunRecord {
  return {
    runId,
    workflowKey: "chat.turn",
    status: "completed",
    attemptCount: 1,
    maxAttempts: 3,
    version: 2,
    payload: {},
    createdAt,
    finishedAt: createdAt,
    updatedAt: createdAt,
  };
}

function dataPortFor(runs: DurableRunRecord[]): ComplianceExportDataPort {
  const byId = new Map(runs.map((run) => [run.runId, run]));
  return {
    getDurableRun: (id) => {
      const run = byId.get(id);
      if (!run) {
        throw new NotFoundError({ entity: "Durable run", id });
      }
      return run;
    },
    findCodeModeRun: () => undefined,
    listApprovalEffects: () => [],
    listSideEffectsForWorkspace: () => [],
    listDurableRunsForExport: () => runs.slice(),
  };
}

function buildService(runs: DurableRunRecord[]): ComplianceExportService {
  return new ComplianceExportService({
    data: dataPortFor(runs),
    signingKeys: new InMemoryEvidenceReceiptSigningKeyProvider(),
    now: () => new Date(FIXED_NOW),
  });
}

async function makeApp(service: ComplianceExportService): Promise<FastifyInstance> {
  const app = Fastify();
  // Operator auth is required by withRouteAccess("operator"); install a permissive handler.
  app.decorate("requireOperatorAuth", async () => undefined);
  app.decorate("services", { compliance: service } as never);
  await app.register(complianceRoutes);
  await app.ready();
  return app;
}

const RUNS: DurableRunRecord[] = [
  makeRun("run-a", "2026-06-10T09:00:00.000Z"),
  makeRun("run-b", "2026-06-12T09:00:00.000Z"),
];

const WIDE_RANGE = { fromTs: "2026-06-01T00:00:00.000Z", toTs: "2026-06-30T00:00:00.000Z" };

describe("compliance routes", () => {
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = null;
    }
  });

  it("POST /api/v1/compliance/export builds and returns a signed bundle", async () => {
    app = await makeApp(buildService(RUNS));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/export",
      payload: WIDE_RANGE,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as ComplianceBundle;
    expect(body.receiptCount).toBe(2);
    expect(body.truncated).toBe(false);
    expect(body.receipts).toHaveLength(2);
    expect(body.bundleContentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(body.signatureAlgorithm).toBe("ed25519");
    expect(body.bundleSignature.length).toBeGreaterThan(0);
    expect(body.publicKey.length).toBeGreaterThan(0);
  });

  it("export then verify round-trips to valid:true", async () => {
    app = await makeApp(buildService(RUNS));

    const exportResponse = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/export",
      payload: WIDE_RANGE,
    });
    const bundle = exportResponse.json() as ComplianceBundle;

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/verify",
      payload: bundle,
    });

    expect(verifyResponse.statusCode).toBe(200);
    const verification = verifyResponse.json() as { valid: boolean; reasons: string[]; perReceipt: unknown[] };
    expect(verification.valid).toBe(true);
    expect(verification.reasons).toEqual([]);
    expect(verification.perReceipt).toHaveLength(2);
  });

  it("verify reports valid:false for a tampered bundle", async () => {
    app = await makeApp(buildService(RUNS));

    const exportResponse = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/export",
      payload: WIDE_RANGE,
    });
    const bundle = exportResponse.json() as ComplianceBundle;
    const tampered: ComplianceBundle = {
      ...bundle,
      receipts: bundle.receipts.slice(1),
    };

    const verifyResponse = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/verify",
      payload: tampered,
    });

    expect(verifyResponse.statusCode).toBe(200);
    const verification = verifyResponse.json() as { valid: boolean; reasons: string[] };
    expect(verification.valid).toBe(false);
    expect(verification.reasons.length).toBeGreaterThan(0);
  });

  it("export rejects a missing fromTs/toTs with 400", async () => {
    app = await makeApp(buildService(RUNS));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/export",
      payload: { workspaceId: "ws-1" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("export surfaces an inverted range as 400", async () => {
    app = await makeApp(buildService(RUNS));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/export",
      payload: { fromTs: "2026-06-30T00:00:00.000Z", toTs: "2026-06-01T00:00:00.000Z" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("verify rejects a non-object body with 400", async () => {
    app = await makeApp(buildService(RUNS));

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/verify",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify("not-an-object"),
    });

    expect(response.statusCode).toBe(400);
  });

  it("surfaces a 503 when the signing key store is unavailable", async () => {
    const service = {
      buildComplianceBundle: () => {
        const error = new Error("OS keychain is unavailable") as Error & { httpStatus: number };
        error.httpStatus = 503;
        throw error;
      },
      verifyComplianceBundle: () => ({ valid: true, reasons: [], perReceipt: [] }),
    } as unknown as ComplianceExportService;
    app = await makeApp(service);

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/compliance/export",
      payload: WIDE_RANGE,
    });

    expect(response.statusCode).toBe(503);
  });
});
