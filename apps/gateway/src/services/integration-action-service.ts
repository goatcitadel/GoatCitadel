import {
  GMAIL_SUMMARY_HEADERS,
  GMAIL_UNTRUSTED_CONTENT_NOTICE,
  summarizeGmailMessage,
  type GmailMessageSummary,
  type GoogleWorkspaceCapability,
  type IntegrationActionInvokeInput,
  type IntegrationActionInvokeResult,
  type IntegrationConnection,
  type IntegrationExternalWritebackResumeState,
  type IntegrationExternalWritebackReplayOutcome,
  type IntegrationOperatorAction,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { invokeActivepiecesRunStatusAction } from "./activepieces-run-status-action.js";
import {
  buildExternalSideEffectReplayOutput,
  type ExternalSideEffectRunStore,
  fingerprintExternalSideEffectDestination,
  type IdempotentExternalSideEffectRunInput,
  recordAuditOnlyExternalSideEffectIntent,
} from "./external-side-effect-runner-service.js";
import { getIntegrationOperatorActions, isLocalBridgeCatalogId } from "./integration-action-registry.js";
import { invokeGifSearchAction } from "./gif-search-action.js";
import { invokeGitHubAction } from "./github-integration-action.js";
import { invokeNotionAction } from "./notion-integration-action.js";
import { buildLocalBridgeActionTargets, isLocalBridgeExternalSideEffectAction } from "./local-bridge-action-policy.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import type { ChannelSecretOwner } from "./channel-secret-resolution.js";
import type { ExternalSideEffectReplayRecords } from "./external-side-effect-replay-record.js";
import {
  buildGmailSendRunInput,
  buildLocalBridgeWriteRunInput,
  buildTrelloCardCreateRunInput,
  gmailApiBaseUrl,
  parseProviderResponse as parseResponse,
  resolveBearerAuth,
  trelloApiBaseUrl,
} from "./integration-writeback-run-inputs.js";
import {
  buildIntegrationWardAction,
  resolveWardEffectForExternalAction,
  type CitadelWardGateStorage,
} from "./citadel-ward-gate.js";
import {
  buildCitadelWardRequestSummary,
  CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
  citadelWardInputSummaryFields,
  computeCitadelWardIntegrationTargetFingerprint,
  type CitadelWardApprovalRef,
  type CitadelWardRequestVault,
} from "./citadel-ward-approval.js";
import {
  DRY_RUN_APPROVAL_TTL_MS,
  type IntegrationDryRunApprovalCreate,
  type IntegrationDryRunApprovalStores,
  type IntegrationDryRunCommitRef,
  type IntegrationWardContext,
  runWardGatedExternalSideEffect,
} from "./integration-dry-run-gate.js";

export interface IntegrationActionHost {
  storage: {
    integrationConnections: {
      get(connectionId: string): Promise<IntegrationConnection | undefined>;
    };
    /** Canonical transaction owner required by durable external-side-effect replay. */
    runImmediateTransaction?<T>(work: () => T | Promise<T>): Promise<Awaited<T>>;
    /**
     * Optional Citadel Ward inputs (workspaces + citadels). Hosts that omit
     * them (narrow test hosts) skip ward evaluation entirely — identical to
     * pre-ward behavior.
     */
    workspaces?: CitadelWardGateStorage["workspaces"];
    citadels?: CitadelWardGateStorage["citadels"];
  } & IntegrationDryRunApprovalStores;
  fetchWithDiagnosticsTimeout(url: string, init?: RequestInit): Promise<Response>;
  readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined;
  resolveConnectionSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId: string,
    owner: ChannelSecretOwner,
  ): string | undefined;
  publishRealtime(scope: string, channel: string, payload: Record<string, unknown>): Promise<unknown>;
  /** The connection's native Google sign-in; Gmail actions never read a pasted access token. */
  resolveGoogleWorkspaceAccessToken?(connectionId: string, capability: GoogleWorkspaceCapability): Promise<string>;
  evidenceEnvelopeService?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  mutationStore?: MutationIdempotencyStore;
  sideEffectRunStore?: ExternalSideEffectRunStore;
  /** Encrypted replay copies of runner payloads (WS8); absent on narrow test hosts. */
  replayRecords?: ExternalSideEffectReplayRecords;
  /**
   * Seals a ward approval request (it can carry secrets) so the approval record never holds
   * it in plaintext. Without it a ward require_approval keeps the fail-closed block.
   */
  citadelWardRequests?: CitadelWardRequestVault;
  /**
   * Optional approval front door (dry-run Stage 2). When present together with
   * `storage.dryRunCommits` + `storage.pendingApprovalActions`, a require_dry_run
   * refusal opens a persisted preview + operator approval instead of a bare block.
   */
  createApproval?: IntegrationDryRunApprovalCreate;
}

