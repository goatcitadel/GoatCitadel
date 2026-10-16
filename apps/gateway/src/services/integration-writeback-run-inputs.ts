import { createHash } from "node:crypto";
import type { IntegrationConnection, IntegrationOperatorAction } from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import {
  type ExternalSideEffectExecutionContext,
  type ExternalSideEffectProbeResult,
  fingerprintExternalSideEffectDestination,
  type IdempotentExternalSideEffectRunInput,
} from "./external-side-effect-runner-service.js";
import type { IntegrationActionHost } from "./integration-action-service.js";
import { buildLocalBridgeActionTargets } from "./local-bridge-action-policy.js";

/**
 * Shared runner inputs for the replayable Gmail, Trello and local-bridge writes (WS8).
 * The live invocation path and the durable replay job builder construct the exact same
 * input here, so the payload hash, destination fingerprint, sealed replay record and
 * provider-side dedupe identifiers never drift between a first attempt and its replay.
 */

export interface ParsedProviderResponse {
  message?: string;
  output?: Record<string, unknown> | unknown[] | string;
}

export interface GmailSendPayload {
  provider: "gmail";
  to: string;
  subject: string;
  bodyText: string;
}

export interface TrelloCardPayload {
  provider: "trello";
  listId: string;
  name: string;
  desc: string;
}

export interface LocalBridgePayload {
  provider: "local_bridge";
  catalogId: string;
  actionId: string;
  input: Record<string, unknown>;
}

export interface WritebackRunInputOptions<TPayload> {
  checkedAt: string;
  payload: TPayload;
  idempotencyKey?: string;
  actorScope?: string;
  /** Durable replay of a claim that never recorded its boundary: probe the provider before resending. */
  replay?: boolean;
}

export interface WritebackRunInputParts {
  input: IdempotentExternalSideEffectRunInput<ParsedProviderResponse>;
  /** Resolved provider destination — feeds `WardGateRunOptions.externalDestination`. */
  target: string;
}

export interface WritebackRunInputBlocked {
  blockedReason: string;
  message: string;
  output?: Record<string, unknown>;
}

const GMAIL_MESSAGE_ID_DOMAIN = "goatcitadel:gmail-message-id:v1";
const TRELLO_MARKER_DOMAIN = "goatcitadel:trello-marker:v1";

export function deriveGmailMessageId(idempotencyKey: string): string {
  return `<gc-${digestKey(GMAIL_MESSAGE_ID_DOMAIN, idempotencyKey)}@goatcitadel.local>`;
}

export function deriveTrelloIdempotencyMarker(idempotencyKey: string): string {
  return `[goatcitadel-idempotency:${digestKey(TRELLO_MARKER_DOMAIN, idempotencyKey)}]`;
}

