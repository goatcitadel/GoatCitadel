import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IntegrationConnection, ToolInvokeRequest } from "@goatcitadel/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGatewayConfig } from "../config.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiRequest,
  type FakeOpenAiResponse,
  type FakeOpenAiServer,
} from "../test/fake-openai-server.js";
import type { ChatThreadKnowledgeDependencies } from "./chat-thread-knowledge-service.js";
import { readScheduledBriefReplyContext } from "./scheduled-brief-reply-context.js";
import { OWN_DELIVERY } from "./comms-service.js";
import { handleDiscordRuntimeInbound } from "./discord-runtime-bridge-service.js";
import { GatewayService } from "./gateway-service.js";

/**
 * Operator decision (Phase 2, Q1): switching a tool group off stops the AI only. Channel replies, the operator's own
 * sends and Library actions keep working. Real Gateway, real policy engine and real channel delivery queue; only the
 * model and the Discord webhook are local fakes.
 */
const ENV_KEYS = [
  "NODE_ENV",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_ROOT_DIR",
  "GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED",
  "GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED",
  "GOATCITADEL_FEATURE_SCHEDULED_CHAT_TURNS_V1_ENABLED",
] as const;
const SWITCHED_OFF_PHRASE = "tool group switched off";
const DISCORD_TARGET = "discord-channel-1";
const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let gateway: GatewayService | undefined;
let fakeProvider: FakeOpenAiServer | undefined;
let fakeDiscord: FakeDiscordWebhookServer | undefined;

