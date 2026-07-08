import type {
  ExternalSideEffectReplayWorkflowPayload,
  ExternalSideEffectRunRecord,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { buildIntegrationWardAction, resolveWardEffectForExternalAction } from "./citadel-ward-gate.js";
import type { IdempotentExternalSideEffectRunInput } from "./external-side-effect-runner-service.js";
import { buildActivepiecesTriggerWebhookRunInput, type IntegrationActionHost } from "./integration-action-service.js";

/**
 * Production replay allowlist for the durable `external_side_effect.replay`
 * workflow. Each entry is an EXACT (boundary, catalogId, actionId) triple
 * that this gateway is willing to safely reconstruct — from LIVE connection
 * config only, never from persisted request payload (ledger rows store no
 * raw payload, only identity fields + a payloadHash) — and re-execute after
 * the original attempt failed before crossing the external boundary.
 *
 * Anything not listed here makes `buildGatewayExternalSideEffectReplayJob`
 * return `undefined`, which the replay-safe worker treats as
 * `job_unavailable` — byte-identical to before this hook existed. Extending
 * this allowlist is a deliberate, reviewed decision per integration/action.
 */
export const EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST = [
  { boundary: "integration_operator_action", catalogId: "automation.activepieces", actionId: "trigger_webhook" },
] as const;

/**
 * Builds a replay-safe runner input for a durably-recorded external
 * side-effect run, reconstructed entirely from LIVE state (the current
 * connection config and the current Citadel Ward posture) — never from the
 * original request payload, which the ledger never persisted. Returns
 * `undefined` when replay is not safe or not possible; every branch below is
 * a DISTINCT, commented fail-closed reason.
 *
 * This function must never throw: `runReplaySafeExternalSideEffectWorker`
 * calls `host.buildExternalSideEffectReplayJob` synchronously as part of a
 * durable workflow step, so any unexpected reconstruction failure (e.g. a
 * malformed webhook URL surfacing from `buildActivepiecesTriggerWebhookRunInput`)
 * is caught here and treated as "no replay job available", not as an
 * unhandled workflow crash.
 */
export function buildGatewayExternalSideEffectReplayJob(
  host: IntegrationActionHost,
  run: ExternalSideEffectRunRecord,
  _payload: ExternalSideEffectReplayWorkflowPayload,
): IdempotentExternalSideEffectRunInput<Record<string, unknown>> | undefined {
  // Reason: allowlist miss — boundary/catalogId/actionId is not an exact
  // match for a production-approved replay integration.
  const allowlisted = EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST.find(
    (entry) => entry.boundary === run.boundary && entry.catalogId === run.catalogId && entry.actionId === run.actionId,
  );
  if (!allowlisted) {
    return undefined;
  }

  // Reason: the run has no connectionId to reconstruct a live connection from.
  if (!run.connectionId) {
    return undefined;
  }

  let connection: IntegrationConnection | undefined;
  try {
    connection = host.storage.integrationConnections.get(run.connectionId);
  } catch {
    connection = undefined;
  }
  // Reason: connection missing, or its catalogId has drifted since the
  // original claim (the connection now points at a different provider) —
  // replaying against a different provider would not be the same action.
  if (!connection || connection.catalogId !== allowlisted.catalogId) {
    return undefined;
  }

  // Reason: Citadel Ward re-check at replay time. runReplaySafeExternalSideEffectWorker
  // only enforces `require_dry_run` via a `wardEffect` carried on the returned
  // job — `deny` and `require_approval` are NEVER enforced by the runner, so
  // this builder must refuse them itself, exactly like the live invocation
  // path in integration-action-service.ts. ANY non-allow effect fails closed
  // here (a ward may have been added or tightened since the original attempt),
  // so a `wardEffect` is never even attached to the job we return below.
  const wardAction = buildIntegrationWardAction(allowlisted.catalogId, allowlisted.actionId);
  const wardResolution = resolveWardEffectForExternalAction({
    storage: host.storage,
    workspaceId: connection.workspaceId,
    action: wardAction,
  });
  if (wardResolution.effect !== undefined) {
    return undefined;
  }

  const flowId = host.readConnectionConfigValue(connection.config, "defaultFlowId");
  const checkedAt = new Date().toISOString();

  let parts: ReturnType<typeof buildActivepiecesTriggerWebhookRunInput>;
  try {
    parts = buildActivepiecesTriggerWebhookRunInput(host, connection, {
      checkedAt,
      flowId,
      // Never replay the original request payload — the ledger never
      // persisted it. The safe reconstruction is an empty trigger payload
      // driven entirely by the live connection's configured flow.
      payload: {},
      idempotencyKey: run.idempotencyKey,
      actorScope: run.actorScope,
    });
  } catch {
    // Reason: the builder threw while reconstructing the job (e.g.
    // `parseHttpUrl` rejecting a malformed non-empty `webhookUrl`). A
    // replay-job builder must never let a reconstruction failure escape as
    // an unhandled workflow crash — treat it as job-unavailable.
    return undefined;
  }
  // Reason: config unreconstructable — no webhook URL is configured on the
  // live connection, so there is nothing safe to replay.
  if ("blockedReason" in parts) {
    return undefined;
  }

  return {
    ...parts.input,
    checkedAt,
    // Identity is pinned from the RUN ROW, not freshly derived, so the
    // replay-safe worker's identity-mismatch check (idempotency key,
    // boundary, catalogId, connectionId, actionId) always passes and the
    // idempotency claim lands on the SAME logical operation as the original
    // attempt — never a fresh one.
    idempotencyKey: run.idempotencyKey,
    actorScope: run.actorScope,
    workspaceId: run.workspaceId,
    mutationStore: host.mutationStore,
    sideEffectRunStore: host.sideEffectRunStore,
  };
}
