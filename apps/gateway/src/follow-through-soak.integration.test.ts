import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { Storage } from "@goatcitadel/storage";
import { buildApp } from "./app.js";
import { CronAutomationService } from "./services/gateway/cron-automation-service.js";
import { startFakeOpenAiCompatibleServer } from "./test/fake-openai-server.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("keeps one occurrence per due hour through a controlled 24-hour soak and two runtime restarts", async () => {
  // Only Date advances. Network, deadlines and assertion waits retain real clocks.
  // This is simulated elapsed time, paired with a separate real-clock delivery proof.
  vi.useFakeTimers({ toFake: ["Date"] });
  const beginning = Date.parse("2026-11-22T00:00:00.000Z");
  vi.setSystemTime(beginning);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-follow-soak-"));
  let streamedCalls = 0;
  const provider = await startFakeOpenAiCompatibleServer((request) => {
    if (request.path === "/v1/models") return { body: { data: [{ id: "gpt-4.1-mini", object: "model" }] } };
    if (request.path !== "/v1/chat/completions") return { status: 404 };
    const body = request.body as { stream?: boolean };
    if (body.stream) streamedCalls++;
    const content = "The synthetic scheduled check completed. No new action needs attention.";
    const usage = { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 };
    return body.stream
      ? {
          sseFrames: [
            JSON.stringify({
              model: "gpt-4.1-mini",
              choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }],
              usage,
            }),
            "[DONE]",
          ],
        }
      : {
          body: {
            model: "gpt-4.1-mini",
            choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
            usage,
          },
        };
  });
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let inspection: Storage | undefined;
  const observed: { owner?: CronAutomationService } = {};
  const originalList = CronAutomationService.prototype.listCronJobs;
  vi.spyOn(CronAutomationService.prototype, "listCronJobs").mockImplementation(function (
    this: CronAutomationService,
    ...args
  ) {
    observed.owner = this;
    return originalList.apply(this, args);
  });
  try {
    const examples = fileURLToPath(new URL("../../../config/", import.meta.url));
    await fs.mkdir(path.join(root, "config"));
    for (const file of [
      "assistant.config.example.json",
      "tool-policy.example.json",
      "budgets.example.json",
      "cron-jobs.example.json",
    ])
      await fs.copyFile(path.join(examples, file), path.join(root, "config", file));
    const config = JSON.parse(await fs.readFile(path.join(examples, "goatcitadel.example.json"), "utf8"));
    config.llm = {
      activeProviderId: "openai",
      activeModel: "gpt-4.1-mini",
      providers: [
        {
          providerId: "openai",
          label: "Controlled clock fixture",
          baseUrl: provider.baseUrl,
          apiStyle: "openai-chat-completions",
          apiKeyEnv: "GOATCITADEL_SOAK_KEY",
          defaultModel: "gpt-4.1-mini",
        },
      ],
    };
    config.assistant.approvalExplainer.enabled = false;
    config.assistant.features = {
      ...config.assistant.features,
      autonomyV1Disabled: false,
      durableKernelV1Enabled: true,
      scheduledChatTurnsV1Enabled: true,
      proactiveHeartbeatTurnsV1Enabled: false,
      memoryLifecycleAdminV1Enabled: false,
      backgroundSkillDraftsV1Enabled: false,
      memoryMaintenanceV1Enabled: false,
    };
    await fs.writeFile(path.join(root, "config", "goatcitadel.json"), JSON.stringify(config));
    await fs.writeFile(
      path.join(root, "config", "llm-model-metadata.json"),
      JSON.stringify({
        version: 1,
        entries: { "openai/gpt-4.1-mini": { contextWindow: 128000, outputTokenLimit: 16000 } },
      }),
    );
    const token = "follow-soak-isolated-operator-12345678901234567890";
    for (const [key, value] of Object.entries({
      NODE_ENV: "test",
      GATEWAY_HOST: "127.0.0.1",
      GOATCITADEL_ROOT_DIR: root,
      GOATCITADEL_AUTH_MODE: "token",
      GOATCITADEL_AUTH_TOKEN: token,
      GOATCITADEL_AUTH_ALLOW_LOOPBACK_BYPASS: "false",
      GOATCITADEL_DISABLE_SECRET_STORE: "true",
      GOATCITADEL_SOAK_KEY: "soak-synthetic-only",
      GOATCITADEL_EMBEDDINGS_PROVIDER: "pseudo",
      GOATCITADEL_BACKUP_DIR: path.join(root, "backups"),
      GOATCITADEL_DATABASE_DRIVER: "sqlite",
      GOATCITADEL_RATE_LIMIT_ENABLED: "false",
      GOATCITADEL_FEATURE_DURABLE_KERNEL_V1_ENABLED: "true",
      GOATCITADEL_FEATURE_AUTONOMY_V1_DISABLED: "false",
      GOATCITADEL_FEATURE_SCHEDULED_CHAT_TURNS_V1_ENABLED: "true",
    }))
      vi.stubEnv(key, value);
    let sequence = 0;
    const headers = () => ({ authorization: `Bearer ${token}`, "idempotency-key": `soak-${++sequence}` });
    app = await buildApp();
    const session = await app.inject({
      method: "POST",
      url: "/api/v1/chat/sessions",
      headers: headers(),
      payload: { title: "Controlled 24 hour follow-through" },
    });
    expect(session.statusCode, session.body).toBe(201);
    const sessionId = session.json().sessionId as string;
    const base = `/api/v1/chat/sessions/${sessionId}`;
    const create = async (purpose: string, trigger: Record<string, unknown>) => {
      const source = await app!.inject({
        method: "GET",
        url: `${base}/follow-through/setup?workspaceId=default`,
        headers: headers(),
      });
      expect(source.statusCode, source.body).toBe(200);
      const review = source.json();
      expect(review.blockedReasons).toEqual([]);
      const result = await app!.inject({
        method: "POST",
        url: `${base}/follow-through/setup`,
        headers: headers(),
        payload: {
          workspaceId: "default",
          expectedSetupHash: review.sourceHash,
          operationId: `soak-create-operation-${++sequence}`,
          purpose,
          trigger,
          permissionProfileId: review.profiles[0].profileId,
          delivery: { kind: "conversation" },
        },
      });
      expect(result.statusCode, result.body).toBe(201);
      return result.json();
    };
    const hourly = await create("Check the synthetic hourly fixture; stay quiet if nothing changed.", {
      kind: "recurring",
      schedule: "0 * * * * UTC",
    });
    const once = await create("Perform the synthetic one-shot once.", {
      kind: "once",
      at: "2026-11-22T09:30:00.000Z",
      timezone: "UTC",
    });
    const paused = await create("This paused fixture must not run.", { kind: "recurring", schedule: "0 * * * * UTC" });
    const pause = await app.inject({
      method: "POST",
      url: `${base}/follow-through/actions`,
      headers: headers(),
      payload: {
        workspaceId: "default",
        owner: { kind: "schedule", ownerId: paused.jobId },
        action: "pause",
        expectedRevision: paused.revision,
      },
    });
    expect(pause.statusCode, pause.body).toBe(200);
    const read = async (jobId: string) => {
      const response = await app!.inject({ method: "GET", url: `/api/v1/cron/jobs/${jobId}`, headers: headers() });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().job ?? response.json();
    };
    await app.inject({ method: "GET", url: "/api/v1/cron/jobs", headers: headers() });
    const jobs = await app.inject({ method: "GET", url: "/api/v1/cron/jobs", headers: headers() });
    for (const job of jobs
      .json()
      .items.filter(
        (item: { jobId: string; enabled: boolean }) => item.enabled && ![hourly.jobId, once.jobId].includes(item.jobId),
      )) {
      const disabled = await app.inject({
        method: "POST",
        url: `/api/v1/cron/jobs/${job.jobId}/pause`,
        headers: headers(),
        payload: { expectedRevision: job.revision },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
    }
    const restarts: number[] = [];
    for (let minute = 1; minute <= 24 * 60; minute++) {
      const now = new Date(beginning + minute * 60000);
      vi.setSystemTime(now);
      if (minute === 6 * 60 + 1 || minute === 18 * 60 + 1) {
        await app.close();
        app = undefined;
        observed.owner = undefined;
        app = await buildApp();
        await app.inject({ method: "GET", url: "/api/v1/cron/jobs", headers: headers() });
        restarts.push(minute);
      }
      const { owner } = observed;
      expect(owner).toBeDefined();
      await owner!.runDueTaskCronJobs(now);
      // Repeated ticks at the same instant cannot create another occurrence.
      if (minute % 60 === 0 || minute === 9 * 60 + 30) {
        await owner!.runDueTaskCronJobs(now);
        await vi.waitFor(
          async () => {
            const current = await read(minute === 9 * 60 + 30 ? once.jobId : hourly.jobId);
            expect(current.lastRunStatus).toBe("ok");
            expect(current.activeRunId).toBeUndefined();
          },
          { timeout: 15000, interval: 25 },
        );
      }
    }
    expect((await read(hourly.jobId)).executionGeneration).toBe(24);
    expect((await read(once.jobId)).executionGeneration).toBe(1);
    expect((await read(paused.jobId)).executionGeneration).toBe(0);
    const dbPath = app.gatewayConfig.dbPath;
    await app.close();
    app = undefined;
    inspection = new Storage({
      dbPath,
      transcriptsDir: path.join(root, "inspection-transcripts"),
      auditDir: path.join(root, "inspection-audit"),
    });
    const hourlyRuns = inspection.cronRuns.listByJob(hourly.jobId);
    expect(hourlyRuns).toHaveLength(24);
    expect(new Set(hourlyRuns.map((run) => run.scheduledFor)).size).toBe(24);
    expect(hourlyRuns.every((run) => run.status === "completed")).toBe(true);
    expect(inspection.cronRuns.listByJob(once.jobId)).toHaveLength(1);
    expect(inspection.cronRuns.listByJob(paused.jobId)).toHaveLength(0);
    expect(restarts).toEqual([361, 1081]);
    expect(streamedCalls).toBe(25);
  } finally {
    inspection?.close();
    await app?.close();
    await provider.close();
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 180000);
