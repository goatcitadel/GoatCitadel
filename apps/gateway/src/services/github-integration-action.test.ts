import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, IntegrationConnection } from "@goatcitadel/contracts";
import { createInMemoryDryRunCommitStore } from "./dry-run-commit-service.js";
import type { ExternalSideEffectRunStore } from "./external-side-effect-runner-service.js";
import {
  buildGitHubIssueCommentRunInput,
  buildGitHubIssueCreateRunInput,
  runGitHubLiveChecks,
} from "./github-integration-action.js";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";

const BASE = "http://github.test";
const TOKEN = "secret-github-token";

function createConnection(
  config: Record<string, unknown> = { token: TOKEN, defaultRepo: "octo/widgets" },
): IntegrationConnection {
  return {
    connectionId: "22222222-2222-2222-2222-222222222222",
    catalogId: "productivity.github",
    kind: "productivity",
    key: "github",
    label: "GitHub",
    enabled: true,
    status: "connected",
    config,
    workspaceId: "ws-guarded",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createSideEffectRunStore() {
  const base = {
    workspaceId: "default",
    boundary: "integration_operator_action",
    routePath: "external",
    actorScope: "",
    idempotencyKey: "op-key",
    payloadHash: "hash",
    replayPolicy: "idempotent_external" as const,
    attemptCount: 1,
    createdAt: "2026-10-18T12:00:00.000Z",
    updatedAt: "2026-10-18T12:00:00.000Z",
  };
  return {
    createOrGet: vi.fn((input, now) => ({
      ...base,
      runId: "extfx-github",
      status: input.status ?? "claimed_not_sent",
      catalogId: input.catalogId,
      connectionId: input.connectionId,
      actionId: input.actionId,
      payloadHash: input.payloadHash,
      requestPayload: input.requestPayload,
      resumeState: "not_resumable" as const,
      createdAt: now ?? base.createdAt,
    })),
    markExternalCallStarted: vi.fn((runId, _input, now) => ({
      ...base,
      runId,
      status: "external_call_started" as const,
      resumeState: "in_progress" as const,
      externalCallStartedAt: now,
    })),
    markCompleted: vi.fn(),
    markFailure: vi.fn((runId, input, now) => ({
      ...base,
      runId,
      status: input.status,
      resumeState: "manual_retry_after_recorded_failure" as const,
      completedAt: now,
    })),
    markFailureIfStatus: vi.fn((runId, _expected, input, now) => ({
      ...base,
      runId,
      status: input.status,
      resumeState:
        input.status === "unknown_external_outcome"
          ? ("manual_review_unknown_external_outcome" as const)
          : ("manual_retry_after_recorded_failure" as const),
      completedAt: now,
    })),
  } satisfies Partial<ExternalSideEffectRunStore> & Record<string, unknown>;
}

function claimedMutationStore(outcome: "claimed" | "duplicate" = "claimed") {
  let sequence = 0;
  return {
    claim: vi.fn((input) => ({
      outcome,
      record: {
        method: input.method,
        routePath: input.routePath,
        idempotencyKey: input.idempotencyKey,
        actorScope: input.actorScope ?? "",
        payloadHash: input.payloadHash,
        status: outcome === "duplicate" ? ("completed" as const) : ("pending" as const),
        claimToken: `claim-${++sequence}`,
        createdAt: "2026-10-18T12:00:00.000Z",
        updatedAt: "2026-10-18T12:00:00.000Z",
      },
    })),
    markCompleted: vi.fn(() => true),
    markFailed: vi.fn(() => true),
  };
}

function createHost(
  connection: IntegrationConnection,
  overrides: Partial<IntegrationActionHost> = {},
  wards: Array<{ actionPattern: string; effect: string }> = [],
): IntegrationActionHost {
  return {
    storage: {
      integrationConnections: { get: vi.fn(() => connection) },
      runImmediateTransaction: vi.fn(<T>(work: () => T): T => work()),
      workspaces: { find: (id: string) => (id === "ws-guarded" ? { citadelId: "citadel-guarded" } : undefined) },
      citadels: { listWards: (id: string) => (id === "citadel-guarded" ? (wards as never) : []) },
    },
    fetchWithDiagnosticsTimeout: vi.fn(),
    readConnectionConfigValue: vi.fn((config: Record<string, unknown>, key: string) => {
      const value = config[key];
      return typeof value === "string" ? value : undefined;
    }),
    resolveConnectionSecret: vi.fn((config: Record<string, unknown>, directKey: string, envKey: string) => {
      const direct = config[directKey];
      if (typeof direct === "string" && direct.length > 0) return direct;
      const envValue = config[envKey];
      return typeof envValue === "string" && envValue.length > 0 ? envValue : undefined;
    }),
    publishRealtime: vi.fn(),
    mutationStore: claimedMutationStore() as never,
    sideEffectRunStore: createSideEffectRunStore() as never,
    ...overrides,
  };
}

function fetchCalls(host: IntegrationActionHost): Array<[string, RequestInit]> {
  return vi.mocked(host.fetchWithDiagnosticsTimeout).mock.calls as Array<[string, RequestInit]>;
}

const EXPECTED_HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "GoatCitadel",
};

const MARKER_PATTERN = /<!-- goatcitadel-idempotency:[0-9a-f]{32} -->$/;

describe("github-integration-action", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubBase(): void {
    vi.stubEnv("GOATCITADEL_GITHUB_API_BASE_URL", BASE);
  }

  it("lists issues, drops pull requests and requests the exact URL", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse([
          {
            number: 1,
            title: "Bug",
            state: "open",
            html_url: "https://github.com/octo/widgets/issues/1",
            user: { login: "ada" },
          },
          {
            number: 2,
            title: "A PR",
            state: "open",
            html_url: "x",
            user: { login: "bob" },
            pull_request: { url: "y" },
          },
        ]),
      ),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", {
      input: {},
    });

    expect(result.status).toBe("executed");
    const [url, init] = fetchCalls(host)[0]!;
    expect(url).toBe(`${BASE}/repos/octo/widgets/issues?state=open&per_page=20`);
    expect(init.method).toBe("GET");
    expect(init.headers).toEqual(EXPECTED_HEADERS);
    expect(result.output).toEqual({
      provider: "github",
      repo: "octo/widgets",
      items: [
        { number: 1, title: "Bug", state: "open", url: "https://github.com/octo/widgets/issues/1", author: "ada" },
      ],
    });
  });

  it("reads an issue with its comments", async () => {
    stubBase();
    const connection = createConnection();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          number: 7,
          title: "Crash",
          state: "open",
          html_url: "u7",
          user: { login: "ada" },
          body: "Steps",
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 11, body: "Me too", user: { login: "bob" }, html_url: "c11" }]));
    const host = createHost(connection, { fetchWithDiagnosticsTimeout: fetchMock });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_read", {
      input: { number: 7, repo: "other/repo" },
    });

    expect(result.status).toBe("executed");
    expect(fetchCalls(host).map(([url]) => url)).toEqual([
      `${BASE}/repos/other/repo/issues/7`,
      `${BASE}/repos/other/repo/issues/7/comments?per_page=20`,
    ]);
    expect(result.output).toMatchObject({
      number: 7,
      title: "Crash",
      author: "ada",
      body: "Steps",
      comments: [{ id: 11, author: "bob", body: "Me too", url: "c11" }],
    });
  });

  it("lists and reads pull requests, capping the body at 4000 characters", async () => {
    stubBase();
    const connection = createConnection();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ number: 3, title: "Fix", state: "open", html_url: "p3", user: { login: "ada" } }]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          number: 3,
          title: "Fix",
          state: "closed",
          draft: false,
          merged: true,
          head: { ref: "fix-branch" },
          base: { ref: "main" },
          html_url: "p3",
          body: "x".repeat(5000),
        }),
      );
    const host = createHost(connection, { fetchWithDiagnosticsTimeout: fetchMock });

    const list = await invokeIntegrationConnectionAction(host, connection.connectionId, "pr_list", {
      input: { state: "all" },
    });
    expect(list.output).toMatchObject({ items: [{ number: 3, author: "ada" }] });
    const read = await invokeIntegrationConnectionAction(host, connection.connectionId, "pr_read", {
      input: { number: 3 },
    });
    expect(fetchCalls(host).map(([url]) => url)).toEqual([
      `${BASE}/repos/octo/widgets/pulls?state=all&per_page=20`,
      `${BASE}/repos/octo/widgets/pulls/3`,
    ]);
    expect(read.output).toMatchObject({ number: 3, merged: true, head: "fix-branch", base: "main", draft: false });
    expect((read.output as { body: string }).body).toHaveLength(4000);
  });

  it("blocks github_auth_missing without a token and never calls GitHub", async () => {
    const connection = createConnection({ defaultRepo: "octo/widgets" });
    const host = createHost(connection);
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", { input: {} });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "github_auth_missing" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it.each(["nope", "a/b/c", "owner/na me", "../etc/passwd"])(
    "blocks an invalid repo %s before any request",
    async (repo) => {
      const connection = createConnection();
      const host = createHost(connection);
      const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", {
        input: { repo },
      });
      expect(result).toMatchObject({ status: "blocked", blockedReason: "github_repo_invalid" });
      expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
    },
  );

  it("blocks a missing or non-positive issue number", async () => {
    const connection = createConnection();
    const host = createHost(connection);
    for (const number of [undefined, 0, -3, 1.5, "abc"]) {
      const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_read", {
        input: { number },
      });
      expect(result).toMatchObject({ status: "blocked", blockedReason: "github_number_invalid" });
    }
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("maps 401 to github_auth_rejected without leaking the token", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401)),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", { input: {} });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "github_auth_rejected" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("maps a rate-limited 403 to a failed result carrying the reset time", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1792000000",
        }),
      ),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", { input: {} });
    expect(result.status).toBe("failed");
    expect(result.message).toBe(`GitHub rate limit reached; retry after ${new Date(1792000000 * 1000).toISOString()}`);
  });

  it("maps any other 403 to github_auth_rejected", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse({ message: "Resource not accessible by personal access token" }, 403, {
          "x-ratelimit-remaining": "42",
        }),
      ),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", { input: {} });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "github_auth_rejected" });
  });

  it("maps 404 to a failed not-found message", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ message: "Not Found" }, 404)),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", { input: {} });
    expect(result).toMatchObject({
      status: "failed",
      message: "GitHub repository or item not found, or the token cannot see it.",
    });
  });

  it("denies a ward-matched read before any provider call", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {}, [{ actionPattern: "integration.productivity.github.*", effect: "deny" }]);
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_list", { input: {} });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "citadel_ward_deny" });
    expect(result.output).toMatchObject({ wardAction: "integration.productivity.github.issue_list" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("creates an issue with the exact body and a trailing marker comment", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse({ number: 12, html_url: "https://github.com/octo/widgets/issues/12" }, 201),
      ),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "New bug", body: "Details" },
    });

    expect(result.status).toBe("executed");
    expect(result.output).toMatchObject({
      provider: "github",
      number: 12,
      url: "https://github.com/octo/widgets/issues/12",
    });
    const [url, init] = fetchCalls(host)[0]!;
    expect(url).toBe(`${BASE}/repos/octo/widgets/issues`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ ...EXPECTED_HEADERS, "Content-Type": "application/json" });
    const body = JSON.parse(init.body as string) as { title: string; body: string };
    expect(body.title).toBe("New bug");
    expect(body.body.startsWith("Details\n\n")).toBe(true);
    expect(body.body).toMatch(MARKER_PATTERN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("comments on an issue with the marker appended", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ id: 99, html_url: "c99" }, 201)),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_comment", {
      idempotencyKey: "op-key",
      input: { number: 5, body: "Thanks" },
    });
    expect(result.status).toBe("executed");
    const [url, init] = fetchCalls(host)[0]!;
    expect(url).toBe(`${BASE}/repos/octo/widgets/issues/5/comments`);
    expect(init.method).toBe("POST");
    expect((JSON.parse(init.body as string) as { body: string }).body).toMatch(
      /^Thanks\n\n<!-- goatcitadel-idempotency:/,
    );
  });

  it("does not resend an issue_comment when the runner reports a duplicate", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(),
      mutationStore: claimedMutationStore("duplicate") as never,
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_comment", {
      idempotencyKey: "op-key",
      input: { number: 5, body: "Thanks" },
    });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "external_side_effect_duplicate" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("requires a title for issue_create and a body for issue_comment", async () => {
    const connection = createConnection();
    const host = createHost(connection);
    const noTitle = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { body: "x" },
    });
    expect(noTitle).toMatchObject({ status: "blocked", blockedReason: "github_title_missing" });
    const noBody = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_comment", {
      idempotencyKey: "op-key",
      input: { number: 1 },
    });
    expect(noBody).toMatchObject({ status: "blocked", blockedReason: "github_body_missing" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("blocks an invalid repo on a write before the runner claims anything", async () => {
    const connection = createConnection();
    const host = createHost(connection);
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "t", repo: "bad repo" },
    });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "github_repo_invalid" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it.each([
    ["a JSON 401", () => jsonResponse({ message: "Bad credentials" }, 401)],
    ["an unparseable 401", () => new Response("<html>nope</html>", { status: 401 })],
    [
      "a token-permission 403",
      () => jsonResponse({ message: "Resource not accessible by personal access token" }, 403),
    ],
  ])("maps %s on a write to github_auth_rejected, never an unknown external outcome", async (_label, make) => {
    stubBase();
    const connection = createConnection();
    const sideEffectRunStore = createSideEffectRunStore();
    const host = createHost(connection, {
      sideEffectRunStore: sideEffectRunStore as never,
      fetchWithDiagnosticsTimeout: vi.fn(async () => make()),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "t" },
    });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "github_auth_rejected" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const failureStatuses = [
      ...sideEffectRunStore.markFailure.mock.calls.map((call) => (call[1] as { status: string }).status),
      ...sideEffectRunStore.markFailureIfStatus.mock.calls.map((call) => (call[2] as { status: string }).status),
    ];
    expect(failureStatuses.length).toBeGreaterThan(0);
    expect(failureStatuses).not.toContain("unknown_external_outcome");
  });

  it.each([
    [
      "a rate-limited 403",
      () => jsonResponse({ message: "rate" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1792000000" }),
      "GitHub rate limit reached; retry after",
    ],
    ["a 404", () => jsonResponse({ message: "Not Found" }, 404), "GitHub repository or item not found"],
    ["a 422", () => jsonResponse({ message: "Validation Failed" }, 422), "Validation Failed"],
  ])("records %s on a write as failed before the boundary, not an unknown outcome", async (_label, make, text) => {
    stubBase();
    const connection = createConnection();
    const sideEffectRunStore = createSideEffectRunStore();
    const host = createHost(connection, {
      sideEffectRunStore: sideEffectRunStore as never,
      fetchWithDiagnosticsTimeout: vi.fn(async () => make()),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "t" },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain(text);
    const failureStatuses = [
      ...sideEffectRunStore.markFailure.mock.calls.map((call) => (call[1] as { status: string }).status),
      ...sideEffectRunStore.markFailureIfStatus.mock.calls.map((call) => (call[2] as { status: string }).status),
    ];
    expect(failureStatuses.length).toBeGreaterThan(0);
    expect(failureStatuses).not.toContain("unknown_external_outcome");
  });

  it("issue_comment reconcile probe bounds the window with since and finds the marker among more than 30 comments", async () => {
    stubBase();
    const connection = createConnection();
    const sendHost = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ id: 99, html_url: "c99" }, 201)),
    });
    await invokeIntegrationConnectionAction(sendHost, connection.connectionId, "issue_comment", {
      idempotencyKey: "op-key",
      input: { number: 5, body: "Thanks" },
    });
    const sentBody = (JSON.parse(fetchCalls(sendHost)[0]![1].body as string) as { body: string }).body;
    const filler = Array.from({ length: 40 }, (_, i) => ({ id: i, body: `c${i}`, html_url: `u${i}` }));
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse([...filler, { id: 99, body: sentBody, html_url: "c99" }]),
      ),
    });
    const parts = buildGitHubIssueCommentRunInput(host, connection, {
      checkedAt: "2026-10-18T12:00:00.000Z",
      idempotencyKey: "op-key",
      payload: { provider: "github", repo: "octo/widgets", number: 5, body: "Thanks" },
    });
    if ("blockedReason" in parts) throw new Error("unexpected block");
    const probed = await parts.input.reconcileExternalOutcome!();
    expect(probed).toMatchObject({ found: true, externalReferenceId: "comment:99" });
    expect(fetchCalls(host).map(([url, init]) => [init.method, url])).toEqual([
      ["GET", `${BASE}/repos/octo/widgets/issues/5/comments?since=2026-10-18T11%3A55%3A00.000Z&per_page=100`],
    ]);
  });

  it.each([
    ["HTTP 500", () => jsonResponse({ message: "boom" }, 500)],
    ["HTTP 429", () => jsonResponse({ message: "slow down" }, 429)],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("records %s on issue_create as unknown_external_outcome, never auth_rejected", async (_label, make) => {
    stubBase();
    const connection = createConnection();
    const sideEffectRunStore = createSideEffectRunStore();
    const host = createHost(connection, {
      sideEffectRunStore: sideEffectRunStore as never,
      fetchWithDiagnosticsTimeout: vi.fn(async () => make()),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "t" },
    });
    expect(result.blockedReason).not.toBe("github_auth_rejected");
    expect(result.status).not.toBe("executed");
    const failureStatuses = [
      ...sideEffectRunStore.markFailure.mock.calls.map((call) => (call[1] as { status: string }).status),
      ...sideEffectRunStore.markFailureIfStatus.mock.calls.map((call) => (call[2] as { status: string }).status),
    ];
    expect(failureStatuses).toContain("unknown_external_outcome");
    expect(failureStatuses).not.toContain("failed_before_boundary");
  });

  it("treats a 403 with retry-after as a secondary rate limit", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse({ message: "secondary" }, 403, { "retry-after": "60" }),
      ),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "t" },
    });
    expect(result.status).toBe("failed");
    expect(result.message).toContain("GitHub rate limit reached; retry after");
  });

  it("reports a non-token 403 on a write with GitHub's message instead of blaming the token", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ message: "Issue is locked" }, 403)),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_comment", {
      idempotencyKey: "op-key",
      input: { number: 4, body: "hi" },
    });
    expect(result.status).toBe("failed");
    expect(result.blockedReason).toBeUndefined();
    expect(result.message).toBe("GitHub refused the request: Issue is locked");
  });

  it("keeps the issue and comment bodies untrimmed", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ number: 1, html_url: "u" }, 201)),
    });
    await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "t", body: "  indented\n" },
    });
    const body = (JSON.parse(fetchCalls(host)[0]![1].body as string) as { body: string }).body;
    expect(body.startsWith("  indented\n\n\n")).toBe(true);
  });

  it("opens a dry-run preview and approval for a require_dry_run issue_create without calling GitHub", async () => {
    stubBase();
    const connection = createConnection();
    const store = createInMemoryDryRunCommitStore();
    const createApproval = vi.fn(
      async (input: ApprovalCreateInput): Promise<ApprovalRequest> => ({
        approvalId: "approval-github-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        linkage: input.linkage,
        createdAt: "2026-10-18T00:00:00.000Z",
        expiresAt: input.expiresAt ?? undefined,
        explanationStatus: "not_requested",
      }),
    );
    const base = createHost(connection, { createApproval }, [
      { actionPattern: "integration.productivity.github.issue_create", effect: "require_dry_run" },
    ]);
    const host: IntegrationActionHost = {
      ...base,
      storage: {
        ...base.storage,
        dryRunCommits: store,
        pendingApprovalActions: {
          upsertPending: (input) => ({
            approvalId: input.approvalId,
            actionType: input.actionType,
            request: input.request,
            createdAt: input.createdAt ?? "2026-10-18T00:00:00.000Z",
            expiresAt: input.expiresAt,
            resolutionStatus: "pending",
          }),
        },
        approvalEvents: { append: (input) => input },
      },
    };

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "Needs review" },
    });

    expect(result).toMatchObject({ status: "blocked", blockedReason: "external_side_effect_dry_run_required" });
    expect(result.output).toMatchObject({ dryRunState: "awaiting_commit", approvalId: "approval-github-1" });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "integration.dry_run_commit",
        payload: expect.objectContaining({ actionId: "issue_create", catalogId: "productivity.github" }),
      }),
    );
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("issue_create reconcile probe finds the marker with GET only, so there is no second POST", async () => {
    stubBase();
    const connection = createConnection();
    const sendHost = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ number: 12, html_url: "u12" }, 201)),
    });
    await invokeIntegrationConnectionAction(sendHost, connection.connectionId, "issue_create", {
      idempotencyKey: "op-key",
      input: { title: "New bug", body: "Details" },
    });
    const sentBody = (JSON.parse(fetchCalls(sendHost)[0]![1].body as string) as { body: string }).body;

    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse([
          { number: 13, body: "unrelated", html_url: "u13" },
          { number: 12, body: sentBody, html_url: "u12" },
        ]),
      ),
    });
    const parts = buildGitHubIssueCreateRunInput(host, connection, {
      checkedAt: "2026-10-18T12:00:00.000Z",
      idempotencyKey: "op-key",
      payload: { provider: "github", repo: "octo/widgets", title: "New bug", body: "Details" },
    });
    if ("blockedReason" in parts) throw new Error("unexpected block");

    const probed = await parts.input.reconcileExternalOutcome!();
    expect(probed).toMatchObject({ found: true, externalReferenceId: "issue:12" });
    expect(fetchCalls(host).map(([url, init]) => [init.method, url])).toEqual([
      ["GET", `${BASE}/repos/octo/widgets/issues?state=all&sort=created&direction=desc&per_page=30`],
    ]);
  });

  it("issue_create reconcile probe reports not found when no body carries the marker", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse([{ number: 1, body: "nothing" }])),
    });
    const parts = buildGitHubIssueCreateRunInput(host, connection, {
      checkedAt: "2026-10-18T12:00:00.000Z",
      idempotencyKey: "op-key",
      payload: { provider: "github", repo: "octo/widgets", title: "t", body: "" },
    });
    if ("blockedReason" in parts) throw new Error("unexpected block");
    await expect(parts.input.reconcileExternalOutcome!()).resolves.toEqual({
      found: false,
      reason: expect.any(String),
    });
  });

  describe("runGitHubLiveChecks", () => {
    it("passes on 200, fails on 401 and stays silent without a token or valid repo", async () => {
      stubBase();
      const connection = createConnection();
      const make = (status: number) =>
        createHost(connection, {
          fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ full_name: "octo/widgets" }, status)),
        });
      const ok = make(200);
      await expect(runGitHubLiveChecks(ok, connection)).resolves.toEqual([
        expect.objectContaining({ key: "auth_live", status: "pass" }),
      ]);
      expect(fetchCalls(ok)[0]![0]).toBe(`${BASE}/repos/octo/widgets`);
      expect(fetchCalls(ok)[0]![1].headers).toEqual(EXPECTED_HEADERS);
      await expect(runGitHubLiveChecks(make(401), connection)).resolves.toEqual([
        expect.objectContaining({ key: "auth_live", status: "fail" }),
      ]);
      await expect(runGitHubLiveChecks(make(200), createConnection({ defaultRepo: "octo/widgets" }))).resolves.toEqual(
        [],
      );
      await expect(runGitHubLiveChecks(make(200), createConnection({ token: TOKEN }))).resolves.toEqual([]);
    });
  });
});