export interface IntegrationActionInvokeOptions {
  /** Present when replaying an operator-approved dry-run commit (Stage 2). */
  dryRunCommit?: IntegrationDryRunCommitRef;
  /**
   * Present when replaying an operator-approved Citadel Ward approval. Satisfies a live
   * `require_approval` only when minted for the same ward action; deny still wins.
   */
  wardApproval?: CitadelWardApprovalRef;
}

export async function invokeIntegrationConnectionAction(
  host: IntegrationActionHost,
  connectionId: string,
  actionId: string,
  request: IntegrationActionInvokeInput = {},
  options: IntegrationActionInvokeOptions = {},
): Promise<IntegrationActionInvokeResult> {
  const connection = await host.storage.integrationConnections.get(connectionId);
  if (!connection) {
    throw new Error(`Unknown integration connection: ${connectionId}`);
  }
  const action = getIntegrationOperatorActions(connection.catalogId).find((item) => item.actionId === actionId);
  if (!action) {
    throw new Error(`Unsupported integration action ${actionId} for ${connection.catalogId}.`);
  }

  const checkedAt = new Date().toISOString();

  // Citadel Ward gate (Stage 1): evaluate once per action against the
  // connection's workspace citadel (personal when unbound). The side-effect
  // runner only enforces require_dry_run, so deny/require_approval MUST be
  // blocked here — before any provider work, including reads. deny wins even
  // over an approved dry-run commit replay.
  const wardAction = buildIntegrationWardAction(connection.catalogId, actionId);
  const wardResolution = await resolveWardEffectForExternalAction({
    storage: host.storage,
    workspaceId: connection.workspaceId,
    action: wardAction,
  });
  // A matching approved ward replay satisfies require_approval (and only that).
  const wardApproved = wardResolution.effect === "require_approval" && options.wardApproval?.wardAction === wardAction;
  const ward: IntegrationWardContext = {
    effect: wardApproved ? undefined : wardResolution.effect,
    action: wardAction,
    citadelId: wardResolution.citadelId,
    invokeRequest: request,
    dryRunCommit: options.dryRunCommit,
  };

  let result: IntegrationActionInvokeResult;
  if (ward.effect === "deny") {
    // Blocked/approval results fall through the shared writeback-envelope + realtime
    // tail below, so ward refusals are audited exactly like provider results.
    result = blocked(
      connection,
      actionId,
      checkedAt,
      `A Citadel Ward denies ${wardAction} for this connection's citadel.`,
      "citadel_ward_deny",
      { wardAction, wardEffect: ward.effect, citadelId: ward.citadelId },
    );
  } else if (ward.effect === "require_approval") {
    result = await openIntegrationWardApproval(host, connection, action, request, ward, checkedAt);
  } else if (isLocalBridgeCatalogId(connection.catalogId)) {
    result = await invokeLocalBridgeAction(host, connection, action, request, checkedAt, ward);
  } else if (connection.catalogId === "productivity.trello") {
    result = await invokeTrelloAction(host, connection, actionId, request, checkedAt, ward);
  } else if (connection.catalogId === "productivity.notion") {
    result = await invokeNotionAction(host, connection, actionId, request, checkedAt, ward);
  } else if (connection.catalogId === "productivity.github") {
    result = await invokeGitHubAction(host, connection, actionId, request, checkedAt, ward);
  } else if (connection.catalogId === "automation.gmail") {
    result = await invokeGmailAction(host, connection, actionId, request, checkedAt, ward);
  } else if (connection.catalogId === "automation.activepieces") {
    result = await invokeActivepiecesAction(host, connection, actionId, request, checkedAt, ward);
  } else if (connection.catalogId === "automation.gif-search") {
    result = await invokeGifSearchAction(host, connection, actionId, request, checkedAt);
  } else {
    result = {
      connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "blocked",
      message: `No operator-action runtime is registered for ${connection.catalogId}.`,
      blockedReason: "runtime_unavailable",
      checkedAt,
    };
  }
  result = await recordExternalWritebackEnvelope(host, connection, action, result, request, checkedAt);

  await host.publishRealtime("system", "integrations", {
    type: "integration_operator_action_completed",
    connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: result.status,
    durableWritebackStatus: result.durableWriteback?.status,
    durableWritebackEnvelopeId: result.durableWriteback?.envelopeId,
    checkedAt,
  });
  return result;
}

