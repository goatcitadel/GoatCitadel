import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatThreadResponse, DurableChildWatcherRecord, DurableRunRecord } from "@goatcitadel/contracts";
import { Storage } from "@goatcitadel/storage";
import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

for (const { pregrant, label } of [
  {
    pregrant: true,
    label:
      "runs fresh public automatic fanout with two real governed children and resumes the same parent for synthesis",
  },
  {
    pregrant: false,
    label: "resumes public automatic fanout through its exact approval and current durable parent authority",
  },
])
  it(
    label,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-public-auto-fanout-"));
      const north = deferred(),
        south = deferred();
      // Count primary streamed inference separately from ordinary post-commit
      // auxiliary calls, which can include the same retained child text.
      const dispatches = { parent: 0, north: 0, south: 0 };
      const observedRequests: Array<{
        stream: boolean;
        messages: Array<{ role: string; north: boolean; south: boolean }>;
      }> = [];
      let toolVisible = false,
        synthesisSawBoth = false;
      const provider = await startFakeOpenAiCompatibleServer(async (request) => {
        if (request.path === "/v1/models") return { body: { data: [{ id: "fixture-chat", object: "model" }] } };
        if (request.path !== "/v1/chat/completions") return { status: 404 };
        const body = request.body as {
          stream?: boolean;
          tools?: Array<{ function: { name: string } }>;
          messages?: Array<{ role: string; content?: unknown }>;
        };
        const lastUser = JSON.stringify(
          body.messages?.filter((message) => message.role === "user").at(-1)?.content ?? "",
        );
        observedRequests.push({
          stream: body.stream === true,
          messages: (body.messages ?? []).map((message) => ({
            role: message.role,
            north: JSON.stringify(message.content).includes("AUTO_CHILD_NORTH"),
            south: JSON.stringify(message.content).includes("AUTO_CHILD_SOUTH"),
          })),
        });
        const child = lastUser.includes("AUTO_CHILD_NORTH")
          ? "north"
          : lastUser.includes("AUTO_CHILD_SOUTH")
            ? "south"
            : undefined;
        let content = "",
          toolCalls;
        if (child) {
          if (body.stream) dispatches[child] += 1;
          await (child === "north" ? north.promise : south.promise);
          content = child === "north" ? "NORTH_RESULT_400" : "SOUTH_RESULT_600";
        } else {
          if (body.stream) dispatches.parent += 1;
          const previousTools = JSON.stringify(body.messages?.filter((message) => message.role === "tool") ?? []);
          if (previousTools.includes("NORTH_RESULT_400") && previousTools.includes("SOUTH_RESULT_600")) {
            if (body.stream) synthesisSawBoth = true;
            content = "PARENT_VERIFIED_TOTAL_1000";
          } else {
            const tool = body.tools?.find((entry) => /agent[._]fanout/u.test(entry.function.name));
            toolVisible ||= Boolean(tool);
            if (body.stream && tool && dispatches.parent === 1)
              toolCalls = [
                {
                  index: 0,
                  id: "call_public_fanout",
                  type: "function",
                  function: {
                    name: tool.function.name,
                    arguments: JSON.stringify({
                      subtasks: [
                        { label: "North", objective: "AUTO_CHILD_NORTH: reply exactly NORTH_RESULT_400" },
                        { label: "South", objective: "AUTO_CHILD_SOUTH: reply exactly SOUTH_RESULT_600" },
                      ],
                    }),
                  },
                },
              ];
            else content = "FANOUT_PROOF_MISSING_CHILD_EVIDENCE";
          }
        }
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
                  usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
                }),
                "[DONE]",
              ],
            }
          : {
              body: {
                model: "fixture-chat",
                choices: [
                  {
                    index: 0,
                    message: toolCalls
                      ? { role: "assistant", content: null, tool_calls: toolCalls }
                      : { role: "assistant", content },
                    finish_reason: toolCalls ? "tool_calls" : "stop",
                  },
                ],
                usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
              },
            };
      });
      let app: Awaited<ReturnType<typeof buildApp>> | undefined;
      let storage: Storage | undefined;
      let pendingSend: Promise<unknown> | undefined;
      let cancelOwnedTurn: (() => Promise<void>) | undefined;
      try {
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
              label: "Automatic fanout fixture",
              baseUrl: provider.baseUrl,
              apiStyle: "openai-chat-completions",
              defaultModel: "fixture-chat",
            },
          ],
        };
        config.assistant.approvalExplainer.enabled = false;
        config.toolPolicy.tools.allow.push("agent.fanout");
        await fs.writeFile(path.join(configDir, "goatcitadel.json"), JSON.stringify(config));
        const policy = JSON.parse(await fs.readFile(path.join(configDir, "tool-policy.example.json"), "utf8"));
        policy.tools.allow.push("agent.fanout");
        await fs.writeFile(path.join(configDir, "tool-policy.json"), JSON.stringify(policy));
        await fs.writeFile(
          path.join(configDir, "llm-model-metadata.json"),
          JSON.stringify({
            version: 1,
            entries: {
              "fake-openai/fixture-chat": { contextWindow: 128_000, outputTokenLimit: 16_000 },
            },
          }),
        );
        const token = "automatic-fanout-test-operator-1234567890";
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
          GOATCITADEL_FEATURE_SUBAGENT_FANOUT_V1_DISABLED: "false",
          GOATCITADEL_FEATURE_DURABLE_CHAT_FANOUT_V1_ENABLED: "true",
          GOATCITADEL_FEATURE_CHAT_AUTOMATIC_FANOUT_V1_ENABLED: "true",
        }))
          vi.stubEnv(key, value);
        let sequence = 0;
        const headers = () => ({
          authorization: `Bearer ${token}`,
          "idempotency-key": `automatic-fanout-${++sequence}`,
        });
        app = await buildApp();
        const project = await app.inject({
          method: "POST",
          url: "/api/v1/chat/projects",
          headers: headers(),
          payload: { name: "Automatic fanout project", workspaceId: "default", workspacePath: "." },
        });
        expect(project.statusCode, project.body).toBe(201);
        const projectId = project.json().projectId as string;
        const session = await app.inject({
          method: "POST",
          url: "/api/v1/chat/sessions",
          headers: headers(),
          payload: { title: "Automatic fanout parent", workspaceId: "default", projectId },
        });
        expect(session.statusCode, session.body).toBe(201);
        const sessionId = session.json().sessionId as string;
        const grant = await app.inject({
          method: "POST",
          url: "/api/v1/capabilities/autonomy-grants",
          headers: headers(),
          payload: {
            workspaceId: "default",
            projectId,
            surfaces: ["chat"],
            maxRiskLevel: "caution",
            capabilityPatterns: ["agent.fanout"],
            toolPatterns: ["agent.fanout"],
            activationKinds: ["subagent_fanout"],
            maxActivations: 3,
            budgetUsd: 0.75,
            grantor: "ignored-client-grantor",
            reason: "Controlled exact-project two-child proof",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          },
        });
        expect(grant.statusCode, grant.body).toBe(201);
        expect(grant.json().grantor).not.toBe("ignored-client-grantor");
        // Activation authority and tool permission are independent owners. Grant
        // this exact Chat tool explicitly; do not switch policy into bypass mode.
        if (pregrant) {
          const toolGrant = await app.inject({
            method: "POST",
            url: "/api/v1/tools/grants",
            headers: headers(),
            payload: {
              toolPattern: "agent.fanout",
              decision: "allow",
              scope: "session",
              scopeRef: sessionId,
              grantType: "ttl",
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
              constraints: { maxCallsPerHour: 3 },
            },
          });
          expect(toolGrant.statusCode, toolGrant.body).toBe(201);
        }
        const content =
          "Use agent.fanout once to compare two independently delegated short numeric findings. Wait for both children, verify their outputs, then provide the combined total.";
        const input = {
          content,
          providerId: "fake-openai",
          model: "fixture-chat",
          subagentPolicy: "auto_when_useful",
          webMode: "off",
          memoryMode: "off",
          useMemory: false,
        };
        const preflight = await app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${sessionId}/route-preflight`,
          headers: headers(),
          payload: { action: "send", ...input },
        });
        expect(preflight.statusCode, preflight.body).toBe(200);
        const sent = app.inject({
          method: "POST",
          url: `/api/v1/chat/sessions/${sessionId}/agent-send/stream`,
          headers: headers(),
          payload: { ...input, routeDecision: preflight.json().decision },
        });
        pendingSend = Promise.resolve(sent);
        void sent.catch(() => undefined);
        const readThread = async () => {
          const response = await app!.inject({
            method: "GET",
            url: `/api/v1/chat/sessions/${sessionId}/thread`,
            headers: headers(),
          });
          expect(response.statusCode, response.body).toBe(200);
          return response.json() as ChatThreadResponse;
        };
        cancelOwnedTurn = async () => {
          const active = (await readThread()).turns.at(-1);
          if (active && !["completed", "failed", "cancelled"].includes(active.trace.status)) {
            const cancelled = await app!.inject({
              method: "POST",
              url: `/api/v1/chat/sessions/${sessionId}/turns/${active.turnId}/cancel`,
              headers: headers(),
              payload: {},
            });
            expect(cancelled.statusCode, cancelled.body).toBe(200);
          }
        };
        let parent: ChatThreadResponse["turns"][number] | undefined;
        let watchers: DurableChildWatcherRecord[] = [];
        const readRun = async (runId: string) => {
          const response = await app!.inject({
            method: "GET",
            url: `/api/v1/durable/runs/${runId}`,
            headers: headers(),
          });
          expect(response.statusCode, response.body).toBe(200);
          return response.json() as DurableRunRecord;
        };
        let approvalId: string | undefined;
        if (!pregrant) {
          await vi.waitFor(
            async () => {
              parent = (await readThread()).turns.at(-1);
              approvalId = parent?.toolRuns.find((tool) => tool.toolName === "agent.fanout")?.approvalId;
              expect(parent?.trace.status, JSON.stringify(parent?.trace)).toBe("waiting_for_approval");
              expect(approvalId).toBeTruthy();
            },
            { timeout: 60_000, interval: 100 },
          );
          expect(dispatches).toMatchObject({ north: 0, south: 0 });
          const replay = await app.inject({
            method: "GET",
            url: `/api/v1/approvals/${approvalId}/replay`,
            headers: headers(),
          });
          expect(replay.statusCode, replay.body).toBe(200);
          expect(replay.json().approval).toMatchObject({
            status: "pending",
            linkage: { sessionId, turnId: parent!.turnId, runId: parent!.trace.durable!.runId },
          });
          const decision = await app.inject({
            method: "POST",
            url: `/api/v1/approvals/${approvalId}/resolve`,
            headers: headers(),
            payload: { decision: "approve" },
          });
          expect(decision.statusCode, decision.body).toBe(200);
        }
        try {
          await vi.waitFor(
            async () => {
              parent = (await readThread()).turns.at(-1);
              if (!parent?.trace.durable?.runId)
                throw new Error(`Parent durable identity is unavailable: ${JSON.stringify(parent?.trace)}`);
              const response = await app!.inject({
                method: "GET",
                url: `/api/v1/durable/runs/${parent!.trace.durable!.runId}/child-watchers`,
                headers: headers(),
              });
              expect(response.statusCode, response.body).toBe(200);
              watchers = response.json<{ items: DurableChildWatcherRecord[] }>().items;
              if (["completed", "failed", "cancelled"].includes(parent.trace.status))
                throw new Error(JSON.stringify(parent.trace));
              expect(watchers, JSON.stringify({ trace: parent?.trace, dispatches })).toHaveLength(2);
              expect(
                dispatches.north + dispatches.south,
                JSON.stringify({ watchers, dispatches, observedRequests }),
              ).toBeGreaterThan(0);
            },
            { timeout: 60_000, interval: 150 },
          );
        } catch (error) {
          const runs = await Promise.all(
            [parent?.trace.durable?.runId, ...watchers.map((watcher) => watcher.childRunId)]
              .filter((runId): runId is string => Boolean(runId))
              .map(async (runId) => {
                const run = await readRun(runId);
                return {
                  runId,
                  status: run.status,
                  attemptCount: run.attemptCount,
                  lastError: run.lastError?.slice(0, 500),
                };
              }),
          );
          const response = await app!.inject({ method: "GET", url: "/api/v1/durable/diagnostics", headers: headers() });
          const diagnostics = response.json() as {
            queuedCount?: number;
            runningCount?: number;
            waitingCount?: number;
            eventLoopLag?: unknown;
          };
          throw new Error(
            JSON.stringify({
              runs,
              queuedCount: diagnostics.queuedCount,
              runningCount: diagnostics.runningCount,
              waitingCount: diagnostics.waitingCount,
              eventLoopLag: diagnostics.eventLoopLag,
              dispatches,
              observedRequests,
            }),
            { cause: error },
          );
        }
        expect(toolVisible).toBe(true);
        expect(new Set(watchers.map((watcher) => watcher.childRunId)).size).toBe(2);
        const parentRunId = parent!.trace.durable!.runId,
          parentTurnId = parent!.turnId;
        await vi.waitFor(
          async () => {
            expect((await readRun(parentRunId)).status).toBe("waiting");
          },
          { timeout: 30_000, interval: 100 },
        );
        const parentCallsWhileWaiting = dispatches.parent;
        // The provider owner may serialize children; parked-parent correctness must
        // not depend on the endpoint's concurrency setting.
        const firstChild = dispatches.north > 0 ? north : south;
        const secondChild = firstChild === north ? south : north;
        firstChild.resolve();
        await vi.waitFor(
          async () => {
            const children = await Promise.all(watchers.map((watcher) => readRun(watcher.childRunId)));
            expect(children.filter((child) => child.status === "completed")).toHaveLength(1);
          },
          { timeout: 30_000, interval: 100 },
        );
        expect((await readRun(parentRunId)).status).toBe("waiting");
        expect(dispatches.parent).toBe(parentCallsWhileWaiting);
        await vi.waitFor(
          () => {
            expect(dispatches).toMatchObject({ north: 1, south: 1 });
          },
          { timeout: 30_000, interval: 100 },
        );
        secondChild.resolve();
        await vi.waitFor(
          async () => {
            parent = (await readThread()).turns.find((turn) => turn.turnId === parentTurnId);
            expect(parent?.trace.status, JSON.stringify(parent?.trace)).toBe("completed");
            expect(parent?.assistantMessage?.content).toContain("PARENT_VERIFIED_TOTAL_1000");
            expect((await readRun(parentRunId)).status).toBe("completed");
          },
          { timeout: 60_000, interval: 150 },
        );
        const response = await sent;
        expect(response.statusCode, response.body).toBe(200);
        expect(synthesisSawBoth).toBe(true);
        expect(dispatches).toMatchObject({ north: 1, south: 1 });
        const fanoutTool = parent!.toolRuns.find((tool) => tool.toolName === "agent.fanout");
        expect(fanoutTool?.status).toBe("executed");
        if (approvalId) {
          const approval = await app.inject({
            method: "GET",
            url: `/api/v1/approvals/${approvalId}`,
            headers: headers(),
          });
          expect(approval.statusCode, approval.body).toBe(200);
          expect(approval.json().status).toBe("approved");
        }
        const dbPath = app.gatewayConfig.dbPath;
        await app.close();
        app = undefined;
        storage = new Storage({
          dbPath,
          transcriptsDir: path.join(root, "inspection-transcripts"),
          auditDir: path.join(root, "inspection-audit"),
        });
        const invocation = storage.chatFanoutInvocations.findByParentAndTool(parentRunId, fanoutTool!.toolRunId);
        expect(invocation).toMatchObject({
          status: "completed",
          childCount: 2,
          reservedActivations: 2,
          projectId,
          grantId: grant.json().grantId,
          parentAdmission: expect.objectContaining({ featureReferenceSha256: expect.any(String) }),
        });
        expect(invocation?.capabilityProfileHash).toBeUndefined();
        expect(storage.chatTurnCapabilityProfiles.findByTurn(parentTurnId)).toBeUndefined();
        const children = watchers.map((watcher) => storage!.durableRuns.getRun(watcher.childRunId));
        expect(
          children.every((child) => child.status === "completed" && child.payload.capabilityProfileId === undefined),
        ).toBe(true);
        expect(new Set(children.map((child) => child.payload.admissionId)).size).toBe(2);
        expect(storage.chatDelegationSteps.listByRun(invocation!.delegationRunId!)).toHaveLength(2);
      } finally {
        north.resolve();
        south.resolve();
        if (app) await cancelOwnedTurn?.();
        await pendingSend?.catch(() => undefined);
        storage?.close();
        await app?.close();
        await provider.close();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
