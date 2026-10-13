import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { it } from "node:test";
import { Pool } from "pg";
import { ChatSessionLifecycleRepository } from "./chat-session-lifecycle-repo.js";
import { SessionMutationAdmissionRepository } from "./session-mutation-admission-repo.js";
import { PostgresDatabaseClient } from "./postgres/client.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { POSTGRES_MIGRATIONS } from "./postgres/migrations.js";
import { runPostgresMigrations } from "./postgres/migrator.js";
import { CronJobRepository } from "./cron-job-repo.js";
import { hasCurrentCronCreatorAuthority } from "@goatcitadel/contracts";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
for (const mode of ["fresh", "upgrade"] as const) {
  it(
    `preserves feature admission authority on real PostgreSQL (${mode})`,
    {
      skip: connectionString ? false : "GOATCITADEL_TEST_POSTGRES_URL is required for live PostgreSQL evidence",
      timeout: 300_000,
    },
    async (context) => {
      assert.ok(connectionString);
      const schema = `feature_quality_${randomUUID().replaceAll("-", "")}`;
      const admin = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 10_000,
        query_timeout: 60_000,
        statement_timeout: 55_000,
      });
      const scoped = new URL(connectionString);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      const database = decodeURIComponent(scoped.pathname.slice(1));
      const client = new PostgresDatabaseClient(
        { connectionString: scoped.toString(), database },
        {
          pool: new Pool({
            connectionString: scoped.toString(),
            max: 2,
            connectionTimeoutMillis: 10_000,
            query_timeout: 60_000,
            statement_timeout: 55_000,
          }),
        },
      );
      let db: PostgresSyncDatabaseClient | undefined;
      try {
        await admin.query(`CREATE SCHEMA ${schema}`);
        if (mode === "upgrade")
          await runPostgresMigrations(
            client,
            POSTGRES_MIGRATIONS.filter((migration) => migration.version <= 200),
          );
        const result = await runPostgresMigrations(client);
        assert.equal(result.latestVersion, POSTGRES_MIGRATIONS.at(-1)?.version);
        context.diagnostic(`${mode}: migrations reached ${result.latestVersion}`);
        assert.deepEqual((await runPostgresMigrations(client)).appliedVersions, []);
        context.diagnostic(`${mode}: repeated startup validated the canonical schema`);
        db = new PostgresSyncDatabaseClient({
          connectionString: scoped.toString(),
          database,
          applicationName: "feature-quality-proof",
          pool: { max: 1, connectionTimeoutMs: 10_000 },
        });
        const columns = db
          .prepare(
            "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = 'chat_routed_context_snapshots'",
          )
          .all<{ column_name: string; is_nullable: string }>(schema);
        assert.equal(columns.find((column) => column.column_name === "capability_profile_id")?.is_nullable, "YES");
        assert.ok(columns.some((column) => column.column_name === "admission_id"));
        assert.ok(
          db
            .prepare(
              "SELECT column_name FROM information_schema.columns WHERE table_schema = ? AND table_name = 'chat_heartbeat_occurrences' AND column_name = 'feature_reference_sha256'",
            )
            .get(schema),
        );
        const jobs = new CronJobRepository(db);
        const spec = {
          jobId: "creator-proof",
          name: "Creator proof",
          action: "agent_turn" as const,
          schedule: "0 12 * * * UTC",
          enabled: true,
          actionConfig: {
            agentTurn: {
              prompt: "Read current status",
              createdBy: {
                operatorId: "operator-a",
                authActorId: "operator-a",
                permissionProfileId: "trusted_local_power",
              },
            },
          },
        };
        const imported = jobs.reconcileSpec(spec);
        assert.equal(imported.creatorAuthority, undefined);
        assert.throws(() =>
          db!.prepare("UPDATE cron_jobs SET creator_authority_json = ? WHERE job_id = ?").run("{}", spec.jobId),
        );
        assert.throws(
          () =>
            jobs.bindCreatorAuthority(spec.jobId, imported.revision, {
              actorId: "foreign",
              source: "authenticated_operator",
            }),
          /canonical actor/u,
        );
        const reviewed = jobs.bindCreatorAuthority(spec.jobId, imported.revision, {
          actorId: "operator-a",
          source: "authenticated_operator",
        });
        assert.equal(hasCurrentCronCreatorAuthority(reviewed), true);
        assert.equal(hasCurrentCronCreatorAuthority(new CronJobRepository(db).get(spec.jobId)!), true);
        const changed = jobs.reconcileSpec({
          ...spec,
          actionConfig: { agentTurn: { ...spec.actionConfig.agentTurn, prompt: "Changed objective" } },
        });
        assert.equal(changed.creatorAuthority, undefined);
        context.diagnostic(
          `${mode}: unreviewed imports, persisted creator authority and changed-action invalidation passed`,
        );
        const lifecycle = new ChatSessionLifecycleRepository(db);
        lifecycle.initialize({
          workspaceId: "workspace-a",
          sessionId: "session-a",
          actorId: "operator-a",
          idempotencyKey: "initialize",
          correlationId: "initialize",
        });
        const repo = new SessionMutationAdmissionRepository(db);
        const admitted = repo.admit({
          workspaceId: "workspace-a",
          sessionId: "session-a",
          turnId: "turn-a",
          runtimeOwnerId: "test-runtime",
          admissionKind: "turn_write",
          aggregateRevision: 1,
          controllerGeneration: 1,
          actorKind: "system",
          actorId: "system:test",
          operation: "chat.turn.execute",
          materialSha256: "a".repeat(64),
          idempotencyKey: "admit",
          correlationId: "admit",
        }).admission;
        const identity = {
          admissionId: admitted.admissionId,
          workspaceId: admitted.workspaceId,
          sessionId: admitted.sessionId,
          sessionIncarnationId: admitted.sessionIncarnationId,
          turnId: admitted.turnId!,
        };
        const input = {
          ...identity,
          requestRuntimeClaim: {
            runtimeOwnerId: admitted.runtimeOwnerId!,
            leaseRevision: admitted.runtimeLeaseRevision!,
          },
          references: {
            version: "chat.turn.feature-references.v1" as const,
            providerRoute: { primary: { providerId: "local", model: "test" }, fingerprint: "b".repeat(64) },
          },
        };
        assert.throws(() => repo.bindFeatureReferences({ ...input, requestRuntimeClaim: undefined }));
        const bound = repo.bindFeatureReferences(input);
        assert.deepEqual(repo.bindFeatureReferences(input), bound);
        assert.deepEqual(new SessionMutationAdmissionRepository(db).findFeatureReferences(identity), bound);
        assert.throws(() => repo.findFeatureReferences({ ...identity, sessionIncarnationId: "foreign" }));
        assert.throws(
          () => db!.prepare("UPDATE chat_turn_feature_references SET reference_sha256 = ?").run("c".repeat(64)),
          /immutable/u,
        );
        repo.closeTurnWrite({
          ...identity,
          requestRuntimeClaim: input.requestRuntimeClaim,
          status: "completed",
          actorId: "system:test",
          idempotencyKey: "settle",
          correlationId: "settle",
        });
        assert.deepEqual(repo.findFeatureReferences(identity), bound);
        assert.throws(() => repo.bindFeatureReferences(input), /closed/u);
        context.diagnostic(`${mode}: exact admission binding, replay, immutability and settlement passed`);
      } finally {
        try {
          db?.close();
        } finally {
          try {
            await client.close();
          } finally {
            try {
              await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
            } finally {
              await admin.end();
            }
          }
        }
      }
    },
  );
}