async function invokeLocalBridgeAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  action: IntegrationOperatorAction,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const bridgeUrl =
    host.readConnectionConfigValue(connection.config, "bridgeUrl") ??
    host.readConnectionConfigValue(connection.config, "baseUrl");
  if (!bridgeUrl) {
    return blocked(
      connection,
      action.actionId,
      checkedAt,
      "Configure a local bridge URL before running this action.",
      "bridge_url_missing",
    );
  }
  if (isExternalSideEffectAction(connection, action)) {
    const parts = buildLocalBridgeWriteRunInput(host, connection, action, {
      checkedAt,
      idempotencyKey: request.idempotencyKey,
      payload: {
        provider: "local_bridge",
        catalogId: connection.catalogId,
        actionId: action.actionId,
        input: request.input ?? {},
      },
    });
    if ("blockedReason" in parts) {
      return blocked(connection, action.actionId, checkedAt, parts.message, parts.blockedReason, parts.output);
    }
    const replayRun = await runWardGatedExternalSideEffect(host, ward, parts.input, {
      externalDestination: parts.target,
    });
    if (replayRun.status === "blocked") {
      return blocked(
        connection,
        action.actionId,
        checkedAt,
        replayRun.message,
        replayRun.blockedReason,
        replayRun.output,
      );
    }
    if (replayRun.status === "failed") {
      return failed(connection, action.actionId, checkedAt, replayRun.error.message, replayRun.output);
    }
    const parsed = replayRun.value;
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId: action.actionId,
      status: "executed",
      message: parsed.message ?? `${action.actionId} completed through the local bridge.`,
      output: buildExternalSideEffectReplayOutput(replayRun.claim, {
        provider: "local_bridge",
        catalogId: connection.catalogId,
        actionId: action.actionId,
        ...(normalizeLocalBridgeOutput(parsed.output) ?? {}),
      }),
      checkedAt,
    };
  }

  return sendLocalBridgeAction(
    host,
    connection,
    action.actionId,
    checkedAt,
    bridgeUrl,
    buildLocalBridgeActionTargets(bridgeUrl, host.readConnectionConfigValue(connection.config, "actionRoute")),
    resolveBearerAuth(host, connection),
    {
      integrationKey: connection.key,
      catalogId: connection.catalogId,
      connectionId: connection.connectionId,
      actionId: action.actionId,
      input: request.input ?? {},
    },
  );
}

async function sendLocalBridgeAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  bridgeUrl: string,
  candidates: string[],
  authHeader: string | undefined,
  bridgePayload: {
    integrationKey: string;
    catalogId: string;
    connectionId: string;
    actionId: string;
    input: Record<string, unknown>;
  },
): Promise<IntegrationActionInvokeResult> {
  let lastFailure: string | undefined;
  for (const target of candidates) {
    try {
      const response = await host.fetchWithDiagnosticsTimeout(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify(bridgePayload),
      });
      const parsed = await parseResponse(response);
      if (!response.ok) {
        lastFailure = parsed.message ?? `Bridge action failed (${response.status}).`;
        continue;
      }
      return {
        connectionId: connection.connectionId,
        catalogId: connection.catalogId,
        actionId,
        status: "executed",
        message: parsed.message ?? `${actionId} completed through the local bridge.`,
        output: normalizeLocalBridgeOutput(parsed.output),
        checkedAt,
      };
    } catch (error) {
      lastFailure = (error as Error).message;
    }
  }

  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "failed",
    message: lastFailure ?? "The configured local bridge did not accept the action request.",
    output: {
      bridgeUrl,
    },
    checkedAt,
  };
}

/** The runner input + externalDestination target for an Activepieces `trigger_webhook` call. */
export interface ActivepiecesTriggerWebhookJobParts {
  input: IdempotentExternalSideEffectRunInput<{
    message?: string;
    output?: Record<string, unknown> | unknown[] | string;
  }>;
  /** Resolved webhook URL — feeds `WardGateRunOptions.externalDestination`. */
  target: string;
}