describe("GoatCitadel's own deliveries while a tool group is off", { timeout: 120_000 }, () => {
  afterEach(async () => {
    await gateway?.close().catch(() => undefined);
    gateway = undefined;
    await fakeProvider?.close().catch(() => undefined);
    fakeProvider = undefined;
    await fakeDiscord?.close().catch(() => undefined);
    fakeDiscord = undefined;
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  async function startGateway(
    options: { scheduledTurns?: boolean; target?: string } = {},
  ): Promise<{ live: GatewayService; connection: IntegrationConnection }> {
    fakeProvider = await startFakeOpenAiCompatibleServer(replyWith("REPLY_OK"));
    fakeDiscord = await startFakeDiscordWebhookServer();
    const root = createIsolatedConfigRoot(fakeProvider.baseUrl);
    process.env.NODE_ENV = "test";
    process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
    process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
    process.env.GOATCITADEL_ROOT_DIR = root;
    if (options.scheduledTurns) {
      process.env.GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED = "true";
      process.env.GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED = "false";
      process.env.GOATCITADEL_FEATURE_SCHEDULED_CHAT_TURNS_V1_ENABLED = "true";
    }
    gateway = new GatewayService(await loadGatewayConfig(root));
    await gateway.initCritical();
    const connection = await gateway.routeServices.integrations.createIntegrationConnection({
      catalogId: "channel.discord",
      label: "Own delivery integration test",
      enabled: true,
      status: "connected",
      config: {
        runtimeMode: "gateway",
        ...(options.target ? { botToken: "fixture-discord-bot-key" } : { webhookUrl: fakeDiscord.webhookUrl }),
        defaultChannelId: options.target ?? DISCORD_TARGET,
        inboundAccessMode: "open_legacy",
      },
    });
    return { live: gateway, connection };
  }

  /** The live tool policy the engine reads by reference, as a Settings save would change it. */
  function switchOff(live: GatewayService, ...groups: string[]): void {
    live.config.toolPolicy.tools.disabledGroups = groups;
  }

  function aiCall(toolName: string, args: Record<string, unknown>): ToolInvokeRequest {
    return { toolName, args, agentId: "assistant", sessionId: "own-delivery-ai-session" };
  }

  /** The operator approves in Inbox; the approval runtime then runs the action. Returns the settled pending action. */
  async function approveAndSettle(live: GatewayService, approvalId: string) {
    await live.resolveApproval(approvalId, { decision: "approve", resolvedBy: "operator" });
    return await pollFor(
      async () => await live.storage.pendingApprovalActions.find(approvalId),
      (action) => action?.resolutionStatus !== undefined && action.resolutionStatus !== "pending",
      `approval ${approvalId} to settle`,
    );
  }

  it("delivers an inbound channel reply while Messaging is off", async () => {
    const { live, connection } = await startGateway();
    switchOff(live, "messaging");

    await handleDiscordRuntimeInbound(live, {
      connectionId: connection.connectionId,
      target: DISCORD_TARGET,
      actorId: "discord-user-1",
      displayName: "Discord Test User",
      content: "Reply with exactly: REPLY_OK",
      sourceMessageId: "discord-source-own-delivery-1",
      peer: "discord-user-1",
      room: DISCORD_TARGET,
      metadata: { guildId: "discord-guild-1", channelId: DISCORD_TARGET, runtimeMode: "gateway" },
    });
    const event = await pollFor(
      async () =>
        await live.storage.inboundChannelEvents.getByIdentity({
          channelKey: "discord",
          connectionId: connection.connectionId,
          idempotencyKey: `discord:${connection.connectionId}:discord-source-own-delivery-1`,
        }),
      (candidate) =>
        candidate?.status === "completed" ||
        candidate?.status === "failed" ||
        candidate?.status === "manual_reconciliation_required" ||
        candidate?.status === "suppressed",
      "the inbound turn to settle",
    );
    expect(event?.status, event?.lastError ?? JSON.stringify(event)).toBe("completed");
    const reply = await settledDelivery(live, connection, event!.deliveryId!);
    expect(reply?.status, reply?.error).toBe("sent");
    // The queue kept the fact that this send is GoatCitadel's own.
    expect(reply?.payload).toMatchObject({ ownDelivery: true });
    expect(fakeDiscord!.requests.map((request) => asRecord(request.body).content)).toEqual(["REPLY_OK"]);

    // The switch is really on: the same channel send without the own-delivery option is stopped before Discord.
    const unmarked = await live.commsSend({
      connectionId: connection.connectionId,
      target: DISCORD_TARGET,
      message: "x",
    });
    const blocked = await settledDelivery(live, connection, String(asRecord(unmarked).deliveryId));
    expect(blocked?.status).toBe("failed");
    expect(blocked?.error).toContain(SWITCHED_OFF_PHRASE);
    expect(fakeDiscord!.requests).toHaveLength(1);
  });

  it("queues the operator's own comms send as GoatCitadel's own", async () => {
    const { live, connection } = await startGateway();
    switchOff(live, "messaging");

    const send = { connectionId: connection.connectionId, target: DISCORD_TARGET, message: "From the operator" };
    const own = asRecord(await live.routeServices.comms.commsSend(send, OWN_DELIVERY));
    const plain = asRecord(await live.routeServices.comms.commsSend({ ...send, message: "From a notification" }));

    expect((await live.storage.commsDeliveries.getById(String(own.deliveryId)))?.payload).toMatchObject({
      ownDelivery: true,
    });
    expect((await live.storage.commsDeliveries.getById(String(plain.deliveryId)))?.payload).not.toHaveProperty(
      "ownDelivery",
    );
  });

  it("blocks the AI's own telegram.send while Messaging is off", async () => {
    const { live, connection } = await startGateway();
    switchOff(live, "messaging");
    const args = { connectionId: connection.connectionId, target: DISCORD_TARGET, message: "From the AI" };

    for (const toolName of ["telegram.send", "channel.send"]) {
      const result = await live.invokeTool(aiCall(toolName, args));
      expect(result.outcome, toolName).toBe("blocked");
      expect(result.policyReason).toContain(SWITCHED_OFF_PHRASE);
    }
    expect(fakeDiscord!.requests).toHaveLength(0);
  });

  it("keeps an approved AI channel.send blocked while Messaging is off", async () => {
    const { live, connection } = await startGateway();
    live.config.toolPolicy.tools.allow.push("channel.send");
    const approvedSend = async (message: string) => {
      const asked = await live.invokeTool(aiCall("channel.send", { connectionId: connection.connectionId, message }));
      expect(asked.outcome, asked.policyReason).toBe("approval_required");
      return asked.approvalId!;
    };

    // Control: with Messaging on, the approved AI send reaches Discord.
    expect((await approveAndSettle(live, await approvedSend("Approved while on")))?.resolutionStatus).toBe("executed");
    expect(fakeDiscord!.requests).toHaveLength(1);

    // The AI's send asks first; the operator approves it while Messaging is off: the AI's send stays stopped.
    const approvalId = await approvedSend("Approved while off");
    switchOff(live, "messaging");
    const stopped = await approveAndSettle(live, approvalId);
    // Stopped by the switch itself, not by some unrelated failure, and named by the group's label.
    expect(stopped?.resolutionStatus).toBe("failed");
    expect(JSON.stringify(stopped?.result)).toContain(SWITCHED_OFF_PHRASE);
    expect(JSON.stringify(stopped?.result)).toContain("(Messaging)");
    expect(fakeDiscord!.requests).toHaveLength(1);
  });

  it("runs an approved Library action while Documents is off", async () => {
    const { live } = await startGateway();
    switchOff(live, "documents");

    // The operator ingests a note in Library. On a default install the operator's Library session asks first.
    const asked = asRecord(
      await live.routeServices.knowledge.knowledgeDocsIngest({
        sourceType: "text",
        source: "Release notes: the own-delivery test document.",
        namespace: "own-delivery",
        title: "Release notes",
      }),
    );
    expect(asked.outcome, JSON.stringify(asked)).toBe("approval_required");

    // The operator approves it in Inbox while Documents is still off, and the approval runtime runs it.
    const settled = await approveAndSettle(live, String(asked.approvalId));
    expect(settled?.resolutionStatus, JSON.stringify(settled?.result)).toBe("executed");
    expect(asRecord(settled?.result)).toMatchObject({ outcome: "executed" });

    // The control: the AI's own docs.ingest is still switched off.
    const aiIngest = await live.invokeTool(
      aiCall("docs.ingest", { sourceType: "text", source: "From the AI.", namespace: "own-delivery" }),
    );
    expect(aiIngest.outcome).toBe("blocked");
    expect(aiIngest.policyReason).toContain(SWITCHED_OFF_PHRASE);
  });

  it("runs Library knowledge actions while Documents is off", async () => {
    const { live } = await startGateway();
    const chatAttachments = (
      live as unknown as { buildChatThreadKnowledgeDependencies(): ChatThreadKnowledgeDependencies }
    ).buildChatThreadKnowledgeDependencies();
    switchOff(live, "documents", "memory");
    // The Library routes and Chat attachments both reach the engine through the knowledge facade. An executed call
    // comes back unwrapped; one that asks first (the install's usual approval mode) keeps its tool outcome.
    const results = [
      await live.routeServices.knowledge.knowledgeMemorySearch({ query: "release notes" }),
      await live.routeServices.knowledge.knowledgeEmbeddingsQuery({ query: "release notes" }),
      await chatAttachments.knowledgeEmbeddingsQuery({ query: "release notes", sessionId: "own-delivery-chat" }),
    ];

    // Each one really runs while the groups are off: at once, or once the operator approves it.
    for (const result of results) {
      const record = asRecord(result);
      if (record.outcome === undefined) continue;
      expect(record.outcome, JSON.stringify(record)).toBe("approval_required");
      const settled = await approveAndSettle(live, String(record.approvalId));
      expect(settled?.resolutionStatus, JSON.stringify(settled?.result)).toBe("executed");
    }

    // The AI's own calls to the same tools are switched off.
    for (const toolName of ["memory.search", "embeddings.query"]) {
      const result = await live.invokeTool(aiCall(toolName, { query: "release notes" }));
      expect(result.outcome, toolName).toBe("blocked");
      expect(result.policyReason).toContain(SWITCHED_OFF_PHRASE);
    }
  });

  it("executes Library knowledge actions while Documents and Memory are off when approvals are bypassed", async () => {
    const { live } = await startGateway();
    // Without approvals in the way, "keeps working" means the call really runs, not just that it is unchanged.
    live.config.toolPolicy.tools.approvalMode = "bypass";
    switchOff(live, "documents", "memory");
    const chatAttachments = (
      live as unknown as { buildChatThreadKnowledgeDependencies(): ChatThreadKnowledgeDependencies }
    ).buildChatThreadKnowledgeDependencies();

    const results = [
      await live.routeServices.knowledge.knowledgeMemorySearch({ query: "release notes" }),
      await live.routeServices.knowledge.knowledgeEmbeddingsQuery({ query: "release notes" }),
      await chatAttachments.knowledgeEmbeddingsQuery({ query: "release notes", sessionId: "own-delivery-chat" }),
    ];
    for (const result of results) {
      // An executed call comes back unwrapped; a refusal or approval request keeps its tool outcome.
      expect(asRecord(result).outcome, JSON.stringify(result)).toBeUndefined();
    }
    // The control: the AI's own call to the same tool is still switched off under the same settings.
    const aiSearch = await live.invokeTool(aiCall("memory.search", { query: "release notes" }));
    expect(aiSearch.outcome).toBe("blocked");
    expect(aiSearch.policyReason).toContain(SWITCHED_OFF_PHRASE);
  });

  /**
   * Fires one scheduled agent turn whose reply goes to the Discord channel, with Messaging switched off, and returns
   * the reply's channel delivery once it settles. The job is created the way each real owner creates it: the
   * operator's cron route stamps an `authenticated_operator` creator receipt, and `schedule.manage` (the AI's tool)
   * stamps `admitted_chat` (chat-autonomous-turn-service.ts scheduleManage).
   */
  async function runScheduledReply(creatorSource: "authenticated_operator" | "admitted_chat") {
    const { live, connection } = await startGateway({ scheduledTurns: true });
    switchOff(live, "messaging");
    const session = await live.createChatSession({ title: "Scheduled reply" });
    // The session may send to its channel without asking (the grant inbound replies use), so the Messaging switch
    // is the only thing that can stop the reply.
    await live.ensureSessionInternalToolGrant(session.sessionId, "channel.send", "own-delivery-test");
    const actorId = "operator-1";
    const jobId = `own-delivery-${creatorSource.replace("_", "-")}`;
    await live.routeServices.cron.createCronJob(
      {
        jobId,
        name: "Scheduled reply",
        action: "agent_turn",
        schedule: "0 0 * * * UTC",
        enabled: true,
        actionConfig: {
          agentTurn: {
            prompt: "Reply with exactly: REPLY_OK",
            sessionId: session.sessionId,
            deliveryChannel: { channelKey: "discord", target: DISCORD_TARGET },
            deliverMode: "always",
            createdBy: {
              operatorId: actorId,
              authActorId: actorId,
              permissionProfileId: "trusted_local_power",
              depth: 0,
            },
          },
        },
      },
      { actorId, source: creatorSource },
    );
    await live.routeServices.cron.runCronJobNow(jobId);
    const delivery = await pollFor(
      async () => (await live.storage.commsDeliveries.list(connection.connectionId, 50))[0],
      (candidate) =>
        candidate?.status === "sent" ||
        candidate?.status === "failed" ||
        candidate?.deliveryStatus === "waiting_approval",
      `the ${creatorSource} schedule's reply delivery to settle`,
      90_000,
    );
    return { delivery, discordRequests: fakeDiscord!.requests };
  }

  it("delivers an operator schedule's reply while Messaging is off", async () => {
    const { delivery, discordRequests } = await runScheduledReply("authenticated_operator");

    expect(delivery?.status, delivery?.error).toBe("sent");
    expect(delivery?.payload).toMatchObject({ ownDelivery: true });
    expect(discordRequests.map((request) => asRecord(request.body).content)).toEqual(["REPLY_OK"]);
  });

  it("creates a reviewed daily brief, delivers to its pinned thread, and supplies context to a reply", async () => {
    const target = "123456789012345678";
    const threadEndpoint = `https://discord.com/api/v10/channels/${target}/messages`;
    const botRequests: Array<{ url: string; body: unknown }> = [];
    const fetchOriginal = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "object" && "url" in input ? input.url : String(input);
      if (new URL(url).hostname !== "discord.com") return fetchOriginal(input, init);
      if (url !== threadEndpoint || init?.method !== "POST") return new Response(null, { status: 404 });
      botRequests.push({ url, body: parseJson(String(init.body)) });
      return Response.json({ id: String(123456789012345678n + BigInt(botRequests.length)) });
    });
    const { live, connection } = await startGateway({ scheduledTurns: true, target });
    const session = await live.createChatSession({ title: "Reviewed daily brief" });
    await live.ensureSessionInternalToolGrant(session.sessionId, "channel.send", "daily-brief-test");
    const scope = { sessionId: session.sessionId, workspaceId: "default", actorId: "operator-1" };
    const setup = await live.routeServices.chatAssistantSupport.inspectFollowThroughSetup(scope);
    expect(setup.channelDestinations).toMatchObject([{ connectionId: connection.connectionId, target }]);
    const job = await live.routeServices.chatAssistantSupport.createFollowThroughSetup({
      ...scope,
      expectedSetupHash: setup.sourceHash,
      operationId: "reviewed-brief-fixture",
      permissionProfileId: "trusted_local_power",
      purpose: "Post the synthetic daily brief",
      trigger: { kind: "recurring", schedule: "0 9 * * * America/Los_Angeles" },
      delivery: { kind: "channel", connectionId: connection.connectionId },
    });
    await live.routeServices.cron.runCronJobNow(job.jobId);
    const delivery = await pollFor(
      async () => (await live.storage.commsDeliveries.list(connection.connectionId, 50))[0],
      (item) => Boolean(item && (item.status !== "queued" || item.deliveryStatus === "waiting_approval")),
      "the pinned destination delivery",
    );
    expect(delivery?.status, JSON.stringify(delivery)).toBe("sent");
    const occurrence = await pollFor(
      async () => {
        await live.cronAutomationService.runDueTaskCronJobs();
        return (await live.storage.cronRuns.listByJob(job.jobId))[0];
      },
      (run) =>
        Boolean(
          run?.status === "completed" || run?.status === "failed" || run?.status === "manual_reconciliation_required",
        ),
      "the reviewed daily brief to settle",
      90_000,
    );
    expect(occurrence?.status, JSON.stringify(occurrence?.failure)).toBe("completed");
    expect(botRequests.map((request) => asRecord(request.body).content)).toEqual(["REPLY_OK"]);
    expect(fakeDiscord!.requests).toHaveLength(0);
    const providerMessageId = String(occurrence!.outcome!.providerMessageId);
    expect(providerMessageId).toMatch(/^\d{10,25}$/u);
    const context = await readScheduledBriefReplyContext(live.storage, {
      sessionId: session.sessionId,
      connectionId: connection.connectionId,
      target,
      providerMessageId,
    });
    expect(Boolean(context), JSON.stringify({ payload: delivery?.payload, outcome: occurrence?.outcome })).toBe(true);
    const reply = "Why was the second item included?";
    const processReply = vi.spyOn(live, "respondToExistingChatMessage");
    await handleDiscordRuntimeInbound(live, {
      connectionId: connection.connectionId,
      target,
      actorId: "discord-user-1",
      peer: "discord-user-1",
      room: target,
      threadId: target,
      content: reply,
      sourceMessageId: "brief-reply-fixture",
      metadata: { referencedMessageId: providerMessageId },
    });
    const outcome = await pollFor(
      async () =>
        await live.storage.inboundChannelEvents.getByIdentity({
          channelKey: "discord",
          connectionId: connection.connectionId,
          idempotencyKey: `discord:${connection.connectionId}:brief-reply-fixture`,
        }),
      (event) => Boolean(event?.sessionId) && processReply.mock.calls.length > 0,
      "the same-thread follow-up to enter Chat",
    );
    expect(outcome?.payload).toMatchObject({ message: { metadata: { referencedMessageId: providerMessageId } } });
    const inboundSessionId = outcome?.sessionId;
    expect(Boolean(inboundSessionId)).toBe(true);
    const inboundContext = await readScheduledBriefReplyContext(live.storage, {
      sessionId: inboundSessionId!,
      connectionId: connection.connectionId,
      target,
      providerMessageId,
    });
    const inboundMeta = await live.storage.chatSessionMeta.get(inboundSessionId!);
    expect(Boolean(inboundContext), `inbound workspace ${inboundMeta?.workspaceId}`).toBe(true);
    expect(processReply.mock.calls[0]?.[2]?.channelSystemInstruction).toBe(inboundContext);
    const hasModelContext = await pollFor(
      () =>
        fakeProvider!.requests.some(
          (request) =>
            request.method === "POST" &&
            JSON.stringify(request.body).includes(reply) &&
            JSON.stringify(request.body).includes("acknowledged scheduled brief"),
        ),
      Boolean,
      "the same-thread follow-up and its brief to reach the provider",
    );
    expect(hasModelContext).toBe(true);
    await pollFor(
      async () =>
        await live.storage.inboundChannelEvents.getByIdentity({
          channelKey: "discord",
          connectionId: connection.connectionId,
          idempotencyKey: `discord:${connection.connectionId}:brief-reply-fixture`,
        }),
      (event) => event?.status === "completed",
      "the same-thread reply delivery to settle",
      60_000,
    );
    expect(botRequests.map((request) => asRecord(request.body).content)).toEqual(["REPLY_OK", "REPLY_OK"]);
  }, 180_000);

  it("stops a schedule.manage schedule's reply while Messaging is off", async () => {
    const { delivery, discordRequests } = await runScheduledReply("admitted_chat");

    expect(delivery?.status).toBe("failed");
    expect(delivery?.error).toContain(SWITCHED_OFF_PHRASE);
    expect(delivery?.payload).not.toHaveProperty("ownDelivery");
    expect(discordRequests).toHaveLength(0);
  });
});

