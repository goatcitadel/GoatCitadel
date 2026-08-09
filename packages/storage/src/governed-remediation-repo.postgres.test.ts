import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
  type GovernedRemediationScope,
  type GovernedRemediationStateRecord,
} from "@goatcitadel/contracts";
import { GovernedRemediationRepository } from "./governed-remediation-repo.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;

const scope: GovernedRemediationScope = {
  schemaVersion: GOVERNED_REMEDIATION_SCOPE_SCHEMA_VERSION,
  deploymentId: "deployment-postgres",
  scopeKind: "workspace",
  scopeId: "workspace-postgres",
  targetId: "connection-postgres",
};

function state(overrides: Partial<GovernedRemediationStateRecord> = {}): GovernedRemediationStateRecord {
  return {
    schemaVersion: GOVERNED_REMEDIATION_STATE_SCHEMA_VERSION,
    remediationId: "remediation-postgres",
    workspaceId: "workspace-postgres",
    sessionId: "session-postgres",
    sourceTurnId: "turn-postgres",
    durableRunId: "run-postgres",
    blockedCheckpointId: "checkpoint-postgres",
    recipeId: "recipe.postgres",
    recipeVersion: 1,
    scope,
    state: "blocked",
    revision: 1,
    expectedWaitingRunVersion: 1,
    expectedOwnerRevision: null,
    promptId: null,
    promptExpiresAt: null,
    approvalId: null,
    effectId: null,
    latestReceiptId: null,
    failureId: null,
    reconciliationId: null,
    createdAt: "2026-08-08T20:00:00.000Z",
    updatedAt: "2026-08-08T20:00:00.000Z",
    ...overrides,
  };
}

describe("GovernedRemediationRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "enforces exact owner scope, idempotent CAS, immutable rows, and secret-free columns",
    { timeout: 300_000 },
    async () => {
      const testScope = await createRemoteWorkerPostgresTestScope(postgresConnectionString!, "governed_remediation");
      try {
        const repo = new GovernedRemediationRepository(testScope.db);
        repo.createState({ ownerId: "owner-postgres", record: state(), idempotencyKey: "create-postgres" });
        const offered = state({ state: "offered", revision: 2, updatedAt: "2026-08-08T20:01:00.000Z" });
        const first = repo.transitionState({
          ownerId: "owner-postgres",
          expectedRevision: 1,
          next: offered,
          idempotencyKey: "transition-postgres",
          recordedAt: offered.updatedAt,
        });
        const replay = repo.transitionState({
          ownerId: "owner-postgres",
          expectedRevision: 1,
          next: offered,
          idempotencyKey: "transition-postgres",
          recordedAt: offered.updatedAt,
        });
        assert.equal(first.replayed, false);
        assert.equal(replay.replayed, true);
        assert.equal(
          repo.findScopedState({ remediationId: offered.remediationId, ownerId: "owner-postgres", scope })?.record
            .revision,
          2,
        );
        assert.equal(
          repo.findScopedState({ remediationId: offered.remediationId, ownerId: "wrong-owner", scope }),
          undefined,
        );
        assert.throws(
          () =>
            testScope.db
              .prepare(
                `UPDATE governed_remediation_states
                 SET state = 'manual_required', revision = 3, updated_at = '2026-08-08T20:02:00.000Z'`,
              )
              .run(),
          /CAS|binding/u,
        );

        const columns = (
          testScope.db
            .prepare(
              `SELECT table_name, column_name FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name LIKE 'governed_remediation_%'`,
            )
            .all() as Array<{ table_name: string; column_name: string }>
        ).map((row) => `${row.table_name}.${row.column_name}`);
        for (const forbidden of ["secret", "credential_value", "oauth_code", "command", "payload", "raw_error"]) {
          assert.equal(
            columns.some((column) => column.toLowerCase().includes(forbidden)),
            false,
            `found forbidden ${forbidden} column`,
          );
        }
      } finally {
        await testScope.teardown();
      }
    },
  );
});
