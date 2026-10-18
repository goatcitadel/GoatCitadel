import type {
  ConnectorDiagnosticReport,
  IntegrationActionInvokeInput,
  IntegrationActionInvokeResult,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { readBoundedResponseText } from "./bounded-response-reader.js";
import {
  buildExternalSideEffectReplayOutput,
  type ExternalSideEffectExecutionContext,
  type ExternalSideEffectProbeResult,
  fingerprintExternalSideEffectDestination,
} from "./external-side-effect-runner-service.js";
import type { IntegrationActionHost } from "./integration-action-service.js";
import { runWardGatedExternalSideEffect, type IntegrationWardContext } from "./integration-dry-run-gate.js";
import {
  baseInput,
  isProviderPreDispatchRejection,
  ProviderRequestRejectedError,
  buildDedupedExecute,
  buildReconcile,
  digestScope,
  liveDedupeScope,
  OPERATOR_ACTION_BOUNDARY,
  parseProviderResponse,
  ProviderAuthRejectedError,
  readProbeJson,
  resolveApiBaseUrl,
  type ParsedProviderResponse,
  type WritebackDedupeScope,
  type WritebackRunInputParts,
} from "./integration-writeback-run-inputs.js";

/**
 * Notion operator actions (search, page read, page create, block append) over an internal
 * integration token. Reads call Notion directly; the two writes run through the shared
 * idempotent side-effect runner behind the Citadel Ward gate.
 *
 * Reconciliation: `block_append` probes the target's last children page for the idempotency
 * marker paragraph. `page_create` has NO reconcile probe: Notion cannot be searched for the
 * marker reliably (search is eventually consistent and title-only), so an unknown outcome stays
 * in manual review instead of risking a duplicate page.
 *
 * The `block_append` probe is NOT reached at runtime today: reconcileExternalOutcome only runs from
 * the replay worker, and productivity.notion is not on its allowlist, so the worker neither resends
 * nor reconciles Notion writes and an unknown outcome stays in manual review. The probe exists for
 * a future reconcile-only path.
 */

const NOTION_VERSION = "2022-06-28";
const NOTION_MARKER_DOMAIN = "goatcitadel:notion-marker:v1";
const NOTION_RICH_TEXT_LIMIT = 2000;
const NOTION_PROBE_MAX_PAGES = 20;
const AUTH_REJECTED_MESSAGE =
  "Notion rejected the integration token. Check the token and share the page with the integration.";

export const notionApiBaseUrl = () => resolveApiBaseUrl("GOATCITADEL_NOTION_API_BASE_URL", "https://api.notion.com");

export function deriveNotionIdempotencyMarker(scope: WritebackDedupeScope): string {
  return `[goatcitadel-idempotency:${digestScope(NOTION_MARKER_DOMAIN, scope).slice(0, 32)}]`;
}

export interface NotionPageCreatePayload {
  provider: "notion";
  parentPageId: string;
  title: string;
  content: string;
}

export interface NotionBlockAppendPayload {
  provider: "notion";
  blockId: string;
  content: string;
}

interface NotionRunInputOptions<TPayload> {
  checkedAt: string;
  payload: TPayload;
  idempotencyKey?: string;
  actorScope?: string;
}

type NotionRunInputBlocked = { blockedReason: string; message: string };

export async function invokeNotionAction(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!token) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Configure a Notion integration token before running this action.",
      "notion_auth_missing",
    );
  }
  switch (actionId) {
    case "search":
      return await runSearch(host, connection, token, request, checkedAt);
    case "page_read":
      return await runPageRead(host, connection, token, request, checkedAt);
    case "page_create":
      return await runPageCreate(host, connection, request, checkedAt, ward);
    case "block_append":
      return await runBlockAppend(host, connection, request, checkedAt, ward);
    default:
      return blocked(
        connection,
        actionId,
        checkedAt,
        `Unsupported Notion operator action: ${actionId}.`,
        "action_unsupported",
      );
  }
}

