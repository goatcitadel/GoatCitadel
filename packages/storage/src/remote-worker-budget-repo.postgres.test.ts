import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Worker } from "node:worker_threads";
import { Pool } from "pg";
import { workerBudgetFixture } from "./remote-worker-budget-fixture.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";
import { verifyNoDispatchBudgetEvidence } from "./remote-worker-budget-no-dispatch-fixture.js";
import { relatedWorkerBudgetFixture, verifyRelatedWorkerBudgets } from "./remote-worker-budget-related-fixture.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
it(
  "worker budgets preserve canonical no-dispatch evidence on PostgreSQL",
  { skip: !url, timeout: 300_000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(url!, "worker_budget_no_dispatch");
    try {
      verifyNoDispatchBudgetEvidence(scope.db);
      verifyRelatedWorkerBudgets(scope.db, "related-postgres");
    } finally {
      await scope.teardown();
    }
  },
);
it(
  "worker budgets serialize inference and utility dispatch limits across real PostgreSQL connections",
  { skip: !url, timeout: 300_000 },
  async () => {
    assert.ok(url);
    const schema = `worker_budget_${randomUUID().replaceAll("-", "")}`;
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set("options", `-csearch_path=${schema}`);
    const connection = {
      connectionString: scopedUrl.toString(),
      database: decodeURIComponent(scopedUrl.pathname.slice(1)) || "postgres",
      pool: { max: 1, connectionTimeoutMs: 10_000 },
    };
    const admin = new Pool({ connectionString: url, max: 1 });
    const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
    const migrations = new PostgresDatabaseClient(connection, { pool });
    const db = new PostgresSyncDatabaseClient(connection);
    const children: Worker[] = [];
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      db.exec(`SET search_path TO ${schema}`);
      await runPostgresMigrations(migrations, POSTGRES_MIGRATIONS);
      const f = workerBudgetFixture(db, "pg-race");
      f.budget.createGrant(f.grant, "operator-a");
      const related = relatedWorkerBudgetFixture(db, "pg-related-race");
      related.budget.authorizeRelatedAttempt(related.begin("held-one"));
      related.budget.authorizeRelatedAttempt(related.begin("held-two"));
      const operations = [f.admit("first"), f.admit("second"),
        { related: true, ...related.begin("racer-one") }, { related: true, ...related.begin("racer-two") }];
      const signal = new SharedArrayBuffer(4);
      const ext = import.meta.url.endsWith(".js") ? ".js" : ".ts";
      const runs = operations.map((operation) => {
        const worker = new Worker(
          String.raw`
        const { parentPort, workerData } = require('node:worker_threads');
        void (async () => {
          let db;
          try {
            const { tsImport } = await import(workerData.tsx);
            const { PostgresSyncDatabaseClient } = await tsImport(workerData.dbUrl, workerData.dbUrl);
            const { RemoteWorkerBudgetRepository } = await tsImport(workerData.repoUrl, workerData.repoUrl);
            db = new PostgresSyncDatabaseClient(workerData.connection);
            db.exec('SET search_path TO ' + workerData.schema);
            parentPort.postMessage({ kind: 'ready' });
            Atomics.wait(new Int32Array(workerData.signal), 0, 0, 30_000);
            const budgets = new RemoteWorkerBudgetRepository(db);
            let receipt;
            if (workerData.operation.related) {
              try { budgets.authorizeRelatedAttempt(workerData.operation); receipt = true; }
              catch (error) { if (!String(error).includes('insufficient capacity')) throw error; }
            } else receipt = budgets.reserve(workerData.operation);
            parentPort.postMessage({ kind: 'result', won: Boolean(receipt) });
          } catch (error) { parentPort.postMessage({ kind: 'error', error: String(error) }); }
          finally { if (db) db.close(); }
        })();
      `,
          {
            eval: true,
            workerData: {
              connection,
              schema,
              operation,
              signal,
              tsx: import.meta.resolve("tsx/esm/api"),
              dbUrl: new URL(`./postgres/sync${ext}`, import.meta.url).href,
              repoUrl: new URL(`./remote-worker-budget-repo${ext}`, import.meta.url).href,
            },
          },
        );
        children.push(worker);
        let readyResolve!: () => void, readyReject!: (error: Error) => void;
        let resultResolve!: (won: boolean) => void, resultReject!: (error: Error) => void;
        const ready = new Promise<void>((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        const result = new Promise<boolean>((resolve, reject) => {
          resultResolve = resolve;
          resultReject = reject;
        });
        const fail = (error: Error) => {
          readyReject(error);
          resultReject(error);
        };
        void result.catch(() => undefined);
        worker.on("message", (message: { kind: string; won?: boolean; error?: string }) => {
          if (message.kind === "ready") readyResolve();
          else if (message.kind === "result") resultResolve(Boolean(message.won));
          else fail(new Error(message.error));
        });
        worker.on("error", fail);
        worker.on("exit", (code) => {
          if (code !== 0) fail(new Error(`Budget race worker exited ${code}`));
        });
        return { ready, result };
      });
      await Promise.all(runs.map((run) => run.ready));
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0);
      const results = await Promise.all(runs.map((run) => run.result));
      assert.equal(results.slice(0, 2).filter(Boolean).length, 1);
      assert.equal(results.slice(2).filter(Boolean).length, 1);
      const balance = f.budget.listGrants("default", "default").find((item) => item.grant.grantId === f.grant.grantId)!;
      assert.equal(balance.heldRequests, 2);
      assert.equal(balance.heldCostMicrousd, 16_784);
      assert.equal(related.balance().heldRequests, 5);
      assert.equal(related.balance().heldCostMicrousd, 41_960);
      assert.throws(() => db.prepare("UPDATE remote_worker_budget_grants SET max_requests = 100").run(), /immutable/u);
      assert.throws(() => db.prepare("DELETE FROM remote_worker_budget_reservations").run(), /cannot be deleted/u);
    } finally {
      await Promise.all(children.map((worker) => worker.terminate()));
      db.close();
      await migrations.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
