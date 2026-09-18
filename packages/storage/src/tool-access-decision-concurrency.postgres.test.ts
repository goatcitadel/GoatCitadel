import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createPostgresRemoteStorage } from "./postgres/remote-storage.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const url = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test("hourly tool accounting serializes independent PostgreSQL runtime connections", { skip: !url, timeout: 180_000 }, async () => {
  const scope = await createRemoteWorkerPostgresTestScope(url!, "policy_limit_concurrency");
  const root = await mkdtemp(join(tmpdir(), "gc-policy-limit-concurrency-"));
  const connection = new URL(url!); connection.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
  const applicationB = `gc-policy-limit-b-${scope.schemaName.slice(-8)}`;
  const create = (name: string) => createPostgresRemoteStorage({ connection: { connectionString: connection.toString(),
    database: connection.pathname.slice(1) || "postgres", applicationName: name, pool: { max: 1, connectionTimeoutMs: 10_000 } },
    migrationsTable: "schema_migrations", transcriptsDir: join(root, name, "transcripts"), auditDir: join(root, name, "audit") });
  const firstStorage = create(`gc-policy-limit-a-${scope.schemaName.slice(-8)}`), secondStorage = create(applicationB);
  try {
    await Promise.all([firstStorage.waitUntilReady(), secondStorage.waitUntilReady()]);
    for (const mode of ["session_calls", "global_calls", "global_writes", "rollback"] as const) {
      const writes = mode === "global_writes" || mode === "rollback";
      const input = { toolName: writes ? "shell.exec" : `proof.${mode}`, scope: mode === "session_calls" ? "session" as const : "global" as const,
        agentId: "assistant", sessionId: mode };
      const count = (storage: typeof firstStorage) => writes
        ? storage.toolAccessDecisions.countWritesInLastHourInScope(input)
        : storage.toolAccessDecisions.countToolCallsInLastHourInScope(input);
      const baseline = await count(firstStorage);
      const record = (storage: typeof firstStorage, second = false) => storage.toolAccessDecisions.record({
        toolName: writes && second ? "fs.write" : input.toolName, agentId: input.agentId, sessionId: input.sessionId,
        allowed: true, requiresApproval: false, riskLevel: writes ? "danger" : "caution", reasonCodes: [], countsTowardLimits: true });
      let release!: () => void, signalHeld!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), held = new Promise<void>(resolve => { signalHeld = resolve; });
      const first = firstStorage.runImmediateTransaction(async () => {
        assert.equal(await count(firstStorage), baseline); signalHeld(); await gate;
        await record(firstStorage); if (mode === "rollback") throw new Error("controlled rollback");
      });
      const firstOutcome = first.then(() => "committed", error => error as Error);
      let second: Promise<boolean> | undefined;
      try {
        await Promise.race([held, first.then(() => { throw new Error("first transaction ended before its barrier"); })]);
        second = secondStorage.runImmediateTransaction(async () => {
          if (await count(secondStorage) >= baseline + 1) return false;
          await record(secondStorage, true); return true;
        });
        const deadline = Date.now() + 10_000;
        let blocked = false;
        while (Date.now() < deadline) {
          const result = await scope.scopedPool.query<{ waiting: boolean }>(
            "SELECT wait_event_type = 'Lock' AND wait_event = 'advisory' AS waiting FROM pg_stat_activity WHERE application_name = $1", [applicationB]);
          if (result.rows.some(row => row.waiting)) { blocked = true; break; }
          await delay(20);
        }
        assert.equal(blocked, true, `${mode}: second connection must wait for the accounting transaction`);
      } finally {
        release();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
      const outcome = await firstOutcome;
      if (mode === "rollback") assert.match(String(outcome), /controlled rollback/u); else assert.equal(outcome, "committed");
      assert.equal(await second, mode === "rollback");
      assert.equal(await count(secondStorage), baseline + 1);
    }
  } finally {
    await Promise.allSettled([firstStorage.close(), secondStorage.close()]);
    await scope.teardown(); await rm(root, { recursive: true, force: true });
  }
});