async function runSearch(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  token: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "search";
  const response = await host.fetchWithDiagnosticsTimeout(new URL("/v1/search", notionApiBaseUrl()).toString(), {
    method: "POST",
    headers: notionHeaders(token),
    body: JSON.stringify({ query: readStringInput(request.input, "query") ?? "", page_size: 10 }),
  });
  const parsed = await parseProviderResponse(response);
  const rejected = readFailure(connection, actionId, checkedAt, response, parsed, "Notion search failed");
  if (rejected) {
    return rejected;
  }
  const body = isRecord(parsed.output) ? parsed.output : {};
  const items = (Array.isArray(body.results) ? body.results : []).filter(isRecord).map((item) => ({
    id: readString(item.id) ?? "",
    object: readString(item.object) ?? "",
    title: extractTitle(item),
    url: readString(item.url) ?? "",
  }));
  return executed(
    connection,
    actionId,
    checkedAt,
    `Found ${items.length} Notion result${items.length === 1 ? "" : "s"}.`,
    { provider: "notion", items },
  );
}

async function runPageRead(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  token: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "page_read";
  const pageId = readStringInput(request.input, "pageId");
  if (!pageId) {
    return blocked(connection, actionId, checkedAt, "Provide a Notion page ID to read.", "notion_page_missing");
  }
  if (!isValidNotionId(pageId)) {
    return idInvalid(connection, actionId, checkedAt);
  }
  const base = notionApiBaseUrl();
  const pageResponse = await host.fetchWithDiagnosticsTimeout(
    new URL(`/v1/pages/${encodeURIComponent(pageId)}`, base).toString(),
    { method: "GET", headers: notionHeaders(token) },
  );
  const pageParsed = await parseProviderResponse(pageResponse);
  const pageFailure = readFailure(connection, actionId, checkedAt, pageResponse, pageParsed, "Notion page read failed");
  if (pageFailure) {
    return pageFailure;
  }
  const childrenUrl = new URL(`/v1/blocks/${encodeURIComponent(pageId)}/children`, base);
  childrenUrl.searchParams.set("page_size", "50");
  const childrenResponse = await host.fetchWithDiagnosticsTimeout(childrenUrl.toString(), {
    method: "GET",
    headers: notionHeaders(token),
  });
  const childrenParsed = await parseProviderResponse(childrenResponse);
  const childrenFailure = readFailure(
    connection,
    actionId,
    checkedAt,
    childrenResponse,
    childrenParsed,
    "Notion block read failed",
  );
  if (childrenFailure) {
    return childrenFailure;
  }
  const page = isRecord(pageParsed.output) ? pageParsed.output : {};
  const childrenBody = isRecord(childrenParsed.output) ? childrenParsed.output : {};
  const blocks = (Array.isArray(childrenBody.results) ? childrenBody.results : []).filter(isRecord).map((block) => ({
    id: readString(block.id) ?? "",
    type: readString(block.type) ?? "",
    text: extractBlockText(block),
  }));
  return executed(connection, actionId, checkedAt, `Read Notion page with ${blocks.length} block(s).`, {
    provider: "notion",
    id: readString(page.id) ?? pageId,
    title: extractTitle(page),
    url: readString(page.url) ?? "",
    blocks,
  });
}

async function runPageCreate(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "page_create";
  const title = readStringInput(request.input, "title");
  if (!title) {
    return blocked(connection, actionId, checkedAt, "Provide a title for the new Notion page.", "notion_title_missing");
  }
  const parentPageId =
    readStringInput(request.input, "parentPageId") ??
    host.readConnectionConfigValue(connection.config, "defaultParentPageId");
  if (!parentPageId) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Set a default Notion parent page or provide a parent page ID before creating a page.",
      "notion_parent_missing",
    );
  }
  if (!isValidNotionId(parentPageId)) {
    return idInvalid(connection, actionId, checkedAt);
  }
  const content = readStringInput(request.input, "content") ?? "";
  const tooLong = checkTextLength(connection, actionId, checkedAt, title, content);
  if (tooLong) {
    return tooLong;
  }
  const parts = buildNotionPageCreateRunInput(host, connection, {
    checkedAt,
    idempotencyKey: request.idempotencyKey,
    payload: { provider: "notion", parentPageId, title, content },
  });
  if ("blockedReason" in parts) {
    return blocked(connection, actionId, checkedAt, parts.message, parts.blockedReason);
  }
  return await runWrite(host, connection, actionId, checkedAt, parts, ward, "Created a Notion page.", (value) => {
    const body = isRecord(value.output) ? value.output : {};
    return { id: readString(body.id), url: readString(body.url), title };
  });
}

