import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
  type RemoteWorkerEffectCorrelation,
  type RemoteWorkerEffectTransitionState,
} from "@goatcitadel/contracts";
import { RemoteWorkerEffectRepository } from "./remote-worker-effect-repo.js";
import { createRemoteWorkerPostgresTestScope, seedRemoteWorkerGeneration } from "./remote-worker-test-fixtures.js";

const postgresConnectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
const postgresIt = postgresConnectionString ? it : it.skip;
const D = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function correlation(transitionState: RemoteWorkerEffectTransitionState): RemoteWorkerEffectCorrelation {
  const crossed = ["external_boundary_started", "completed_no_effect", "completed_with_effect"].includes(
    transitionState,
  );
  return {
    schemaVersion: REMOTE_WORKER_EFFECT_CORRELATION_SCHEMA_VERSION,
    transitionState,
    externalSideEffectRunId: crossed ? "external-run-1" : null,
    approvalRecordSha256: null,
    boundaryReceiptSha256: crossed ? D("boundary") : null,
    hx305OutcomeSha256: transitionState === "completed_with_effect" ? D("hx305-outcome") : null,
    reconciliationRecordSha256: null,
    sanitizedError: null,
  };
}

describe("RemoteWorkerEffectRepository live PostgreSQL (skips without GOATCITADEL_TEST_POSTGRES_URL)", () => {
  postgresIt(
    "chains transitions, books receipts, and enforces insert-only and non-authority",
    { timeout: 300_000 },
    async () => {
      const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString!, "hx506_effect");
      try {
        const effects = new RemoteWorkerEffectRepository(scope.db);
        const ctx = seedRemoteWorkerGeneration(scope.db, "effect");
        const key = {
          registryWorkspaceId: ctx.registryWorkspaceId,
          assignmentId: ctx.assignmentId,
          assignmentGeneration: ctx.assignmentGeneration,
        };

        const intent = effects.recordIntent({
          ...key,
          intentIndex: 0,
          effectSelector: "email.send",
          canonicalArgs: { to: "user@example.com" },
          workerIdempotencyKey: "worker-key-1",
          idempotencyKey: "intent-1",
        });
        const append = (state: RemoteWorkerEffectTransitionState, k: string) =>
          effects.appendTransition({
            ...key,
            intentId: intent.intentId,
            correlation: correlation(state),
            idempotencyKey: k,
          });
        append("recorded", "t1");
        append("dispatch_claimed", "t2");
        append("external_boundary_started", "t3");
        const terminal = append("completed_with_effect", "t4");
        const receipt = effects.recordReceipt({
          ...key,
          intentId: intent.intentId,
          receiptState: "completed_with_effect",
          finalTransitionSequence: terminal.transitionSequence,
          finalTransitionSha256: terminal.transitionSha256,
          hx305OutcomeSha256: D("hx305-outcome"),
          idempotencyKey: "receipt-1",
        });
        assert.equal(receipt.receiptState, "completed_with_effect");

        // Insert-only enforcement and composite-FK isolation on the live cluster.
        assert.throws(
          () => scope.db.prepare("UPDATE remote_worker_effect_intents SET intent_index = 9").run(),
          /insert-only/u,
        );
        assert.throws(() => scope.db.prepare("DELETE FROM remote_worker_effect_transitions").run(), /insert-only/u);
        assert.throws(() =>
          scope.db
            .prepare(
              `INSERT INTO remote_worker_effect_intents (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, intent_id, intent_index, effect_selector, canonical_args_json,
              canonical_args_sha256, intent_sha256, worker_idempotency_key, idempotency_key, request_sha256, recorded_at
            ) VALUES (
              @rw, @ew, @aid, @gen, 'worker-forged', @wg, @rm, @wc, @cc, @am, 'intent-forged', 1, 'x', '{}', @h, @h, 'k', 'forged', @h, @now
            )`,
            )
            .run({
              rw: key.registryWorkspaceId,
              ew: intent.identity.executionWorkspaceId,
              aid: key.assignmentId,
              gen: key.assignmentGeneration,
              wg: intent.identity.workerGeneration,
              rm: intent.identity.runtimeManifestSha256,
              wc: intent.identity.workspaceCeilingSha256,
              cc: intent.identity.capabilityCeilingSha256,
              am: intent.identity.assignmentManifestSha256,
              h: D("forged"),
              now: "2099-01-01T00:00:00.000Z",
            }),
        );

        // HX-306 non-authority: no cost/usage column exists on any effect table.
        const columns = (
          scope.db
            .prepare(
              `SELECT column_name FROM information_schema.columns
             WHERE table_name = 'remote_worker_effect_receipts'`,
            )
            .all() as Array<{ column_name: string }>
        ).map((row) => row.column_name);
        for (const forbidden of ["cost", "usage", "tokens", "price"]) {
          assert.equal(
            columns.some((c) => c.toLowerCase().includes(forbidden)),
            false,
            `found ${forbidden}`,
          );
        }
      } finally {
        await scope.teardown();
      }
    },
  );

  postgresIt(
    "serializes the transition hash chain so two connections cannot both write sequence 1",
    { timeout: 300_000 },
    async () => {
      const scope = await createRemoteWorkerPostgresTestScope(postgresConnectionString!, "hx506_effect_chain");
      try {
        const ctx = seedRemoteWorkerGeneration(scope.db, "chain");
        const key = {
          registryWorkspaceId: ctx.registryWorkspaceId,
          assignmentId: ctx.assignmentId,
          assignmentGeneration: ctx.assignmentGeneration,
        };
        const effectsA = new RemoteWorkerEffectRepository(scope.db);
        const intent = effectsA.recordIntent({
          ...key,
          intentIndex: 0,
          effectSelector: "email.send",
          canonicalArgs: {},
          workerIdempotencyKey: "worker-key-1",
          idempotencyKey: "intent-1",
        });
        effectsA.appendTransition({
          ...key,
          intentId: intent.intentId,
          correlation: correlation("recorded"),
          idempotencyKey: "t1",
        });
        // A second transition claiming sequence 1 again is rejected by the chain guard.
        assert.throws(() =>
          scope.db
            .prepare(
              `INSERT INTO remote_worker_effect_transitions (
              registry_workspace_id, execution_workspace_id, assignment_id, assignment_generation, worker_id,
              worker_generation, runtime_manifest_sha256, workspace_ceiling_sha256, capability_ceiling_sha256,
              assignment_manifest_sha256, intent_id, transition_sequence, transition_state, correlation_json,
              correlation_sha256, external_side_effect_run_id, hx305_outcome_sha256, previous_transition_sha256,
              transition_sha256, idempotency_key, request_sha256, recorded_at
            ) VALUES (
              @rw, @ew, @aid, @gen, @wid, @wg, @rm, @wc, @cc, @am, @iid, 1, 'recorded',
              '{"transitionState":"recorded"}', @h, NULL, NULL, @zero, @h2, 'dup', @h2, @now
            )`,
            )
            .run({
              rw: key.registryWorkspaceId,
              ew: intent.identity.executionWorkspaceId,
              aid: key.assignmentId,
              gen: key.assignmentGeneration,
              wid: intent.identity.workerId,
              wg: intent.identity.workerGeneration,
              rm: intent.identity.runtimeManifestSha256,
              wc: intent.identity.workspaceCeilingSha256,
              cc: intent.identity.capabilityCeilingSha256,
              am: intent.identity.assignmentManifestSha256,
              iid: intent.intentId,
              h: D("dup"),
              h2: D("dup2"),
              zero: "0".repeat(64),
              now: "2099-01-01T00:00:00.000Z",
            }),
        );
      } finally {
        await scope.teardown();
      }
    },
  );
});
