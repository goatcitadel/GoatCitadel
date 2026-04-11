import type {
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { getIntegrationOperatorActions, isLocalBridgeCatalogId } from "./integration-action-registry.js";

export interface IntegrationActionHost {
  storage: {
    integrationConnections: {
      get(connectionId: string): IntegrationConnection;
    };
  };
  fetchWithDiagnosticsTimeout(url: string, init?: RequestInit): Promise<Response>;
  readConnectionConfigValue(config: Record<string, unknown>, key: string): string | undefined;
  resolveConnectionSecret(config: Record<string, unknown>, directKey: string, envKey: string): string | undefined;
  publishRealtime(scope: string, channel: string, payload: Record<string, unknown>): void;
}

export async function invokeIntegrationConnectionAction(
  host: IntegrationActionHost,
  connectionId: string,
  actionId: string,
  request: IntegrationActionInvokeInput = {},
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
  let result: IntegrationActionInvokeResult;
  if (isLocalBridgeCatalogId(connection.catalogId)) {
    result = await invokeLocalBridgeAction(host, connection, actionId, request, checkedAt);
  } else if (connection.catalogId === "productivity.trello") {
    result = await invokeTrelloAction(host, connection, actionId, request, checkedAt);
  } else if (connection.catalogId === "automation.gmail") {
    result = await invokeGmailAction(host, connection, actionId, request, checkedAt);
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

  host.publishRealtime("system", "integrations", {
    type: "integration_operator_action_completed",
    connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: result.status,
    checkedAt,
  });
  return result;
}

async function invokeLocalBridgeAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const bridgeUrl =
    host.readConnectionConfigValue(connection.config, "bridgeUrl") ??
    host.readConnectionConfigValue(connection.config, "baseUrl");
  if (!bridgeUrl) {
    return blocked(
      connection,
      actionId,
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

  let lastFailure: string | undefined;
  for (const target of candidates) {
    try {
      const response = await host.fetchWithDiagnosticsTimeout(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(authHeader ? { authorization: authHeader } : {}),
        },
        body: JSON.stringify({
          integrationKey: connection.key,
          catalogId: connection.catalogId,
          connectionId: connection.connectionId,
          actionId,
          input: request.input ?? {},
        }),
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
        output: isRecord(parsed.output)
          ? parsed.output
          : parsed.output !== undefined
            ? { raw: parsed.output }
            : undefined,
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

async function invokeTrelloAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
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
    const response = await host.fetchWithDiagnosticsTimeout(url.toString(), { method: "POST" });
    const parsed = await parseResponse(response);
    if (!response.ok) {
      return failed(
        connection,
        actionId,
        checkedAt,
        parsed.message ?? `Trello card create failed (${response.status}).`,
        {
          provider: "trello",
        },
      );
    }
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "executed",
      message: "Created a Trello card through the configured connection.",
      output: isRecord(parsed.output) ? parsed.output : { raw: parsed.output },
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
    const response = await host.fetchWithDiagnosticsTimeout(
      new URL("/gmail/v1/users/me/messages/send", resolveGmailApiBaseUrl()).toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          raw: Buffer.from(rawMessage).toString("base64url"),
        }),
      },
    );
    const parsed = await parseResponse(response);
    if (!response.ok) {
      return failed(connection, actionId, checkedAt, parsed.message ?? `Gmail send failed (${response.status}).`, {
        provider: "gmail",
      });
    }
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "executed",
      message: "Sent a Gmail operator test message through the configured connection.",
      output: isRecord(parsed.output) ? parsed.output : { raw: parsed.output },
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

async function invokeGifSearchAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  if (actionId !== "search") {
    return blocked(
      connection,
      actionId,
      checkedAt,
      `Unsupported GIF search operator action: ${actionId}.`,
      "action_unsupported",
    );
  }
  const provider = (host.readConnectionConfigValue(connection.config, "provider") ?? "tenor").trim().toLowerCase();
  const apiKey = host.resolveConnectionSecret(connection.config, "apiKey", "apiKeyEnv");
  if (!apiKey) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Configure a GIF provider API key before running search.",
      "gif_api_key_missing",
    );
  }
  const query = readStringInput(request.input, "query") ?? "happy goat";
  const locale = host.readConnectionConfigValue(connection.config, "defaultLocale") ?? "en_US";
  const url = provider === "giphy" ? buildGiphyUrl(apiKey, query) : buildTenorUrl(apiKey, query, locale);
  const response = await host.fetchWithDiagnosticsTimeout(url, { method: "GET" });
  const parsed = await parseResponse(response);
  if (!response.ok) {
    return failed(connection, actionId, checkedAt, parsed.message ?? `GIF search failed (${response.status}).`, {
      provider,
      query,
    });
  }
  const items = provider === "giphy" ? normalizeGiphyResults(parsed.output) : normalizeTenorResults(parsed.output);
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "executed",
    message: `Fetched ${items.length} GIF result${items.length === 1 ? "" : "s"} from ${provider}.`,
    output: {
      provider,
      query,
      items,
    },
    checkedAt,
  };
}

