import { describe, expect, it, vi } from "vitest";
import type {
  ExternalSideEffectReplayWorkflowPayload,
  ExternalSideEffectRunRecord,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import {
  buildGatewayExternalSideEffectReplayJob,
  EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST,
} from "./external-side-effect-replay-job-service.js";
import type { IntegrationActionHost } from "./integration-action-service.js";
import type { ExternalSideEffectRunStore } from "./external-side-effect-runner-service.js";
import { runReplaySafeExternalSideEffectWorker } from "./external-side-effect-runner-service.js";

const ACTIVEPIECES_ROUTE_PATH =
  "external_side_effect:integration_operator_action:automation.activepieces:conn-1:trigger_webhook";

function createConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    catalogId: "automation.activepieces",
    kind: "automation",
    key: "activepieces",
    label: "Activepieces",
    enabled: true,
    status: "connected",
    config: {
      webhookUrl: "https://activepieces.example.test/hooks/flow-1",
      defaultFlowId: "flow-1",
    },
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createHost(
  connection: IntegrationConnection,
  overrides: Partial<IntegrationActionHost> = {},
): IntegrationActionHost {
  return {
    storage: {
      integrationConnections: {
        get: vi.fn((connectionId: string) => {
          if (connectionId !== connection.connectionId) {
            throw new Error(`Unknown integration connection: ${connectionId}`);
          }
          return connection;
        }),
      },
    },
    fetchWithDiagnosticsTimeout: vi.fn(),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, directKey: string, envKey: string) => {
      const direct = config[directKey];
      if (typeof direct === "string" && direct.length > 0) {
        return direct;
      }
      const envValue = config[envKey];
      return typeof envValue === "string" && envValue.length > 0 ? envValue : undefined;
    }),
    publishRealtime: vi.fn(),
    mutationStore: {
      claim: vi.fn(() => ({
        outcome: "claimed" as const,
        record: {
          method: "POST",
          routePath: ACTIVEPIECES_ROUTE_PATH,
          idempotencyKey: "idem-run-key",
          actorScope: "actor-run-scope",
          payloadHash: "hash",
          status: "pending" as const,
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:00:00.000Z",
        },
      })),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    },
    sideEffectRunStore: {
      createOrGet: vi.fn(),
      markExternalCallStarted: vi.fn(),
      markCompleted: vi.fn(),
      markFailure: vi.fn(),
    },
    ...overrides,
  };
}

function wardHost(
  connection: IntegrationConnection,
  wards: Array<{ actionPattern: string; effect: string }>,
  overrides: Partial<IntegrationActionHost> = {},
): IntegrationActionHost {
  const base = createHost(connection, overrides);
  return {
    ...base,
    storage: {
      ...base.storage,
      workspaces: { find: (id: string) => (id === "ws-guarded" ? { citadelId: "citadel-guarded" } : undefined) },
      citadels: { listWards: (citadelId: string) => (citadelId === "citadel-guarded" ? (wards as never) : []) },
    },
  };
}

function buildRun(overrides: Partial<ExternalSideEffectRunRecord> = {}): ExternalSideEffectRunRecord {
  return {
    runId: "extfx-1",
    workspaceId: "ws-run",
    boundary: "integration_operator_action",
    routePath: ACTIVEPIECES_ROUTE_PATH,
    catalogId: "automation.activepieces",
    connectionId: "conn-1",
    actionId: "trigger_webhook",
    actorScope: "actor-run-scope",
    idempotencyKey: "idem-run-key",
    payloadHash: "original-payload-hash",
    status: "failed_before_boundary",
    replayPolicy: "idempotent_external",
    replayOutcome: "claimed",
    replayAttempt: "new",
    resumeState: "manual_retry_after_recorded_failure",
    attemptCount: 1,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:01:00.000Z",
    ...overrides,
  };
}

