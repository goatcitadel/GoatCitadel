import type { CodeModeRunVerificationResponse } from "@goatcitadel/contracts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { EngineeringLearningService } from "../services/engineering-learning-service.js";
import { engineeringLearningRoutes } from "./engineering-learnings.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function buildApp(): Promise<{ app: FastifyInstance; service: EngineeringLearningService }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gc-learning-routes-"));
  const storage = new Storage({ dbPath: ":memory:", transcriptsDir: root, auditDir: root });
  cleanups.push(
    () => fs.rmSync(root, { recursive: true, force: true }),
    () => storage.close(),
  );
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "fix.ts"), "export const fixed = true;\n", "utf8");
  const service = new EngineeringLearningService({
    storage,
    rootDir: root,
    isEnabled: () => true,
    createApproval: async (input) => storage.approvals.create(input),
    resolveSourceRoot: async () => root,
    readVerifiedSource: async (runId, workspaceId) => ({ run: { runId, workspaceId, sessionId: "source-chat", turnId: "source-turn", status: "completed", codeHash: "code", codeModeInputHash: "input", wrapperManifestHash: "wrapper", policySnapshotHash: "policy", verification: { status: "verified", evidenceId: "verified-source", subjectHash: "subject" } }, evidence: { evidenceId: "verified-source", runId, workspaceId, sessionId: "source-chat", turnId: "source-turn", status: "verified", subject: { subjectHash: "subject", codeHash: "code", codeModeInputHash: "input", wrapperManifestHash: "wrapper", policySnapshotHash: "policy", changedFiles: ["src/fix.ts"], changedFilesTruncated: false }, outputArtifactRefs: [] } }) as CodeModeRunVerificationResponse,
  });
  const app = Fastify();
  app.decorateRequest("authActorId", "operator-test");
  app.decorate("gatewayRuntime", { engineeringLearningService: service });
  await app.register(engineeringLearningRoutes);
  cleanups.push(() => app.close());
  return { app, service };
}

function proposal(runId: string, title: string) {
  return {
    workspaceId: "default",
    source: { runId },
    disposition: "completed" as const,
    changedFiles: ["src/fix.ts"],
    verificationEvidence: ["test:focused-pass"],
    title,
    problem: "The old branch skipped validation.",
    rootCause: "The mutation path had no invariant test.",
    resolution: "Added the invariant and a focused test.",
    prevention: "Run the focused proof before changing this path.",
  };
}

describe("engineering learning routes", () => {
  it("returns a stored learning and its overlaps", async () => {
    const { app, service } = await buildApp();
    const first = await service.propose(proposal("code-run-1", "Keep the regression guard"));
    const second = await service.propose(proposal("code-run-2", "Keep the invariant test"));

    const found = await app.inject({ method: "GET", url: `/api/v1/engineering-learnings/${first.learningId}` });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({ learningId: first.learningId, title: "Keep the regression guard" });

    const overlaps = await app.inject({
      method: "GET",
      url: `/api/v1/engineering-learnings/${first.learningId}/overlaps`,
    });
    expect(overlaps.statusCode).toBe(200);
    expect(overlaps.json().items.map((item: { learningId: string }) => item.learningId)).toEqual([second.learningId]);
  });

  it("answers 404 for a missing learning and its overlaps", async () => {
    const { app } = await buildApp();

    const missing = await app.inject({ method: "GET", url: "/api/v1/engineering-learnings/learning-missing" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toMatch(/not found: learning-missing/);

    const overlaps = await app.inject({
      method: "GET",
      url: "/api/v1/engineering-learnings/learning-missing/overlaps",
    });
    expect(overlaps.statusCode).toBe(404);
    expect(overlaps.json().error).toMatch(/not found: learning-missing/);
  });

  it("sends resolved records from the list, context, proposal, and refresh routes", async () => {
    const { app } = await buildApp();

    const proposed = await app.inject({
      method: "POST",
      url: "/api/v1/engineering-learnings/proposals",
      payload: proposal("code-run-3", "Keep the proposal route honest"),
    });
    expect(proposed.statusCode).toBe(201);
    const learningId = proposed.json().learningId;
    expect(learningId).toMatch(/^learning-/);

    const listed = await app.inject({ method: "GET", url: "/api/v1/engineering-learnings?workspaceId=default" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items.map((item: { learningId: string }) => item.learningId)).toEqual([learningId]);

    const context = await app.inject({
      method: "GET",
      url: "/api/v1/engineering-learnings/context?workspaceId=default&paths=src/fix.ts",
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toEqual({ items: [], citations: [] });

    const refreshed = await app.inject({ method: "POST", url: "/api/v1/engineering-learnings/maintenance/refresh" });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toEqual({ staleCount: 0 });
  });

  it("answers 400 when a list read fails instead of rejecting outside the handler", async () => {
    const failing = Fastify();
    failing.decorate("gatewayRuntime", {
      engineeringLearningService: {
        list: async () => {
          throw new Error("Feature engineeringLearningsV1Enabled is disabled.");
        },
      },
    });
    await failing.register(engineeringLearningRoutes);
    cleanups.push(() => failing.close());

    const listed = await failing.inject({ method: "GET", url: "/api/v1/engineering-learnings?workspaceId=default" });
    expect(listed.statusCode).toBe(400);
    expect(listed.json().error).toMatch(/disabled/);
  });
});