async function runBlockAppend(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "block_append";
  const blockId = readStringInput(request.input, "blockId");
  const content = readStringInput(request.input, "content");
  if (!blockId || !content) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Provide a Notion page or block ID and the text to append.",
      "notion_input_missing",
    );
  }
  if (!isValidNotionId(blockId)) {
    return idInvalid(connection, actionId, checkedAt);
  }
  const tooLong = checkTextLength(connection, actionId, checkedAt, content);
  if (tooLong) {
    return tooLong;
  }
  const parts = buildNotionBlockAppendRunInput(host, connection, {
    checkedAt,
    idempotencyKey: request.idempotencyKey,
    payload: { provider: "notion", blockId, content },
  });
  if ("blockedReason" in parts) {
    return blocked(connection, actionId, checkedAt, parts.message, parts.blockedReason);
  }
  return await runWrite(
    host,
    connection,
    actionId,
    checkedAt,
    parts,
    ward,
    "Appended text to the Notion block.",
    () => ({
      blockId,
    }),
  );
}

async function runWrite(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  parts: WritebackRunInputParts,
  ward: IntegrationWardContext | undefined,
  successMessage: string,
  summarize: (value: ParsedProviderResponse) => Record<string, unknown>,
): Promise<IntegrationActionInvokeResult> {
  const run = await runWardGatedExternalSideEffect(host, ward, parts.input, { externalDestination: parts.target });
  if (run.status === "blocked") {
    return blocked(connection, actionId, checkedAt, run.message, run.blockedReason, run.output);
  }
  if (run.status === "failed") {
    if (run.error instanceof ProviderAuthRejectedError) {
      // A 401/403 is proven pre-effect (the run input classifies it as not dispatched), so this is a
      // credential problem the operator can fix and retry, not an unknown external outcome.
      return blocked(connection, actionId, checkedAt, AUTH_REJECTED_MESSAGE, "notion_auth_rejected", run.output);
    }
    return {
      connectionId: connection.connectionId,
      catalogId: connection.catalogId,
      actionId,
      status: "failed",
      message: run.error.message,
      output: run.output,
      checkedAt,
    };
  }
  return executed(
    connection,
    actionId,
    checkedAt,
    successMessage,
    buildExternalSideEffectReplayOutput(run.claim, { provider: "notion", ...summarize(run.value) }),
  );
}

export function buildNotionPageCreateRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: NotionRunInputOptions<NotionPageCreatePayload>,
): WritebackRunInputParts | NotionRunInputBlocked {
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!token) {
    return { blockedReason: "notion_auth_missing", message: "Configure a Notion integration token." };
  }
  const { payload } = options;
  const target = new URL("/v1/pages", notionApiBaseUrl()).toString();
  const send = async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    const children = [
      ...(payload.content ? [paragraph(payload.content)] : []),
      paragraph(deriveNotionIdempotencyMarker(claim)),
    ];
    const response = await host.fetchWithDiagnosticsTimeout(target, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify({
        parent: { page_id: payload.parentPageId },
        properties: { title: { title: [{ text: { content: payload.title } }] } },
        children,
      }),
    });
    return await settleWrite(response, "Notion page create failed");
  };
  // No reconcile probe by design (see module comment): replay is never requested and an unknown
  // outcome stays in manual review.
  const probe = async (): Promise<ExternalSideEffectProbeResult> => ({
    found: false,
    reason: "Notion page create has no reconcile probe; unknown outcomes need manual review.",
  });
  return {
    target,
    input: {
      ...baseInput(host, connection, options, "page_create"),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      payload,
      label: "Notion page create",
      output: { provider: "notion", parentPageId: payload.parentPageId, title: payload.title },
      execute: buildDedupedExecute(host, payload, false, probe, send),
      isExternalCallProvenNotDispatched: isProviderPreDispatchRejection,
    },
  };
}