/**
 * Builds the ward-gated runner input for triggering an Activepieces webhook flow, without
 * running it. Resolves the webhook URL + bearer auth from the connection and constructs the
 * `execute` closure that performs the fetch. Extracted so replay callers (e.g. dry-run commit
 * replay) can reuse the exact same runner input the live invocation path builds.
 */
export function buildActivepiecesTriggerWebhookRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: {
    checkedAt: string;
    flowId?: string;
    payload: Record<string, unknown>;
    idempotencyKey?: string;
    actorScope?: string;
  },
): ActivepiecesTriggerWebhookJobParts | { blockedReason: "activepieces_webhook_missing"; message: string } {
  const webhookUrl = host.readConnectionConfigValue(connection.config, "webhookUrl");
  if (!webhookUrl) {
    return {
      blockedReason: "activepieces_webhook_missing",
      message: "Configure an Activepieces webhook URL before triggering a flow.",
    };
  }
  const target = parseHttpUrl(webhookUrl, "Activepieces webhook URL");
  const authHeader = resolveBearerAuth(host, connection);
  const { checkedAt, flowId, payload, idempotencyKey, actorScope } = options;
  return {
    target,
    input: {
      mutationStore: host.mutationStore,
      sideEffectRunStore: host.sideEffectRunStore,
      boundary: "integration_operator_action",
      catalogId: connection.catalogId,
      connectionId: connection.connectionId,
      actionId: "trigger_webhook",
      checkedAt,
      workspaceId: connection.workspaceId,
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      idempotencyKey,
      ...(actorScope ? { actorScope } : {}),
      payload: {
        provider: "activepieces",
        flowId,
        payload,
      },
      label: "Activepieces webhook trigger",
      output: {
        provider: "activepieces",
        ...(flowId ? { flowId } : {}),
      },
      execute: async (claim) => {
        await claim.markExternalCallStarted();
        const response = await host.fetchWithDiagnosticsTimeout(target, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(authHeader ? { authorization: authHeader } : {}),
          },
          body: JSON.stringify({
            source: "goatcitadel",
            checkedAt,
            ...(flowId ? { flowId } : {}),
            payload,
          }),
        });
        const parsed = await parseResponse(response);
        if (!response.ok) {
          throw new Error(parsed.message ?? `Activepieces webhook trigger failed (${response.status}).`);
        }
        return parsed;
      },
    },
  };
}

async function invokeActivepiecesAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  if (actionId === "check_run_status") {
    return invokeActivepiecesRunStatusAction(host, connection, request, checkedAt);
  }
  if (actionId !== "trigger_webhook") {
    return blocked(
      connection,
      actionId,
      checkedAt,
      `Unsupported Activepieces operator action: ${actionId}.`,
      "action_unsupported",
    );
  }
  const flowId =
    readStringInput(request.input, "flowId") ?? host.readConnectionConfigValue(connection.config, "defaultFlowId");
  const payload = readActivepiecesPayload(request.input);
  const parts = buildActivepiecesTriggerWebhookRunInput(host, connection, {
    checkedAt,
    flowId,
    payload,
    idempotencyKey: request.idempotencyKey,
  });
  if ("blockedReason" in parts) {
    return blocked(connection, actionId, checkedAt, parts.message, parts.blockedReason);
  }
  const replayRun = await runWardGatedExternalSideEffect(host, ward, parts.input, {
    externalDestination: parts.target,
  });
  if (replayRun.status === "blocked") {
    return blocked(connection, actionId, checkedAt, replayRun.message, replayRun.blockedReason, replayRun.output);
  }
  if (replayRun.status === "failed") {
    return failed(connection, actionId, checkedAt, replayRun.error.message, replayRun.output);
  }
  const parsed = replayRun.value;
  const activepiecesOutput = normalizeActivepiecesWebhookOutput(parsed.output);
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "executed",
    message: parsed.message ?? "Triggered the configured Activepieces webhook flow.",
    output: buildExternalSideEffectReplayOutput(replayRun.claim, {
      provider: "activepieces",
      ...(flowId ? { flowId } : {}),
      ...activepiecesOutput,
    }),
    checkedAt,
  };
}

