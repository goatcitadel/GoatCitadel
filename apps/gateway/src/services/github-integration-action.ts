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
 * GitHub operator actions (issue and pull request reads, issue create, issue comment) over a
 * fine-grained token. Reads call GitHub directly; the two writes run through the shared idempotent
 * side-effect runner behind the Citadel Ward gate.
 *
 * Reconciliation: both writes embed an HTML-comment marker derived from the run scope in the body
 * and carry a probe that looks for it (newest 30 issues; comments updated since just before the
 * run). These probes are NOT reached at runtime today: reconcileExternalOutcome only runs from the
 * replay worker, and productivity.github is not on its allowlist, so the worker neither resends
 * nor reconciles these writes and an unknown outcome stays in manual review. The probes exist for
 * a future reconcile-only path; a replay rebuild of issue_comment must pass the run's createdAt
 * as the probe's `checkedAt` so the `since` window covers the original send.
 */

const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_MARKER_DOMAIN = "goatcitadel:github-marker:v1";
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMENT_PROBE_LOOKBACK_MS = 5 * 60 * 1000;
const PR_BODY_LIMIT = 4000;
const COMMENT_BODY_LIMIT = 1000;
const AUTH_REJECTED_MESSAGE = "GitHub rejected the token. Check the token and that it can access the repository.";
const NOT_FOUND_MESSAGE = "GitHub repository or item not found, or the token cannot see it.";

// The override must be an origin: URL resolution drops any path, so GitHub Enterprise `/api/v3`
// bases are not supported.
export const githubApiBaseUrl = () => resolveApiBaseUrl("GOATCITADEL_GITHUB_API_BASE_URL", "https://api.github.com");

export function deriveGitHubIdempotencyMarker(scope: WritebackDedupeScope): string {
  return `<!-- goatcitadel-idempotency:${digestScope(GITHUB_MARKER_DOMAIN, scope).slice(0, 32)} -->`;
}

export interface GitHubIssueCreatePayload {
  provider: "github";
  repo: string;
  title: string;
  body: string;
}

export interface GitHubIssueCommentPayload {
  provider: "github";
  repo: string;
  number: number;
  body: string;
}

interface GitHubRunInputOptions<TPayload> {
  checkedAt: string;
  payload: TPayload;
  idempotencyKey?: string;
  actorScope?: string;
}

type GitHubRunInputBlocked = { blockedReason: string; message: string };

export async function invokeGitHubAction(
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
      "Configure a GitHub token before running this action.",
      "github_auth_missing",
    );
  }
  const repo = resolveRepo(host, connection, request);
  if (!repo) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      'Provide a GitHub repository as "owner/name" or set a default repository.',
      "github_repo_invalid",
    );
  }
  switch (actionId) {
    case "issue_list":
      return await runList(host, connection, token, repo, request, checkedAt, "issue_list", "issues");
    case "pr_list":
      return await runList(host, connection, token, repo, request, checkedAt, "pr_list", "pulls");
    case "issue_read":
      return await runIssueRead(host, connection, token, repo, request, checkedAt);
    case "pr_read":
      return await runPrRead(host, connection, token, repo, request, checkedAt);
    case "issue_create":
      return await runIssueCreate(host, connection, repo, request, checkedAt, ward);
    case "issue_comment":
      return await runIssueComment(host, connection, repo, request, checkedAt, ward);
    default:
      return blocked(
        connection,
        actionId,
        checkedAt,
        `Unsupported GitHub operator action: ${actionId}.`,
        "action_unsupported",
      );
  }
}

async function runList(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  token: string,
  repo: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  actionId: string,
  collection: "issues" | "pulls",
): Promise<IntegrationActionInvokeResult> {
  const url = new URL(`/repos/${repo}/${collection}`, githubApiBaseUrl());
  url.searchParams.set("state", readState(request.input));
  url.searchParams.set("per_page", "20");
  const response = await host.fetchWithDiagnosticsTimeout(url.toString(), {
    method: "GET",
    headers: githubHeaders(token),
  });
  const parsed = await parseProviderResponse(response);
  const failure = readFailure(connection, actionId, checkedAt, response, parsed, "GitHub list failed");
  if (failure) {
    return failure;
  }
  const items = (Array.isArray(parsed.output) ? parsed.output : [])
    .filter(isRecord)
    // The issues endpoint also returns pull requests; the issue list is issues only.
    .filter((item) => collection === "pulls" || !("pull_request" in item))
    .map(summarizeItem);
  return executed(
    connection,
    actionId,
    checkedAt,
    `Found ${items.length} GitHub ${collection === "pulls" ? "pull request" : "issue"}${items.length === 1 ? "" : "s"}.`,
    { provider: "github", repo, items },
  );
}

