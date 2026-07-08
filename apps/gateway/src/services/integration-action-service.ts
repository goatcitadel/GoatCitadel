import type {
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationConnection,
  IntegrationExternalWritebackResumeState,
  IntegrationExternalWritebackReplayOutcome,
  IntegrationOperatorAction,
} from "@goatcitadel/contracts";
import type { EvidenceEnvelopeService } from "./evidence-envelope-service.js";
import { invokeActivepiecesRunStatusAction } from "./activepieces-run-status-action.js";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import {
  buildExternalSideEffectReplayOutput,
  type ExternalSideEffectRunStore,
  type IdempotentExternalSideEffectRunInput,
  recordAuditOnlyExternalSideEffectIntent,
} from "./external-side-effect-runner-service.js";
import { getIntegrationOperatorActions, isLocalBridgeCatalogId } from "./integration-action-registry.js";
import { invokeGifSearchAction } from "./gif-search-action.js";
import type { MutationIdempotencyStore } from "./mutation-idempotency-store.js";
import {
  buildIntegrationWardAction,
  resolveWardEffectForExternalAction,
  type CitadelWardGateStorage,
} from "./citadel-ward-gate.js";
import {
  type IntegrationDryRunApprovalCreate,
  type IntegrationDryRunApprovalStores,
  type IntegrationDryRunCommitRef,
  type IntegrationWardContext,
  runWardGatedExternalSideEffect,
} from "./integration-dry-run-gate.js";