async function invokeTrelloAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const apiKey = host.resolveConnectionSecret(
    connection.config,
    "apiKey",
    "apiKeyEnv",
    connection.catalogId,
    connection,
  );
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId, connection);
  if (!apiKey || !token) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Configure Trello API key and token before running this action.",
      "trello_auth_missing",
    );
  }

  if (actionId === "read") {
    const url = new URL("/1/members/me/boards", trelloApiBaseUrl());
    url.searchParams.set("fields", "name,url,closed");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("token", token);
    url.searchParams.set("lists", "none");
    const response = await host.fetchWithDiagnosticsTimeout(url.toString(), { method: "GET" });
    const parsed = await parseResponse(response);
    if (!response.ok) {
      return failed(connection, actionId, checkedAt, parsed.message ?? `Trello read failed (${response.status}).`, {
        provider: "trello",
      });
    }
    const items = Array.isArray(parsed.output) ? parsed.output : [];
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "executed",
      message: `Fetched ${items.length} Trello board${items.length === 1 ? "" : "s"}.`,
      output: {
        provider: "trello",
        items: items.slice(0, 5),
      },
      checkedAt,
    };
  }

  if (actionId === "write") {
    const name = readStringInput(request.input, "name") ?? "GoatCitadel operator card";
    const desc = readStringInput(request.input, "desc") ?? "Created from Mission Control operator actions.";
    const listId =
      readStringInput(request.input, "listId") ?? host.readConnectionConfigValue(connection.config, "defaultListId");
    if (!listId) {
      return blocked(
        connection,
        actionId,
        checkedAt,
        "Set a default Trello list or provide a list override before creating a card.",
        "trello_list_missing",
      );
    }
    const parts = buildTrelloCardCreateRunInput(host, connection, {
      checkedAt,
      idempotencyKey: request.idempotencyKey,
      payload: { provider: "trello", listId, name, desc },
    });
    if ("blockedReason" in parts) {
      return blocked(connection, actionId, checkedAt, parts.message, parts.blockedReason, parts.output);
    }
    const replayRun = await runWardGatedExternalSideEffect(host, ward, parts.input, {
      externalDestination: parts.target,
    });
    if (replayRun.status === "blocked") {
      return blocked(connection, actionId, checkedAt, replayRun.message, replayRun.blockedReason, replayRun.output);
    }
    if (replayRun.status === "failed") {
      return failed(connection, actionId, checkedAt, replayRun.error.message, replayRun.output);
    }
    const parsed = replayRun.value;
    const output = normalizeProviderOutput(parsed.output);
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "executed",
      message: "Created a Trello card through the configured connection.",
      output: buildExternalSideEffectReplayOutput(replayRun.claim, {
        provider: "trello",
        ...output,
      }),
      checkedAt,
    };
  }

  return blocked(
    connection,
    actionId,
    checkedAt,
    `Unsupported Trello operator action: ${actionId}.`,
    "action_unsupported",
  );
}

const OPERATOR_READ_MAX_RESULTS = 10;

/**
 * Gmail operator actions on a Google-signed-in connection. `read` returns bounded message
 * metadata like the `gmail.read` tool; `write` sends one test message through the shared
 * idempotent side-effect runner behind the Citadel Ward gate.
 */
async function invokeGmailAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  if (actionId !== "read" && actionId !== "write") {
    return blocked(
      connection,
      actionId,
      checkedAt,
      `Unsupported Gmail operator action: ${actionId}.`,
      "action_unsupported",
    );
  }
  const token = await resolveGmailActionToken(host, connection, actionId === "write" ? "gmail.send" : "gmail.read");
  if ("message" in token) {
    return blocked(connection, actionId, checkedAt, token.message, "gmail_auth_missing");
  }
  return actionId === "read"
    ? await runRead(host, connection, token.accessToken, request, checkedAt)
    : await runWrite(host, connection, token.accessToken, request, checkedAt, ward);
}

/** The connection's Google sign-in, or the refusal the operator sees. Never a pasted token. */
export async function resolveGmailActionToken(
  host: Pick<IntegrationActionHost, "resolveGoogleWorkspaceAccessToken">,
  connection: IntegrationConnection,
  capability: GoogleWorkspaceCapability,
): Promise<{ accessToken: string } | { message: string }> {
  const resolveAccessToken = host.resolveGoogleWorkspaceAccessToken;
  if (!resolveAccessToken) {
    return { message: "Google sign-in is not available here. Connect Google before running Gmail actions." };
  }
  try {
    return { accessToken: await resolveAccessToken.call(host, connection.connectionId, capability) };
  } catch (error) {
    return {
      message: (error instanceof Error ? error.message : "Google sign-in failed.").replace(/^blocked:\s*/u, ""),
    };
  }
}

