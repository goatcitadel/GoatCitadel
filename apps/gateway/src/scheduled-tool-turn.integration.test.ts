import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  canOfferChatToolGrant,
  type ApprovalRequest,
  type ChatThreadResponse,
  type CronRunRecord,
  type DurableChatTurnExecutionPayloadAuthority,
  type ToolGrantRecord,
} from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { buildApp } from "./app.js";
import { CronAutomationService } from "./services/gateway/cron-automation-service.js";
import { SecretStoreService } from "./services/secret-store-service.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

type ScheduledOccurrence = Pick<CronRunRecord, "runId" | "status" | "trigger" | "childSessionId" | "childTurnId">;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function startScheduledToolProvider(toolPattern: RegExp, args: Record<string, unknown> = {}) {
  let toolRequests = 0;
  let observedToolResult = false;
  const provider = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path === "/v1/models") return { body: { data: [{ id: "fixture-chat", object: "model" }] } };
    if (request.path !== "/v1/chat/completions") return { status: 404 };
    const body = request.body as {
      stream?: boolean;
      tools?: Array<{ function: { name: string; description?: string } }>;
      messages?: Array<{ role: string; content?: unknown }>;
    };
    const messages = body.messages ?? [];
    const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
    const toolResult = messages.slice(lastUserIndex + 1).some((message) => message.role === "tool");
    observedToolResult ||= Boolean(toolResult);
    const tool = body.tools?.find((entry) => toolPattern.test(entry.function.name));
    const toolCalls =
      !toolResult && tool
        ? [
            {
              index: 0,
              id: "call_scheduled_tool",
              type: "function",
              function: { name: tool.function.name, arguments: JSON.stringify(args) },
            },
          ]
        : undefined;
    if (toolCalls) toolRequests += 1;
    const content = toolResult ? "SCHEDULED_TOOL_COMPLETE" : "SCHEDULED_TOOL_UNAVAILABLE";
    return body.stream
      ? {
          sseFrames: [
            JSON.stringify({
              model: "fixture-chat",
              choices: [
                {
                  index: 0,
                  delta: toolCalls ? { tool_calls: toolCalls } : { role: "assistant", content },
                  finish_reason: toolCalls ? "tool_calls" : "stop",
                },
              ],
            }),
            "[DONE]",
          ],
        }
      : {
          body: {
            model: "fixture-chat",
            choices: [
              {
                message: toolCalls
                  ? { role: "assistant", content: null, tool_calls: toolCalls }
                  : { role: "assistant", content },
                finish_reason: toolCalls ? "tool_calls" : "stop",
              },
            ],
          },
        };
  });
  return { ...provider, observe: () => ({ toolRequests, observedToolResult }) };
}

async function configureScheduledToolFixture(
  root: string,
  baseUrl: string,
  toolName: string,
  networkHosts: string[] = [],
) {
  const configDir = path.join(root, "config");
  await fs.mkdir(configDir);
  const examples = fileURLToPath(new URL("../../../config/", import.meta.url));
  for (const name of [
    "assistant.config.example.json",
    "tool-policy.example.json",
    "budgets.example.json",
    "cron-jobs.example.json",
  ])
    await fs.copyFile(path.join(examples, name), path.join(configDir, name));
  const config = JSON.parse(await fs.readFile(path.join(examples, "goatcitadel.example.json"), "utf8"));
  config.llm = {
    activeProviderId: "fake-openai",
    activeModel: "fixture-chat",
    providers: [
      {
        providerId: "fake-openai",
        label: "Scheduled fixture",
        baseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "fixture-chat",
      },
    ],
  };
  config.assistant.approvalExplainer.enabled = false;
  config.toolPolicy.tools.allow.push(toolName);
  config.toolPolicy.sandbox.networkAllowlist.push(...networkHosts);
  await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
  await fs.writeFile(path.join(configDir, "tool-policy.json"), JSON.stringify(config.toolPolicy));
  await fs.writeFile(
    path.join(configDir, "llm-model-metadata.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "fake-openai/fixture-chat": { contextWindow: 128_000, outputTokenLimit: 16_000 },
      },
    }),
  );
  const token = "scheduled-tool-test-operator-1234567890";
  for (const [key, value] of Object.entries({
    GATEWAY_HOST: "127.0.0.1",
    NODE_ENV: "test",
    GOATCITADEL_ROOT_DIR: root,
    GOATCITADEL_ALLOWED_ORIGINS: "http://localhost:5173",
    GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS: "false",
    GOATCITADEL_AUTH_MODE: "token",
    GOATCITADEL_AUTH_TOKEN: token,
    GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
    GOATCITADEL_DATABASE_DRIVER: "sqlite",
    GOATCITADEL_RATE_LIMIT_ENABLED: "false",
    GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
    GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED: "false",
    GOATCITADEL_FEATURE_SCHEDULED_CHAT_TURNS_V1_ENABLED: "true",
  }))
    vi.stubEnv(key, value);
  let sequence = 0;
  return () => ({ authorization: `Bearer ${token}`, "idempotency-key": `scheduled-tool-${++sequence}` });
}

