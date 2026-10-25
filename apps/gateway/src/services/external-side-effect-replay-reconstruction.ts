import type { ExternalSideEffectRunRecord, IntegrationConnection } from "@goatcitadel/contracts";
import { hashExternalSideEffectPayload } from "./external-side-effect-runner-service.js";
import { resolveGmailActionToken, type IntegrationActionHost } from "./integration-action-service.js";
import { getIntegrationOperatorActions } from "./integration-action-registry.js";
import {
  buildGmailSendRunInput,
  buildLocalBridgeWriteRunInput,
  buildTrelloCardCreateRunInput,
  type GmailSendPayload,
  type LocalBridgePayload,
  type TrelloCardPayload,
  type WritebackRunInputBlocked,
  type WritebackRunInputOptions,
  type WritebackRunInputParts,
} from "./integration-writeback-run-inputs.js";

/**
 * Per-provider replay reconstruction for the writes whose original payload was sealed
 * (WS8): Gmail send, Trello card create and local-bridge writes. Each reconstructor opens
 * the run's encrypted replay record, validates the payload shape, and rebuilds the runner
 * input through the SAME builder the live path used, in `replay` mode (probe before
 * resending) and with the run's own idempotency key and actor scope.
 *
 * Every refusal returns `undefined` (the worker reports `job_unavailable`):
 * - no sealed record, or the record fails authentication (tampered ciphertext, a record
 *   bound to a different run id or payload hash, or no replay key on this host);
 * - the decrypted payload does not have the provider's exact shape;
 * - the live connection can no longer build the input (missing credentials or URL);
 * - the rebuilt payload no longer hashes to the run's `payloadHash` with the LIVE
 *   destination fingerprint (destination drift since the original attempt).
 */
export type SealedReplayReconstructor = (
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  run: ExternalSideEffectRunRecord,
  checkedAt: string,
) => Promise<WritebackRunInputParts | undefined>;

type SealedInputBuilder = (
  payload: unknown,
  options: Omit<WritebackRunInputOptions<unknown>, "payload">,
) => WritebackRunInputParts | WritebackRunInputBlocked | undefined;

export const reconstructSealedGmailSend: SealedReplayReconstructor = async (host, connection, run, checkedAt) => {
  // Without a usable Google sign-in for sending, the live connection can no longer build the input.
  const token = await resolveGmailActionToken(host, connection, "gmail.send");
  if (!("accessToken" in token)) {
    return undefined;
  }
  return await reconstructFromSealedRecord(host, run, checkedAt, (payload, options) => {
    const gmail = readGmailPayload(payload);
    return gmail
      ? buildGmailSendRunInput(host, connection, { ...options, payload: gmail }, token.accessToken)
      : undefined;
  });
};

export const reconstructSealedTrelloCardCreate: SealedReplayReconstructor = async (host, connection, run, checkedAt) =>
  await reconstructFromSealedRecord(host, run, checkedAt, (payload, options) => {
    const trello = readTrelloPayload(payload);
    return trello ? buildTrelloCardCreateRunInput(host, connection, { ...options, payload: trello }) : undefined;
  });

export const reconstructSealedLocalBridgeWrite: SealedReplayReconstructor = async (host, connection, run, checkedAt) =>
  await reconstructFromSealedRecord(host, run, checkedAt, (payload, options) => {
    const actionId = run.actionId;
    if (!actionId) {
      return undefined;
    }
    const bridge = readLocalBridgePayload(payload, connection.catalogId, actionId);
    const action = getIntegrationOperatorActions(connection.catalogId).find((item) => item.actionId === actionId);
    return bridge && action
      ? buildLocalBridgeWriteRunInput(host, connection, action, { ...options, payload: bridge })
      : undefined;
  });

async function reconstructFromSealedRecord(
  host: IntegrationActionHost,
  run: ExternalSideEffectRunRecord,
  checkedAt: string,
  build: SealedInputBuilder,
): Promise<WritebackRunInputParts | undefined> {
  const sealed = await host.replayRecords?.open(run);
  if (!sealed) {
    return undefined;
  }
  const parts = build(sealed.payload, {
    checkedAt,
    replay: true,
    // Always the RUN's key: reconciliation probes and provider dedupe identifiers derive from it.
    idempotencyKey: run.idempotencyKey,
    actorScope: run.actorScope,
  });
  if (!parts || "blockedReason" in parts) {
    return undefined;
  }
  if (
    hashExternalSideEffectPayload(parts.input.payload, parts.input.externalDestinationFingerprint) !== run.payloadHash
  ) {
    return undefined;
  }
  return parts;
}

function readGmailPayload(value: unknown): GmailSendPayload | undefined {
  if (!isRecord(value) || value.provider !== "gmail") {
    return undefined;
  }
  const { to, subject, bodyText } = value;
  return isNonEmptyString(to) && isNonEmptyString(subject) && isNonEmptyString(bodyText)
    ? { provider: "gmail", to, subject, bodyText }
    : undefined;
}

function readTrelloPayload(value: unknown): TrelloCardPayload | undefined {
  if (!isRecord(value) || value.provider !== "trello") {
    return undefined;
  }
  const { listId, name, desc } = value;
  return isNonEmptyString(listId) && typeof name === "string" && typeof desc === "string"
    ? { provider: "trello", listId, name, desc }
    : undefined;
}

function readLocalBridgePayload(value: unknown, catalogId: string, actionId: string): LocalBridgePayload | undefined {
  if (!isRecord(value) || value.provider !== "local_bridge") {
    return undefined;
  }
  return value.catalogId === catalogId && value.actionId === actionId && isRecord(value.input)
    ? { provider: "local_bridge", catalogId, actionId, input: value.input }
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
