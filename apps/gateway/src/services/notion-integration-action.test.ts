import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalCreateInput, ApprovalRequest, IntegrationConnection } from "@goatcitadel/contracts";
import { createInMemoryDryRunCommitStore } from "./dry-run-commit-service.js";
import type { ExternalSideEffectRunStore } from "./external-side-effect-runner-service.js";
import { invokeIntegrationConnectionAction, type IntegrationActionHost } from "./integration-action-service.js";
import { buildNotionBlockAppendRunInput, runNotionLiveChecks } from "./notion-integration-action.js";

const BASE = "http://notion.test";
const TOKEN = "secret-notion-token";

function createConnection(config: Record<string, unknown> = { token: TOKEN }): IntegrationConnection {
  return {
    connectionId: "11111111-1111-1111-1111-111111111111",
    catalogId: "productivity.notion",
    kind: "productivity",
    key: "notion",
    label: "Notion",
    enabled: true,
    status: "connected",
    config,
    workspaceId: "ws-guarded",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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
    createdAt: "2026-10-17T12:00:00.000Z",
    updatedAt: "2026-10-17T12:00:00.000Z",
  };
  return {
    createOrGet: vi.fn((input, now) => ({
      ...base,
      runId: "extfx-notion",
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
        createdAt: "2026-10-17T12:00:00.000Z",
        updatedAt: "2026-10-17T12:00:00.000Z",
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
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json",
};

describe("notion-integration-action", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function stubBase(): void {
    vi.stubEnv("GOATCITADEL_NOTION_API_BASE_URL", BASE);
  }

  it("searches with the exact request and normalizes items", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse({
          results: [
            {
              object: "page",
              id: "page-1",
              url: "https://notion.so/page-1",
              properties: { Name: { type: "title", title: [{ plain_text: "Roadmap" }] } },
            },
            { object: "database", id: "db-1", url: "https://notion.so/db-1", title: [{ plain_text: "Tasks" }] },
          ],
        }),
      ),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", {
      input: { query: "road" },
    });

    expect(result.status).toBe("executed");
    expect(fetchCalls(host)).toHaveLength(1);
    const [url, init] = fetchCalls(host)[0]!;
    expect(url).toBe(`${BASE}/v1/search`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(EXPECTED_HEADERS);
    expect(JSON.parse(init.body as string)).toEqual({ query: "road", page_size: 10 });
    expect(result.output).toEqual({
      provider: "notion",
      items: [
        { id: "page-1", object: "page", title: "Roadmap", url: "https://notion.so/page-1" },
        { id: "db-1", object: "database", title: "Tasks", url: "https://notion.so/db-1" },
      ],
    });
  });

  it("reads a page and its first blocks", async () => {
    stubBase();
    const connection = createConnection();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "page-1",
          url: "https://notion.so/page-1",
          properties: { title: { type: "title", title: [{ plain_text: "Plan" }] } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: "b-1",
              type: "paragraph",
              paragraph: { rich_text: [{ plain_text: "Hello " }, { plain_text: "world" }] },
            },
            { id: "b-2", type: "divider", divider: {} },
          ],
        }),
      );
    const host = createHost(connection, { fetchWithDiagnosticsTimeout: fetchMock });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "page_read", {
      input: { pageId: "page-1" },
    });

    expect(result.status).toBe("executed");
    expect(fetchCalls(host).map(([url, init]) => [init.method, url])).toEqual([
      ["GET", `${BASE}/v1/pages/page-1`],
      ["GET", `${BASE}/v1/blocks/page-1/children?page_size=50`],
    ]);
    expect(fetchCalls(host)[1]![1].headers).toEqual(EXPECTED_HEADERS);
    expect(result.output).toEqual({
      provider: "notion",
      id: "page-1",
      title: "Plan",
      url: "https://notion.so/page-1",
      blocks: [
        { id: "b-1", type: "paragraph", text: "Hello world" },
        { id: "b-2", type: "divider", text: "" },
      ],
    });
  });

  it("blocks notion_auth_missing without a token and never calls the provider", async () => {
    const connection = createConnection({});
    const host = createHost(connection);
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", { input: {} });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "notion_auth_missing" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("maps a search 401 to notion_auth_rejected without leaking the token", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ message: "API token is invalid." }, 401)),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", { input: {} });
    expect(result).toMatchObject({
      status: "blocked",
      blockedReason: "notion_auth_rejected",
      message: "Notion rejected the integration token. Check the token and share the page with the integration.",
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports other read failures with Notion's message", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ message: "rate limited" }, 429)),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", { input: {} });
    expect(result).toMatchObject({ status: "failed", message: "rate limited" });
  });

  it("creates a page with the exact body, a marker paragraph and the default parent", async () => {
    stubBase();
    const connection = createConnection({ token: TOKEN, defaultParentPageId: "parent-default" });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () =>
        jsonResponse({ id: "new-page", url: "https://notion.so/new-page" }),
      ),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "page_create", {
      idempotencyKey: "op-key",
      input: { title: "Status", content: "All green" },
    });

    expect(result.status).toBe("executed");
    expect(result.output).toMatchObject({ provider: "notion", id: "new-page", url: "https://notion.so/new-page" });
    const [url, init] = fetchCalls(host)[0]!;
    expect(url).toBe(`${BASE}/v1/pages`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual(EXPECTED_HEADERS);
    const body = JSON.parse(init.body as string) as {
      parent: unknown;
      properties: unknown;
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>;
    };
    expect(body.parent).toEqual({ page_id: "parent-default" });
    expect(body.properties).toEqual({ title: { title: [{ text: { content: "Status" } }] } });
    expect(body.children).toHaveLength(2);
    expect(body.children[0]!.paragraph.rich_text[0]!.text.content).toBe("All green");
    expect(body.children[1]!.paragraph.rich_text[0]!.text.content).toMatch(
      /^\[goatcitadel-idempotency:[0-9a-f]{32}\]$/,
    );
  });

  it("blocks page_create without any parent", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection);
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "page_create", {
      idempotencyKey: "op-key",
      input: { title: "Orphan" },
    });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "notion_parent_missing" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("maps a page_create 401 to notion_auth_rejected and never an unknown external outcome", async () => {
    stubBase();
    const connection = createConnection({ token: TOKEN, defaultParentPageId: "parent-default" });
    const sideEffectRunStore = createSideEffectRunStore();
    const host = createHost(connection, {
      sideEffectRunStore: sideEffectRunStore as never,
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ message: "unauthorized" }, 401)),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "page_create", {
      idempotencyKey: "op-key",
      input: { title: "Status" },
    });

    expect(result).toMatchObject({ status: "blocked", blockedReason: "notion_auth_rejected" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    const failureStatuses = [
      ...sideEffectRunStore.markFailure.mock.calls.map((call) => (call[1] as { status: string }).status),
      ...sideEffectRunStore.markFailureIfStatus.mock.calls.map((call) => (call[2] as { status: string }).status),
    ];
    expect(failureStatuses.length).toBeGreaterThan(0);
    expect(failureStatuses).not.toContain("unknown_external_outcome");
  });

  it("maps an unparseable 401 on a write to notion_auth_rejected", async () => {
    stubBase();
    const connection = createConnection({ token: TOKEN, defaultParentPageId: "parent-default" });
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => new Response("<html>unauthorized</html>", { status: 401 })),
    });
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "page_create", {
      idempotencyKey: "op-key",
      input: { title: "Status" },
    });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "notion_auth_rejected" });
  });

  it("appends text with a PATCH carrying the content and the marker", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ results: [{ id: "appended" }] })),
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "block_append", {
      idempotencyKey: "op-key",
      input: { blockId: "block-9", content: "More notes" },
    });

    expect(result.status).toBe("executed");
    expect(result.output).toMatchObject({ provider: "notion", blockId: "block-9" });
    const [url, init] = fetchCalls(host)[0]!;
    expect(url).toBe(`${BASE}/v1/blocks/block-9/children`);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toEqual(EXPECTED_HEADERS);
    const body = JSON.parse(init.body as string) as {
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>;
    };
    expect(body.children[0]!.paragraph.rich_text[0]!.text.content).toBe("More notes");
    expect(body.children[1]!.paragraph.rich_text[0]!.text.content).toMatch(
      /^\[goatcitadel-idempotency:[0-9a-f]{32}\]$/,
    );
  });

  it("does not resend block_append when the runner reports a duplicate", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(),
      mutationStore: claimedMutationStore("duplicate") as never,
    });

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "block_append", {
      idempotencyKey: "op-key",
      input: { blockId: "block-9", content: "More notes" },
    });

    expect(result).toMatchObject({ status: "blocked", blockedReason: "external_side_effect_duplicate" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("reconcile probe pages to the last children page with GET only and reports not found", async () => {
    stubBase();
    const connection = createConnection();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [], has_more: true, next_cursor: "cursor-2" }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ id: "old", type: "paragraph", paragraph: { rich_text: [{ plain_text: "unrelated" }] } }],
          has_more: false,
        }),
      );
    const host = createHost(connection, { fetchWithDiagnosticsTimeout: fetchMock });
    const parts = buildNotionBlockAppendRunInput(host, connection, {
      checkedAt: "2026-10-17T12:00:00.000Z",
      idempotencyKey: "op-key",
      payload: { provider: "notion", blockId: "block-9", content: "More notes" },
    });
    if ("blockedReason" in parts) throw new Error("unexpected block");

    await expect(parts.input.reconcileExternalOutcome!()).resolves.toEqual({
      found: false,
      reason: expect.any(String),
    });
    expect(fetchCalls(host).map(([url]) => url)).toEqual([
      `${BASE}/v1/blocks/block-9/children?page_size=100`,
      `${BASE}/v1/blocks/block-9/children?page_size=100&start_cursor=cursor-2`,
    ]);
    expect(fetchCalls(host).every(([, init]) => init.method === "GET")).toBe(true);
  });

  it("reconcile probe reports found when a paragraph carries the live scope marker", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, { fetchWithDiagnosticsTimeout: vi.fn() });
    const parts = buildNotionBlockAppendRunInput(host, connection, {
      checkedAt: "2026-10-17T12:00:00.000Z",
      idempotencyKey: "op-key",
      payload: { provider: "notion", blockId: "block-9", content: "More notes" },
    });
    if ("blockedReason" in parts) throw new Error("unexpected block");
    // Capture the marker the runner's own scope derives by running the first attempt for real.
    const sendHost = createHost(connection, {
      fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ results: [] })),
    });
    await invokeIntegrationConnectionAction(sendHost, connection.connectionId, "block_append", {
      idempotencyKey: "op-key",
      input: { blockId: "block-9", content: "More notes" },
    });
    const sent = JSON.parse(fetchCalls(sendHost)[0]![1].body as string) as {
      children: Array<{ paragraph: { rich_text: Array<{ text: { content: string } }> } }>;
    };
    const marker = sent.children[1]!.paragraph.rich_text[0]!.text.content;
    vi.mocked(host.fetchWithDiagnosticsTimeout).mockResolvedValueOnce(
      jsonResponse({
        results: [{ id: "landed", type: "paragraph", paragraph: { rich_text: [{ plain_text: marker }] } }],
        has_more: false,
      }),
    );
    // The reconcile scope's routePath/actor come from the runner's identity rule, which is the
    // same rule the send claim used, so the marker the PATCH carried is the one the probe matches.
    const probed = await parts.input.reconcileExternalOutcome!();
    expect(probed).toMatchObject({ found: true, externalReferenceId: "blockId:landed" });
    expect(fetchCalls(host).some(([, init]) => init.method === "PATCH")).toBe(false);
  });

  it("denies a ward-matched read before any provider call", async () => {
    stubBase();
    const connection = createConnection();
    const host = createHost(connection, {}, [{ actionPattern: "integration.productivity.notion.*", effect: "deny" }]);
    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "search", { input: {} });
    expect(result).toMatchObject({ status: "blocked", blockedReason: "citadel_ward_deny" });
    expect(result.output).toMatchObject({ wardAction: "integration.productivity.notion.search" });
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  it("opens a dry-run preview and approval for a require_dry_run page_create without calling Notion", async () => {
    stubBase();
    const connection = createConnection({ token: TOKEN, defaultParentPageId: "parent-default" });
    const store = createInMemoryDryRunCommitStore();
    const createApproval = vi.fn(
      async (input: ApprovalCreateInput): Promise<ApprovalRequest> => ({
        approvalId: "approval-notion-1",
        kind: input.kind,
        riskLevel: input.riskLevel,
        status: "pending",
        payload: input.payload,
        preview: input.preview,
        linkage: input.linkage,
        createdAt: "2026-10-17T00:00:00.000Z",
        expiresAt: input.expiresAt ?? undefined,
        explanationStatus: "not_requested",
      }),
    );
    const base = createHost(connection, { createApproval }, [
      { actionPattern: "integration.productivity.notion.page_create", effect: "require_dry_run" },
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
            createdAt: input.createdAt ?? "2026-10-17T00:00:00.000Z",
            expiresAt: input.expiresAt,
            resolutionStatus: "pending",
          }),
        },
        approvalEvents: { append: (input) => input },
      },
    };

    const result = await invokeIntegrationConnectionAction(host, connection.connectionId, "page_create", {
      idempotencyKey: "op-key",
      input: { title: "Status" },
    });

    expect(result).toMatchObject({ status: "blocked", blockedReason: "external_side_effect_dry_run_required" });
    expect(result.output).toMatchObject({ dryRunState: "awaiting_commit", approvalId: "approval-notion-1" });
    expect(createApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "integration.dry_run_commit",
        payload: expect.objectContaining({ actionId: "page_create", catalogId: "productivity.notion" }),
      }),
    );
    expect(host.fetchWithDiagnosticsTimeout).not.toHaveBeenCalled();
  });

  describe("runNotionLiveChecks", () => {
    it("passes on 200, fails on 401 and stays silent without a token", async () => {
      stubBase();
      const connection = createConnection();
      const make = (status: number) =>
        createHost(connection, {
          fetchWithDiagnosticsTimeout: vi.fn(async () => jsonResponse({ object: "user" }, status)),
        });

      const ok = make(200);
      await expect(runNotionLiveChecks(ok, connection)).resolves.toEqual([
        expect.objectContaining({ key: "auth_live", status: "pass" }),
      ]);
      expect(fetchCalls(ok)[0]![0]).toBe(`${BASE}/v1/users/me`);
      expect(fetchCalls(ok)[0]![1].headers).toEqual(EXPECTED_HEADERS);

      await expect(runNotionLiveChecks(make(401), connection)).resolves.toEqual([
        expect.objectContaining({ key: "auth_live", status: "fail" }),
      ]);
      await expect(runNotionLiveChecks(make(200), createConnection({}))).resolves.toEqual([]);
    });
  });
});
