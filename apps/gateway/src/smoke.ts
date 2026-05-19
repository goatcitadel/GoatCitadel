import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { buildApp } from "./app.js";

interface JsonResponse<T = unknown> {
  statusCode: number;
  body: T;
}

let smokeRunId = randomUUID();
const DEFAULT_SMOKE_STEP_TIMEOUT_MS = 30_000;

function smokeIdempotencyKey(base: string): string {
  return `${base}-${smokeRunId}`;
}

function writeSmokeInfo(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeSmokeError(message: string): void {
  process.stderr.write(`${message}\n`);
}

function formatSmokeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

export async function runSmoke(): Promise<void> {
  smokeRunId = randomUUID();
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-smoke-"));
  const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
  const priorAuthMode = process.env.GOATCITADEL_AUTH_MODE;
  const priorDatabaseDriver = process.env.GOATCITADEL_DATABASE_DRIVER;
  const priorDisableSecretStore = process.env.GOATCITADEL_DISABLE_SECRET_STORE;
  const priorInsecureLocalOverride = process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY;

  try {
    await cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "transcripts"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "audit"), { recursive: true });
    await mkdir(path.join(tempRoot, "workspace"), { recursive: true });
    process.env.GOATCITADEL_ROOT_DIR = tempRoot;
    process.env.GOATCITADEL_AUTH_MODE = "none";
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    process.env.GOATCITADEL_DISABLE_SECRET_STORE = "true";
    process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY = "true";

    const app = await buildApp();
    try {
      await runSmokeStep("health", () => smokeHealth(app));
      await runSmokeStep("gateway-events", () => smokeGatewayEvents(app));
      await runSmokeStep("sessions", () => smokeSessions(app));
      await runSmokeStep("chat", () => smokeChat(app));
      await runSmokeStep("prompt-packs", () => smokePromptPacks(app));
      await runSmokeStep("tools", () => smokeTools(app));
      await runSmokeStep("native-tools-expansion", () => smokeNativeToolsExpansion(app));
      await runSmokeStep("approvals", () => smokeApprovals(app));
      await runSmokeStep("agents", () => smokeAgents(app));
      await runSmokeStep("integrations", () => smokeIntegrations(app));
      await runSmokeStep("secrets", () => smokeSecrets(app));
      await runSmokeStep("mesh", () => smokeMesh(app));
      await runSmokeStep("npu", () => smokeNpu(app));
      await runSmokeStep("onboarding", () => smokeOnboarding(app));
      writeSmokeInfo("Smoke tests passed.");
    } finally {
      await app.close();
    }
  } finally {
    if (priorRoot === undefined) {
      delete process.env.GOATCITADEL_ROOT_DIR;
    } else {
      process.env.GOATCITADEL_ROOT_DIR = priorRoot;
    }
    if (priorAuthMode === undefined) {
      delete process.env.GOATCITADEL_AUTH_MODE;
    } else {
      process.env.GOATCITADEL_AUTH_MODE = priorAuthMode;
    }
    if (priorDatabaseDriver === undefined) {
      delete process.env.GOATCITADEL_DATABASE_DRIVER;
    } else {
      process.env.GOATCITADEL_DATABASE_DRIVER = priorDatabaseDriver;
    }
    if (priorDisableSecretStore === undefined) {
      delete process.env.GOATCITADEL_DISABLE_SECRET_STORE;
    } else {
      process.env.GOATCITADEL_DISABLE_SECRET_STORE = priorDisableSecretStore;
    }
    if (priorInsecureLocalOverride === undefined) {
      delete process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY;
    } else {
      process.env.GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY = priorInsecureLocalOverride;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

async function runSmokeStep(name: string, fn: () => Promise<void>): Promise<void> {
  writeSmokeInfo(`[smoke] ${name}...`);
  await withSmokeStepTimeout(name, fn());
  writeSmokeInfo(`[smoke] ${name} ok`);
}

async function withSmokeStepTimeout<T>(name: string, promise: Promise<T>): Promise<T> {
  const timeoutMs = Number.parseInt(
    process.env.GOATCITADEL_SMOKE_STEP_TIMEOUT_MS ?? String(DEFAULT_SMOKE_STEP_TIMEOUT_MS),
    10,
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Smoke step ${name} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function smokeChat(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const projectsBefore = await app.inject({
    method: "GET",
    url: "/api/v1/chat/projects?view=all&limit=20",
  });
  assert.equal(projectsBefore.statusCode, 200);

  const createdProject = await postJson<{ projectId: string; name: string }>(
    app,
    "/api/v1/chat/projects",
    {
      name: "Smoke Project",
      workspacePath: "chat/smoke",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-chat-project-create-1"),
    },
  );
  assert.equal(createdProject.statusCode, 201);
  const projectId = createdProject.body.projectId;

  const createdSession = await postJson<{ sessionId: string; projectId?: string }>(
    app,
    "/api/v1/chat/sessions",
    {
      title: "Smoke Chat Session",
      projectId,
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-chat-session-create-1"),
    },
  );
  assert.equal(createdSession.statusCode, 201);
  const sessionId = createdSession.body.sessionId;
  assert.ok(sessionId, "chat session id should be returned");

  const sessionsRes = await app.inject({
    method: "GET",
    url: `/api/v1/chat/sessions?scope=all&view=all&projectId=${encodeURIComponent(projectId)}&limit=20`,
  });
  assert.equal(sessionsRes.statusCode, 200);
  const sessionsBody = JSON.parse(sessionsRes.body) as { items: Array<{ sessionId: string }> };
  assert.equal(
    sessionsBody.items.some((item) => item.sessionId === sessionId),
    true,
  );

  const messagesRes = await app.inject({
    method: "GET",
    url: `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages?limit=20`,
  });
  assert.equal(messagesRes.statusCode, 200);
  const messagesBody = JSON.parse(messagesRes.body) as { items: unknown[] };
  assert.equal(Array.isArray(messagesBody.items), true);

  const uploaded = await postJson<{ attachmentId: string; fileName: string }>(
    app,
    "/api/v1/chat/attachments",
    {
      sessionId,
      projectId,
      fileName: "smoke-note.txt",
      mimeType: "text/plain",
      bytesBase64: Buffer.from("hello from smoke").toString("base64"),
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-chat-attachment-create-1"),
    },
  );
  assert.equal(uploaded.statusCode, 201);
  const attachmentId = uploaded.body.attachmentId;
  assert.equal(typeof attachmentId, "string");

  const attachmentMeta = await app.inject({
    method: "GET",
    url: `/api/v1/chat/attachments/${encodeURIComponent(attachmentId)}`,
  });
  assert.equal(attachmentMeta.statusCode, 200);
}

async function smokePromptPacks(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const imported = await postJson<{
    pack: { packId: string };
    tests: Array<{ testId: string }>;
  }>(
    app,
    "/api/v1/prompt-packs/import",
    {
      name: "Smoke Prompt Pack",
      sourceLabel: "smoke",
      content: [
        "[TEST-01] Basic greeting",
        "Say hello and list one action.",
        "",
        "[TEST-02] Tool honesty",
        "If you cannot verify something, say you cannot verify.",
      ].join("\n"),
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-prompt-pack-import-1"),
    },
  );
  assert.equal(imported.statusCode, 200);
  const packId = imported.body.pack.packId;
  const testId = imported.body.tests[0]?.testId;
  assert.ok(packId, "prompt pack id should exist");
  assert.ok(testId, "prompt pack test id should exist");

  const listed = await app.inject({
    method: "GET",
    url: "/api/v1/prompt-packs?limit=20",
  });
  assert.equal(listed.statusCode, 200);
  const listedBody = JSON.parse(listed.body) as { items: Array<{ packId: string }> };
  assert.equal(
    listedBody.items.some((item) => item.packId === packId),
    true,
  );

  const run = await postJson<{
    runId: string;
    status: string;
    integrity?: {
      validationStatus?: string;
      signals?: string[];
    };
    trace?: {
      failure?: {
        message?: string;
      };
    };
  }>(
    app,
    `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId!)}/run`,
    {},
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-prompt-pack-run-1"),
    },
  );
  assert.equal(run.statusCode, 200);
  assert.equal(typeof run.body.runId, "string");
  assert.equal(["running", "completed", "failed", "queued"].includes(run.body.status), true);

  if (!isUnscorablePromptPackRun(run.body)) {
    const score = await postJson<{
      reviewId: string;
      scores: {
        taskSuccess?: number;
        honesty?: number;
        executionQuality?: number;
        robustness?: number;
        usability?: number;
      };
    }>(
      app,
      `/api/v1/prompt-packs/${encodeURIComponent(packId)}/tests/${encodeURIComponent(testId!)}/score`,
      {
        runId: run.body.runId,
        routingScore: 1,
        honestyScore: 1,
        handoffScore: 1,
        robustnessScore: 1,
        usabilityScore: 1,
        notes: "smoke",
      },
      {
        "Idempotency-Key": smokeIdempotencyKey("smoke-prompt-pack-score-1"),
      },
    );
    assert.equal(score.statusCode, 200);
    assert.equal(typeof score.body.reviewId, "string");
    assert.equal(score.body.scores.honesty, 2);
    assert.equal(score.body.scores.executionQuality, 2);
    assert.equal(score.body.scores.robustness, 2);
    assert.equal(score.body.scores.usability, 2);
  }

  const report = await app.inject({
    method: "GET",
    url: `/api/v1/prompt-packs/${encodeURIComponent(packId)}/report`,
  });
  assert.equal(report.statusCode, 200);
  const reportBody = JSON.parse(report.body) as { summary: { totalTests: number } };
  assert.equal(reportBody.summary.totalTests >= 2, true);
}

function isUnscorablePromptPackRun(run: {
  status: string;
  integrity?: { validationStatus?: string; signals?: string[] };
  trace?: { failure?: { message?: string } };
}): boolean {
  const failureMessage = run.trace?.failure?.message ?? "";
  return (
    (run.status === "failed" || run.status === "completed") &&
    (run.integrity?.validationStatus === "invalid" || run.status === "failed") &&
    ((run.integrity?.signals ?? []).includes("completion_interrupted") || run.status === "failed") &&
    /No active LLM provider is configured|OAuth is not connected|API key is not configured|provider is not configured/i.test(
      failureMessage,
    )
  );
}

async function smokeHealth(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200, "health should return 200");
  const body = JSON.parse(res.body) as { status: string };
  assert.equal(body.status, "ok");
}

async function smokeGatewayEvents(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const payload = {
    eventId: `evt-${randomUUID()}`,
    route: {
      channel: "webchat",
      account: "operator",
      peer: "assistant",
    },
    actor: {
      type: "user",
      id: "operator",
    },
    message: {
      role: "user",
      content: "smoke test message",
    },
    usage: {
      inputTokens: 5,
      outputTokens: 2,
      costUsd: 0.0003,
    },
  };
  const headers = {
    "Idempotency-Key": smokeIdempotencyKey("smoke-gateway-event-1"),
  };

  const first = await postJson(app, "/api/v1/gateway/events", payload, headers);
  assert.equal(first.statusCode, 200);
  assert.equal((first.body as { deduped: boolean }).deduped, false);

  const second = await postJson(app, "/api/v1/gateway/events", payload, headers);
  assert.equal(second.statusCode, 200);
  assert.equal((second.body as { deduped: boolean }).deduped, true);
}

async function smokeSessions(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const res = await app.inject({ method: "GET", url: "/api/v1/sessions?limit=5" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { items: Array<{ sessionId: string; tokenTotal: number }> };
  assert.equal(body.items.length >= 1, true);
  assert.equal(typeof body.items[0]?.sessionId, "string");
  assert.equal(typeof body.items[0]?.tokenTotal, "number");

  const firstSessionId = body.items[0]?.sessionId;
  assert.ok(firstSessionId, "session id should exist");

  const summaryRes = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${firstSessionId}/summary`,
  });
  assert.equal(summaryRes.statusCode, 200);
  const summaryBody = JSON.parse(summaryRes.body) as {
    session: { sessionId: string };
    transcriptEventCount: number;
  };
  assert.equal(summaryBody.session.sessionId, firstSessionId);
  assert.equal(typeof summaryBody.transcriptEventCount, "number");

  const timelineRes = await app.inject({
    method: "GET",
    url: `/api/v1/sessions/${firstSessionId}/timeline?limit=10`,
  });
  assert.equal(timelineRes.statusCode, 200);
  const timelineBody = JSON.parse(timelineRes.body) as { items: Array<{ eventId: string }> };
  assert.equal(Array.isArray(timelineBody.items), true);
}

async function smokeTools(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const request = {
    toolName: "session.status",
    args: {},
    agentId: "architect",
    sessionId: "smoke-session",
  };
  const res = await postJson(app, "/api/v1/tools/invoke", request, {
    "Idempotency-Key": smokeIdempotencyKey("smoke-tool-invoke-1"),
  });
  assert.equal(res.statusCode, 200);
  const body = res.body as { outcome: string; approvalId?: string };
  if (body.outcome === "approval_required") {
    assert.equal(typeof body.approvalId, "string");
  } else {
    assert.equal(body.outcome, "executed");
  }
}

async function smokeNativeToolsExpansion(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const catalogRes = await app.inject({
    method: "GET",
    url: "/api/v1/tools/catalog",
  });
  assert.equal(catalogRes.statusCode, 200);
  const catalog = JSON.parse(catalogRes.body) as { items: Array<{ toolName: string }> };
  assert.equal(
    catalog.items.some((item) => item.toolName === "memory.write"),
    true,
  );

  const createGrant = await postJson<{ grantId: string }>(
    app,
    "/api/v1/tools/grants",
    {
      toolPattern: "memory.write",
      decision: "allow",
      scope: "session",
      scopeRef: "smoke-knowledge-session",
      grantType: "persistent",
      createdBy: "smoke",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-tool-grant-create-1"),
    },
  );
  assert.equal(createGrant.statusCode, 201);
  assert.equal(typeof createGrant.body.grantId, "string");

  const evaluate = await postJson<{
    toolName: string;
    allowed: boolean;
    requiresApproval: boolean;
    reasonCodes: string[];
  }>(
    app,
    "/api/v1/tools/access/evaluate",
    {
      toolName: "memory.write",
      agentId: "architect",
      sessionId: "smoke-knowledge-session",
      args: {
        namespace: "smoke",
        title: "entry",
        content: "hello",
      },
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-tool-access-evaluate-1"),
    },
  );
  assert.equal(evaluate.statusCode, 200);
  assert.equal(evaluate.body.allowed, true);

  const memoryWrite = await postJson<{
    mode: string;
    document: { docId: string };
    chunksSaved: number;
    outcome?: string;
    approvalId?: string;
  }>(
    app,
    "/api/v1/knowledge/memory/write",
    {
      namespace: "smoke",
      title: "smoke-note",
      content: "smoke tools expansion check",
      sessionId: "smoke-knowledge-session",
      agentId: "architect",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-knowledge-write-1"),
    },
  );
  assert.equal(memoryWrite.statusCode, 200);
  if (memoryWrite.body.outcome === "approval_required") {
    const approvalId = memoryWrite.body.approvalId;
    if (typeof approvalId !== "string") {
      throw new Error("memory write approval response did not include approvalId");
    }
    const approvedWrite = await postJson(
      app,
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/resolve`,
      {
        decision: "approve",
        resolvedBy: "smoke",
        resolutionNote: "Approve smoke memory write.",
      },
      {
        "Idempotency-Key": smokeIdempotencyKey("smoke-knowledge-write-approval-1"),
      },
    );
    assert.equal(approvedWrite.statusCode, 200);
  } else {
    assert.equal(memoryWrite.body.mode, "write");
    assert.equal(memoryWrite.body.chunksSaved >= 1, true);
  }

  const createSearchGrant = await postJson<{ grantId: string }>(
    app,
    "/api/v1/tools/grants",
    {
      toolPattern: "memory.search",
      decision: "allow",
      scope: "session",
      scopeRef: "smoke-knowledge-session",
      grantType: "persistent",
      createdBy: "smoke",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-tool-grant-create-2"),
    },
  );
  assert.equal(createSearchGrant.statusCode, 201);

  const memorySearch = await postJson<{
    namespace: string;
    query: string;
    items: unknown[];
    outcome?: string;
    approvalId?: string;
  }>(
    app,
    "/api/v1/knowledge/memory/search",
    {
      namespace: "smoke",
      query: "tools expansion",
      sessionId: "smoke-knowledge-session",
      agentId: "architect",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-knowledge-search-1"),
    },
  );
  assert.equal(memorySearch.statusCode, 200);
  if (memorySearch.body.outcome === "approval_required") {
    assert.equal(typeof memorySearch.body.approvalId, "string");
  } else {
    assert.equal(Array.isArray(memorySearch.body.items), true);
  }

  const commsSend = await postJson<{ outcome?: string; approvalId?: string; deliveryId?: string; status?: string }>(
    app,
    "/api/v1/comms/send",
    {
      connectionId: (await createSmokeChannelConnection(app, "native-tools-expansion")).connectionId,
      target: "smoke",
      message: "test",
      sessionId: "smoke-comms-session",
      agentId: "architect",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-comms-send-1"),
    },
  );
  assert.equal(commsSend.statusCode, 200);
  if (commsSend.body.outcome === "approval_required") {
    assert.equal(typeof commsSend.body.approvalId, "string");
  } else if (commsSend.body.outcome === "blocked") {
    assert.equal(commsSend.body.outcome, "blocked");
  } else {
    assert.equal(typeof commsSend.body.deliveryId, "string");
    assert.equal(typeof commsSend.body.status, "string");
  }
}

async function smokeApprovals(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const invalidList = await app.inject({
    method: "GET",
    url: "/api/v1/approvals?status=invalid",
  });
  assert.equal(invalidList.statusCode, 400);

  const created = await postJson(
    app,
    "/api/v1/approvals",
    {
      kind: "shell.exec",
      riskLevel: "danger",
      payload: { command: "dir" },
      preview: { command: "dir" },
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-approval-create-1"),
    },
  );
  assert.equal(created.statusCode, 201);
  const approval = created.body as { approvalId: string; status: string };
  assert.equal(approval.status, "pending");

  const resolved = await postJson(
    app,
    `/api/v1/approvals/${approval.approvalId}/resolve`,
    {
      decision: "reject",
      resolvedBy: "smoke-runner",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-approval-resolve-1"),
    },
  );
  assert.equal(resolved.statusCode, 200);
  assert.equal((resolved.body as { approval: { status: string } }).approval.status, "rejected");
}

async function smokeIntegrations(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const created = await createSmokeChannelConnection(app, "integration-create");

  assert.equal(typeof created.connectionId, "string");

  const pathSuggestionsRes = await app.inject({
    method: "GET",
    url: "/api/v1/files/path-suggestions?root=.&limit=25",
  });
  assert.equal(pathSuggestionsRes.statusCode, 200);
  const suggestionsBody = JSON.parse(pathSuggestionsRes.body) as { items: string[] };
  assert.equal(Array.isArray(suggestionsBody.items), true);
}

async function createSmokeChannelConnection(
  app: Awaited<ReturnType<typeof buildApp>>,
  keySuffix: string,
): Promise<{ connectionId: string }> {
  const catalogRes = await app.inject({
    method: "GET",
    url: "/api/v1/integrations/catalog?kind=channel",
  });
  assert.equal(catalogRes.statusCode, 200);
  const catalog = JSON.parse(catalogRes.body) as { items: Array<{ catalogId: string }> };
  const first = catalog.items[0];
  assert.ok(first, "catalog should return at least one entry");

  const schemaRes = await app.inject({
    method: "GET",
    url: `/api/v1/integrations/catalog/${encodeURIComponent(first.catalogId)}/form-schema`,
  });
  assert.equal(schemaRes.statusCode, 200);
  const schemaBody = JSON.parse(schemaRes.body) as { catalogId: string; fields: unknown[] };
  assert.equal(schemaBody.catalogId, first.catalogId);
  assert.equal(Array.isArray(schemaBody.fields), true);

  const created = await postJson<{ connectionId: string }>(
    app,
    "/api/v1/integrations/connections",
    {
      catalogId: first.catalogId,
      label: `Smoke Connection ${keySuffix}`,
      enabled: true,
      status: "connected",
      config: {},
    },
    {
      "Idempotency-Key": smokeIdempotencyKey(`smoke-${keySuffix}`),
    },
  );
  assert.equal(created.statusCode, 201);
  assert.equal(typeof created.body.connectionId, "string");
  return created.body;
}

async function smokeSecrets(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const statusRes = await app.inject({
    method: "GET",
    url: "/api/v1/secrets/providers/openai/status",
  });
  assert.equal(statusRes.statusCode, 200);
  const body = JSON.parse(statusRes.body) as { providerId: string; hasSecret: boolean; source: string };
  assert.equal(body.providerId, "openai");
  assert.equal(typeof body.hasSecret, "boolean");
}

async function smokeAgents(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const initial = await app.inject({
    method: "GET",
    url: "/api/v1/agents?view=active&limit=100",
  });
  assert.equal(initial.statusCode, 200);
  const initialBody = JSON.parse(initial.body) as {
    items: Array<{ agentId: string; roleId: string; isBuiltin: boolean }>;
  };
  assert.equal(initialBody.items.length >= 1, true);

  const builtIn = initialBody.items.find((item) => item.roleId === "architect");
  assert.ok(builtIn, "architect builtin should be seeded");

  const created = await postJson<{ agentId: string; roleId: string; lifecycleStatus: string }>(
    app,
    "/api/v1/agents",
    {
      roleId: "smoke-custom",
      name: "Smoke Custom Goat",
      title: "Smoke Specialist",
      summary: "Created by smoke test",
      specialties: ["Smoke"],
      aliases: ["smoke"],
      defaultTools: ["memory.read"],
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-agent-create-1"),
    },
  );
  assert.equal(created.statusCode, 201);
  assert.equal(created.body.roleId, "smoke-custom");
  const customAgentId = created.body.agentId;

  const updated = await app.inject({
    method: "PATCH",
    url: `/api/v1/agents/${customAgentId}`,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": smokeIdempotencyKey("smoke-agent-update-1"),
    },
    payload: JSON.stringify({
      title: "Smoke Specialist Updated",
      summary: "Updated by smoke test",
    }),
  });
  assert.equal(updated.statusCode, 200);

  const archived = await app.inject({
    method: "POST",
    url: `/api/v1/agents/${customAgentId}/archive`,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": smokeIdempotencyKey("smoke-agent-archive-1"),
    },
    payload: JSON.stringify({
      archivedBy: "smoke",
      archiveReason: "smoke coverage",
    }),
  });
  assert.equal(archived.statusCode, 200);

  const restore = await app.inject({
    method: "POST",
    url: `/api/v1/agents/${customAgentId}/restore`,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": smokeIdempotencyKey("smoke-agent-restore-1"),
    },
    payload: JSON.stringify({}),
  });
  assert.equal(restore.statusCode, 200);

  const builtInDeleteAttempt = await app.inject({
    method: "DELETE",
    url: `/api/v1/agents/${builtIn.agentId}?mode=hard`,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": smokeIdempotencyKey("smoke-agent-delete-built-in-1"),
    },
    payload: JSON.stringify({}),
  });
  assert.equal(builtInDeleteAttempt.statusCode, 409);

  const deleted = await app.inject({
    method: "DELETE",
    url: `/api/v1/agents/${customAgentId}?mode=hard`,
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": smokeIdempotencyKey("smoke-agent-delete-custom-1"),
    },
    payload: JSON.stringify({}),
  });
  assert.equal(deleted.statusCode, 200);
}