async function runIssueRead(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  token: string,
  repo: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "issue_read";
  const number = readNumber(request.input);
  if (number === undefined) {
    return numberInvalid(connection, actionId, checkedAt);
  }
  const issueUrl = new URL(`/repos/${repo}/issues/${number}`, githubApiBaseUrl());
  const issueResponse = await host.fetchWithDiagnosticsTimeout(issueUrl.toString(), {
    method: "GET",
    headers: githubHeaders(token),
  });
  const issueParsed = await parseProviderResponse(issueResponse);
  const issueFailure = readFailure(
    connection,
    actionId,
    checkedAt,
    issueResponse,
    issueParsed,
    "GitHub issue read failed",
  );
  if (issueFailure) {
    return issueFailure;
  }
  const commentsUrl = new URL(`/repos/${repo}/issues/${number}/comments`, githubApiBaseUrl());
  commentsUrl.searchParams.set("per_page", "20");
  const commentsResponse = await host.fetchWithDiagnosticsTimeout(commentsUrl.toString(), {
    method: "GET",
    headers: githubHeaders(token),
  });
  const commentsParsed = await parseProviderResponse(commentsResponse);
  const commentsFailure = readFailure(
    connection,
    actionId,
    checkedAt,
    commentsResponse,
    commentsParsed,
    "GitHub comment read failed",
  );
  if (commentsFailure) {
    return commentsFailure;
  }
  const issue = isRecord(issueParsed.output) ? issueParsed.output : {};
  const comments = (Array.isArray(commentsParsed.output) ? commentsParsed.output : [])
    .filter(isRecord)
    .map((comment) => ({
      id: typeof comment.id === "number" ? comment.id : undefined,
      author: readLogin(comment.user),
      body: (readString(comment.body) ?? "").slice(0, COMMENT_BODY_LIMIT),
      url: readString(comment.html_url) ?? "",
    }));
  return executed(connection, actionId, checkedAt, `Read GitHub issue #${number} with ${comments.length} comment(s).`, {
    provider: "github",
    repo,
    ...summarizeItem(issue),
    body: (readString(issue.body) ?? "").slice(0, PR_BODY_LIMIT),
    comments,
  });
}

async function runPrRead(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  token: string,
  repo: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "pr_read";
  const number = readNumber(request.input);
  if (number === undefined) {
    return numberInvalid(connection, actionId, checkedAt);
  }
  const response = await host.fetchWithDiagnosticsTimeout(
    new URL(`/repos/${repo}/pulls/${number}`, githubApiBaseUrl()).toString(),
    { method: "GET", headers: githubHeaders(token) },
  );
  const parsed = await parseProviderResponse(response);
  const failure = readFailure(connection, actionId, checkedAt, response, parsed, "GitHub pull request read failed");
  if (failure) {
    return failure;
  }
  const pr = isRecord(parsed.output) ? parsed.output : {};
  return executed(connection, actionId, checkedAt, `Read GitHub pull request #${number}.`, {
    provider: "github",
    repo,
    ...summarizeItem(pr),
    draft: pr.draft === true,
    merged: pr.merged === true,
    head: readRef(pr.head),
    base: readRef(pr.base),
    body: (readString(pr.body) ?? "").slice(0, PR_BODY_LIMIT),
  });
}

async function runIssueCreate(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  repo: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "issue_create";
  const title = readStringInput(request.input, "title");
  if (!title) {
    return blocked(
      connection,
      actionId,
      checkedAt,
      "Provide a title for the new GitHub issue.",
      "github_title_missing",
    );
  }
  const parts = buildGitHubIssueCreateRunInput(host, connection, {
    checkedAt,
    idempotencyKey: request.idempotencyKey,
    payload: { provider: "github", repo, title, body: readRawText(request.input, "body") ?? "" },
  });
  if ("blockedReason" in parts) {
    return blocked(connection, actionId, checkedAt, parts.message, parts.blockedReason);
  }
  return await runWrite(host, connection, actionId, checkedAt, parts, ward, "Created a GitHub issue.", (value) => {
    const body = isRecord(value.output) ? value.output : {};
    return { repo, number: body.number, url: readString(body.html_url), title };
  });
}

