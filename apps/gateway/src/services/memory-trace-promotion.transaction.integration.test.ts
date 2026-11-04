import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError } from "@goatcitadel/contracts";
import { createPostgresRemoteStorage, createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { acquireGatewayLivePostgresTestLease } from "../test/live-postgres-suite-lock.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { RealtimeEventService } from "./realtime-event-service.js";

const postgresUrl = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();

async function observeBarrier(ready: Promise<void>, settled: Promise<PromiseSettledResult<unknown>[]>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ready,
      settled.then((results) => {
        const details = results.map((result) => result.status === "fulfilled" ? "fulfilled before barrier"
          : String(result.reason instanceof Error ? result.reason.message : result.reason).slice(0, 300));
        throw new Error(`Operation settled before reaching the fixture barrier: ${details.join("; ")}`);
      }),
      new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Fixture barrier was not reached within 10 seconds.")), 10_000); }),
    ]);
  } finally { if (timeout) clearTimeout(timeout); }
}

for (const dialect of ["sqlite", "postgres"] as const) {
  describe.skipIf(dialect === "postgres" && !postgresUrl)(`trace promotion transactions on real ${dialect}`, { timeout: 120_000 }, () => {
    const stores: ReturnType<typeof createSqliteAsyncStorage>[] = [];
    const remotes: ReturnType<typeof createPostgresRemoteStorage>[] = [];
    let local: Storage | undefined;
    let admin: Pool | undefined;
    let lease: Awaited<ReturnType<typeof acquireGatewayLivePostgresTestLease>> | undefined;
    let root: string;
    const schema = `memory_promotion_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    let beforeTransaction: (() => Promise<void>) | undefined;
    let afterTransactionWork: (() => Promise<void>) | undefined;
    let beforeRejectWrite: (() => Promise<void>) | undefined;
    const emitted: Record<string, unknown>[] = [];
    const services: MemoryLifecycleService[] = [];
    let candidate: Awaited<ReturnType<MemoryLifecycleService["proposeTraceMemoryCandidate"]>>;
    let key: string;

    function makeService(
      store: ReturnType<typeof createSqliteAsyncStorage>,
      publish?: (channel: string, topic: string, payload: Record<string, unknown>) => Promise<unknown>,
    ) {
      const sql = {
        dialect: store.gatewaySql.dialect,
        prepare: (statementSql: string) => {
          const statement = store.gatewaySql.prepare(statementSql);
          if (!/SET\s+status\s*=\s*'rejected'/u.test(statementSql)) return statement;
          return new Proxy(statement, {
            get(target, member, receiver) {
              if (member !== "run") return Reflect.get(target, member, receiver);
              return async (...params: unknown[]) => {
                await beforeRejectWrite?.();
                return await target.run(...params);
              };
            },
          });
        },
        exec: (statementSql: string) => store.gatewaySql.exec(statementSql),
        runImmediateTransaction: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> => {
          await beforeTransaction?.();
          return await store.gatewaySql.runImmediateTransaction(async () => {
            const result = await work();
            await afterTransactionWork?.();
            return result;
          });
        },
      };
      return new MemoryLifecycleService({
        context: {} as never, learned: {} as never, maintenance: {} as never,
        admin: {
          gatewaySql: sql, memoryQualityIssues: store.memoryQualityIssues,
          tryParseJson: (raw: string | null | undefined, fallback: unknown) => {
            try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
          },
          requireFeatureEnabled: () => undefined,
          publishRealtime: async (channel, topic, payload) => {
            if (publish) return await publish(channel, topic, payload);
            emitted.push(payload);
          },
        },
        resolveLearnedMemoryPolicy: async () => ({ allowWrite: true, reason: "allowed" }),
        readTranscriptOrEmpty: async () => [],
      });
    }

    beforeAll(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), "goat-memory-promotion-"));
      if (dialect === "sqlite") {
        local = new Storage({ dbPath: path.join(root, "runtime.sqlite"), transcriptsDir: path.join(root, "transcripts"), auditDir: path.join(root, "audit") });
        const store = createSqliteAsyncStorage(local);
        stores.push(store, store);
      } else {
        lease = await acquireGatewayLivePostgresTestLease(postgresUrl!);
        admin = new Pool({ connectionString: postgresUrl, max: 2, connectionTimeoutMillis: 10_000 });
        await admin.query(`CREATE SCHEMA ${schema}`);
        const scoped = new URL(postgresUrl!);
        scoped.searchParams.set("options", `-csearch_path=${schema}`);
        for (const worker of ["a", "b"]) {
          const remote = createPostgresRemoteStorage({
            connection: { connectionString: scoped.toString(), database: scoped.pathname.slice(1), applicationName: `memory-promotion-${worker}`, pool: { max: 2 } },
            migrationsTable: "schema_migrations", transcriptsDir: path.join(root, worker), auditDir: path.join(root, worker), startupWaitTimeoutMs: 120_000,
          });
          remotes.push(remote);
          await remote.waitUntilReady();
          stores.push(remote);
        }
      }
      services.push(...stores.map((store) => makeService(store)));
      // Warm existing lazy learning DDL before competing transactions start.
      await services[0]!.createMemoryLearning({ key: "fixture.seed", type: "repo_fact", insight: "Synthetic fixture setup.", authority: "operator" }, "fixture-operator");
    }, 180_000);

    afterAll(async () => {
      await Promise.all(remotes.map((remote) => remote.close()));
      local?.close();
      if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
      if (root) await fs.rm(root, { recursive: true, force: true });
      await lease?.release();
    }, 120_000);

    beforeEach(async () => {
      beforeTransaction = undefined;
      afterTransactionWork = undefined;
      beforeRejectWrite = undefined;
      key = `trace.fixture.${randomUUID()}`;
      candidate = await services[0]!.proposeTraceMemoryCandidate({
        workspaceId: "default", candidateType: "fact", sourceText: `Synthetic trace ${key}`,
        proposedInsight: `Synthetic approved insight for ${key}.`, confidence: 0.82,
        sourceRefs: [{ sourceType: "run", sourceRef: "fixture-run" }], metadata: { key },
      }, "fixture-agent");
      emitted.length = 0;
    });

    const learnings = () => stores[0]!.gatewaySql.prepare("SELECT learning_id FROM memory_learnings WHERE learning_key = ?").all<{ learning_id: string }>(key);

    it("admits only one of two competing promotions after both initial reads complete", async () => {
      let entered = 0;
      let bothReady!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { bothReady = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      beforeTransaction = async () => { if (++entered === 2) bothReady(); await gate; };
      const settled = Promise.allSettled(services.map((service, index) => service.promoteTraceMemoryCandidate(candidate.candidateId, `operator-${index}`)));
      try { await observeBarrier(ready, settled); } finally { release(); }
      const results = await settled;
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
      const rows = await learnings();
      expect(rows).toHaveLength(1);
      expect(await services[0]!.getTraceMemoryCandidate(candidate.candidateId, "default")).toMatchObject({ status: "promoted", promotedLearningId: rows[0]!.learning_id });
    });

    it("preserves rejection which wins before a stale promotion enters its transaction", async () => {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      beforeTransaction = async () => { entered(); await gate; };
      const settled = Promise.allSettled([services[0]!.promoteTraceMemoryCandidate(candidate.candidateId, "operator-promote")]);
      try {
        await observeBarrier(ready, settled);
        expect(await services[1]!.rejectTraceMemoryCandidate(candidate.candidateId, "operator-reject")).toMatchObject({ status: "rejected" });
      } finally { release(); }
      const [result] = await settled;
      expect(await services[0]!.getTraceMemoryCandidate(candidate.candidateId, "default")).toMatchObject({ status: "rejected" });
      expect(await learnings()).toHaveLength(0);
      expect(result?.status).toBe("rejected");
    });

    it("does not report rejection after a concurrent promotion wins the candidate CAS", async () => {
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      beforeRejectWrite = async () => { entered(); await gate; };
      const settled = Promise.allSettled([services[1]!.rejectTraceMemoryCandidate(candidate.candidateId, "operator-reject")]);
      try { await observeBarrier(ready, settled); await services[0]!.promoteTraceMemoryCandidate(candidate.candidateId, "operator-promote"); }
      finally { release(); }
      const [result] = await settled;
      expect(result?.status).toBe("rejected");
      expect(await services[0]!.getTraceMemoryCandidate(candidate.candidateId, "default")).toMatchObject({ status: "promoted" });
      expect(await learnings()).toHaveLength(1);
      expect(emitted.some((event) => event.type === "memory_trace_candidate_rejected")).toBe(false);
    });

    it("does not emit a learning-created signal when promotion rolls back before commit", async () => {
      const retainedBefore = await stores[0]!.realtimeEvents.list(100);
      const realtime = new RealtimeEventService({ storage: stores[0]!, getGatewayNodeId: () => "fixture-node" });
      const live: unknown[] = [];
      const unsubscribe = realtime.subscribeRealtime((event) => {
        if (event.payload.type === "memory_learning_created") live.push(event);
      });
      const service = makeService(stores[0]!, (channel, topic, payload) => realtime.publishRealtime(channel, topic, payload));
      afterTransactionWork = async () => { throw new Error("fixture failure before promotion commit"); };
      try {
        await expect(service.promoteTraceMemoryCandidate(candidate.candidateId, "operator-promote")).rejects.toThrow("fixture failure before promotion commit");
        expect(await services[0]!.getTraceMemoryCandidate(candidate.candidateId, "default")).toMatchObject({ status: "proposed" });
        expect(await learnings()).toHaveLength(0);
        expect(await stores[0]!.realtimeEvents.list(100)).toEqual(retainedBefore);
        expect(live).toHaveLength(0);
      } finally {
        afterTransactionWork = undefined;
        unsubscribe();
      }
    });

    it("emits a successful learning-created signal only after canonical promotion commits", async () => {
      const realtime = new RealtimeEventService({ storage: stores[0]!, getGatewayNodeId: () => "fixture-node" });
      const live: Record<string, unknown>[] = [];
      const observed: Promise<{ status: string; promoted_learning_id: string } | undefined>[] = [];
      const unsubscribe = realtime.subscribeRealtime((event) => {
        if (event.payload.type !== "memory_learning_created") return;
        live.push(event.payload);
        observed.push(stores[1]!.gatewaySql.prepare("SELECT status, promoted_learning_id FROM memory_trace_candidates WHERE candidate_id = ?")
          .get<{ status: string; promoted_learning_id: string }>(candidate.candidateId));
      });
      const service = makeService(stores[0]!, (channel, topic, payload) => realtime.publishRealtime(channel, topic, payload));
      afterTransactionWork = async () => { expect(live).toHaveLength(0); };
      try {
        const learning = await service.promoteTraceMemoryCandidate(candidate.candidateId, "operator-promote");
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({ learningId: learning.learningId, status: "trusted" });
        expect(await Promise.all(observed)).toEqual([{ status: "promoted", promoted_learning_id: learning.learningId }]);
      } finally {
        afterTransactionWork = undefined;
        unsubscribe();
      }
    });

    it("commits only one correction when two operators supersede the same active learning", async () => {
      const previous = await services[0]!.createMemoryLearning({
        workspaceId: "default",
        key: `base.${key}`,
        type: "repo_fact",
        insight: `Original ${key}`,
        authority: "operator",
      }, "fixture-operator");
      let entered = 0;
      let bothReady!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { bothReady = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      beforeTransaction = async () => { if (++entered === 2) bothReady(); await gate; };
      const settled = Promise.allSettled(services.map((service, index) =>
        service.supersedeMemoryLearning(previous.learningId, {
          workspaceId: "default",
          key,
          type: "repo_fact",
          insight: `Conflicting correction ${index} for ${key}`,
          authority: "operator",
        }, `fixture-operator-${index}`),
      ));
      try { await observeBarrier(ready, settled); } finally { release(); }
      const results = await settled;
      const rows = await learnings();
      expect(rows).toHaveLength(1);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.filter((result) => result.status === "rejected");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
      expect(await stores[1]!.gatewaySql.prepare(
        "SELECT status, superseded_by_id FROM memory_learnings WHERE learning_id = ?",
      ).get(previous.learningId)).toMatchObject({ status: "superseded", superseded_by_id: rows[0]!.learning_id });
      expect(emitted.filter((event) => event.type === "memory_learning_superseded")).toHaveLength(1);

      const correction = {
        workspaceId: "default",
        key,
        type: "repo_fact" as const,
        insight: `Follow-up correction for ${key}`,
        authority: "operator" as const,
      };
      await expect(services[0]!.supersedeMemoryLearning(previous.learningId, correction))
        .rejects.toBeInstanceOf(ConflictError);
      expect(await learnings()).toEqual(rows);
      expect(emitted.filter((event) => event.type === "memory_learning_created" && event.status === "trusted"))
        .toHaveLength(2); // Original learning and winning correction.

      const chained = await services[0]!.supersedeMemoryLearning(rows[0]!.learning_id, correction);
      expect(chained.previous).toMatchObject({ status: "superseded", supersededById: chained.next.learningId });
      expect(chained.next.status).toBe("trusted");
    });

    it("does not emit a learning-created signal when supersession rolls back before commit", async () => {
      const previous = await services[0]!.createMemoryLearning({ workspaceId: "default", key: `base.${key}`, type: "repo_fact", insight: `Original ${key}`, authority: "operator" }, "operator");
      const retainedBefore = await stores[0]!.realtimeEvents.list(100);
      const realtime = new RealtimeEventService({ storage: stores[0]!, getGatewayNodeId: () => "fixture-node" });
      const live: unknown[] = [];
      const unsubscribe = realtime.subscribeRealtime((event) => { if (event.payload.type === "memory_learning_created") live.push(event); });
      const service = makeService(stores[0]!, (channel, topic, payload) => realtime.publishRealtime(channel, topic, payload));
      afterTransactionWork = async () => { throw new Error("fixture failure before supersession commit"); };
      try {
        await expect(service.supersedeMemoryLearning(previous.learningId, { workspaceId: "default", key, type: "repo_fact", insight: `Correction ${key}`, authority: "operator" }, "operator"))
          .rejects.toThrow("fixture failure before supersession commit");
        expect(await learnings()).toHaveLength(0);
        expect(await stores[1]!.gatewaySql.prepare("SELECT status, superseded_by_id FROM memory_learnings WHERE learning_id = ?").get(previous.learningId))
          .toMatchObject({ status: "trusted", superseded_by_id: null });
        expect(await stores[0]!.realtimeEvents.list(100)).toEqual(retainedBefore);
        expect(live).toHaveLength(0);
      } finally {
        afterTransactionWork = undefined;
        unsubscribe();
      }
    });

    it("emits a successful learning-created signal only after canonical supersession commits", async () => {
      const previous = await services[0]!.createMemoryLearning({ workspaceId: "default", key: `base.${key}`, type: "repo_fact", insight: `Original ${key}`, authority: "operator" }, "operator");
      const realtime = new RealtimeEventService({ storage: stores[0]!, getGatewayNodeId: () => "fixture-node" });
      const live: Record<string, unknown>[] = [];
      const observed: Promise<{ status: string; superseded_by_id: string | null } | undefined>[] = [];
      const unsubscribe = realtime.subscribeRealtime((event) => {
        if (event.payload.type !== "memory_learning_created") return;
        live.push(event.payload);
        observed.push(stores[1]!.gatewaySql.prepare("SELECT status, superseded_by_id FROM memory_learnings WHERE learning_id = ?")
          .get<{ status: string; superseded_by_id: string | null }>(previous.learningId));
      });
      const service = makeService(stores[0]!, (channel, topic, payload) => realtime.publishRealtime(channel, topic, payload));
      afterTransactionWork = async () => { expect(live).toHaveLength(0); };
      try {
        const result = await service.supersedeMemoryLearning(previous.learningId, { workspaceId: "default", key, type: "repo_fact", insight: `Correction ${key}`, authority: "operator" }, "operator");
        expect(live).toHaveLength(1);
        expect(live[0]).toMatchObject({ learningId: result.next.learningId, status: "trusted" });
        expect(await Promise.all(observed)).toEqual([{ status: "superseded", superseded_by_id: result.next.learningId }]);
      } finally {
        afterTransactionWork = undefined;
        unsubscribe();
      }
    });
  });
}