export interface IntegrationActionHost {
  storage: {
    integrationConnections: {
      get(connectionId: string): IntegrationConnection;
    };
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
  resolveConnectionSecret(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined;
  publishRealtime(scope: string, channel: string, payload: Record<string, unknown>): void;
  evidenceEnvelopeService?: Pick<EvidenceEnvelopeService, "createEnvelope">;
  mutationStore?: MutationIdempotencyStore;
  sideEffectRunStore?: ExternalSideEffectRunStore;
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
}

export async function invokeIntegrationConnectionAction(
  host: IntegrationActionHost,
  connectionId: string,
  actionId: string,
  request: IntegrationActionInvokeInput = {},
  options: IntegrationActionInvokeOptions = {},
): Promise<IntegrationActionInvokeResult> {
  const connection = host.storage.integrationConnections.get(connectionId);
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
  const wardResolution = resolveWardEffectForExternalAction({
    storage: host.storage,
    workspaceId: connection.workspaceId,
    action: wardAction,
  });
  const ward: IntegrationWardContext = {
    effect: wardResolution.effect,
    action: wardAction,
    citadelId: wardResolution.citadelId,
    invokeRequest: request,
    dryRunCommit: options.dryRunCommit,
  };

  let result: IntegrationActionInvokeResult;
  if (ward.effect === "deny" || ward.effect === "require_approval") {
    // Blocked results fall through the shared writeback-envelope + realtime
    // tail below, so ward refusals are audited exactly like provider results.
    result = blocked(
      connection,
      actionId,
      checkedAt,
      ward.effect === "deny"
        ? `A Citadel Ward denies ${wardAction} for this connection's citadel.`
        : `A Citadel Ward requires approval for ${wardAction}; approval-gated execution for integration actions is not wired yet, so the action is blocked.`,
      ward.effect === "deny" ? "citadel_ward_deny" : "citadel_ward_approval_required",
      { wardAction, wardEffect: ward.effect, citadelId: ward.citadelId },
    );
  } else if (isLocalBridgeCatalogId(connection.catalogId)) {
    result = await invokeLocalBridgeAction(host, connection, action, request, checkedAt, ward);
  } else if (connection.catalogId === "productivity.trello") {
    result = await invokeTrelloAction(host, connection, actionId, request, checkedAt, ward);
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
  result = recordExternalWritebackEnvelope(host, connection, action, result, request, checkedAt);

  host.publishRealtime("system", "integrations", {
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
  const authHeader = resolveBearerAuth(host, connection.config);
  const candidates = [
    joinUrl(bridgeUrl, "/v1/integrations/actions"),
    joinUrl(bridgeUrl, "/api/v1/integrations/actions"),
  ];
  const bridgePayload = {
    integrationKey: connection.key,
    catalogId: connection.catalogId,
    connectionId: connection.connectionId,
    actionId: action.actionId,
    input: request.input ?? {},
  };
  const executeBridge = () =>
    sendLocalBridgeAction(
      host,
      connection,
      action.actionId,
      checkedAt,
      bridgeUrl,
      candidates,
      authHeader,
      bridgePayload,
    );

  if (action.capability === "write") {
    const replayRun = await runWardGatedExternalSideEffect(
      host,
      ward,
      {
        mutationStore: host.mutationStore,
        sideEffectRunStore: host.sideEffectRunStore,
        boundary: "integration_local_bridge_action",
        catalogId: connection.catalogId,
        connectionId: connection.connectionId,
        actionId: action.actionId,
        checkedAt,
        workspaceId: connection.workspaceId,
        idempotencyKey: request.idempotencyKey,
        payload: {
          provider: "local_bridge",
          catalogId: connection.catalogId,
          actionId: action.actionId,
          input: request.input ?? {},
        },
        label: `${action.label} local bridge action`,
        output: {
          provider: "local_bridge",
          catalogId: connection.catalogId,
          actionId: action.actionId,
        },
        execute: async (claim) => {
          claim.markExternalCallStarted();
          const result = await executeBridge();
          if (result.status === "failed") {
            throw new Error(result.message);
          }
          return result;
        },
      },
      { externalDestination: bridgeUrl },
    );
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
    return {
      ...replayRun.value,
      output: buildExternalSideEffectReplayOutput(replayRun.claim, {
        provider: "local_bridge",
        catalogId: connection.catalogId,
        actionId: action.actionId,
        ...(replayRun.value.output ?? {}),
      }),
    };
  }

  return executeBridge();
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
  const authHeader = resolveBearerAuth(host, connection.config);
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
        claim.markExternalCallStarted();
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
  const apiKey = host.resolveConnectionSecret(connection.config, "apiKey", "apiKeyEnv");
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv");
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
    const url = new URL("/1/members/me/boards", resolveTrelloApiBaseUrl());
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
    const url = new URL("/1/cards", resolveTrelloApiBaseUrl());
    url.searchParams.set("key", apiKey);
    url.searchParams.set("token", token);
    url.searchParams.set("idList", listId);
    url.searchParams.set("name", name);
    url.searchParams.set("desc", desc);
    const replayRun = await runWardGatedExternalSideEffect(
      host,
      ward,
      {
        mutationStore: host.mutationStore,
        sideEffectRunStore: host.sideEffectRunStore,
        boundary: "integration_operator_action",
        catalogId: connection.catalogId,
        connectionId: connection.connectionId,
        actionId,
        checkedAt,
        workspaceId: connection.workspaceId,
        idempotencyKey: request.idempotencyKey,
        payload: {
          provider: "trello",
          listId,
          name,
          desc,
        },
        label: "Trello card create",
        output: {
          provider: "trello",
          listId,
          name,
        },
        execute: async (claim) => {
          claim.markExternalCallStarted();
          const response = await host.fetchWithDiagnosticsTimeout(url.toString(), { method: "POST" });
          const parsed = await parseResponse(response);
          if (!response.ok) {
            throw new Error(parsed.message ?? `Trello card create failed (${response.status}).`);
          }
          return parsed;
        },
      },
      { externalDestination: url.toString() },
    );
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

async function invokeGmailAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const token = host.resolveConnectionSecret(connection.config, "accessToken", "accessTokenEnv");
  if (!token) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Configure a Gmail access token before running operator actions.",
      "gmail_auth_missing",
    );
  }

  if (actionId === "read") {
    const url = new URL("/gmail/v1/users/me/messages", resolveGmailApiBaseUrl());
    const query = readStringInput(request.input, "query");
    if (query) {
      url.searchParams.set("q", query);
    }
    url.searchParams.set("maxResults", readStringInput(request.input, "maxResults") ?? "10");
    const response = await host.fetchWithDiagnosticsTimeout(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const parsed = await parseResponse(response);
    if (!response.ok) {
      return failed(connection, actionId, checkedAt, parsed.message ?? `Gmail read failed (${response.status}).`, {
        provider: "gmail",
      });
    }
    const body = isRecord(parsed.output) ? parsed.output : {};
    const items = Array.isArray(body.messages) ? body.messages.slice(0, 10) : [];
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "executed",
      message: `Fetched ${items.length} Gmail message${items.length === 1 ? "" : "s"}.`,
      output: {
        provider: "gmail",
        items,
      },
      checkedAt,
    };
  }

  if (actionId === "write") {
    const to = readStringInput(request.input, "to");
    const subject = readStringInput(request.input, "subject");
    const bodyText = readStringInput(request.input, "bodyText");
    if (!to || !subject || !bodyText) {
      return blocked(
        connection,
        actionId,
        checkedAt,
        "Provide recipient, subject, and body text before sending a Gmail operator test.",
        "gmail_message_incomplete",
      );
    }
    const rawMessage = [
      `To: ${to}`,
      `Subject: ${subject}`,
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      bodyText,
    ].join("\r\n");
    const gmailSendUrl = new URL("/gmail/v1/users/me/messages/send", resolveGmailApiBaseUrl()).toString();
    const replayRun = await runWardGatedExternalSideEffect(
      host,
      ward,
      {
        mutationStore: host.mutationStore,
        sideEffectRunStore: host.sideEffectRunStore,
        boundary: "integration_operator_action",
        catalogId: connection.catalogId,
        connectionId: connection.connectionId,
        actionId,
        checkedAt,
        workspaceId: connection.workspaceId,
        idempotencyKey: request.idempotencyKey,
        payload: {
          provider: "gmail",
          to,
          subject,
          bodyText,
        },
        label: "Gmail send",
        output: {
          provider: "gmail",
          to,
          subject,
        },
        execute: async (claim) => {
          claim.markExternalCallStarted();
          const response = await host.fetchWithDiagnosticsTimeout(gmailSendUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              raw: Buffer.from(rawMessage).toString("base64url"),
            }),
          });
          const parsed = await parseResponse(response);
          if (!response.ok) {
            throw new Error(parsed.message ?? `Gmail send failed (${response.status}).`);
          }
          return parsed;
        },
      },
      { externalDestination: gmailSendUrl },
    );
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
      message: "Sent a Gmail operator test message through the configured connection.",
      output: buildExternalSideEffectReplayOutput(replayRun.claim, {
        provider: "gmail",
        ...output,
      }),
      checkedAt,
    };
  }

  return blocked(
    connection,
    actionId,
    checkedAt,
    `Unsupported Gmail operator action: ${actionId}.`,
    "action_unsupported",
  );
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