async function runRead(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  accessToken: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const url = new URL("/gmail/v1/users/me/messages", gmailApiBaseUrl());
  const query = readStringInput(request.input, "query");
  if (query) url.searchParams.set("q", query.slice(0, 512));
  const requested = Number(readStringInput(request.input, "maxResults") ?? OPERATOR_READ_MAX_RESULTS);
  const maxResults = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), OPERATOR_READ_MAX_RESULTS) : 10;
  url.searchParams.set("maxResults", String(maxResults));
  const headers = { Authorization: `Bearer ${accessToken}` };
  const fetchWithTimeout = host.fetchWithDiagnosticsTimeout.bind(host);
  const list = await fetchWithTimeout(url.toString(), { method: "GET", headers });
  const parsed = await parseResponse(list);
  if (!list.ok) {
    return failed(connection, "read", checkedAt, parsed.message ?? `Gmail read failed (${list.status}).`, {
      provider: "gmail",
    });
  }
  const ids = (isRecord(parsed.output) && Array.isArray(parsed.output.messages) ? parsed.output.messages : [])
    .map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : ""))
    .filter((id) => /^[A-Za-z0-9_-]{1,128}$/u.test(id))
    .slice(0, maxResults);
  const items: GmailMessageSummary[] = [];
  for (const id of ids) {
    const messageUrl = new URL(`/gmail/v1/users/me/messages/${encodeURIComponent(id)}`, gmailApiBaseUrl());
    messageUrl.searchParams.set("format", "metadata");
    for (const header of GMAIL_SUMMARY_HEADERS) messageUrl.searchParams.append("metadataHeaders", header);
    const response = await fetchWithTimeout(messageUrl.toString(), { method: "GET", headers });
    const message = await parseResponse(response);
    const summary = response.ok ? summarizeGmailMessage(message.output) : undefined;
    if (summary) items.push(summary);
  }
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId: "read",
    status: "executed",
    message: `Fetched ${items.length} Gmail message${items.length === 1 ? "" : "s"}.`,
    output: { provider: "gmail", items, contentTrust: "untrusted_external", notice: GMAIL_UNTRUSTED_CONTENT_NOTICE },
    checkedAt,
  };
}

async function runWrite(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  accessToken: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const to = readStringInput(request.input, "to");
  const subject = readStringInput(request.input, "subject");
  const bodyText = readStringInput(request.input, "bodyText");
  if (!to || !subject || !bodyText) {
    return blocked(
      connection,
      "write",
      checkedAt,
      "Provide recipient, subject, and body text before sending a Gmail operator test.",
      "gmail_message_incomplete",
    );
  }
  const parts = buildGmailSendRunInput(
    host,
    connection,
    { checkedAt, idempotencyKey: request.idempotencyKey, payload: { provider: "gmail", to, subject, bodyText } },
    accessToken,
  );
  const replayRun = await runWardGatedExternalSideEffect(host, ward, parts.input, {
    externalDestination: parts.target,
  });
  if (replayRun.status === "blocked") {
    return blocked(connection, "write", checkedAt, replayRun.message, replayRun.blockedReason, replayRun.output);
  }
  if (replayRun.status === "failed") {
    return failed(connection, "write", checkedAt, replayRun.error.message, replayRun.output);
  }
  const output = replayRun.value.output;
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId: "write",
    status: "executed",
    message: "Sent a Gmail operator test message through the configured connection.",
    output: buildExternalSideEffectReplayOutput(replayRun.claim, {
      provider: "gmail",
      ...(isRecord(output) ? output : output === undefined ? {} : { raw: output }),
    }),
    checkedAt,
  };
}

/**
 * Open an operator approval for a ward `require_approval` refusal. The approval carries the
 * exact invoke request sealed, plus its hash; executing it is the approval effect's job (it
 * re-invokes with `wardApproval`). Hosts without `createApproval`, or whose request cannot be
 * sealed, keep the fail-closed block: the request never lands in the approval in plaintext.
 */