function blocked(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  message: string,
  blockedReason: string,
): IntegrationActionInvokeResult {
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "blocked",
    message,
    blockedReason,
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
  const raw = await response.text();
  if (!raw.trim()) {
    return {};
  }
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

function buildTenorUrl(apiKey: string, query: string, locale: string): string {
  const url = new URL("/v2/search", resolveTenorApiBaseUrl());
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("locale", locale);
  return url.toString();
}

function buildGiphyUrl(apiKey: string, query: string): string {
  const url = new URL("/v1/gifs/search", resolveGiphyApiBaseUrl());
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("rating", "pg-13");
  return url.toString();
}

function normalizeTenorResults(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    return [];
  }
  return value.results
    .filter(isRecord)
    .map((item) => ({
      id: item.id,
      title: typeof item.content_description === "string" ? item.content_description : item.id,
      url: readTenorMediaUrl(item),
    }))
    .slice(0, 5);
}

function readTenorMediaUrl(item: Record<string, unknown>): string | undefined {
  const mediaFormats = isRecord(item.media_formats) ? item.media_formats : undefined;
  if (!mediaFormats) {
    return undefined;
  }
  for (const key of ["gif", "mediumgif", "tinygif"]) {
    const entry = mediaFormats[key];
    if (isRecord(entry) && typeof entry.url === "string") {
      return entry.url;
    }
  }
  return undefined;
}

function normalizeGiphyResults(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    return [];
  }
  return value.data
    .filter(isRecord)
    .map((item) => ({
      id: item.id,
      title: typeof item.title === "string" ? item.title : item.id,
      url: readGiphyMediaUrl(item),
    }))
    .slice(0, 5);
}

function readGiphyMediaUrl(item: Record<string, unknown>): string | undefined {
  const images = isRecord(item.images) ? item.images : undefined;
  if (!images) {
    return undefined;
  }
  for (const key of ["original", "downsized", "fixed_height"]) {
    const entry = images[key];
    if (isRecord(entry) && typeof entry.url === "string") {
      return entry.url;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTrelloApiBaseUrl(): string {
  return resolveApiBaseUrl("GOATCITADEL_TRELLO_API_BASE_URL", "https://api.trello.com");
}

function resolveTenorApiBaseUrl(): string {
  return resolveApiBaseUrl("GOATCITADEL_TENOR_API_BASE_URL", "https://tenor.googleapis.com");
}

function resolveGiphyApiBaseUrl(): string {
  return resolveApiBaseUrl("GOATCITADEL_GIPHY_API_BASE_URL", "https://api.giphy.com");
}

function resolveGmailApiBaseUrl(): string {
  return resolveApiBaseUrl("GOATCITADEL_GMAIL_API_BASE_URL", "https://gmail.googleapis.com");
}

function resolveApiBaseUrl(envKey: string, fallback: string): string {
  const override = process.env[envKey]?.trim();
  return override && override.length > 0 ? override : fallback;
}