function recordExternalWritebackEnvelope(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  action: IntegrationOperatorAction,
  result: IntegrationActionInvokeResult,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): IntegrationActionInvokeResult {
  if (action.capability !== "write") {
    return result;
  }
  const durableWriteback = recordAuditOnlyExternalSideEffectIntent({
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

function readExternalReplayOutcome(
  output: Record<string, unknown> | undefined,
): IntegrationExternalWritebackReplayOutcome | undefined {
  const value = readOutputString(output, "replayOutcome");
  return value === "claimed" ||
    value === "duplicate" ||
    value === "in_progress" ||
    value === "payload_mismatch" ||
    value === "idempotency_unavailable"
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

function resolveBearerAuth(host: IntegrationActionHost, config: Record<string, unknown>): string | undefined {
  const token =
    host.resolveConnectionSecret(config, "authToken", "authTokenEnv") ??
    host.resolveConnectionSecret(config, "accessToken", "accessTokenEnv") ??
    host.resolveConnectionSecret(config, "token", "tokenEnv");
  return token ? `Bearer ${token}` : undefined;
}

function joinUrl(baseUrl: string, suffix: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `${normalizedBase}${normalizedSuffix}`;
}

async function parseResponse(
  response: Response,
): Promise<{ message?: string; output?: Record<string, unknown> | unknown[] | string }> {
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

function resolveTrelloApiBaseUrl(): string {
  return resolveApiBaseUrl("GOATCITADEL_TRELLO_API_BASE_URL", "https://api.trello.com");
}

function resolveGmailApiBaseUrl(): string {
  return resolveApiBaseUrl("GOATCITADEL_GMAIL_API_BASE_URL", "https://gmail.googleapis.com");
}

function resolveApiBaseUrl(envKey: string, fallback: string): string {
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : fallback;
}