async function runIssueComment(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  repo: string,
  request: IntegrationActionInvokeInput,
  checkedAt: string,
  ward?: IntegrationWardContext,
): Promise<IntegrationActionInvokeResult> {
  const actionId = "issue_comment";
  const number = readNumber(request.input);
  if (number === undefined) {
    return numberInvalid(connection, actionId, checkedAt);
  }
  const commentBody = readRawText(request.input, "body");
  if (!commentBody) {
    return blocked(connection, actionId, checkedAt, "Provide the comment text.", "github_body_missing");
  }
  const parts = buildGitHubIssueCommentRunInput(host, connection, {
    checkedAt,
    idempotencyKey: request.idempotencyKey,
    payload: { provider: "github", repo, number, body: commentBody },
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
    "Commented on the GitHub issue.",
    (value) => {
      const body = isRecord(value.output) ? value.output : {};
      return { repo, number, commentId: body.id, url: readString(body.html_url) };
    },
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
      return blocked(connection, actionId, checkedAt, AUTH_REJECTED_MESSAGE, "github_auth_rejected", run.output);
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
    buildExternalSideEffectReplayOutput(run.claim, { provider: "github", ...summarize(run.value) }),
  );
}

export function buildGitHubIssueCreateRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: GitHubRunInputOptions<GitHubIssueCreatePayload>,
): WritebackRunInputParts | GitHubRunInputBlocked {
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!token) {
    return { blockedReason: "github_auth_missing", message: "Configure a GitHub token." };
  }
  const { payload } = options;
  if (!isValidRepo(payload.repo)) {
    return { blockedReason: "github_repo_invalid", message: 'Provide a GitHub repository as "owner/name".' };
  }
  const target = new URL(`/repos/${payload.repo}/issues`, githubApiBaseUrl()).toString();
  const probe = async (scope: WritebackDedupeScope): Promise<ExternalSideEffectProbeResult> => {
    const marker = deriveGitHubIdempotencyMarker(scope);
    const url = new URL(target);
    url.searchParams.set("state", "all");
    url.searchParams.set("sort", "created");
    url.searchParams.set("direction", "desc");
    url.searchParams.set("per_page", "30");
    const items = await readProbeJson(host, url.toString(), { method: "GET", headers: githubHeaders(token) });
    const match = (Array.isArray(items) ? items : [])
      .filter(isRecord)
      .find((item) => typeof item.body === "string" && item.body.includes(marker));
    return match
      ? {
          found: true,
          externalReferenceId: `issue:${String(match.number)}`,
          output: { number: match.number, html_url: match.html_url },
        }
      : { found: false, reason: "No recent issue body carries the idempotency marker." };
  };
  const send = async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    const response = await host.fetchWithDiagnosticsTimeout(target, {
      method: "POST",
      headers: githubWriteHeaders(token),
      body: JSON.stringify({
        title: payload.title,
        body: withMarker(payload.body, deriveGitHubIdempotencyMarker(claim)),
      }),
    });
    return await settleWrite(response, "GitHub issue create failed");
  };
  return {
    target,
    input: {
      ...baseInput(host, connection, options, "issue_create"),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      payload,
      label: "GitHub issue create",
      output: { provider: "github", repo: payload.repo, title: payload.title },
      execute: buildDedupedExecute(host, payload, false, probe, send),
      reconcileExternalOutcome: buildReconcile(
        liveDedupeScope(connection, options, OPERATOR_ACTION_BOUNDARY, "issue_create"),
        probe,
      ),
      isExternalCallProvenNotDispatched: isProviderPreDispatchRejection,
    },
  };
}