async function settledDelivery(live: GatewayService, connection: IntegrationConnection, deliveryId: string) {
  return await pollFor(
    async () =>
      (await live.storage.commsDeliveries.list(connection.connectionId, 50)).find(
        (candidate) => candidate.deliveryId === deliveryId,
      ),
    (candidate) =>
      candidate?.status === "sent" ||
      candidate?.status === "failed" ||
      candidate?.status === "manual_reconciliation_required",
    `delivery ${deliveryId} to settle`,
  );
}

function replyWith(content: string): (request: FakeOpenAiRequest) => FakeOpenAiResponse {
  return (request) => {
    if (request.method === "GET" && request.path === "/v1/models") {
      return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }] } };
    }
    if (request.method !== "POST" || request.path !== "/v1/chat/completions") {
      return { status: 404, body: { error: { message: `No fake route for ${request.method} ${request.path}` } } };
    }
    const body = asRecord(request.body);
    const model = typeof body.model === "string" ? body.model : "fake-chat";
    const usage = { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 };
    return body.stream === true
      ? {
          sseFrames: [
            JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: "stop" }], model, usage }),
            "[DONE]",
          ],
        }
      : {
          body: {
            object: "chat.completion",
            model,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage,
          },
        };
  };
}

interface FakeDiscordWebhookServer {
  webhookUrl: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  close: () => Promise<void>;
}

