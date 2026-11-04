import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { ConflictError } from "@goatcitadel/contracts";
import { afterAll, beforeAll, describe, it } from "vitest";
import { createPostgresRemoteStorage } from "@goatcitadel/storage";
import { acquireGatewayLivePostgresTestLease } from "../test/live-postgres-suite-lock.js";
import { DocumentEditingService } from "./document-editing-service.js";

const postgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
describe.skipIf(!postgresUrl)("document proposal transactions across real PostgreSQL workers", { timeout: 120_000 }, () => {
  const workers: ReturnType<typeof createPostgresRemoteStorage>[] = [];
  const services: DocumentEditingService[] = [];
  const schema = `document_apply_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let root: string;
  let admin: Pool;
  let lease: Awaited<ReturnType<typeof acquireGatewayLivePostgresTestLease>>;
  const session = (sessionId: string) => ({ sessionId, workspaceId: "default" });

  beforeAll(async () => {
    lease = await acquireGatewayLivePostgresTestLease(postgresUrl!);
    root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-document-apply-pg-"));
    admin = new Pool({ connectionString: postgresUrl, max: 2, connectionTimeoutMillis: 10_000 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(postgresUrl!);
    scoped.searchParams.set("options", `-csearch_path=${schema}`);
    for (const name of ["a", "b"]) {
      const worker = createPostgresRemoteStorage({
        connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1), applicationName: `document-apply-${name}`, pool: { max: 2 } },
        migrationsTable: "schema_migrations", transcriptsDir: path.join(root, name), auditDir: path.join(root, name), startupWaitTimeoutMs: 120_000,
      });
      workers.push(worker);
      await worker.waitUntilReady();
      services.push(new DocumentEditingService({ storage: worker, requireChatSession: session }));
    }
    await admin.query(`CREATE FUNCTION ${schema}.reject_applied_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'settlement rejected'; END $$`);
  }, 180_000);

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    if (root) await fs.rm(root, { recursive: true, force: true });
    await lease?.release();
  }, 120_000);

  const rejectSettlement = () => admin.query(`CREATE TRIGGER reject_applied BEFORE UPDATE ON ${schema}.document_patch_proposals
    FOR EACH ROW WHEN (NEW.state = 'applied') EXECUTE FUNCTION ${schema}.reject_applied_settlement()`);
  const restoreSettlement = () => admin.query(`DROP TRIGGER IF EXISTS reject_applied ON ${schema}.document_patch_proposals`);

  it("rolls note content and history back with failed proposal settlement", async () => {
    const [a, b] = workers;
    const service = services[0]!;
    const note = await a!.personalOps.createNote({ workspaceId: "default", title: "Atomic note", body: "before" });
    const proposal = await service.createProposal({ workspaceId: "default", targetKind: "personal_note", targetId: note.noteId, baseRevision: 1, proposedContent: "after" }, "operator");
    await rejectSettlement();
    try {
      await assert.rejects(service.applyProposal(proposal.proposalId, "default", "operator"), /settlement rejected/);
      assert.equal((await b!.personalOps.getNote(note.noteId)).body, "before");
      assert.equal((await b!.personalOps.getNote(note.noteId)).revision, 1);
      assert.equal((await b!.personalOps.listNoteRevisions(note.noteId, { workspaceId: "default" })).length, 1);
      assert.equal((await b!.documentPatchProposals.get(proposal.proposalId)).state, "pending");
    } finally { await restoreSettlement(); }
    const applied = await service.applyProposal(proposal.proposalId, "default", "operator");
    assert.equal(applied.state, "applied");
    assert.equal(applied.appliedRevision, 2);
    assert.equal((await b!.personalOps.listNoteRevisions(note.noteId, { workspaceId: "default" })).length, 2);
  });

  it("rolls artifact creation back with failed proposal settlement", async () => {
    const [a, b] = workers;
    const service = services[0]!;
    const now = "2026-11-02T00:00:00.000Z";
    const base = await a!.chatGeneratedArtifacts.create({
      artifactId: `atomic-${randomUUID()}`, sessionId: "fixture-session", workspaceId: "default", turnId: "fixture-turn",
      title: "Atomic artifact", kind: "markdown", content: "before", sourceSurface: "chat", version: 1,
      contentHash: createHash("sha256").update("before").digest("hex"), createdAt: now, updatedAt: now,
    });
    const proposal = await service.createProposal({ workspaceId: "default", targetKind: "generated_artifact", targetId: base.artifactId, baseContentHash: base.contentHash, proposedContent: "after" }, "operator");
    await rejectSettlement();
    try {
      await assert.rejects(service.applyProposal(proposal.proposalId, "default", "operator"), /settlement rejected/);
      assert.equal(await b!.chatGeneratedArtifacts.findDirectSuccessor(base.artifactId), undefined);
      assert.equal((await b!.documentPatchProposals.get(proposal.proposalId)).state, "pending");
    } finally { await restoreSettlement(); }
    const applied = await service.applyProposal(proposal.proposalId, "default", "operator");
    assert.equal(applied.state, "applied");
    assert.equal((await b!.chatGeneratedArtifacts.findDirectSuccessor(base.artifactId))?.artifactId, applied.appliedTargetId);
  });

  it("refuses an apply after another worker rejects its stale pending snapshot", async () => {
    const [a, b] = workers;
    const note = await a!.personalOps.createNote({ workspaceId: "default", title: "Race note", body: "before" });
    const proposal = await services[0]!.createProposal({ workspaceId: "default", targetKind: "personal_note", targetId: note.noteId, baseRevision: 1, proposedContent: "after" }, "operator");
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let intercepted = false;
    const proposals = new Proxy(a!.documentPatchProposals, {
      get(target, key, receiver) {
        if (key !== "get") return Reflect.get(target, key, receiver);
        return async (id: string) => {
          const snapshot = await target.get(id);
          if (!intercepted) { intercepted = true; entered(); await gate; }
          return snapshot;
        };
      },
    });
    const applyingStorage = {
      chatGeneratedArtifacts: a!.chatGeneratedArtifacts, chatTurnTraces: a!.chatTurnTraces,
      documentPatchProposals: proposals, personalOps: a!.personalOps,
      runImmediateTransaction: a!.runImmediateTransaction.bind(a),
    };
    const applying = new DocumentEditingService({ storage: applyingStorage, requireChatSession: session });
    const settled = Promise.allSettled([applying.applyProposal(proposal.proposalId, "default", "operator-apply")]);
    try { await ready; assert.equal((await services[1]!.rejectProposal(proposal.proposalId, "default", "operator-reject")).state, "rejected"); }
    finally { release(); }
    const [result] = await settled;
    assert.equal((await b!.personalOps.getNote(note.noteId)).body, "before");
    assert.equal((await b!.documentPatchProposals.get(proposal.proposalId)).state, "rejected");
    assert.equal(result?.status, "rejected");
  });

  it("serializes distinct proposal versions against the same artifact base", async () => {
    const [a, b] = workers;
    const now = "2026-11-02T00:00:00.000Z";
    const base = await a!.chatGeneratedArtifacts.create({
      artifactId: `linear-${randomUUID()}`, sessionId: "fixture-session", workspaceId: "default", turnId: "fixture-turn",
      title: "Linear artifact", kind: "markdown", content: "before", sourceSurface: "chat", version: 1,
      contentHash: createHash("sha256").update("before").digest("hex"), createdAt: now, updatedAt: now,
    });
    const proposals = await Promise.all(services.map((service, index) => service.createProposal({
      workspaceId: "default", targetKind: "generated_artifact", targetId: base.artifactId,
      baseContentHash: base.contentHash, proposedContent: `version from operator ${index}`,
    }, `operator-${index}`)));
    const gateKey = 701_105;
    await admin.query(`CREATE FUNCTION ${schema}.hold_artifact_version() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_advisory_xact_lock(${gateKey}); RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER hold_artifact_version BEFORE INSERT ON ${schema}.chat_generated_artifacts
      FOR EACH ROW WHEN (NEW.supersedes_artifact_id IS NOT NULL) EXECUTE FUNCTION ${schema}.hold_artifact_version()`);
    const barrier = await admin.connect();
    let held = false;
    try {
      await barrier.query("SELECT pg_advisory_lock($1)", [gateKey]);
      held = true;
      const settled = Promise.allSettled(services.map((service, index) => service.applyProposal(proposals[index]!.proposalId, "default", `operator-${index}`)));
      let completed: PromiseSettledResult<unknown>[] | undefined;
      void settled.then((results) => { completed = results; });
      try {
        const deadline = Date.now() + 10_000;
        while (true) {
          const blocked = await admin.query("SELECT count(DISTINCT application_name)::int AS count FROM pg_stat_activity WHERE application_name = ANY($1) AND wait_event_type = 'Lock'", [["document-apply-a", "document-apply-b"]]);
          if (blocked.rows[0].count === 2) break;
          assert.equal(completed, undefined, "both writers must reach the database lock barrier before finishing");
          assert.ok(Date.now() < deadline, "both independent writers must reach a real database lock wait");
          await delay(20);
        }
      } finally {
        await barrier.query("SELECT pg_advisory_unlock($1)", [gateKey]);
        held = false;
      }
      const results = await settled;
      const successors = await admin.query(`SELECT artifact_id, version::int AS version FROM ${schema}.chat_generated_artifacts WHERE supersedes_artifact_id = $1`, [base.artifactId]);
      assert.equal(successors.rowCount, 1, "one base may have only one direct document-edit successor");
      assert.equal(successors.rows[0].version, 2);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.filter((result) => result.status === "rejected");
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0]!.reason instanceof ConflictError);
      const decisions = await Promise.all(proposals.map((proposal) => b!.documentPatchProposals.get(proposal.proposalId)));
      assert.deepEqual(decisions.map((proposal) => proposal.state).sort(), ["applied", "conflicted"]);
    } finally {
      if (held) await barrier.query("SELECT pg_advisory_unlock($1)", [gateKey]);
      barrier.release();
      await admin.query(`DROP TRIGGER IF EXISTS hold_artifact_version ON ${schema}.chat_generated_artifacts`);
    }
  });
});