it("runs one scheduled tool-using Chat child through canonical owners and retains it across restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-scheduled-tool-"));
  const provider = await startScheduledToolProvider(/time[._]now/u);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let storage: Storage | undefined;
  try {
    const headers = await configureScheduledToolFixture(root, provider.baseUrl, "time.now");
    app = await buildApp();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      headers: headers(),
      payload: { title: "Scheduled tool proof" },
    });
    expect(session.statusCode, session.body).toBe(201);
    const sessionId = session.json().sessionId as string;
    const job = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      headers: headers(),
      payload: {
        jobId: "scheduled-tool-proof",
        name: "Scheduled tool proof",
        action: "agent_turn",
        schedule: "0 0 * * * UTC",
        enabled: true,
        actionConfig: {
          agentTurn: {
            prompt: "Use time.now once, then report SCHEDULED_TOOL_COMPLETE.",
            sessionId,
            createdBy: { permissionProfileId: "trusted_local_power" },
          },
        },
      },
    });
    expect(job.statusCode, job.body).toBe(201);
    expect(job.json().actionConfig.agentTurn.createdBy.operatorId).toBeTruthy();
    const admitted = await app.inject({
      method: "POST",
      url: "/api/v1/cron/jobs/scheduled-tool-proof/run",
      headers: headers(),
      payload: {},
    });
    expect(admitted.statusCode, admitted.body).toBe(200);
    const occurrenceId = admitted.json().runId as string;
    expect(occurrenceId).toBeTruthy();
    let completed: ChatThreadResponse["turns"][number] | undefined;
    await vi.waitFor(
      async () => {
        const response = await app!.inject({
          method: "GET",
          url: `/api/v1/chat/sessions/${sessionId}/thread`,
          headers: headers(),
        });
        expect(response.statusCode, response.body).toBe(200);
        completed = (response.json() as ChatThreadResponse).turns.at(-1);
        expect(completed?.trace.status, JSON.stringify(completed?.trace)).toBe("completed");
      },
      { timeout: 60_000, interval: 150 },
    );
    expect(provider.observe()).toEqual({ toolRequests: 1, observedToolResult: true });
    expect(completed!.assistantMessage?.content).toContain("SCHEDULED_TOOL_COMPLETE");
    expect(completed!.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "time.now", status: "executed" })]),
    );
    const runId = completed!.trace.durable!.runId;
    const configRead = app.gatewayConfig;
    await app.close();
    app = undefined;
    const dispatchCount = provider.requests.filter((request) => request.path === "/v1/chat/completions").length;
    app = await buildApp();
    const retained = await app.inject({ method: "GET", url: `/api/v1/cron/runs/${occurrenceId}`, headers: headers() });
    expect(retained.statusCode, retained.body).toBe(200);
    expect(retained.json().canonical.childDurableRunId).toBe(runId);
    expect(provider.requests.filter((request) => request.path === "/v1/chat/completions")).toHaveLength(dispatchCount);
    await app.close();
    app = undefined;
    storage = new Storage({
      dbPath: configRead.dbPath,
      transcriptsDir: path.join(root, "read-transcripts"),
      auditDir: path.join(root, "read-audit"),
    });
    const run = storage.durableRuns.getRun(runId);
    expect(run.status).toBe("completed");
    const authority = run.payload as unknown as DurableChatTurnExecutionPayloadAuthority;
    expect(authority.capabilityProfileId).toBeUndefined();
    const feature = storage.sessionMutationAdmissions.findFeatureReferences({
      admissionId: authority.admissionId,
      sessionIncarnationId: authority.sessionIncarnationId,
      workspaceId: authority.workspaceId,
      sessionId,
      turnId: authority.turnId,
    });
    expect(feature?.referenceSha256).toBe(authority.featureReferenceSha256);
    expect(feature?.references.scheduledOccurrence?.ownerId).toBe(occurrenceId);
    expect(storage.cronRuns.listByJob("scheduled-tool-proof")).toHaveLength(1);
    expect(storage.cronRuns.get(occurrenceId)?.childDurableRunId).toBe(runId);
    // There is no external destination in this fixture. Delivery retry is proved separately.
    expect(storage.cronRuns.get(occurrenceId)?.deliveryRunId).toBeUndefined();
  } finally {
    storage?.close();
    await app?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180_000);

