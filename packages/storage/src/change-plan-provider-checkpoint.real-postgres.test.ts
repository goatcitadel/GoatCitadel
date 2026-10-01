import assert from "node:assert/strict";
import { test } from "node:test";
import { ConflictError, type ChangePlanRecord, type ChangePlanRequiredAction } from "@goatcitadel/contracts";
import { ChangePlanRepository, type ChangePlanRepositoryTransitionInput } from "./change-plan-repo.js";
import { PostgresSyncDatabaseClient } from "./postgres/sync.js";
import { createRemoteWorkerPostgresTestScope } from "./remote-worker-test-fixtures.js";

const connectionString = process.env.GOATCITADEL_TEST_POSTGRES_URL?.trim();
test(
  "PostgreSQL admits only an exact committed provider input checkpoint and preserves it across competing CAS",
  { skip: !connectionString, timeout: 120_000 },
  async () => {
    const scope = await createRemoteWorkerPostgresTestScope(connectionString!, "provider_checkpoint");
    const url = new URL(connectionString!);
    url.searchParams.set("options", `-csearch_path=${scope.schemaName}`);
    const second = new PostgresSyncDatabaseClient({
      connectionString: url.toString(),
      database: decodeURIComponent(url.pathname.slice(1)) || "postgres",
      pool: { max: 1 },
    });
    try {
      const first = new ChangePlanRepository(scope.db),
        other = new ChangePlanRepository(second);
      const initial = first.create({
        origin: { workspaceId: "default", surface: "settings", actorId: "fixture-operator" },
        request: {
          kind: "provider_connection",
          providerId: "fixture-provider",
          credentialStorage: "env",
          credentialEnvVar: "FIXTURE_KEY",
          profile: {
            label: "Disposable provider",
            baseUrl: "http://127.0.0.1:9999/v1",
            apiStyle: "openai-chat-completions",
            authMode: "api-key",
            defaultModel: "fixture-model",
            apiKeyEnv: "FIXTURE_KEY",
          },
        },
        adapter: { adapterId: "provider-connection", version: 2 },
        target: { ownerId: "provider_connection", resourceId: "fixture-provider", expectedRevision: 7 },
        title: "Create disposable provider",
        summary: "Public metadata only",
        impact: "No network or credential operation",
        risk: "caution",
        status: "awaiting_confirmation",
        requiredAction: {
          kind: "confirmation",
          actionId: "confirm-profile",
          actionNonce: "profile-nonce",
          title: "Confirm",
          confirmationText: "Confirm public metadata",
        },
      });
      const applying = first.transition(initial.planId, {
        expectedRevision: initial.revision,
        status: "applying",
        actionNonce: initial.requiredAction!.actionNonce,
        requiredAction: null,
      });
      const observedByPeer = other.get(initial.planId);
      const checkpoint = {
        version: "provider_profile_checkpoint.v1" as const,
        providerId: "fixture-provider",
        originalRevision: 7,
        appliedRevision: 8,
        intentHash: initial.intentHash,
      };
      const action: ChangePlanRequiredAction = {
        kind: "secure_input",
        actionId: "secure-owner",
        actionNonce: "secure-nonce",
        title: "Provide credential",
        targetId: "fixture-provider",
        expiresAt: "2099-01-01T00:00:00Z",
      };
      const valid: ChangePlanRepositoryTransitionInput = {
        expectedRevision: applying.revision,
        internal: true,
        status: "awaiting_input",
        requiredAction: action,
        target: { ...initial.target, expectedRevision: 8 },
        result: {
          summary: "Public profile committed; credential pending",
          appliedRevision: 8,
          providerProfileCheckpoint: checkpoint,
        },
        evidenceRefs: ["provider_profile:fixture-provider:settings_revision:8"],
      };
      const eventsBefore = first.listEvents(initial.planId);
      const invalid: ChangePlanRepositoryTransitionInput[] = [
        { ...valid, internal: false },
        { ...valid, result: { summary: "No canonical checkpoint" } },
        { ...valid, evidenceRefs: [] },
        { ...valid, requiredAction: { ...action, targetId: "foreign-provider" } },
        { ...valid, target: { ...initial.target, expectedRevision: 9 } },
        ...[
          { intentHash: "f".repeat(64) },
          { providerId: "foreign-provider" },
          { originalRevision: 6 },
          { appliedRevision: 7 },
        ].map((patch) => ({
          ...valid,
          result: { ...valid.result!, providerProfileCheckpoint: { ...checkpoint, ...patch } },
        })),
      ];
      for (const input of invalid) {
        assert.throws(() => first.transition(initial.planId, input));
        assert.deepEqual(other.get(initial.planId), observedByPeer);
        assert.deepEqual(first.listEvents(initial.planId), eventsBefore);
      }
      const waiting = first.transition(initial.planId, valid);
      assert.deepEqual(waiting.result?.providerProfileCheckpoint, checkpoint);
      assert.equal(waiting.target.expectedRevision, 8);
      assert.deepEqual(other.get(initial.planId), waiting);
      assert.throws(
        () => other.transition(initial.planId, { ...valid, expectedRevision: observedByPeer.revision }),
        ConflictError,
      );
      assert.equal(first.listEvents(initial.planId).filter((event) => event.toStatus === "awaiting_input").length, 1);
      assert.deepEqual(waiting.evidenceRefs, valid.evidenceRefs);

      // Later owner results retain the immutable partial-commit evidence; they cannot erase or alter it.
      const staged = first.transition(initial.planId, {
        expectedRevision: waiting.revision,
        internal: true,
        status: "awaiting_confirmation",
        requiredAction: {
          kind: "confirmation",
          actionId: "confirm-secret",
          actionNonce: "secret-nonce",
          title: "Confirm",
          confirmationText: "Confirm owner credential promotion",
        },
        result: { summary: "Temporary credential input verified" },
      });
      assert.deepEqual(staged.result?.providerProfileCheckpoint, checkpoint);
      assert.throws(
        () =>
          other.transition(initial.planId, {
            expectedRevision: staged.revision,
            internal: true,
            status: "cancelled",
            result: { summary: "Attempted rewrite", providerProfileCheckpoint: { ...checkpoint, originalRevision: 6 } },
          }),
        ConflictError,
      );
      const cancelled = first.transition(initial.planId, {
        expectedRevision: staged.revision,
        internal: true,
        status: "cancelled",
        result: { summary: "Cancel remaining credential work" },
      });
      assert.deepEqual(cancelled.result?.providerProfileCheckpoint, checkpoint);
      assert.equal(other.get(initial.planId).status, "cancelled");

      assertRejectsGenericProviderCheckpoint(first, initial);
    } finally {
      second.close();
      await scope.teardown();
    }
  },
);