function buildPayload(
  overrides: Partial<ExternalSideEffectReplayWorkflowPayload> = {},
): ExternalSideEffectReplayWorkflowPayload {
  return {
    version: "external_side_effect.replay.v1",
    workspaceId: "default",
    requestedBy: "operator",
    requestedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Mirrors packages/storage/src/mutation-idempotency-repo.ts claim() exactly (see
 * external-side-effect-runner-service.test.ts): the payload-hash mismatch check
 * runs BEFORE the failed-record revive, and a still-"pending" existing row
 * yields "in_progress" rather than "duplicate".
 */
function createStatefulMutationIdempotencyStore(): {
  claim: ReturnType<typeof vi.fn>;
  markCompleted: ReturnType<typeof vi.fn>;
  markFailed: ReturnType<typeof vi.fn>;
} {
  const rows = new Map<string, { payloadHash: string; status: "pending" | "completed" | "failed" }>();
  const toKey = (input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }) =>
    [input.method, input.routePath, input.idempotencyKey, input.actorScope ?? ""].join("|");
  const toRecord = (
    input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string; now?: string },
    row: { payloadHash: string; status: "pending" | "completed" | "failed" },
  ) => ({
    method: input.method,
    routePath: input.routePath,
    idempotencyKey: input.idempotencyKey,
    actorScope: input.actorScope ?? "",
    payloadHash: row.payloadHash,
    status: row.status,
    createdAt: input.now ?? "",
    updatedAt: input.now ?? "",
  });

  return {
    claim: vi.fn(
      (input: {
        method: string;
        routePath: string;
        idempotencyKey: string;
        actorScope?: string;
        payloadHash: string;
        now?: string;
      }) => {
        const key = toKey(input);
        const existing = rows.get(key);
        if (!existing) {
          const row = { payloadHash: input.payloadHash, status: "pending" as const };
          rows.set(key, row);
          return { outcome: "claimed" as const, claimKind: "new" as const, record: toRecord(input, row) };
        }
        if (existing.payloadHash !== input.payloadHash) {
          return { outcome: "payload_mismatch" as const, record: toRecord(input, existing) };
        }
        if (existing.status === "failed") {
          const row = { payloadHash: input.payloadHash, status: "pending" as const };
          rows.set(key, row);
          return {
            outcome: "claimed" as const,
            claimKind: "retry_after_failure" as const,
            record: toRecord(input, row),
          };
        }
        return {
          outcome: existing.status === "pending" ? ("in_progress" as const) : ("duplicate" as const),
          record: toRecord(input, existing),
        };
      },
    ),
    markCompleted: vi.fn(
      (input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }) => {
        const key = toKey(input);
        const existing = rows.get(key);
        if (existing) {
          rows.set(key, { ...existing, status: "completed" });
        }
      },
    ),
    markFailed: vi.fn((input: { method: string; routePath: string; idempotencyKey: string; actorScope?: string }) => {
      const key = toKey(input);
      const existing = rows.get(key);
      if (existing) {
        rows.set(key, { ...existing, status: "failed" });
      }
    }),
  };
}

function createTrackedSideEffectRunStore(seed: ExternalSideEffectRunRecord): ExternalSideEffectRunStore & {
  getRow(): ExternalSideEffectRunRecord;
} {
  let row = { ...seed };
  return {
    createOrGet: vi.fn(() => row),
    markExternalCallStarted: vi.fn((runId, _input, now) => {
      row = { ...row, status: "external_call_started", updatedAt: now ?? row.updatedAt };
      return row;
    }),
    markCompleted: vi.fn((runId, input, now) => {
      row = {
        ...row,
        status: "completed",
        responsePayload: input?.responsePayload,
        externalReferenceId: input?.externalReferenceId,
        updatedAt: now ?? row.updatedAt,
        completedAt: now,
      };
      return row;
    }),
    markFailure: vi.fn((runId, input, now) => {
      row = { ...row, status: input.status, errorText: input.errorText, updatedAt: now ?? row.updatedAt };
      return row;
    }),
    getRow: () => row,
  };
}