it("uses a Calendar allowance on later occurrences in the schedule's Chat and asks again when revoked", async () => {
  const tempDirectory = path.resolve(os.tmpdir());
  const root = path.resolve(await fs.mkdtemp(path.join(tempDirectory, "gc-scheduled-calendar-")));
  if (path.dirname(root) !== tempDirectory) throw new Error("Unexpected scheduled Calendar fixture path.");
  const provider = await startScheduledToolProvider(/calendar[._]list/u, { calendarId: "primary", maxResults: 2 });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    const headers = await configureScheduledToolFixture(root, provider.baseUrl, "calendar.list", [
      "oauth2.googleapis.com",
      "www.googleapis.com",
    ]);
    const secrets = new Map<string, string>();
    vi.spyOn(SecretStoreService.prototype, "isAvailable").mockReturnValue(true);
    vi.spyOn(SecretStoreService.prototype, "getSecret").mockImplementation((account) => secrets.get(account));
    vi.spyOn(SecretStoreService.prototype, "setSecret").mockImplementation((account, secret) => {
      secrets.set(account, secret);
    });
    const runCronJobNow = vi.spyOn(CronAutomationService.prototype, "runCronJobNow");
    const calendarReads: string[] = [];
    const realFetch = globalThis.fetch;
    const providerOrigin = new URL(provider.baseUrl).origin;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === providerOrigin) return realFetch(input, init);
      if (url.href === "https://oauth2.googleapis.com/token") {
        return Response.json({
          access_token: "scheduled-calendar-access-token",
          refresh_token: "scheduled-calendar-refresh-token",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/calendar.events.readonly",
        });
      }
      if (url.origin === "https://www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scheduled-calendar-access-token");
        calendarReads.push(url.href);
        return Response.json({ items: [] });
      }
      throw new Error(`Unexpected request in scheduled Calendar fixture: ${url.origin}${url.pathname}`);
    });
    const gateway = await buildApp();
    app = gateway;
    const connection = await gateway.inject({
      method: "POST",
      url: "/api/v1/integrations/connections",
      headers: headers(),
      payload: {
        catalogId: "automation.gmail",
        label: "Scheduled Calendar fixture",
        enabled: true,
        config: { clientId: "1234567890-schedule.apps.googleusercontent.com", calendarRead: true },
      },
    });
    expect(connection.statusCode, connection.body).toBe(201);
    const connectionId = connection.json().connectionId as string;
    const oauth = `/api/v1/integrations/connections/${connectionId}/google-oauth`;
    const started = await gateway.inject({
      method: "POST",
      url: `${oauth}/start`,
      headers: { ...headers(), origin: "http://localhost:5173", "x-goatcitadel-browser-intent": "mutation" },
      payload: { capabilities: ["calendar.read"], clientSecret: "GOCSPX-scheduled-calendar-fixture" },
    });
    expect(started.statusCode, started.body).toBe(200);
    const connected = await gateway.inject({
      method: "POST",
      url: `${oauth}/complete`,
      headers: headers(),
      payload: { state: started.json().state, code: "scheduled-calendar-code" },
    });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({ connectionId, connected: true });

    const jobId = "scheduled-calendar-proof";
    const job = await gateway.inject({
      method: "POST",
      url: "/api/v1/cron/jobs",
      headers: headers(),
      payload: {
        jobId,
        name: "Scheduled Calendar read",
        action: "agent_turn",
        schedule: "0 */1 * * * UTC",
        enabled: true,
        actionConfig: {
          agentTurn: {
            prompt:
              "Use calendar.list once to check for Calendar events, then report only whether the read succeeded and what grant was created.",
            createdBy: { permissionProfileId: "trusted_local_power" },
          },
        },
      },
    });
    expect(job.statusCode, job.body).toBe(201);

    async function readOccurrence(occurrenceId: string) {
      const response = await gateway.inject({
        method: "GET",
        url: `/api/v1/cron/runs/${occurrenceId}`,
        headers: headers(),
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json<{ canonical: ScheduledOccurrence }>().canonical;
    }

    async function waitForOccurrenceLink(occurrenceId: string) {
      return vi.waitFor(
        async () => {
          const occurrence = await readOccurrence(occurrenceId);
          expect(occurrence.childSessionId, JSON.stringify(occurrence)).toBeTruthy();
          expect(occurrence.childTurnId, JSON.stringify(occurrence)).toBeTruthy();
          return occurrence;
        },
        { timeout: 45_000, interval: 150 },
      );
    }

    async function runOccurrence() {
      const response = await gateway.inject({
        method: "POST",
        url: `/api/v1/cron/jobs/${jobId}/run`,
        headers: headers(),
        payload: {},
      });
      expect(response.statusCode, response.body).toBe(200);
      return waitForOccurrenceLink(response.json<{ runId: string }>().runId);
    }

    async function readTurn(occurrence: ScheduledOccurrence, status: "waiting_for_approval" | "completed") {
      const turn = await vi.waitFor(
        async () => {
          const thread = await gateway.inject({
            method: "GET",
            url: `/api/v1/chat/sessions/${occurrence.childSessionId}/thread`,
            headers: headers(),
          });
          expect(thread.statusCode, thread.body).toBe(200);
          const turn = thread
            .json<ChatThreadResponse>()
            .turns.find(({ trace }) => trace.turnId === occurrence.childTurnId);
          if (turn && ["failed", "cancelled", "completed"].includes(turn.trace.status)) return turn;
          expect(turn?.trace.status, JSON.stringify(turn)).toBe(status);
          return turn!;
        },
        { timeout: 45_000, interval: 150 },
      );
      expect(turn.trace.status, JSON.stringify(turn)).toBe(status);
      return turn;
    }

    async function waitForSettlement(scheduler: CronAutomationService, occurrenceId: string) {
      await vi.waitFor(
        async () => {
          // Use the real maintenance sweep without waiting for its minute-long interval.
          await scheduler.runDueTaskCronJobs();
          const occurrence = await readOccurrence(occurrenceId);
          expect(occurrence.status, JSON.stringify(occurrence)).toBe("completed");
        },
        { timeout: 45_000, interval: 150 },
      );
    }

    const first = await runOccurrence();
    const scheduler: unknown = runCronJobNow.mock.contexts.at(-1);
    if (!(scheduler instanceof CronAutomationService)) {
      throw new Error("Scheduled Calendar fixture did not capture the cron owner.");
    }
    const heldTurn = await readTurn(first, "waiting_for_approval");
    const heldRead = heldTurn.toolRuns.find(({ toolName }) => toolName === "calendar.list");
    expect(heldRead).toMatchObject({ status: "approval_required", approvalId: expect.any(String) });
    expect(calendarReads).toHaveLength(0);
    const workspaceId = "default";
    const approval = await gateway.inject({
      method: "GET",
      url: `/api/v1/approvals/${heldRead!.approvalId}?workspaceId=${workspaceId}`,
      headers: headers(),
    });
    expect(approval.statusCode, approval.body).toBe(200);
    const approvalDetail = approval.json<ApprovalRequest>();
    expect(approvalDetail).toMatchObject({
      kind: "calendar.list",
      linkage: { actionType: "tool.invoke", sessionId: first.childSessionId, workspaceId, turnId: first.childTurnId },
    });
    expect(canOfferChatToolGrant(approvalDetail, first.childSessionId!, workspaceId)).toBe(true);
    const directSelection = await gateway.inject({
      method: "POST",
      url: "/api/v1/tools/access/evaluate",
      headers: headers(),
      payload: {
        toolName: "calendar.list",
        agentId: "assistant",
        sessionId: first.childSessionId,
        workspaceId,
        permissionProfileId: approvalDetail.linkage?.permissionProfileId,
      },
    });
    expect(directSelection.statusCode, directSelection.body).toBe(400);
    expect(directSelection.json().error).toContain("cannot be selected directly");
    const approved = await gateway.inject({
      method: "POST",
      url: "/api/v1/chat/tools/approve-temporarily",
      headers: headers(),
      payload: { sessionId: first.childSessionId, approvalId: heldRead!.approvalId, duration: "24h" },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const grant = approved.json<{ grant: ToolGrantRecord }>().grant;
    expect(grant).toMatchObject({
      decision: "allow",
      scope: "session",
      scopeRef: first.childSessionId,
      grantType: "ttl",
      toolPattern: "calendar.list",
      constraints: {
        googleRead: {
          sessionId: first.childSessionId,
          workspaceId,
          connectionId,
          calendarId: "primary",
          signInId: expect.any(String),
        },
      },
    });
    expect(Date.parse(grant.expiresAt ?? "") - Date.parse(grant.createdAt)).toBe(24 * 60 * 60_000);
    const approvedRead = await readTurn(first, "completed");
    expect(approvedRead.assistantMessage?.content).toBe(
      "The Google Calendar read succeeded after your approval. GoatCitadel granted 24 hours of read-only access in this Chat.",
    );
    await waitForSettlement(scheduler, first.runId);
    expect(calendarReads).toHaveLength(1);

    const { nextRunAt } = await scheduler.getCronJob(jobId);
    expect(nextRunAt).toBeTruthy();
    const due = await scheduler.runDueTaskCronJobs(new Date(nextRunAt!));
    const dueRunId = due.items.find((item) => item.jobId === jobId)?.runId;
    expect(dueRunId, JSON.stringify(due.items)).toBeTruthy();
    const second = await waitForOccurrenceLink(dueRunId!);
    expect(second.trigger).toBe("scheduled_due");
    expect(second.childSessionId).toBe(first.childSessionId);
    const completed = await readTurn(second, "completed");
    expect(completed.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "calendar.list", status: "executed" })]),
    );
    expect(completed.toolRuns.find(({ toolName }) => toolName === "calendar.list")?.approvalId).toBeUndefined();
    expect(completed.assistantMessage?.content).not.toContain("after your approval");
    await waitForSettlement(scheduler, second.runId);
    expect(calendarReads).toHaveLength(2);

    const revoked = await gateway.inject({
      method: "POST",
      url: `/api/v1/tools/grants/${grant.grantId}/revoke`,
      headers: headers(),
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    const third = await runOccurrence();
    expect(third.childSessionId).toBe(first.childSessionId);
    const heldAgain = await readTurn(third, "waiting_for_approval");
    expect(heldAgain.toolRuns).toEqual(
      expect.arrayContaining([expect.objectContaining({ toolName: "calendar.list", status: "approval_required" })]),
    );
    expect(calendarReads).toHaveLength(2);
  } finally {
    await app?.close();
    await provider.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 240_000);