async function startFakeDiscordWebhookServer(): Promise<FakeDiscordWebhookServer> {
  const requests: FakeDiscordWebhookServer["requests"] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push({ method: request.method ?? "GET", path: url.pathname, body: parseJson(rawBody) });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: String(123456789012345678n + BigInt(requests.length)) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return {
    webhookUrl: `http://127.0.0.1:${address.port}/api/webhooks/discord-test-id/discord-test-token`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-own-delivery-"));
  tempRoots.push(root);
  fs.cpSync(path.join(findRepoRoot(), "config"), path.join(root, "config"), { recursive: true });
  const llmConfig = {
    activeProviderId: "fake-openai",
    activeModel: "fake-chat",
    providers: [
      {
        providerId: "fake-openai",
        label: "Fake OpenAI",
        baseUrl: providerBaseUrl,
        apiStyle: "openai-chat-completions",
        defaultModel: "fake-chat",
      },
    ],
  };
  const unifiedConfig = readJson(path.join(root, "config", "goatcitadel.example.json"));
  unifiedConfig.llm = llmConfig;
  appendLoopbackNetworkAllowlist(unifiedConfig);
  writeJson(path.join(root, "config", "goatcitadel.json"), unifiedConfig);
  writeJson(path.join(root, "config", "llm-providers.json"), llmConfig);
  const toolPolicyPath = path.join(root, "config", "tool-policy.json");
  // config/tool-policy.json is gitignored, so a fresh checkout (CI) only carries the example.
  const toolPolicy = readJson(
    fs.existsSync(toolPolicyPath) ? toolPolicyPath : path.join(root, "config", "tool-policy.example.json"),
  );
  appendLoopbackNetworkAllowlist({ toolPolicy });
  writeJson(toolPolicyPath, toolPolicy);
  const metadataPath = path.join(root, "config", "llm-model-metadata.json");
  const metadata = readJson(metadataPath) as { entries: Record<string, unknown> };
  metadata.entries["fake-openai/fake-chat"] = { contextWindow: 128_000, outputTokenLimit: 16_000 };
  writeJson(metadataPath, metadata);
  return root;
}

function appendLoopbackNetworkAllowlist(config: Record<string, unknown>): void {
  const toolPolicy = asRecord(config.toolPolicy);
  const sandbox = asRecord(toolPolicy.sandbox);
  const networkAllowlist = Array.isArray(sandbox.networkAllowlist) ? sandbox.networkAllowlist : [];
  sandbox.networkAllowlist = [...new Set([...networkAllowlist, "127.0.0.1"])];
  toolPolicy.sandbox = sandbox;
  config.toolPolicy = toolPolicy;
}

async function pollFor<T>(
  read: () => T | Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}. Last value: ${JSON.stringify(last).slice(0, 4_000)}`);
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function parseJson(rawBody: string): unknown {
  if (!rawBody.trim()) return undefined;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return rawBody;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) throw new Error("Unable to locate GoatCitadel repository root.");
    current = parent;
  }
}