describe("buildGatewayExternalSideEffectReplayJob", () => {
  it("builds an identity-preserving replay job for an allowlisted failed-before-boundary activepieces run", () => {
    const connection = createConnection({ workspaceId: undefined });
    const host = createHost(connection);
    const run = buildRun();
    const payload = buildPayload();

    const job = buildGatewayExternalSideEffectReplayJob(host, run, payload);

    expect(job).toBeDefined();
    // Mirrors readReplayJobIdentityMismatch's checks (external-side-effect-runner-service.ts,
    // private to that module) — identity must be pinned from the RUN ROW, not freshly derived.
    expect(job?.idempotencyKey).toBe(run.idempotencyKey);
    expect(job?.actorScope).toBe(run.actorScope);
    expect(job?.workspaceId).toBe(run.workspaceId);
    expect(job?.boundary).toBe(run.boundary);
    expect(job?.catalogId).toBe(run.catalogId);
    expect(job?.connectionId).toBe(run.connectionId);
    expect(job?.actionId).toBe(run.actionId);
    expect(job?.payload).toMatchObject({ provider: "activepieces", flowId: "flow-1", payload: {} });
    expect(job?.mutationStore).toBe(host.mutationStore);
    expect(job?.sideEffectRunStore).toBe(host.sideEffectRunStore);
  });

  it("replays end-to-end through the replay-safe worker", async () => {
    const connection = createConnection({ workspaceId: undefined });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "run-99", message: "flow accepted" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const mutationStore = createStatefulMutationIdempotencyStore();
    const run = buildRun();
    const sideEffectRunStore = createTrackedSideEffectRunStore(run);
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: fetchMock,
      mutationStore,
      sideEffectRunStore,
    });
    const payload = buildPayload();

    const results = await runReplaySafeExternalSideEffectWorker({
      runs: [run],
      checkedAt: "2026-06-01T00:00:00.000Z",
      buildJob: (candidate) => buildGatewayExternalSideEffectReplayJob(host, candidate, payload),
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "executed", run: expect.objectContaining({ runId: "extfx-1" }) }),
    ]);
    expect(sideEffectRunStore.getRow().status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledOnce();
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(requestBody).toMatchObject({ source: "goatcitadel", flowId: "flow-1", payload: {} });
  });

  it("returns undefined for non-allowlisted runs", async () => {
    const gmailWriteRun = buildRun({
      runId: "extfx-gmail",
      boundary: "integration_operator_action",
      catalogId: "automation.gmail",
      connectionId: "conn-gmail",
      actionId: "write",
      routePath: "external_side_effect:integration_operator_action:automation.gmail:conn-gmail:write",
    });
    const trelloWriteRun = buildRun({
      runId: "extfx-trello",
      boundary: "integration_operator_action",
      catalogId: "productivity.trello",
      connectionId: "conn-trello",
      actionId: "write",
      routePath: "external_side_effect:integration_operator_action:productivity.trello:conn-trello:write",
    });
    const localBridgeRun = buildRun({
      runId: "extfx-bridge",
      boundary: "integration_local_bridge_action",
      catalogId: "productivity.local-bridge",
      connectionId: "conn-bridge",
      actionId: "run",
      routePath: "external_side_effect:integration_local_bridge_action:productivity.local-bridge:conn-bridge:run",
    });
    const host = createHost(createConnection());
    const payload = buildPayload();

    expect(buildGatewayExternalSideEffectReplayJob(host, gmailWriteRun, payload)).toBeUndefined();
    expect(buildGatewayExternalSideEffectReplayJob(host, trelloWriteRun, payload)).toBeUndefined();
    expect(buildGatewayExternalSideEffectReplayJob(host, localBridgeRun, payload)).toBeUndefined();

    const results = await runReplaySafeExternalSideEffectWorker({
      runs: [gmailWriteRun, trelloWriteRun, localBridgeRun],
      checkedAt: "2026-06-01T00:00:00.000Z",
      buildJob: (candidate) => buildGatewayExternalSideEffectReplayJob(host, candidate, payload),
    });

    expect(results).toEqual([
      expect.objectContaining({ status: "skipped", reason: "job_unavailable" }),
      expect.objectContaining({ status: "skipped", reason: "job_unavailable" }),
      expect.objectContaining({ status: "skipped", reason: "job_unavailable" }),
    ]);
  });

  it("refuses payload drift at claim time", async () => {
    const connection = createConnection({
      workspaceId: undefined,
      config: { webhookUrl: "https://activepieces.example.test/hooks/flow-1", defaultFlowId: "flow-NEW" },
    });
    const mutationStore = createStatefulMutationIdempotencyStore();
    // Seed the store with the claim as it existed under the OLD (pre-drift)
    // connection config — same identity (routePath/idempotencyKey/actorScope),
    // different payload hash than what the drifted config now produces.
    mutationStore.claim({
      method: "POST",
      routePath: ACTIVEPIECES_ROUTE_PATH,
      idempotencyKey: "idem-run-key",
      actorScope: "actor-run-scope",
      payloadHash: "hash-for-flow-1-old",
      now: "2026-05-31T00:00:00.000Z",
    });
    const fetchMock = vi.fn();
    const sideEffectRunStore = {
      createOrGet: vi.fn((input, now) => ({ ...buildRun(), status: input.status, updatedAt: now ?? "" })),
      markExternalCallStarted: vi.fn(),
      markCompleted: vi.fn(),
      markFailure: vi.fn(),
    };
    const host = createHost(connection, { fetchWithDiagnosticsTimeout: fetchMock, mutationStore, sideEffectRunStore });
    const run = buildRun();
    const payload = buildPayload();

    const results = await runReplaySafeExternalSideEffectWorker({
      runs: [run],
      checkedAt: "2026-06-01T00:00:00.000Z",
      buildJob: (candidate) => buildGatewayExternalSideEffectReplayJob(host, candidate, payload),
    });

    expect(results).toEqual([
      expect.objectContaining({
        status: "blocked",
        result: expect.objectContaining({ blockedReason: "external_side_effect_payload_mismatch" }),
      }),
    ]);
    // The webhook was never actually triggered, and the run's own terminal
    // bookkeeping methods were never invoked — the original run row is not
    // silently marked completed or failed by a refused drifted replay.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markCompleted).not.toHaveBeenCalled();
    expect(sideEffectRunStore.markFailure).not.toHaveBeenCalled();
    expect(run.status).toBe("failed_before_boundary");
  });

  it("returns undefined when ward denies or requires dry-run at replay time", () => {
    const connection = createConnection({ workspaceId: "ws-guarded" });
    const run = buildRun();
    const payload = buildPayload();

    const denyHost = wardHost(connection, [{ actionPattern: "integration.*", effect: "deny" }]);
    expect(buildGatewayExternalSideEffectReplayJob(denyHost, run, payload)).toBeUndefined();

    const dryRunHost = wardHost(connection, [
      { actionPattern: "integration.automation.activepieces.*", effect: "require_dry_run" },
    ]);
    expect(buildGatewayExternalSideEffectReplayJob(dryRunHost, run, payload)).toBeUndefined();

    const approvalHost = wardHost(connection, [{ actionPattern: "integration.*", effect: "require_approval" }]);
    expect(buildGatewayExternalSideEffectReplayJob(approvalHost, run, payload)).toBeUndefined();
  });

  it("returns undefined for missing connection or missing webhook url", () => {
    const run = buildRun();
    const payload = buildPayload();

    const missingConnectionHost = createHost(createConnection({ connectionId: "some-other-connection" }));
    expect(buildGatewayExternalSideEffectReplayJob(missingConnectionHost, run, payload)).toBeUndefined();

    const noWebhookHost = createHost(createConnection({ config: { defaultFlowId: "flow-1" } }));
    expect(buildGatewayExternalSideEffectReplayJob(noWebhookHost, run, payload)).toBeUndefined();
  });

  it("returns undefined when the connection's catalogId has drifted since the original claim", () => {
    const run = buildRun();
    const payload = buildPayload();
    const driftedHost = createHost(createConnection({ catalogId: "automation.gmail" }));

    expect(buildGatewayExternalSideEffectReplayJob(driftedHost, run, payload)).toBeUndefined();
  });

  it("does not propagate a builder error from a malformed webhook URL (job unavailable, not a crash)", () => {
    const run = buildRun();
    const payload = buildPayload();
    const malformedHost = createHost(
      createConnection({ config: { webhookUrl: "not-a-url", defaultFlowId: "flow-1" } }),
    );

    expect(() => buildGatewayExternalSideEffectReplayJob(malformedHost, run, payload)).not.toThrow();
    expect(buildGatewayExternalSideEffectReplayJob(malformedHost, run, payload)).toBeUndefined();
  });

  it("exposes exactly the Activepieces trigger_webhook allowlist entry", () => {
    expect(EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST).toEqual([
      { boundary: "integration_operator_action", catalogId: "automation.activepieces", actionId: "trigger_webhook" },
    ]);
  });
});