async function openIntegrationWardApproval(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  action: IntegrationOperatorAction,
  request: IntegrationActionInvokeInput,
  ward: IntegrationWardContext,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const wardOutput = { wardAction: ward.action, wardEffect: ward.effect, citadelId: ward.citadelId };
  const refusal = (message: string, extra: Record<string, unknown> = {}) =>
    blocked(connection, action.actionId, checkedAt, message, "citadel_ward_approval_required", {
      ...wardOutput,
      ...extra,
    });
  const createApproval = host.createApproval;
  if (!createApproval) {
    return refusal(
      `A Citadel Ward requires approval for ${ward.action}, but no approval loop is available on this host, so the action is blocked.`,
    );
  }
  const payload = await host.citadelWardRequests?.seal(CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND, {
    wardAction: ward.action,
    citadelId: ward.citadelId,
    workspaceId: connection.workspaceId,
    request: {
      connectionId: connection.connectionId,
      actionId: action.actionId,
      invokeRequest: {
        input: request.input ?? {},
        ...(request.idempotencyKey ? { idempotencyKey: request.idempotencyKey } : {}),
      },
      // A hash only: the replay refuses a connection whose target changed after approval.
      targetFingerprint: computeCitadelWardIntegrationTargetFingerprint(connection, action.actionId),
    },
  });
  if (!payload) {
    return refusal(
      `A Citadel Ward requires approval for ${ward.action}, but the request could not be sealed for the approval record, so the approval loop is unavailable and the action is blocked.`,
    );
  }
  try {
    const approval = await createApproval({
      kind: CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND,
      riskLevel: "caution",
      payload: { ...payload },
      preview: {
        title: `${action.label} — Citadel Ward approval`,
        route: ward.action,
        target: `${connection.connectionId}:${action.actionId}`,
        requestSummary: buildCitadelWardRequestSummary([
          ["Connection", `${connection.label} (${connection.catalogId})`],
          ["Action", `${action.label} (${action.actionId})`],
          ...citadelWardInputSummaryFields(request.input ?? {}),
        ]),
      },
      linkage: { workspaceId: connection.workspaceId, actionType: CITADEL_WARD_INTEGRATION_ACTION_APPROVAL_KIND },
      expiresAt: new Date(Date.parse(checkedAt) + DRY_RUN_APPROVAL_TTL_MS).toISOString(),
    });
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId: action.actionId,
      status: "approval_required",
      message: `A Citadel Ward requires operator approval for ${ward.action}; approval ${approval.approvalId} is pending.`,
      blockedReason: "citadel_ward_approval_required",
      output: { approvalId: approval.approvalId, ...wardOutput },
      checkedAt,
    };
  } catch (error) {
    return refusal(
      `A Citadel Ward requires approval for ${ward.action}; the approval could not be opened, so the action is blocked.`,
      { approvalError: error instanceof Error ? error.message : "citadel_ward_approval_create_failed" },
    );
  }
}

function blocked(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  message: string,
  blockedReason: string,
  output?: Record<string, unknown>,
): IntegrationActionInvokeResult {
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "blocked",
    message,
    blockedReason,
    output,
    checkedAt,
  };
}

function failed(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  message: string,
  output?: Record<string, unknown>,
): IntegrationActionInvokeResult {
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "failed",
    message,
    output,
    checkedAt,
  };
}

async function recordExternalWritebackEnvelope(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  action: IntegrationOperatorAction,
  result: IntegrationActionInvokeResult,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  if (!isExternalSideEffectAction(connection, action)) {
    return result;
  }
  const durableWriteback = await recordAuditOnlyExternalSideEffectIntent({
    evidenceEnvelopeService: host.evidenceEnvelopeService,
    boundary: "integration_operator_action",
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    integrationKey: connection.key,
    actionId: action.actionId,
    actionLabel: action.label,
    actionCapability: action.capability,
    replayPolicy:
      readOutputString(result.output, "replayPolicy") === "idempotent_external" ? "idempotent_external" : undefined,
    replayOutcome: readExternalReplayOutcome(result.output),
    resumable: readOutputBoolean(result.output, "resumable"),
    resumeState: readExternalResumeState(result.output),
    idempotencyKey: readOutputString(result.output, "idempotencyKey") ?? request.idempotencyKey,
    payloadHash: readOutputString(result.output, "payloadHash"),
    status: result.status,
    blockedReason: result.blockedReason,
    inputKeys: Object.keys(request.input ?? {}).sort(),
    outputKeys: isRecord(result.output) ? Object.keys(result.output).sort() : [],
    externalReferenceId: readExternalReferenceId(result.output),
    message: result.message,
    checkedAt,
  });
  return {
    ...result,
    durableWriteback,
    reversibility: durableWriteback.reversibility,
  };
}

