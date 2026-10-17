import type {
  ExternalSideEffectReplayWorkflowPayload,
  ExternalSideEffectRunRecord,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { buildIntegrationWardAction, resolveWardEffectForExternalAction } from "./citadel-ward-gate.js";
import type { IdempotentExternalSideEffectRunInput } from "./external-side-effect-runner-service.js";
import {
  reconstructSealedGmailSend,
  reconstructSealedLocalBridgeWrite,
  reconstructSealedTrelloCardCreate,
} from "./external-side-effect-replay-reconstruction.js";
import { buildActivepiecesTriggerWebhookRunInput, type IntegrationActionHost } from "./integration-action-service.js";
import type { WritebackRunInputParts } from "./integration-writeback-run-inputs.js";

export type GatewayExternalSideEffectReplayJob = IdempotentExternalSideEffectRunInput<Record<string, unknown>> & {
  externalDestinationFingerprint: string;
  runClaimTransaction<T>(work: () => T | Promise<T>): Promise<Awaited<T>>;
  requireDurableBoundaryRecord: true;
};

/**
 * Production replay allowlist for the durable `external_side_effect.replay`
 * workflow. Each entry is an EXACT (boundary, catalogId, actionId) triple
 * that this gateway is willing to safely reconstruct and re-execute after the
 * original attempt failed before crossing the external boundary, or — when the
 * reconstructed job carries a provider probe — reconcile after it crossed with
 * an unknown outcome (never by resending).
 *
 * - Activepieces `trigger_webhook` reconstructs from LIVE connection config
 *   only (`defaultFlowId`, empty payload); ledger rows store no raw payload.
 * - Gmail send, Trello card create and local-bridge writes reconstruct from the
 *   run's encrypted replay record (sealed by the live path before the boundary),
 *   rebuilt through the live builder in replay mode, and refused unless the
 *   rebuilt payload hashes to the run's `payloadHash` with the LIVE destination.
 *
 * Anything not listed here makes `buildGatewayExternalSideEffectReplayJob`
 * return `undefined`, which the replay-safe worker treats as
 * `job_unavailable` — byte-identical to before this hook existed. Extending
 * this allowlist is a deliberate, reviewed decision per integration/action.
 */
export const EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST = [
  { boundary: "integration_operator_action", catalogId: "automation.activepieces", actionId: "trigger_webhook" },
  { boundary: "integration_operator_action", catalogId: "automation.gmail", actionId: "write" },
  { boundary: "integration_operator_action", catalogId: "productivity.trello", actionId: "write" },
  { boundary: "integration_local_bridge_action", catalogId: "productivity.apple-notes", actionId: "write" },
  { boundary: "integration_local_bridge_action", catalogId: "productivity.apple-reminders", actionId: "write" },
  { boundary: "integration_local_bridge_action", catalogId: "productivity.things3", actionId: "write" },
  { boundary: "integration_local_bridge_action", catalogId: "productivity.bear", actionId: "write" },
] as const;

type ReplayInputParts = Pick<WritebackRunInputParts, "input">;
type ReplayAllowlistCatalogId = (typeof EXTERNAL_SIDE_EFFECT_REPLAY_JOB_ALLOWLIST)[number]["catalogId"];
type ReplayReconstructor = (
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  run: ExternalSideEffectRunRecord,
  checkedAt: string,
) => Promise<ReplayInputParts | undefined>;

/**
 * Activepieces `trigger_webhook`: never replays the original request payload —
 * the ledger never persisted it. The safe reconstruction is an empty trigger
 * payload driven entirely by the live connection's configured flow. Returns
 * `undefined` when no webhook URL is configured on the live connection.
 */
const reconstructActivepiecesTriggerWebhook: ReplayReconstructor = async (host, connection, run, checkedAt) => {
  const parts = buildActivepiecesTriggerWebhookRunInput(host, connection, {
    checkedAt,
    flowId: host.readConnectionConfigValue(connection.config, "defaultFlowId"),
    payload: {},
    idempotencyKey: run.idempotencyKey,
    actorScope: run.actorScope,
  });
  return "blockedReason" in parts ? undefined : parts;
};

/** One reconstructor per allowlisted catalog; each entry's catalogId is unique in the allowlist. */
const REPLAY_RECONSTRUCTORS: Record<ReplayAllowlistCatalogId, ReplayReconstructor> = {
  "automation.activepieces": reconstructActivepiecesTriggerWebhook,
  "automation.gmail": reconstructSealedGmailSend,
  "productivity.trello": reconstructSealedTrelloCardCreate,
  "productivity.apple-notes": reconstructSealedLocalBridgeWrite,
  "productivity.apple-reminders": reconstructSealedLocalBridgeWrite,
  "productivity.things3": reconstructSealedLocalBridgeWrite,
  "productivity.bear": reconstructSealedLocalBridgeWrite,
};

/**
 * Builds a replay-safe runner input for a durably-recorded external
 * side-effect run from LIVE state (the current connection config and the
 * current Citadel Ward posture) plus, for sealed-record providers, the run's
 * authenticated replay record — never from a plaintext ledger payload. Returns
 * `undefined` when replay is not safe or not possible; every branch below is
 * a DISTINCT, commented fail-closed reason.
 *
 * This function must never throw: `runReplaySafeExternalSideEffectWorker`
 * awaits `host.buildExternalSideEffectReplayJob` as part of a durable workflow
 * step, so any unexpected reconstruction failure (e.g. a
 * malformed webhook URL surfacing from `buildActivepiecesTriggerWebhookRunInput`)
 * is caught here and treated as "no replay job available", not as an
 * unhandled workflow crash.
 */
export async function buildGatewayExternalSideEffectReplayJob(
  host: IntegrationActionHost,
  run: ExternalSideEffectRunRecord,
  _payload: ExternalSideEffectReplayWorkflowPayload,
): Promise<GatewayExternalSideEffectReplayJob | undefined> {
  const storage = host.storage;
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
    connection = await storage.integrationConnections.get(run.connectionId);
  } catch {
    connection = undefined;
  }
  // Reason: connection missing, or its catalogId has drifted since the
  // original claim (the connection now points at a different provider) —
  // replaying against a different provider would not be the same action.
  if (!connection || connection.catalogId !== allowlisted.catalogId) {
    return undefined;
  }
  // Reason: connection ownership drift. Replaying a run recorded in one
  // workspace through a connection now owned by another workspace would cross
  // the original policy/actor boundary even if the connection ID stayed the same.
  if ((connection.workspaceId ?? "default") !== run.workspaceId) {
    return undefined;
  }

  // Reason: replay must atomically fence mutation ownership with the durable
  // side-effect boundary. A host without the canonical transaction owner is
  // not allowed to construct an executable replay job.
  if (!storage.runImmediateTransaction) {
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
  const wardResolution = await resolveWardEffectForExternalAction({
    storage,
    workspaceId: connection.workspaceId,
    action: wardAction,
  });
  if (wardResolution.effect !== undefined) {
    return undefined;
  }

  const checkedAt = new Date().toISOString();

  let parts: ReplayInputParts | undefined;
  try {
    parts = await REPLAY_RECONSTRUCTORS[allowlisted.catalogId](host, connection, run, checkedAt);
  } catch {
    // Reason: the per-provider reconstruction threw (e.g. `parseHttpUrl`
    // rejecting a malformed non-empty Activepieces `webhookUrl`). A
    // replay-job builder must never let a reconstruction failure escape as
    // an unhandled workflow crash — treat it as job-unavailable.
    return undefined;
  }
  // Reason: config or sealed payload unreconstructable — see the
  // per-provider reconstructor for its distinct refusal reasons.
  if (!parts) {
    return undefined;
  }
  if (!parts.input.externalDestinationFingerprint) {
    return undefined;
  }

  return {
    ...parts.input,
    checkedAt,
    // Identity is pinned from the RUN ROW, not freshly derived, so the
    // replay-safe worker's identity-mismatch check pins the idempotency key,
    // boundary, catalog, connection, action, actor, and route. The payload hash
    // additionally binds the redacted destination digest, so target drift
    // blocks before provider contact.
    idempotencyKey: run.idempotencyKey,
    actorScope: run.actorScope,
    workspaceId: run.workspaceId,
    mutationStore: host.mutationStore,
    sideEffectRunStore: host.sideEffectRunStore,
    externalDestinationFingerprint: parts.input.externalDestinationFingerprint,
    runClaimTransaction: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> =>
      await storage.runImmediateTransaction!(work),
    requireDurableBoundaryRecord: true,
  };
}