export function buildGitHubIssueCommentRunInput(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  options: GitHubRunInputOptions<GitHubIssueCommentPayload>,
): WritebackRunInputParts | GitHubRunInputBlocked {
  const token = host.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  if (!token) {
    return { blockedReason: "github_auth_missing", message: "Configure a GitHub token." };
  }
  const { payload } = options;
  if (!isValidRepo(payload.repo)) {
    return { blockedReason: "github_repo_invalid", message: 'Provide a GitHub repository as "owner/name".' };
  }
  const target = new URL(`/repos/${payload.repo}/issues/${payload.number}/comments`, githubApiBaseUrl()).toString();
  const probe = async (scope: WritebackDedupeScope): Promise<ExternalSideEffectProbeResult> => {
    const marker = deriveGitHubIdempotencyMarker(scope);
    // The comments endpoint ignores sort/direction and lists oldest first, so bound the window with
    // `since` (updated_at >= creation, so the marker comment is always inside it) and take a full page.
    const url = new URL(target);
    url.searchParams.set("since", new Date(Date.parse(options.checkedAt) - COMMENT_PROBE_LOOKBACK_MS).toISOString());
    url.searchParams.set("per_page", "100");
    const items = await readProbeJson(host, url.toString(), { method: "GET", headers: githubHeaders(token) });
    const match = (Array.isArray(items) ? items : [])
      .filter(isRecord)
      .find((item) => typeof item.body === "string" && item.body.includes(marker));
    return match
      ? {
          found: true,
          externalReferenceId: `comment:${String(match.id)}`,
          output: { id: match.id, html_url: match.html_url },
        }
      : { found: false, reason: "No recent comment carries the idempotency marker." };
  };
  const send = async (claim: ExternalSideEffectExecutionContext): Promise<ParsedProviderResponse> => {
    const response = await host.fetchWithDiagnosticsTimeout(target, {
      method: "POST",
      headers: githubWriteHeaders(token),
      body: JSON.stringify({ body: withMarker(payload.body, deriveGitHubIdempotencyMarker(claim)) }),
    });
    return await settleWrite(response, "GitHub comment create failed");
  };
  return {
    target,
    input: {
      ...baseInput(host, connection, options, "issue_comment"),
      externalDestinationFingerprint: fingerprintExternalSideEffectDestination(target),
      payload,
      label: "GitHub issue comment",
      output: { provider: "github", repo: payload.repo, number: payload.number },
      execute: buildDedupedExecute(host, payload, false, probe, send),
      reconcileExternalOutcome: buildReconcile(
        liveDedupeScope(connection, options, OPERATOR_ACTION_BOUNDARY, "issue_comment"),
        probe,
      ),
      isExternalCallProvenNotDispatched: isProviderPreDispatchRejection,
    },
  };
}

/** Structural-diagnostics live check: `GET /repos/{defaultRepo}` proves the token and repo access without any write. */
export async function runGitHubLiveChecks(
  deps: Pick<
    IntegrationActionHost,
    "fetchWithDiagnosticsTimeout" | "resolveConnectionSecret" | "readConnectionConfigValue"
  >,
  connection: IntegrationConnection,
): Promise<ConnectorDiagnosticReport["checks"]> {
  const token = deps.resolveConnectionSecret(connection.config, "token", "tokenEnv", connection.catalogId);
  const repo = deps.readConnectionConfigValue(connection.config, "defaultRepo");
  if (!token || !repo || !isValidRepo(repo)) {
    return [];
  }
  try {
    const response = await deps.fetchWithDiagnosticsTimeout(new URL(`/repos/${repo}`, githubApiBaseUrl()).toString(), {
      method: "GET",
      headers: githubHeaders(token),
    });
    await readBoundedResponseText(response, {
      maxBytes: 64 * 1024,
      timeoutMs: 5_000,
      label: "GitHub repository diagnostics response",
    });
    if (response.ok) {
      return [{ key: "auth_live", status: "pass", message: "GitHub accepted the token for the default repository." }];
    }
    if (response.status === 401 || response.status === 403) {
      return [{ key: "auth_live", status: "fail", message: AUTH_REJECTED_MESSAGE }];
    }
    if (response.status === 404) {
      return [{ key: "auth_live", status: "fail", message: NOT_FOUND_MESSAGE }];
    }
    return [{ key: "auth_live", status: "warn", message: `GitHub live check returned HTTP ${response.status}.` }];
  } catch (error) {
    return [
      {
        key: "auth_live",
        status: "warn",
        message: `GitHub live check could not reach the API: ${error instanceof Error ? error.message : "unknown error"}`,
      },
    ];
  }
}