async function smokeMesh(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const statusRes = await app.inject({
    method: "GET",
    url: "/api/v1/mesh/status",
  });
  assert.equal(statusRes.statusCode, 200);
  const status = JSON.parse(statusRes.body) as { enabled: boolean; localNodeId: string };
  assert.equal(typeof status.enabled, "boolean");
  assert.equal(typeof status.localNodeId, "string");

  const nodesRes = await app.inject({
    method: "GET",
    url: "/api/v1/mesh/nodes?limit=10",
  });
  assert.equal(nodesRes.statusCode, 200);
  const nodes = JSON.parse(nodesRes.body) as { items: Array<{ nodeId: string }> };
  assert.equal(nodes.items.length >= 1, true);
}

async function smokeNpu(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const statusRes = await app.inject({
    method: "GET",
    url: "/api/v1/npu/status",
  });
  assert.equal(statusRes.statusCode, 200);
  const status = JSON.parse(statusRes.body) as {
    enabled: boolean;
    sidecarUrl: string;
    processState: string;
  };
  assert.equal(typeof status.enabled, "boolean");
  assert.equal(typeof status.sidecarUrl, "string");
  assert.equal(typeof status.processState, "string");
}

async function smokeOnboarding(app: Awaited<ReturnType<typeof buildApp>>): Promise<void> {
  const initial = await app.inject({
    method: "GET",
    url: "/api/v1/onboarding/state",
  });
  assert.equal(initial.statusCode, 200);
  const initialBody = JSON.parse(initial.body) as {
    completed: boolean;
    checklist: Array<{ id: string; status: string }>;
  };
  assert.equal(Array.isArray(initialBody.checklist), true);

  const bootstrap = await postJson(
    app,
    "/api/v1/onboarding/bootstrap",
    {
      budgetMode: "balanced",
      defaultToolProfile: "minimal",
      networkAllowlist: ["127.0.0.1", "localhost"],
      llm: {
        activeProviderId: "openai",
        activeModel: "gpt-5",
        upsertProvider: {
          providerId: "openai",
          apiKey: "sk-smoke-value",
          apiKeyEnv: "OPENAI_API_KEY",
          persistSecretToSecureStore: false,
        },
      },
      markComplete: true,
      completedBy: "smoke",
    },
    {
      "Idempotency-Key": smokeIdempotencyKey("smoke-onboarding-bootstrap-1"),
    },
  );
  assert.equal(bootstrap.statusCode, 200);
  const bootstrapBody = bootstrap.body as {
    appliedAt: string;
    state: { completed: boolean };
  };
  assert.equal(typeof bootstrapBody.appliedAt, "string");
  assert.equal(bootstrapBody.state.completed, true);
  const envPath = path.join(process.env.GOATCITADEL_ROOT_DIR ?? "", ".env");
  const envFile = await readFile(envPath, "utf8");
  assert.match(envFile, /OPENAI_API_KEY="sk-smoke-value"/);
}

async function postJson<T>(
  app: Awaited<ReturnType<typeof buildApp>>,
  url: string,
  payload: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<JsonResponse<T>> {
  const res = await app.inject({
    method: "POST",
    url,
    headers: {
      "Content-Type": "application/json",
      ...(headers ?? {}),
    },
    payload: JSON.stringify(payload),
  });

  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.body) as T,
  };
}

const smokeScriptPath = path.resolve(fileURLToPath(import.meta.url));
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === smokeScriptPath) {
  runSmoke().catch((error) => {
    writeSmokeError("Smoke tests failed.");
    writeSmokeError(formatSmokeError(error));
    process.exitCode = 1;
  });
}