export function buildNotionBlockAppendRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: NotionRunInputOptions<NotionBlockAppendPayload>,
): WritebackRunInputParts | NotionRunInputBlocked {
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!token) {
    return { blockedReason: "notion_auth_missing", message: "Configure a Notion integration token." };
  }
  const { payload } = options;
  const childrenPath = `/v1/blocks/${encodeURIComponent(payload.blockId)}/children`;
  const target = new URL(childrenPath, notionApiBaseUrl()).toString();
  const probe = async (scope: WritebackDedupeScope): Promise<ExternalSideEffectProbeResult> => {
    const marker = deriveNotionIdempotencyMarker(scope);
    let cursor: string | undefined;
    for (let page = 0; page < NOTION_PROBE_MAX_PAGES; page += 1) {
      const url = new URL(childrenPath, notionApiBaseUrl());
      url.searchParams.set("page_size", "100");
      if (cursor) {
        url.searchParams.set("start_cursor", cursor);
      }
      const body = await readProbeJson(host, url.toString(), { method: "GET", headers: notionHeaders(token) });
      const record = isRecord(body) ? body : {};
      const next = record.has_more === true ? readString(record.next_cursor) : undefined;
      if (next) {
        cursor = next;
        continue;
      }
      // Heuristic (future reconcile-only path): the appended paragraph lands at the end, so only the
      // last children page is inspected. If other writers append after ours the marker can sit on an
      // earlier page and the probe reports not found, which fails safe (manual review, no resend).
      const match = (Array.isArray(record.results) ? record.results : [])
        .filter(isRecord)
        .find((block) => block.type === "paragraph" && extractBlockText(block).includes(marker));
      const id = match ? readString(match.id) : undefined;
      return id
        ? { found: true, externalReferenceId: `blockId:${id}`, output: { id } }
        : { found: false, reason: "No paragraph on the block carries the idempotency marker." };
    }
    throw new Error("Notion reconciliation probe exceeded its page budget.");
  };
  const send = async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    const response = await host.fetchWithDiagnosticsTimeout(target, {
      method: "PATCH",
      headers: notionHeaders(token),
      body: JSON.stringify({
        children: [paragraph(payload.content), paragraph(deriveNotionIdempotencyMarker(claim))],
      }),
    });
    return await settleWrite(response, "Notion block append failed");
  };
  return {
    target,
    input: {
      ...baseInput(host, connection, options, "block_append"),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      payload,
      label: "Notion block append",
      output: { provider: "notion", blockId: payload.blockId },
      execute: buildDedupedExecute(host, payload, false, probe, send),
      reconcileExternalOutcome: buildReconcile(
        liveDedupeScope(connection, options, OPERATOR_ACTION_BOUNDARY, "block_append"),
        probe,
      ),
      isExternalCallProvenNotDispatched: isProviderPreDispatchRejection,
    },
  };
}