async function settleWrite(response: Response, failurePrefix: string): Promise<ParsedProviderResponse> {
  // Auth statuses are decided before the body is read: an unparseable 401 page must still be a
  // proven-not-dispatched credential failure.
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderAuthRejectedError("GitHub", 401);
  }
  if (response.status === 403) {
    const limited = rateLimitMessage(response);
    if (limited) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderRequestRejectedError("GitHub", 403, limited);
    }
    const forbidden = await parseProviderResponse(response);
    if (isTokenPermissionMessage(forbidden.message)) {
      throw new ProviderAuthRejectedError("GitHub", 403);
    }
    // Definitive refusal that is not a token problem (for example a locked issue).
    throw new ProviderRequestRejectedError("GitHub", 403, `GitHub refused the request: ${forbidden.message}`);
  }
  const parsed = await parseProviderResponse(response);
  if (response.status === 404) {
    throw new ProviderRequestRejectedError("GitHub", 404, NOT_FOUND_MESSAGE);
  }
  if (response.status === 422) {
    throw new ProviderRequestRejectedError(
      "GitHub",
      422,
      parsed.message ? `GitHub rejected the request: ${parsed.message}` : `${failurePrefix} (422).`,
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
  if (response.status === 403) {
    const limited = rateLimitMessage(response);
    if (limited) {
      return failed(connection, actionId, checkedAt, limited);
    }
  }
  if (response.status === 403 && !isTokenPermissionMessage(parsed.message)) {
    return failed(connection, actionId, checkedAt, `GitHub refused the request: ${parsed.message}`);
  }
  if (response.status === 401 || response.status === 403) {
    return blocked(connection, actionId, checkedAt, AUTH_REJECTED_MESSAGE, "github_auth_rejected");
  }
  if (response.status === 404) {
    return failed(connection, actionId, checkedAt, NOT_FOUND_MESSAGE);
  }
  return failed(connection, actionId, checkedAt, parsed.message ?? `${failurePrefix} (${response.status}).`);
}

function rateLimitMessage(response: Response): string | undefined {
  // retry-after on a 403 marks GitHub's secondary rate limit.
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0 && response.headers.get("x-ratelimit-remaining") !== "0") {
    return `GitHub rate limit reached; retry after ${new Date(Date.now() + retryAfter * 1000).toISOString()}`;
  }
  if (response.headers.get("x-ratelimit-remaining") !== "0") {
    return undefined;
  }
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : undefined;
  return resetAt ? `GitHub rate limit reached; retry after ${resetAt}` : "GitHub rate limit reached; retry later.";
}

function resolveRepo(
  host: IntegrationActionHost,
  connection: IntegrationConnection,
  request: IntegrationActionInvokeInput,
): string | undefined {
  const repo =
    readStringInput(request.input, "repo") ?? host.readConnectionConfigValue(connection.config, "defaultRepo");
  return repo && isValidRepo(repo) ? repo : undefined;
}

function isValidRepo(repo: string): boolean {
  // "." and ".." segments would be normalized out of the request path by URL resolution.
  return GITHUB_REPO_PATTERN.test(repo) && repo.split("/").every((part) => part !== "." && part !== "..");
}

function readState(input: Record<string, unknown> | undefined): string {
  const state = readStringInput(input, "state")?.toLowerCase();
  return state === "closed" || state === "all" ? state : "open";
}

function readNumber(input: Record<string, unknown> | undefined): number | undefined {
  const raw = input?.number;
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function numberInvalid(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
): IntegrationActionInvokeResult {
  return blocked(
    connection,
    actionId,
    checkedAt,
    "Provide a positive issue or pull request number.",
    "github_number_invalid",
  );
}

function withMarker(body: string, marker: string): string {
  return body ? `${body}\n\n${marker}` : marker;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent": "GoatCitadel",
  };
}

function githubWriteHeaders(token: string): Record<string, string> {
  return { ...githubHeaders(token), "Content-Type": "application/json" };
}

function summarizeItem(item: Record<string, unknown>): Record<string, unknown> {
  return {
    number: item.number,
    title: readString(item.title) ?? "",
    state: readString(item.state) ?? "",
    url: readString(item.html_url) ?? "",
    author: readLogin(item.user),
  };
}

function readLogin(user: unknown): string {
  return isRecord(user) ? (readString(user.login) ?? "") : "";
}

function readRef(value: unknown): string {
  return isRecord(value) ? (readString(value.ref) ?? "") : "";
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

function failed(
  connection: IntegrationConnection,
  actionId: string,
  checkedAt: string,
  message: string,
): IntegrationActionInvokeResult {
  return {
    connectionId: connection.connectionId,
    catalogId: connection.catalogId,
    actionId,
    status: "failed",
    message,
    output: { provider: "github" },
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

/** Raw text for issue and comment bodies: trimmed only for the emptiness check, never rewritten. */
function readRawText(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = input?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** A 403 whose GitHub message points at the token or its permissions (not, say, a locked issue). */
function isTokenPermissionMessage(message: string | undefined): boolean {
  return message === undefined || /token|credential|resource not accessible|permission|scope/i.test(message);
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