function isExternalSideEffectAction(connection: IntegrationConnection, action: IntegrationOperatorAction): boolean {
  if (isLocalBridgeCatalogId(connection.catalogId)) {
    return isLocalBridgeExternalSideEffectAction(action);
  }
  return action.capability === "write";
}

function readExternalReplayOutcome(
  output: Record<string, unknown> | undefined,
): IntegrationExternalWritebackReplayOutcome | undefined {
  const value = readOutputString(output, "replayOutcome");
  return value === "claimed" ||
    value === "duplicate" ||
    value === "in_progress" ||
    value === "payload_mismatch" ||
    value === "idempotency_unavailable" ||
    value === "unknown_after_send"
    ? value
    : undefined;
}

function readExternalResumeState(
  output: Record<string, unknown> | undefined,
): IntegrationExternalWritebackResumeState | undefined {
  const value = readOutputString(output, "resumeState");
  return value === "not_resumable" ||
    value === "completed" ||
    value === "manual_retry_after_recorded_failure" ||
    value === "manual_review_unknown_external_outcome" ||
    value === "in_progress" ||
    value === "payload_mismatch" ||
    value === "idempotency_unavailable"
    ? value
    : undefined;
}

function readOutputBoolean(output: Record<string, unknown> | undefined, key: string): boolean | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  return typeof output[key] === "boolean" ? output[key] : undefined;
}

function readOutputString(output: Record<string, unknown> | undefined, key: string): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  const value = output[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readExternalReferenceId(output: Record<string, unknown> | undefined): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  for (const key of ["workflowRunId", "flowRunId", "runId", "id", "messageId", "threadId", "url", "webUrl"]) {
    const value = output[key];
    if (typeof value === "string" && value.trim()) {
      return `${key}:${value.trim().slice(0, 128)}`;
    }
  }
  return undefined;
}

function normalizeProviderOutput(
  output: Record<string, unknown> | unknown[] | string | undefined,
): Record<string, unknown> {
  if (isRecord(output)) {
    return output;
  }
  return output === undefined ? {} : { raw: output };
}

function normalizeLocalBridgeOutput(output: Record<string, unknown> | unknown[] | string | undefined) {
  if (isRecord(output) && isRecord(output.output)) {
    return output.output;
  }
  return isRecord(output) ? output : output !== undefined ? { raw: output } : undefined;
}

function normalizeActivepiecesWebhookOutput(
  output: Record<string, unknown> | unknown[] | string | undefined,
): Record<string, unknown> {
  const normalized = normalizeProviderOutput(output);
  const source = isRecord(normalized.output) ? normalized.output : normalized;
  const workflowRunId = readFirstString(source, ["workflowRunId", "flowRunId", "runId", "run_id", "id"]);
  const workflowRunStatus = readFirstString(source, ["workflowRunStatus", "flowRunStatus", "status"]);
  const workflowRunUrl = sanitizeReturnedWorkflowUrl(
    readFirstString(source, ["workflowRunUrl", "flowRunUrl", "webUrl", "url"]),
  );
  return {
    ...(workflowRunId ? { workflowRunId } : {}),
    ...(workflowRunStatus ? { workflowRunStatus } : {}),
    ...(workflowRunUrl ? { workflowRunUrl } : {}),
    workflowRunStatusSource: workflowRunStatus ? "webhook_response" : "not_available",
  };
}

function readFirstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function sanitizeReturnedWorkflowUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function readStringInput(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readActivepiecesPayload(input: Record<string, unknown> | undefined): Record<string, unknown> {
  const payload = input?.payload;
  if (isRecord(payload)) {
    return payload;
  }
  if (typeof payload === "string" && payload.trim()) {
    try {
      const parsed = JSON.parse(payload) as unknown;
      if (isRecord(parsed)) {
        return parsed;
      }
    } catch {
      return { text: payload.trim() };
    }
    return { text: payload.trim() };
  }
  const fallback = { ...(input ?? {}) };
  delete fallback.flowId;
  delete fallback.payload;
  return fallback;
}

function parseHttpUrl(value: string, label: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    return parsed.toString();
  } catch {
    throw new Error(`${label} must be an http or https URL.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