/** Structural-diagnostics live check: `GET /v1/users/me` proves the token without any write. */
export async function runNotionLiveChecks(
  deps: Pick<IntegrationActionHost, "fetchWithDiagnosticsTimeout" | "resolveConnectionSecret">,
  connection: IntegrationConnection,
): Promise<ConnectorDiagnosticReport["checks"]> {
  const token = deps.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!token) {
    return [];
  }
  try {
    const response = await deps.fetchWithDiagnosticsTimeout(new URL("/v1/users/me", notionApiBaseUrl()).toString(), {
      method: "GET",
      headers: notionHeaders(token),
    });
    await readBoundedResponseText(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "Notion users/me diagnostics response",
    });
    if (response.ok) {
      return [{ key: "auth_live", status: "pass", message: "Notion accepted the integration token." }];
    }
    if (response.status === 401 || response.status === 403) {
      return [{ key: "auth_live", status: "fail", message: AUTH_REJECTED_MESSAGE }];
    }
    return [{ key: "auth_live", status: "warn", message: `Notion live check returned HTTP ${response.status}.` }];
  } catch (error) {
    return [
      {
        key: "auth_live",
        status: "warn",
        message: `Notion live check could not reach the API: ${error instanceof Error ? error.message : "unknown error"}`,
      },
    ];
  }
}

async function settleWrite(response: Response, failurePrefix: string): Promise<ParsedProviderResponse> {
  // Auth statuses are decided before the body is read so an unparseable 401 page still maps to a
  // proven-not-dispatched credential failure.
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderAuthRejectedError("Notion", response.status);
  }
  const parsed = await parseProviderResponse(response);
  if (response.status === 400 || response.status === 404) {
    // validation_error / object_not_found are definitive: Notion did not apply the write.
    throw new ProviderRequestRejectedError(
      "Notion",
      response.status,
      parsed.message ?? `${failurePrefix} (${response.status}).`,
    );
  }
  if (!response.ok) {
    throw new Error(parsed.message ?? `${failurePrefix} (${response.status}).`);
  }
  return parsed;
}

function readFailure(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  response: Response,
  parsed: ParsedProviderResponse,
  failurePrefix: string,
): IntegrationActionInvokeResult | undefined {
  if (response.ok) {
    return undefined;
  }
  if (response.status === 401 || response.status === 403) {
    return blocked(connection, actionId, checkedAt, AUTH_REJECTED_MESSAGE, "notion_auth_rejected");
  }
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "failed",
    message: parsed.message ?? `${failurePrefix} (${response.status}).`,
    output: { provider: "notion" },
    checkedAt,
  };
}

function checkTextLength(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  ...texts: string[]
): IntegrationActionInvokeResult | undefined {
  if (texts.some((text) => text.length > NOTION_RICH_TEXT_LIMIT)) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      `Notion text fields are limited to ${NOTION_RICH_TEXT_LIMIT} characters.`,
      "notion_content_too_long",
    );
  }
  return undefined;
}

function notionHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

function paragraph(content: string): Record<string, unknown> {
  return {
    object: "block",
    type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content } }] },
  };
}

function richTextToPlain(value: unknown): string {
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .map((part) => (typeof part.plain_text === "string" ? part.plain_text : ""))
        .join("")
    : "";
}

function extractBlockText(block: Record<string, unknown>): string {
  const type = readString(block.type);
  const body = type ? block[type] : undefined;
  return isRecord(body) ? richTextToPlain(body.rich_text) : "";
}

function extractTitle(item: Record<string, unknown>): string {
  if (Array.isArray(item.title)) {
    return richTextToPlain(item.title);
  }
  const properties = isRecord(item.properties) ? item.properties : {};
  for (const property of Object.values(properties)) {
    if (isRecord(property) && property.type === "title") {
      return richTextToPlain(property.title);
    }
  }
  return "";
}

function executed(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  message: string,
  output: Record<string, unknown>,
): IntegrationActionInvokeResult {
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "executed",
    message,
    output,
    checkedAt,
  };
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

const NOTION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/** Ids go into URL paths; anything with dots or separators (for example "..") is refused before a fetch. */
function isValidNotionId(id: string): boolean {
  return NOTION_ID_PATTERN.test(id);
}

function idInvalid(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
): IntegrationActionInvokeResult {
  return blocked(
    connection,
    actionId,
    checkedAt,
    "Notion page and block IDs may contain only letters, digits and dashes.",
    "notion_id_invalid",
  );
}

function readStringInput(input: Record<string, unknown> | undefined, key: string): string | undefined {
  return readString(input?.[key]);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
