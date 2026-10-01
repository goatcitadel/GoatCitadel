import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { idempotencyHeaderPlugin } from "../plugins/idempotency.js";
import { ImprovementCandidateDecisionPostCommitError } from "../services/improvement-review-precondition.js";
import { improvementRoutes } from "./improvement.js";

let app: FastifyInstance | undefined;
let storage: Storage | undefined;
let storageRoot: string | undefined;
afterEach(async () => {
  await app?.close(); app = undefined;
  storage?.close(); storage = undefined;
  if (storageRoot) fs.rmSync(storageRoot, { recursive: true, force: true });
  storageRoot = undefined;
});
const binding = { workspaceId: "workspace-a", expectedStatus: "ready_for_approval", expectedRevisionId: "revision-a", expectedChangeHash: "hash-a" };

async function setup(withIdempotency = false) {
  const approve = vi.fn(async () => ({ status: "approved" }));
  const reject = vi.fn(async () => ({ status: "rejected" }));
  app = Fastify();
  app.decorate("services", { improvement: { approveImprovementCandidate: approve, rejectImprovementCandidate: reject } } as never);
  if (withIdempotency) {
    storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gc-improvement-review-idempotency-"));
    storage = new Storage({ dbPath: ":memory:", transcriptsDir: path.join(storageRoot, "transcripts"), auditDir: path.join(storageRoot, "audit") });
    app.decorateRequest("authActorId", "operator:test");
    await app.register(idempotencyHeaderPlugin, { mutationStore: storage.mutationIdempotency });
  }
  await app.register(improvementRoutes);
  return { approve, reject };
}

describe("improvement candidate review preconditions", () => {
  it.each(["approve", "reject"] as const)("passes a complete %s binding to the owner", async (action) => {
    const owner = await setup();
    const response = await app!.inject({ method: "POST", url: `/api/v1/improvement/candidates/candidate-a/${action}`,
      payload: { reviewPrecondition: binding } });
    expect(response.statusCode).toBe(200);
    expect(owner[action]).toHaveBeenCalledWith("candidate-a", { reviewPrecondition: binding });
  });

  it.each(["approve", "reject"] as const)("retains %s compatibility when no review binding was sent", async (action) => {
    const owner = await setup();
    const response = await app!.inject({ method: "POST", url: `/api/v1/improvement/candidates/candidate-a/${action}`, payload: { reason: "reviewed" } });
    expect(response.statusCode).toBe(200);
    expect(owner[action]).toHaveBeenCalledWith("candidate-a", { reason: "reviewed" });
  });

  it("rejects incomplete, unknown, or inconsistent binding fields before calling the owner", async () => {
    const owner = await setup();
    for (const reviewPrecondition of [
      {}, { ...binding, workspaceId: "" }, { ...binding, expectedStatus: "invented" },
      { ...binding, expectedRevisionId: undefined }, { ...binding, expectedChangeHash: null },
      { ...binding, extraAuthority: true }, null,
    ]) {
      const response = await app!.inject({ method: "POST", url: "/api/v1/improvement/candidates/candidate-a/approve",
        payload: { reviewPrecondition } });
      expect(response.statusCode).toBe(400);
    }
    expect(owner.approve).not.toHaveBeenCalled();
  });

  it("accepts an explicit absent revision for an operator rejection", async () => {
    const owner = await setup();
    const reviewPrecondition = { ...binding, expectedRevisionId: null, expectedChangeHash: null };
    expect((await app!.inject({ method: "POST", url: "/api/v1/improvement/candidates/candidate-a/reject",
      payload: { reviewPrecondition } })).statusCode).toBe(200);
    expect(owner.reject).toHaveBeenCalledWith("candidate-a", { reviewPrecondition });
  });

  it.each(["approve", "reject"] as const)("retains a committed %s claim after review or audit fails", async (action) => {
    const owner = await setup(true);
    const canonicalResult = { candidateId: "candidate-a", workspaceId: "workspace-a",
      status: action === "approve" ? "approved" as const : "rejected" as const,
      currentRevisionId: "revision-a", changeHash: "hash-a" };
    owner[action].mockRejectedValueOnce(new ImprovementCandidateDecisionPostCommitError(canonicalResult,
      new Error("private response consumer unavailable")));
    const request = { method: "POST" as const, url: `/api/v1/improvement/candidates/candidate-a/${action}`,
      headers: { "Idempotency-Key": `committed-${action}` }, payload: { reviewPrecondition: binding } };
    const first = await app!.inject(request);
    expect(first.statusCode).toBe(500);
    expect(first.json()).toMatchObject({ code: "mutation_committed", retryable: false, canonicalResult });
    expect(first.body).not.toContain("private response consumer");
    const retry = await app!.inject(request);
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toEqual({ error: "Duplicate mutation blocked for this Idempotency-Key" });
    expect(owner[action]).toHaveBeenCalledTimes(1);
    expect(storage!.mutationIdempotency.get({ method: "POST", routePath: `/api/v1/improvement/candidates/:candidateId/${action}`,
      idempotencyKey: `committed-${action}`, actorScope: "operator:test" })?.status).toBe("completed");
  });

  it.each(["approve", "reject"] as const)("keeps precommit %s failures retryable", async (action) => {
    const owner = await setup(true);
    owner[action].mockRejectedValueOnce(new Error("Candidate changed after review"));
    const request = { method: "POST" as const, url: `/api/v1/improvement/candidates/candidate-a/${action}`,
      headers: { "Idempotency-Key": `precommit-${action}` }, payload: { reviewPrecondition: binding } };
    const first = await app!.inject(request);
    expect(first.statusCode).toBe(409);
    expect(first.json()).not.toHaveProperty("code", "mutation_committed");
    expect((await app!.inject(request)).statusCode).toBe(200);
    expect(owner[action]).toHaveBeenCalledTimes(2);
  });
});