function assertRejectsGenericProviderCheckpoint(repo: ChangePlanRepository, source: ChangePlanRecord) {
  const base = {
    origin: source.origin,
    request: source.request,
    adapter: source.adapter,
    target: { ...source.target, resourceId: "other-provider" },
    title: "Independent fixture",
    summary: "No claimed write",
    impact: "No effects",
    risk: "caution" as const,
  };
  assert.throws(() =>
    repo.create({
      ...base,
      status: "draft",
      result: {
        summary: "Forged initial checkpoint",
        providerProfileCheckpoint: {
          version: "provider_profile_checkpoint.v1",
          providerId: "other-provider",
          originalRevision: 7,
          appliedRevision: 8,
          intentHash: source.intentHash,
        },
      },
    }),
    /A new plan cannot claim an already committed provider profile/u,
  );
  const plan = repo.create({
    ...base,
    request: { kind: "runtime_configuration", change: { operation: "budget_mode", mode: "balanced" } },
    status: "awaiting_confirmation",
    requiredAction: {
      kind: "confirmation",
      actionId: "generic-confirm",
      actionNonce: "generic-nonce",
      title: "Confirm",
      confirmationText: "Confirm generic fixture",
    },
  });
  const applying = repo.transition(plan.planId, {
    expectedRevision: plan.revision,
    status: "applying",
    actionNonce: plan.requiredAction!.actionNonce,
    requiredAction: null,
  });
  assert.throws(
    () =>
      repo.transition(plan.planId, { expectedRevision: applying.revision, internal: true, status: "awaiting_input" }),
    ConflictError,
  );
  assert.equal(repo.get(plan.planId).status, "applying");
}
