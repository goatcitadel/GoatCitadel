import type {
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import type { IntegrationActionHost } from "./integration-action-service.js";

/**
 * GIF search operator action (Tenor/Giphy), extracted from
 * integration-action-service to keep the dispatcher under the max-lines
 * budget. Read-only: no side-effect runner involvement.
 */
export async function invokeGifSearchAction(
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
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "failed",
      message: parsed.message ?? `GIF search failed (${response.status}).`,
      output: { provider, query },
      checkedAt,
    };
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

async function parseResponse(
  response: Response,
): Promise<{ message?: string; output?: Record<string, unknown> | unknown[] | string }> {
  const raw = await readBoundedResponseText(response, {
    maxBytes: 256 * 1024,
    timeoutMs: 5_000,
    label: "gif search response",
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
    return { output: parsed as unknown[] | string };
  } catch {
    return { message: raw.slice(0, 400) };
  }
}

function readStringInput(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildTenorUrl(apiKey: string, query: string, locale: string): string {
  const url = new URL(
    "/v2/search",
    resolveApiBaseUrl("GOATCITADEL_TENOR_API_BASE_URL", "https://tenor.googleapis.com"),
  );
  url.searchParams.set("key", apiKey);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "5");
  url.searchParams.set("locale", locale);
  return url.toString();
}

function buildGiphyUrl(apiKey: string, query: string): string {
  const url = new URL("/v1/gifs/search", resolveApiBaseUrl("GOATCITADEL_GIPHY_API_BASE_URL", "https://api.giphy.com"));
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

function resolveApiBaseUrl(envKey: string, fallback: string): string {
  const value = process.env[envKey]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