export function buildGmailSendRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: WritebackRunInputOptions<GmailSendPayload>,
): WritebackRunInputParts | WritebackRunInputBlocked {
  const token = host.resolveConnectionSecret(connection.config, "accessToken", "accessTokenEnv", connection.catalogId);
  if (!token) {
    return {
      blockedReason: "gmail_auth_missing",
      message: "Configure a Gmail access token before running operator actions.",
    };
  }
  const { payload } = options;
  const target = new URL("/gmail/v1/users/me/messages/send", gmailApiBaseUrl()).toString();
  const probe = async (idempotencyKey: string): Promise<ExternalSideEffectProbeResult> => {
    const url = new URL("/gmail/v1/users/me/messages", gmailApiBaseUrl());
    url.searchParams.set("q", `rfc822msgid:${deriveGmailMessageId(idempotencyKey).replace(/^<|>$/g, "")}`);
    url.searchParams.set("includeSpamTrash", "true");
    url.searchParams.set("maxResults", "1");
    const body = await readProbeJson(host, url.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    const first = isRecord(body) && Array.isArray(body.messages) ? body.messages[0] : undefined;
    const id = isRecord(first) ? readNonEmptyString(first.id) : undefined;
    if (!id || !isRecord(first)) {
      return { found: false, reason: "No Gmail message carries the derived Message-ID." };
    }
    const threadId = readNonEmptyString(first.threadId);
    return { found: true, externalReferenceId: `messageId:${id}`, output: { id, ...(threadId ? { threadId } : {}) } };
  };
  const send = async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    const rawMessage = [
      `To: ${payload.to}`,
      `Subject: ${payload.subject}`,
      `Message-ID: ${deriveGmailMessageId(claim.idempotencyKey)}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      payload.bodyText,
    ].join("\r\n");
    const response = await host.fetchWithDiagnosticsTimeout(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ raw: Buffer.from(rawMessage).toString("base64url") }),
    });
    const parsed = await parseProviderResponse(response);
    if (!response.ok) {
      throw new Error(parsed.message ?? `Gmail send failed (${response.status}).`);
    }
    return parsed;
  };
  return {
    target,
    input: {
      ...baseInput(host, connection, options, "write"),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      payload,
      label: "Gmail send",
      output: { provider: "gmail", to: payload.to, subject: payload.subject },
      execute: buildDedupedExecute(host, payload, options.replay, probe, send),
      reconcileExternalOutcome: buildReconcile(options.idempotencyKey, probe),
    },
  };
}

export function buildTrelloCardCreateRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: WritebackRunInputOptions<TrelloCardPayload>,
): WritebackRunInputParts | WritebackRunInputBlocked {
  const apiKey = host.resolveConnectionSecret(connection.config, "apiKey", "apiKeyEnv", connection.catalogId);
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!apiKey || !token) {
    return {
      blockedReason: "trello_auth_missing",
      message: "Configure Trello API key and token before running this action.",
    };
  }
  const { payload } = options;
  const buildCardUrl = (desc: string): string => {
    const url = new URL("/1/cards", trelloApiBaseUrl());
    url.searchParams.set("key", apiKey);
    url.searchParams.set("token", token);
    url.searchParams.set("idList", payload.listId);
    url.searchParams.set("name", payload.name);
    url.searchParams.set("desc", desc);
    return url.toString();
  };
  const probe = async (idempotencyKey: string): Promise<ExternalSideEffectProbeResult> => {
    const marker = deriveTrelloIdempotencyMarker(idempotencyKey);
    const url = new URL(`/1/lists/${encodeURIComponent(payload.listId)}/cards/all`, trelloApiBaseUrl());
    url.searchParams.set("fields", "id,desc,shortUrl");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("token", token);
    const body = await readProbeJson(host, url.toString(), { method: "GET" });
    const card = Array.isArray(body)
      ? body.find((item) => isRecord(item) && typeof item.desc === "string" && item.desc.includes(marker))
      : undefined;
    const id = isRecord(card) ? readNonEmptyString(card.id) : undefined;
    if (!id || !isRecord(card)) {
      return { found: false, reason: "No Trello card on the list carries the idempotency marker." };
    }
    const shortUrl = readNonEmptyString(card.shortUrl);
    return { found: true, externalReferenceId: `id:${id}`, output: { id, ...(shortUrl ? { shortUrl } : {}) } };
  };
  const send = async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    const desc = `${payload.desc}\n\n${deriveTrelloIdempotencyMarker(claim.idempotencyKey)}`;
    const response = await host.fetchWithDiagnosticsTimeout(buildCardUrl(desc), { method: "POST" });
    const parsed = await parseProviderResponse(response);
    if (!response.ok) {
      throw new Error(parsed.message ?? `Trello card create failed (${response.status}).`);
    }
    return parsed;
  };
  return {
    // The ward/dry-run gate sanitizes this destination; only the fingerprint below must be secret-free.
    target: buildCardUrl(payload.desc),
    input: {
      ...baseInput(host, connection, options, "write"),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(
        new URL("/1/cards", trelloApiBaseUrl()).toString(),
      ),
      payload,
      label: "Trello card create",
      output: { provider: "trello", listId: payload.listId, name: payload.name },
      execute: buildDedupedExecute(host, payload, options.replay, probe, send),
      reconcileExternalOutcome: buildReconcile(options.idempotencyKey, probe),
    },
  };
}

export function buildLocalBridgeWriteRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  action: IntegrationOperatorAction,
  options: WritebackRunInputOptions<LocalBridgePayload>,
): WritebackRunInputParts | WritebackRunInputBlocked {
  const bridgeUrl =
    host.readConnectionConfigValue(connection.config, "bridgeUrl") ??
    host.readConnectionConfigValue(connection.config, "baseUrl");
  if (!bridgeUrl) {
    return { blockedReason: "bridge_url_missing", message: "Configure a local bridge URL before running this action." };
  }
  if (!host.mutationStore || !host.sideEffectRunStore || !host.storage.runImmediateTransaction) {
    return {
      blockedReason: "external_side_effect_durability_unavailable",
      message: `${action.label} was not sent because durable external-side-effect authority is unavailable.`,
      output: { provider: "local_bridge", catalogId: connection.catalogId, actionId: action.actionId },
    };
  }
  const target = buildLocalBridgeActionTargets(
    bridgeUrl,
    host.readConnectionConfigValue(connection.config, "actionRoute"),
  )[0]!;
  const authHeader = resolveBearerAuth(host, connection);
  const enforced = host.readConnectionConfigValue(connection.config, "idempotencyKeyEnforced") === "true";
  const { payload } = options;
  const post = async (idempotencyKey: string) => {
    const response = await host.fetchWithDiagnosticsTimeout(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      body: JSON.stringify({
        integrationKey: connection.key,
        catalogId: connection.catalogId,
        connectionId: connection.connectionId,
        actionId: payload.actionId,
        input: payload.input,
      }),
    });
    return { response, parsed: await parseProviderResponse(response) };
  };
  const probe = async (idempotencyKey: string): Promise<ExternalSideEffectProbeResult> => {
    const { response, parsed } = await post(idempotencyKey);
    if (!response.ok) {
      throw new Error(`Local bridge reconciliation probe failed (${response.status}).`);
    }
    return { found: true, output: isRecord(parsed.output) ? parsed.output : {} };
  };
  return {
    target,
    input: {
      ...baseInput(host, connection, options, action.actionId),
      runClaimTransaction: async <T>(work: () => T | Promise<T>): Promise<Awaited<T>> =>
        await host.storage.runImmediateTransaction!(work),
      requireMutationClaimOwnership: true,
      requireDurableBoundaryRecord: true,
      boundary: "integration_local_bridge_action",
      ...(enforced ? { providerIdempotencyKeyEnforced: true } : {}),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      payload,
      label: `${action.label} local bridge action`,
      output: { provider: "local_bridge", catalogId: connection.catalogId, actionId: action.actionId },
      execute: async (claim) => {
        await sealReplayRecord(host, claim, payload);
        await claim.markExternalCallStarted();
        const { response, parsed } = await post(claim.idempotencyKey);
        if (!response.ok) {
          throw new Error(parsed.message ?? `Bridge action failed (${response.status}).`);
        }
        return parsed;
      },
      ...(enforced ? { reconcileExternalOutcome: buildReconcile(options.idempotencyKey, probe) } : {}),
    },
  };
}

export async function parseProviderResponse(response: Response): Promise<ParsedProviderResponse> {
  const raw = await readBoundedResponseText(response, {
    maxBytes: 256 * 1024,
    timeoutMs: 5_000,
    label: "integration action response",
  });
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return {
        message: typeof parsed.message === "string" ? parsed.message : undefined,
        output: parsed,
      };
    }
    if (Array.isArray(parsed)) {
      return { output: parsed };
    }
  } catch {
    // fall through to plain text
  }
  return { message: raw.trim().slice(0, 400), output: raw.trim().slice(0, 1000) };
}

export function resolveBearerAuth(host: IntegrationActionHost, connection: IntegrationConnection): string | undefined {
  const token =
    host.resolveConnectionSecret(connection.config, "authToken", "authTokenEnv", connection.catalogId) ??
    host.resolveConnectionSecret(connection.config, "accessToken", "accessTokenEnv", connection.catalogId) ??
    host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  return token ? `Bearer ${token}` : undefined;
}

export const trelloApiBaseUrl = () => resolveApiBaseUrl("GOATCITADEL_TRELLO_API_BASE_URL", "https://api.trello.com");

export const gmailApiBaseUrl = () =>
  resolveApiBaseUrl("GOATCITADEL_GMAIL_API_BASE_URL", "https://gmail.googleapis.com");

function baseInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: WritebackRunInputOptions<unknown>,
  actionId: string,
) {
  return {
    mutationStore: host.mutationStore,
    sideEffectRunStore: host.sideEffectRunStore,
    boundary: "integration_operator_action",
    catalogId: connection.catalogId,
    connectionId: connection.connectionId,
    actionId,
    checkedAt: options.checkedAt,
    workspaceId: connection.workspaceId,
    idempotencyKey: options.idempotencyKey,
    ...(options.actorScope ? { actorScope: options.actorScope } : {}),
  };
}

/**
 * Probe-then-send execute for providers that can be searched for a previous delivery.
 * On replay the probe runs before the boundary: a found effect settles without resending,
 * and a probe error throws while the claim is still provably pre-boundary.
 */
function buildDedupedExecute(
  host: IntegrationActionHost,
  payload: unknown,
  replay: boolean | undefined,
  probe: (idempotencyKey: string) => Promise<ExternalSideEffectProbeResult>,
  send: (claim: ExternalSideEffectExecutionContext) => Promise<ParsedProviderResponse>,
) {
  return async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    if (replay) {
      const found = await probe(claim.idempotencyKey);
      if (found.found) {
        claim.markExternalCallNotRequired();
        return { output: found.output ?? {} };
      }
    }
    await sealReplayRecord(host, claim, payload);
    await claim.markExternalCallStarted();
    return await send(claim);
  };
}

function buildReconcile(
  idempotencyKey: string | undefined,
  probe: (idempotencyKey: string) => Promise<ExternalSideEffectProbeResult>,
): () => Promise<ExternalSideEffectProbeResult> {
  return async () => {
    const key = idempotencyKey?.trim();
    if (!key) {
      throw new Error("External outcome reconciliation requires the run idempotency key.");
    }
    return await probe(key);
  };
}

async function sealReplayRecord(
  host: IntegrationActionHost,
  claim: ExternalSideEffectExecutionContext,
  payload: unknown,
): Promise<void> {
  if (!claim.sideEffectRunId) {
    return;
  }
  await host.replayRecords?.seal({ runId: claim.sideEffectRunId, payloadHash: claim.payloadHash, payload });
}

async function readProbeJson(host: IntegrationActionHost, url: string, init: RequestInit): Promise<unknown> {
  const response = await host.fetchWithDiagnosticsTimeout(url, init);
  const raw = await readBoundedResponseText(response, {
    maxBytes: 256 * 1024,
    timeoutMs: 5_000,
    label: "integration reconciliation probe response",
  });
  if (!response.ok) {
    throw new Error(`Provider reconciliation probe failed (${response.status}).`);
  }
  try {
    return raw.trim() ? (JSON.parse(raw) as unknown) : undefined;
  } catch {
    throw new Error("Provider reconciliation probe returned an unreadable response.");
  }
}

function digestKey(domain: string, idempotencyKey: string): string {
  return createHash("sha256").update(`${domain}\0${idempotencyKey}`).digest("hex").slice(0, 32);
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveApiBaseUrl(envKey: string, fallback: string): string {
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : fallback;
}
