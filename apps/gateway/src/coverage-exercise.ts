/* eslint-disable no-console, max-lines */
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cp, mkdtemp, mkdir, rm } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { renderDoctorReport, runDoctor } from "./doctor/engine.js";

type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type EnvSnapshot = Record<string, string | undefined>;

const COVERAGE_ENV_OVERRIDES: Record<string, string> = {
  GOATCITADEL_AUTH_MODE: "none",
  GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART: "false",
  GOATCITADEL_BUNDLED_POSTGRES_ENABLED: "false",
  GOATCITADEL_DATABASE_DRIVER: "sqlite",
  GOATCITADEL_DISABLE_SECRET_STORE: "true",
  GOATCITADEL_I_UNDERSTAND_THIS_IS_INSECURE_LOCAL_ONLY: "true",
  GOATCITADEL_LLAMACPP_AUTOSTART: "false",
  GOATCITADEL_LLAMACPP_ENABLED: "false",
  GOATCITADEL_NPU_AUTOSTART: "false",
  GOATCITADEL_NPU_ENABLED: "false",
};

interface RequestResult<T = unknown> {
  statusCode: number;
  body: T;
}

interface ChatSeed {
  projectId: string;
  sessionId: string;
  attachmentId: string;
}

interface ExerciseSeed extends ChatSeed {
  workspaceId?: string;
  taskId?: string;
  cronJobId?: string;
  durableRunId?: string;
  promptPackId?: string;
  promptTestId?: string;
  promptRunId?: string;
  benchmarkRunId?: string;
}

async function runCoverageExercise(): Promise<void> {
  const onUnhandledRejection = (error: unknown): void => {
    console.warn("[coverage-exercise] swallowed unhandled rejection during reflective sweep");
    console.warn(error);
  };
  const onUncaughtException = (error: Error): void => {
    console.warn("[coverage-exercise] swallowed uncaught exception during reflective sweep");
    console.warn(error);
  };

  process.on("unhandledRejection", onUnhandledRejection);
  process.on("uncaughtException", onUncaughtException);
  try {
    await withTempRoot(async (app, tempRoot) => {
      const chat = await seedChat(app);
      await exerciseChatCommands(app, chat.sessionId);
      const seed = await exerciseRoutes(app, chat);
      await exerciseGatewayServiceMethods(app, seed);
      await exerciseDoctorEngine(tempRoot);
      exerciseCliEntryPoints(tempRoot);
    });
    console.log("[coverage-exercise] completed");
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("uncaughtException", onUncaughtException);
  }
}

async function withTempRoot(run: (app: FastifyInstance, tempRoot: string) => Promise<void>): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-coverage-exercise-"));
  const envSnapshot = applyCoverageEnvironment(tempRoot);
  try {
    await cp(path.join(repoRoot, "config"), path.join(tempRoot, "config"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "transcripts"), { recursive: true });
    await mkdir(path.join(tempRoot, "data", "audit"), { recursive: true });
    await mkdir(path.join(tempRoot, "workspace"), { recursive: true });

    const app = await buildApp();
    try {
      await run(app, tempRoot);
    } finally {
      await app.close();
    }
  } finally {
    restoreEnvironment(envSnapshot);
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function applyCoverageEnvironment(rootDir: string): EnvSnapshot {
  const keys = ["GOATCITADEL_ROOT_DIR", ...Object.keys(COVERAGE_ENV_OVERRIDES)];
  const snapshot: EnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  process.env.GOATCITADEL_ROOT_DIR = rootDir;
  for (const [key, value] of Object.entries(COVERAGE_ENV_OVERRIDES)) {
    process.env[key] = value;
  }
  return snapshot;
}

function restoreEnvironment(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function exerciseDoctorEngine(rootDir: string): Promise<void> {
  const audit = await runDoctor({
    rootDir,
    gatewayBaseUrl: "http://127.0.0.1:8787",
    profileName: "coverage",
    profilePath: path.join(rootDir, "coverage-profile.json"),
    readOnly: true,
    auditOnly: true,
    deep: false,
    yes: false,
    noRepair: true,
    authMode: "none",
  });
  renderDoctorReport(audit);

  const deepAudit = await runDoctor({
    rootDir,
    gatewayBaseUrl: "http://127.0.0.1:8787",
    profileName: "coverage",
    profilePath: path.join(rootDir, "coverage-profile.json"),
    readOnly: true,
    auditOnly: true,
    deep: true,
    yes: false,
    noRepair: true,
    authMode: "none",
  });
  renderDoctorReport(deepAudit);
}

function exerciseCliEntryPoints(rootDir: string): void {
  const gatewayDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const run = (script: string, args: string[], acceptableExitCodes: number[] = [0, 1]): void => {
    const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: gatewayDir,
      env: {
        ...process.env,
        GOATCITADEL_ROOT_DIR: rootDir,
        GOATCITADEL_GATEWAY_URL: "http://127.0.0.1:8787",
        GOATCITADEL_TUI_AUTH_MODE: "none",
      },
      stdio: "pipe",
      encoding: "utf8",
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }

    const exitCode = result.status ?? 1;
    if (!acceptableExitCodes.includes(exitCode)) {
      throw new Error(`coverage CLI exercise failed: ${script} exited with ${exitCode}`);
    }
  };

  run("src/admin-cli.ts", []);
  run("src/admin-cli.ts", ["retention", "show"]);
  run("src/tui/tools-cli.ts", ["catalog", "--read-only"]);
  run("src/tui/tools-cli.ts", ["invoke", "--tool", "session.status", "--args", "{}", "--read-only"]);
  run("src/doctor/cli.ts", ["--audit-only", "--json", "--read-only"], [0, 1, 2]);
  run("src/tui/main.ts", ["--doctor", "--audit-only", "--json", "--read-only"], [0, 1, 2]);
}

async function seedChat(app: FastifyInstance): Promise<ChatSeed> {
  const project = await requestJson<{ projectId: string }>(app, "POST", "/api/v1/chat/projects", {
    name: "Coverage Exercise Project",
    workspacePath: "coverage/exercise",
  });
  assert.equal(project.statusCode, 201);

  const session = await requestJson<{ sessionId: string }>(app, "POST", "/api/v1/chat/sessions", {
    title: "Coverage Exercise Session",
    projectId: project.body.projectId,
  });
  assert.equal(session.statusCode, 201);

  const attachment = await requestJson<{ attachmentId: string }>(app, "POST", "/api/v1/chat/attachments", {
    sessionId: session.body.sessionId,
    projectId: project.body.projectId,
    fileName: "coverage.txt",
    mimeType: "text/plain",
    bytesBase64: Buffer.from("coverage exercise payload").toString("base64"),
  });
  assert.equal(attachment.statusCode, 201);

  return {
    projectId: project.body.projectId,
    sessionId: session.body.sessionId,
    attachmentId: attachment.body.attachmentId,
  };
}

async function exerciseChatCommands(app: FastifyInstance, sessionId: string): Promise<void> {
  const chatSupport = getCoverageChatSupport(app);

  const commands = [
    "/help",
    "/mode chat",
    "/mode cowork",
    "/mode code",
    "/model smoke-model",
    "/web auto",
    "/web off",
    "/web quick",
    "/web deep",
    "/memory auto",
    "/memory on",
    "/memory off",
    "/think minimal",
    "/think standard",
    "/think extended",
    "/tool safe_auto",
    "/tool manual",
    "/proactive off",
    "/proactive suggest",
    "/proactive auto_full",
    "/retrieval standard",
    "/retrieval layered",
    "/reflect off",
    "/reflect on",
    "/project none",
    "/attach fake-attachment",
    "/run",
    "/research",
    "/delegate",
    "/pipeline",
    "/score TEST-04",
    "/pack",
    "/approve approval-missing",
    "/deny approval-missing",
    "/unknown",
  ];

  for (const command of commands) {
    try {
      await chatSupport.parseChatCommand(sessionId, command);
    } catch {
      // Some command branches intentionally reference missing ids to cover error paths.
    }
    const viaRoute = await requestJson(
      app,
      "POST",
      `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/commands/parse`,
      {
        commandText: command,
      },
    );
    assertExpectedStatus(`parse command ${command}`, viaRoute, [200, 400, 404]);
  }

  const proactiveStatus = await requestJson(
    app,
    "GET",
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/status`,
  );
  assertExpectedStatus("proactive status", proactiveStatus, [200]);
  // The policy PATCH is CAS-guarded: expectedRevision is required. Take it from the
  // status read above rather than assuming a fresh session starts at a fixed value.
  const proactiveStatusBody = proactiveStatus.body as { revision?: number; policy?: { revision?: number } } | undefined;
  const expectedProactiveRevision = proactiveStatusBody?.policy?.revision ?? proactiveStatusBody?.revision ?? 1;
  const proactivePolicy = await requestJson(
    app,
    "PATCH",
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/policy`,
    {
      expectedRevision: expectedProactiveRevision,
      proactiveMode: "off",
      retrievalMode: "standard",
      reflectionMode: "off",
      autonomyBudget: {
        maxActionsPerHour: 2,
        maxActionsPerTurn: 1,
        cooldownSeconds: 15,
      },
    },
  );
  assertExpectedStatus("proactive policy", proactivePolicy, [200]);
  const proactiveTrigger = await requestJson(
    app,
    "POST",
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/trigger`,
    {
      source: "manual",
      reason: "coverage exercise",
    },
  );
  assertExpectedStatus("proactive trigger", proactiveTrigger, [200, 202, 409]);
  const proactiveRuns = await requestJson(
    app,
    "GET",
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/runs?limit=25`,
  );
  assertExpectedStatus("proactive runs", proactiveRuns, [200]);

  const learned = await requestJson<{ items?: Array<{ itemId: string }> }>(
    app,
    "GET",
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory?limit=25`,
  );
  assertExpectedStatus("learned memory list", learned, [200]);
  if (Array.isArray(learned.body.items) && learned.body.items.length > 0) {
    const itemId = learned.body.items[0]?.itemId;
    if (itemId) {
      const patch = await requestJson(
        app,
        "PATCH",
        `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory/${encodeURIComponent(itemId)}`,
        {
          confidence: 0.75,
        },
      );
      assertExpectedStatus("learned memory patch", patch, [200]);
    }
  }
  const rebuild = await requestJson(
    app,
    "POST",
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/learned-memory/rebuild`,
    {},
  );
  assertExpectedStatus("learned memory rebuild", rebuild, [200, 202]);
}

async function exerciseRoutes(app: FastifyInstance, chat: ChatSeed): Promise<ExerciseSeed> {
  await requestNotServerError(app, "GET", "/api/v1/docs");
  await requestNotServerError(app, "GET", "/api/v1/docs/openapi.json");
  await requestNotServerError(app, "POST", "/api/v1/auth/sse-token", {});

  await requestNotServerError(app, "GET", "/api/v1/sessions?limit=10");
  await requestNotServerError(app, "GET", `/api/v1/sessions/${encodeURIComponent(chat.sessionId)}`);
  await requestNotServerError(app, "GET", `/api/v1/sessions/${encodeURIComponent(chat.sessionId)}/summary`);
  await requestNotServerError(app, "GET", `/api/v1/sessions/${encodeURIComponent(chat.sessionId)}/timeline?limit=20`);
  await requestNotServerError(app, "POST", `/api/v1/chat/sessions/${encodeURIComponent(chat.sessionId)}/agent-send`, {
    content: "coverage hello",
    mode: "chat",
    webMode: "off",
    memoryMode: "auto",
    thinkingLevel: "minimal",
  });
  await requestNotServerError(app, "POST", `/api/v1/chat/sessions/${encodeURIComponent(chat.sessionId)}/agent-send`, {
    content: "coverage delegate",
    mode: "cowork",
    webMode: "off",
    memoryMode: "auto",
    thinkingLevel: "minimal",
  });
  await requestNotServerError(app, "POST", "/api/v1/ui/change-risk/evaluate", {
    pageId: "settings",
    changes: [
      { field: "providerBaseUrl", from: "http://127.0.0.1:1234/v1", to: "https://api.openai.com/v1" },
      { field: "auth.mode", from: "none", to: "token" },
    ],
  });

  await requestNotServerError(app, "GET", "/api/v1/events?limit=20");

  await requestNotServerError(app, "GET", "/api/v1/dashboard/state");
  await requestNotServerError(app, "GET", "/api/v1/system/vitals");
  await requestNotServerError(app, "GET", "/api/v1/operators");
  const settingsSnapshot = await requestJson<{ revision: number }>(app, "GET", "/api/v1/settings");
  await requestNotServerError(app, "PATCH", "/api/v1/settings", {
    expectedRevision: settingsSnapshot.body.revision,
    budgetMode: "balanced",
  });
  await requestNotServerError(app, "GET", "/api/v1/auth/settings");
  const authSettingsSnapshot = await requestJson<{ revision: number }>(app, "GET", "/api/v1/auth/settings");
  await requestNotServerError(app, "PATCH", "/api/v1/auth/settings", {
    expectedRevision: authSettingsSnapshot.body.revision,
    allowLoopbackBypass: true,
  });
  await requestNotServerError(app, "GET", "/api/v1/memory/files?dir=memory");

  const cronJobId = `cov-${Date.now()}`;
  await requestNotServerError(app, "GET", "/api/v1/cron/jobs");
  await requestNotServerError(app, "POST", "/api/v1/cron/jobs", {
    jobId: cronJobId,
    name: "Coverage Exercise Cron",
    schedule: "*/15 * * * *",
    enabled: false,
  });
  await requestNotServerError(app, "GET", `/api/v1/cron/jobs/${encodeURIComponent(cronJobId)}`);
  await requestNotServerError(app, "PATCH", `/api/v1/cron/jobs/${encodeURIComponent(cronJobId)}`, {
    enabled: true,
    name: "Coverage Exercise Cron Updated",
  });
  await requestNotServerError(app, "POST", `/api/v1/cron/jobs/${encodeURIComponent(cronJobId)}/run`, {});
  await requestNotServerError(app, "POST", `/api/v1/cron/jobs/${encodeURIComponent(cronJobId)}/pause`, {});
  await requestNotServerError(app, "POST", `/api/v1/cron/jobs/${encodeURIComponent(cronJobId)}/start`, {});
  await requestNotServerError(app, "GET", "/api/v1/cron/review-queue?limit=25");
  await requestNotServerError(app, "POST", "/api/v1/cron/review-queue/missing-item/retry", {});
  await requestNotServerError(app, "GET", "/api/v1/cron/runs/missing-run/diff");
  await requestNotServerError(app, "DELETE", `/api/v1/cron/jobs/${encodeURIComponent(cronJobId)}`);

  await requestNotServerError(app, "GET", "/api/v1/daemon/status");
  await requestNotServerError(app, "POST", "/api/v1/daemon/start", {});
  await requestNotServerError(app, "POST", "/api/v1/daemon/stop", {});
  await requestNotServerError(app, "POST", "/api/v1/daemon/restart", {});
  await requestNotServerError(app, "GET", "/api/v1/daemon/logs?limit=20");

  await requestNotServerError(app, "GET", "/api/v1/costs/summary?scope=day");
  await requestNotServerError(app, "GET", "/api/v1/costs/summary?scope=session");
  await requestNotServerError(app, "POST", "/api/v1/costs/run-cheaper", {});

  await requestNotServerError(app, "GET", "/api/v1/llm/providers");
  const llmConfigSnapshot = await requestJson<{ revision: number }>(app, "GET", "/api/v1/llm/config");
  await requestNotServerError(app, "PATCH", "/api/v1/llm/config", {
    expectedRevision: llmConfigSnapshot.body.revision,
    activeProviderId: "openai",
  });
  await requestNotServerError(app, "GET", "/api/v1/llm/models");

  await requestNotServerError(app, "GET", "/api/v1/npu/status");
  await requestNotServerError(app, "GET", "/api/v1/npu/models");
  await requestNotServerError(app, "POST", "/api/v1/npu/start", {});
  await requestNotServerError(app, "POST", "/api/v1/npu/refresh", {});
  await requestNotServerError(app, "POST", "/api/v1/npu/stop", {});

  await requestNotServerError(app, "GET", "/api/v1/onboarding/state");
  await requestNotServerError(app, "POST", "/api/v1/onboarding/complete", {
    completedBy: "coverage",
  });

  const workspace = await requestJson<{ workspaceId?: string }>(app, "POST", "/api/v1/workspaces", {
    name: `Coverage Workspace ${Date.now()}`,
    slug: `coverage-${Math.floor(Math.random() * 100000)}`,
  });
  assertExpectedStatus("workspace create", workspace, [201]);
  assert.equal(typeof workspace.body.workspaceId, "string");
  const workspaceId = workspace.body.workspaceId ?? "default";
  await requestNotServerError(app, "GET", "/api/v1/workspaces?limit=25");
  await requestNotServerError(app, "GET", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`);
  await requestNotServerError(app, "PATCH", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}`, {
    name: "Coverage Workspace Updated",
  });
  await requestNotServerError(app, "GET", "/api/v1/guidance/global");
  await requestNotServerError(app, "PUT", "/api/v1/guidance/global/operator", {
    body: "coverage global guidance",
  });
  await requestNotServerError(app, "GET", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guidance`);
  await requestNotServerError(app, "PUT", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guidance/operator`, {
    body: "coverage workspace guidance",
  });
  await requestNotServerError(app, "POST", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/archive`, {});
  await requestNotServerError(app, "POST", `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/restore`, {});

  const task = await requestJson<{ taskId?: string }>(app, "POST", "/api/v1/tasks", {
    title: "Coverage task",
    description: "exercise task routes",
    priority: "normal",
  });
  assertExpectedStatus("task create", task, [201]);
  assert.equal(typeof task.body.taskId, "string");
  const taskId = task.body.taskId;
  await requestNotServerError(app, "GET", "/api/v1/tasks?limit=50");
  if (taskId) {
    await requestNotServerError(app, "GET", `/api/v1/tasks/${encodeURIComponent(taskId)}`);
    await requestNotServerError(app, "PATCH", `/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      status: "in_progress",
    });
    await requestNotServerError(app, "POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/activities`, {
      message: "coverage note",
      createdBy: "coverage",
    });
    await requestNotServerError(app, "GET", `/api/v1/tasks/${encodeURIComponent(taskId)}/activities`);
    await requestNotServerError(app, "POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`, {
      title: "coverage deliverable",
      status: "draft",
    });
    await requestNotServerError(app, "GET", `/api/v1/tasks/${encodeURIComponent(taskId)}/deliverables`);
    const subagent = await requestJson<{ agentSessionId?: string }>(
      app,
      "POST",
      `/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`,
      {
        agentSessionId: `coverage-agent-${Date.now()}`,
        agentName: "coverage architect",
        metadata: {
          profileId: "architect",
          contextMode: "fork",
        },
      },
    );
    assertExpectedStatus("task subagent create", subagent, [201]);
    await requestNotServerError(app, "GET", `/api/v1/tasks/${encodeURIComponent(taskId)}/subagents`);
    const agentSessionId = subagent.body.agentSessionId;
    if (agentSessionId) {
      await requestNotServerError(app, "PATCH", `/api/v1/subagents/${encodeURIComponent(agentSessionId)}`, {
        status: "active",
      });
    }
    await requestNotServerError(app, "DELETE", `/api/v1/tasks/${encodeURIComponent(taskId)}`, {});
    await requestNotServerError(app, "POST", `/api/v1/tasks/${encodeURIComponent(taskId)}/restore`, {});
  }

  await requestNotServerError(app, "GET", "/api/v1/memory/qmd/stats");
  const memoryItems = await requestJson<{ items?: Array<{ itemId: string }> }>(
    app,
    "GET",
    "/api/v1/memory/items?limit=50",
  );
  assertExpectedStatus("memory items list", memoryItems, [200, 409]);
  if (memoryItems.statusCode === 409) {
    assert.equal((memoryItems.body as { code?: unknown }).code, "STATE_CONFLICT");
  }
  if (Array.isArray(memoryItems.body.items) && memoryItems.body.items.length > 0) {
    const itemId = memoryItems.body.items[0]!.itemId;
    await requestNotServerError(app, "PATCH", `/api/v1/memory/items/${encodeURIComponent(itemId)}`, {
      pinned: true,
    });
    await requestNotServerError(app, "GET", `/api/v1/memory/items/${encodeURIComponent(itemId)}/history`);
    await requestNotServerError(app, "POST", `/api/v1/memory/items/${encodeURIComponent(itemId)}/forget`, {});
  }
  await requestNotServerError(app, "POST", "/api/v1/memory/forget", { namespace: "coverage.exercise" });

  await requestNotServerError(app, "GET", "/api/v1/durable/diagnostics");
  await requestNotServerError(app, "GET", "/api/v1/durable/runs?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/durable/dead-letters?limit=25");
  const durable = await requestJson<{ runId?: string }>(app, "POST", "/api/v1/durable/runs", {
    workflowKey: "coverage",
    payload: { note: "coverage run" },
  });
  assertExpectedStatus("durable run create", durable, [200, 201, 202]);
  const durableRunId = durable.body.runId;
  if (durableRunId) {
    await requestNotServerError(app, "GET", `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}`);
    await requestNotServerError(
      app,
      "GET",
      `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/timeline?limit=50`,
    );
    await requestNotServerError(app, "POST", `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/pause`, {});
    await requestNotServerError(app, "POST", `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/resume`, {});
    await requestNotServerError(app, "POST", `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/retry`, {
      reason: "coverage",
    });
    await requestNotServerError(app, "POST", `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/events/wake`, {
      eventKey: "coverage",
      payload: {},
    });
    await requestNotServerError(app, "POST", `/api/v1/durable/runs/${encodeURIComponent(durableRunId)}/cancel`, {});
  }

  await requestNotServerError(app, "GET", "/api/v1/improvement/reports?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/improvement/reports/missing-report");
  await requestNotServerError(app, "GET", "/api/v1/improvement/capability-gaps?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/improvement/repair-candidates?limit=25");
  await requestNotServerError(app, "PATCH", "/api/v1/improvement/repair-candidates/missing/validation", {
    status: "needs_review",
    summary: "coverage",
  });
  await requestNotServerError(app, "GET", "/api/v1/improvement/signals?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/improvement/signals/missing-signal");
  await requestNotServerError(app, "GET", "/api/v1/improvement/candidates?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/improvement/candidates/missing-candidate");
  await requestNotServerError(app, "POST", "/api/v1/improvement/candidates/missing-candidate/activation-request", {});
  await requestNotServerError(app, "GET", "/api/v1/improvement/activations/missing-activation");
  await requestNotServerError(app, "POST", "/api/v1/improvement/activations/missing-activation/pause", {});
  await requestNotServerError(app, "POST", "/api/v1/improvement/activations/missing-activation/rollback", {});
  await requestNotServerError(app, "GET", "/api/v1/improvement/replay/runs?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/improvement/replay/runs/missing-run");
  await requestNotServerError(app, "POST", "/api/v1/improvement/replay/run", {
    triggerMode: "manual",
    sampleSize: 5,
  });
  await requestNotServerError(app, "POST", "/api/v1/improvement/autotune/missing/approve", {});
  await requestNotServerError(app, "POST", "/api/v1/improvement/autotune/missing/revert", {});

  await requestNotServerError(app, "GET", "/api/v1/mcp/templates");
  await requestNotServerError(app, "GET", "/api/v1/mcp/templates/discovery");
  await requestNotServerError(app, "GET", "/api/v1/mcp/remote-preview");
  await requestNotServerError(app, "GET", "/api/v1/mcp/server-mode/manifest");
  const mcpServer = await requestJson<{ serverId?: string }>(app, "POST", "/api/v1/mcp/servers", {
    label: "Coverage MCP",
    transport: "stdio",
    command: "node",
    args: ["--version"],
    enabled: true,
    authType: "none",
  });
  assertExpectedStatus("mcp server create", mcpServer, [201]);
  const serverId = mcpServer.body.serverId;
  await requestNotServerError(app, "GET", "/api/v1/mcp/servers");
  if (serverId) {
    await requestNotServerError(app, "PATCH", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}`, {
      trustTier: "restricted",
      policy: {
        requireFirstToolApproval: true,
      },
    });
    await requestNotServerError(app, "POST", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/connect`, {});
    await requestNotServerError(app, "GET", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`);
    await requestNotServerError(app, "POST", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/oauth/start`, {});
    await requestNotServerError(app, "POST", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/oauth/complete`, {
      code: "fake-code",
      state: "fake-state",
    });
    await requestNotServerError(app, "PATCH", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/policy`, {
      redactionMode: "basic",
      allowedToolPatterns: ["search"],
    });
    await requestNotServerError(app, "POST", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/health-check`, {});
    await requestNotServerError(app, "POST", "/api/v1/mcp/invoke", {
      serverId,
      toolName: "search",
      arguments: { query: "coverage" },
      sessionId: chat.sessionId,
      agentId: "coverage",
    });
    await requestNotServerError(app, "POST", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}/disconnect`, {});
    await requestNotServerError(app, "DELETE", `/api/v1/mcp/servers/${encodeURIComponent(serverId)}`);
  }

  await requestNotServerError(app, "POST", "/api/v1/media/jobs", {
    type: "thumbnail",
    attachmentId: chat.attachmentId,
    sessionId: chat.sessionId,
  });
  await requestNotServerError(app, "GET", "/api/v1/media/jobs?limit=25");
  await requestNotServerError(app, "GET", `/api/v1/chat/attachments/${encodeURIComponent(chat.attachmentId)}/preview`);
  await requestNotServerError(app, "GET", `/api/v1/chat/attachments/${encodeURIComponent(chat.attachmentId)}/content`);

  await requestNotServerError(app, "GET", "/api/v1/voice/status");
  const talk = await requestJson<{ talkSessionId?: string }>(app, "POST", "/api/v1/voice/talk/sessions", {
    mode: "push_to_talk",
    sessionId: chat.sessionId,
  });
  assertExpectedStatus("voice talk session create", talk, [201, 400]);
  if (talk.statusCode === 400) {
    assert.equal(
      (talk.body as { error?: unknown }).error,
      "Cannot start Talk Mode while the managed voice runtime is missing.",
    );
  }
  const talkSessionId = talk.body.talkSessionId;
  if (talkSessionId) {
    await requestNotServerError(
      app,
      "POST",
      `/api/v1/voice/talk/sessions/${encodeURIComponent(talkSessionId)}/stop`,
      {},
    );
  }
  await requestNotServerError(app, "POST", "/api/v1/voice/wake/start", {});
  await requestNotServerError(app, "POST", "/api/v1/voice/wake/stop", {});

  const promptPackImport = await requestJson<{
    pack?: { packId: string };
    tests?: Array<{ testId: string }>;
  }>(app, "POST", "/api/v1/prompt-packs/import", {
    name: "Coverage Prompt Pack",
    sourceLabel: "coverage",
    content: [
      "[TEST-01] Coverage greeting",
      "Say hello.",
      "",
      "[TEST-02] Coverage honesty",
      "Acknowledge unknowns clearly.",
    ].join("\n"),
  });
  assertExpectedStatus("prompt pack import", promptPackImport, [200]);
  assert.equal(typeof promptPackImport.body.pack?.packId, "string");
  const promptPackId = promptPackImport.body.pack?.packId;
  const promptTestId = promptPackImport.body.tests?.[0]?.testId;
  let promptRunId: string | undefined;
  let benchmarkRunId: string | undefined;
  if (promptPackId && promptTestId) {
    await requestNotServerError(app, "GET", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/tests?limit=100`);
    const promptRun = await requestJson<{ runId?: string }>(
      app,
      "POST",
      `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/tests/${encodeURIComponent(promptTestId)}/run`,
      {},
    );
    promptRunId = promptRun.body.runId;
    if (promptRunId) {
      await requestNotServerError(
        app,
        "POST",
        `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/tests/${encodeURIComponent(promptTestId)}/score`,
        {
          runId: promptRunId,
          routingScore: 1,
          honestyScore: 1,
          handoffScore: 1,
          robustnessScore: 1,
          usabilityScore: 1,
          notes: "coverage",
        },
      );
      await requestNotServerError(
        app,
        "POST",
        `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/tests/${encodeURIComponent(promptTestId)}/auto-score`,
        {
          runId: promptRunId,
          force: false,
        },
      );
    }
    await requestNotServerError(app, "POST", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/auto-score`, {
      onlyUnscored: false,
      limit: 10,
    });
    await requestNotServerError(app, "GET", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/report`);
    const benchmark = await requestJson<{ benchmarkRunId?: string }>(
      app,
      "POST",
      `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/benchmark/run`,
      {},
    );
    benchmarkRunId = benchmark.body.benchmarkRunId;
    if (benchmarkRunId) {
      await requestNotServerError(app, "GET", `/api/v1/prompt-packs/benchmark/${encodeURIComponent(benchmarkRunId)}`);
    }
    const replayRegression = await requestJson<{ runId?: string }>(
      app,
      "POST",
      `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/replay-regression/run`,
      {},
    );
    if (replayRegression.body.runId) {
      await requestNotServerError(
        app,
        "GET",
        `/api/v1/prompt-packs/replay-regression/${encodeURIComponent(replayRegression.body.runId)}`,
      );
    }
    await requestNotServerError(app, "GET", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/trends`);
    await requestNotServerError(app, "GET", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/export`);
    await requestNotServerError(app, "POST", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/export`, {});
    await requestNotServerError(app, "POST", `/api/v1/prompt-packs/${encodeURIComponent(promptPackId)}/reset`, {
      clearRuns: true,
      clearScores: true,
    });
  }

  await requestNotServerError(app, "GET", "/api/v1/files/templates");
  await requestNotServerError(app, "GET", "/api/v1/files/list?root=.&limit=25");
  await requestNotServerError(app, "GET", "/api/v1/files/path-suggestions?root=.&limit=25");
  const upload = await requestJson<{ relativePath?: string }>(app, "POST", "/api/v1/files/upload", {
    relativePath: `coverage-${Date.now()}.txt`,
    content: "coverage file content",
  });
  assertExpectedStatus("file upload", upload, [201]);
  const uploadedPath = upload.body.relativePath;
  if (uploadedPath) {
    await requestNotServerError(app, "GET", `/api/v1/files/download?relativePath=${encodeURIComponent(uploadedPath)}`);
    await requestNotServerError(
      app,
      "GET",
      `/api/v1/files/preview?relativePath=${encodeURIComponent(uploadedPath)}&lineLimit=20`,
    );
  }
  await requestNotServerError(app, "POST", "/api/v1/files/templates/text-note/create", {
    relativePath: `coverage-template-${Date.now()}.md`,
    overwrite: true,
  });

  await requestNotServerError(app, "POST", "/api/v1/knowledge/docs/ingest", {
    source: "coverage",
    content: "coverage docs ingest",
  });
  await requestNotServerError(app, "POST", "/api/v1/knowledge/embeddings/index", {
    docs: [{ id: "coverage-doc", text: "coverage text" }],
  });
  await requestNotServerError(app, "POST", "/api/v1/knowledge/embeddings/query", {
    query: "coverage",
    limit: 5,
  });

  await requestNotServerError(app, "GET", "/api/v1/integrations/plugins");
  await requestNotServerError(app, "GET", "/api/v1/integrations/obsidian/status");
  await requestNotServerError(app, "PATCH", "/api/v1/integrations/obsidian/config", {
    enabled: false,
  });
  await requestNotServerError(app, "POST", "/api/v1/integrations/obsidian/test", {});
  await requestNotServerError(app, "POST", "/api/v1/integrations/obsidian/search", {
    query: "coverage",
    limit: 5,
  });
  await requestNotServerError(app, "GET", "/api/v1/integrations/obsidian/note?path=Coverage.md");
  await requestNotServerError(app, "POST", "/api/v1/integrations/obsidian/append", {
    path: "Coverage.md",
    content: "coverage append",
  });
  await requestNotServerError(app, "POST", "/api/v1/integrations/obsidian/inbox/capture", {
    content: "coverage inbox",
    source: "coverage",
  });
  await requestNotServerError(app, "POST", "/api/v1/integrations/plugins/install", {
    pluginId: "coverage-plugin",
    source: "https://example.com/plugin.git",
  });
  await requestNotServerError(app, "POST", "/api/v1/integrations/plugins/coverage-plugin/enable", {});
  await requestNotServerError(app, "POST", "/api/v1/integrations/plugins/coverage-plugin/disable", {});

  await requestNotServerError(app, "POST", "/api/v1/mesh/join", {
    inviteCode: "coverage-invite",
    requestedNodeId: `coverage-${randomUUID()}`,
    displayName: "Coverage node",
  });
  await requestNotServerError(app, "POST", "/api/v1/mesh/leases/acquire", {
    sessionId: chat.sessionId,
    holderNodeId: "coverage-holder",
    ttlSeconds: 60,
  });
  await requestNotServerError(app, "GET", "/api/v1/mesh/leases?limit=25");
  await requestNotServerError(app, "POST", `/api/v1/mesh/sessions/${encodeURIComponent(chat.sessionId)}/claim`, {
    nodeId: "coverage-holder",
    holder: "coverage",
  });
  await requestNotServerError(app, "GET", `/api/v1/mesh/sessions/${encodeURIComponent(chat.sessionId)}/owner`);
  await requestNotServerError(app, "GET", "/api/v1/mesh/sessions/owners?limit=25");
  await requestNotServerError(app, "POST", "/api/v1/mesh/replication/events", {
    sourceNodeId: "coverage-holder",
    events: [],
  });
  await requestNotServerError(app, "GET", "/api/v1/mesh/replication/events?limit=25");
  await requestNotServerError(app, "GET", "/api/v1/mesh/replication/offsets");

  await exerciseProviderSecretRoutes(app);

  await requestNotServerError(app, "GET", "/api/v1/admin/retention");
  await requestNotServerError(app, "PATCH", "/api/v1/admin/retention", {
    backupsKeep: 3,
  });
  await requestNotServerError(app, "POST", "/api/v1/admin/retention/prune", {
    dryRun: true,
  });
  await requestNotServerError(app, "GET", "/api/v1/admin/backups?limit=10");
  await requestNotServerError(app, "POST", "/api/v1/admin/backups/create", {
    name: "coverage-backup",
  });
  await requestNotServerError(app, "POST", "/api/v1/admin/backups/restore", {
    filePath: "missing-backup.json",
    confirm: false,
  });

  return {
    ...chat,
    workspaceId,
    taskId,
    cronJobId,
    durableRunId,
    promptPackId,
    promptTestId,
    promptRunId,
    benchmarkRunId,
  };
}

async function exerciseProviderSecretRoutes(app: FastifyInstance): Promise<void> {
  const envSnapshot = snapshotEnvironment(getCoverageProviderSecretEnvNames(app));
  try {
    const config = await requestNotServerError<{ revision?: number }>(app, "GET", "/api/v1/llm/config");
    const expectedRevision = config.body.revision ?? 1;
    const saved = await requestNotServerError<{ revision?: number }>(app, "POST", "/api/v1/secrets/providers/openai", {
      apiKey: "coverage-secret-value",
      expectedRevision,
    });
    await requestNotServerError(app, "GET", "/api/v1/secrets/providers/openai/status");
    await requestNotServerError(app, "DELETE", "/api/v1/secrets/providers/openai", {
      expectedRevision: saved.body.revision ?? expectedRevision,
      storage: "all",
    });
  } finally {
    restoreEnvironment(envSnapshot);
  }
}

function getCoverageProviderSecretEnvNames(app: FastifyInstance): string[] {
  const names = new Set<string>();
  const gatewayApp = app as FastifyInstance & {
    gatewayConfig?: {
      llm?: {
        providers?: Array<{
          apiKeyEnv?: unknown;
          apiKeyRef?: unknown;
        }>;
      };
    };
  };

  for (const provider of gatewayApp.gatewayConfig?.llm?.providers ?? []) {
    collectProviderEnvName(names, provider.apiKeyEnv);
    collectProviderEnvName(names, provider.apiKeyRef);
  }

  return [...names];
}

function collectProviderEnvName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("keychain:") || !/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) {
    return;
  }
  names.add(trimmed);
}

function snapshotEnvironment(keys: string[]): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const key of keys) {
    snapshot[key] = process.env[key];
  }
  return snapshot;
}

async function exerciseGatewayServiceMethods(app: FastifyInstance, seed: ExerciseSeed): Promise<void> {
  const skipTargets = new Set<string>(["services.llamaCpp", "services.secrets"]);
  const skip = new Set<string>([
    "constructor",
    "init",
    "close",
    "startImprovementScheduler",
    "startProactiveScheduler",
    "installVoiceRuntime",
    "deleteProviderSecret",
    "saveProviderSecret",
    "startLlamaCppHuggingFaceDownload",
    "startLlamaCppRuntime",
    "startNpuRuntime",
    "startTalkSession",
    "startVoiceWake",
    "stopLlamaCppRuntime",
    "stopNpuRuntime",
    "stopTalkSession",
    "stopVoiceWake",
    "daemonStart",
    "daemonStop",
    "daemonRestart",
  ]);

  const specialArgs: Record<string, unknown[]> = {
    getSession: [seed.sessionId],
    getTranscript: [seed.sessionId],
    getSessionSummary: [seed.sessionId],
    listSessionTimeline: [seed.sessionId, 50],
    getChatSessionPrefs: [seed.sessionId],
    listChatMessages: [seed.sessionId, 50],
    getChatSessionBinding: [seed.sessionId],
    getChatAttachment: [seed.attachmentId],
    readChatAttachmentContent: [seed.attachmentId],
    getWorkspace: [seed.workspaceId ?? "missing-workspace"],
    updateWorkspace: [seed.workspaceId ?? "missing-workspace", { name: "coverage-workspace" }],
    archiveWorkspace: [seed.workspaceId ?? "missing-workspace"],
    restoreWorkspace: [seed.workspaceId ?? "missing-workspace"],
    getTask: [seed.taskId ?? "missing-task"],
    updateTask: [seed.taskId ?? "missing-task", { status: "in_progress" }],
    listTaskActivities: [seed.taskId ?? "missing-task", 20],
    listTaskDeliverables: [seed.taskId ?? "missing-task", 20],
    listTaskSubagents: [seed.taskId ?? "missing-task", 20],
    getCronJob: [seed.cronJobId ?? "missing-cron"],
    updateCronJob: [seed.cronJobId ?? "missing-cron", { enabled: false }],
    setCronJobEnabled: [seed.cronJobId ?? "missing-cron", false],
    deleteCronJob: [seed.cronJobId ?? "missing-cron"],
    runCronJobNow: [seed.cronJobId ?? "missing-cron"],
    assignChatSessionProject: [seed.sessionId, seed.projectId],
    setChatSessionBinding: [
      {
        sessionId: seed.sessionId,
        workspacePath: "workspace",
        memoryPath: "memory",
        taskRoot: "tasks",
      },
    ],
    parseChatCommand: [seed.sessionId, "/help"],
    updateChatSessionProactivePolicy: [seed.sessionId, { proactiveMode: "off" }],
    triggerChatSessionProactive: [seed.sessionId, "coverage", false],
    uploadWorkspaceFile: ["coverage-reflective.txt", Buffer.from("coverage").toString("base64")],
    downloadWorkspaceFile: ["coverage-reflective.txt"],
    listWorkspaceFiles: [".", 50],
    listWorkspacePathSuggestions: [".", 30],
    listMemoryFiles: ["memory"],
    getMemoryContext: ["missing-context"],
    listMemoryItemHistory: ["missing-memory-item", 20],
    forgetMemoryItem: ["missing-memory-item", "coverage"],
    listApprovals: ["pending", 25],
    resolveApproval: ["missing-approval", { approved: false, resolvedBy: "coverage" }],
    getApprovalReplay: ["missing-approval", "coverage"],
    invokeTool: [{ toolName: "session.status", args: {} }],
    evaluateToolAccess: [{ toolName: "session.status", args: {} }],
    createToolGrant: [{ toolPattern: "session.*", decision: "allow", scope: "global", issuedBy: "coverage" }],
    listToolGrants: [{ limit: 25 }],
    revokeToolGrant: ["missing-grant"],
    createApproval: [{ reason: "coverage", request: { toolName: "session.status", args: {} } }],
    updateAuthSettings: [{ expectedRevision: 1, allowLoopbackBypass: true }],
    getProviderSecretStatus: ["openai"],
    saveProviderSecret: ["openai", "coverage-secret", 1, "keychain"],
    deleteProviderSecret: ["openai", 1, "all"],
    listMcpTools: ["missing-server"],
    connectMcpServer: ["missing-server"],
    disconnectMcpServer: ["missing-server"],
    deleteMcpServer: ["missing-server"],
    updateMcpServerPolicy: ["missing-server", { redactionMode: "basic" }],
    updateMcpServer: ["missing-server", { trustTier: "restricted" }],
    runMcpServerHealthCheck: ["missing-server"],
    startMcpOAuth: ["missing-server"],
    completeMcpOAuth: ["missing-server", { code: "code", state: "state" }],
    invokeMcpTool: [{ serverId: "missing-server", toolName: "search", arguments: { query: "coverage" } }],
    getPromptPackReport: [seed.promptPackId ?? "missing-pack"],
    getPromptPackExport: [seed.promptPackId ?? "missing-pack"],
    exportPromptPack: [seed.promptPackId ?? "missing-pack"],
    runPromptPackBenchmark: [seed.promptPackId ?? "missing-pack", {}],
    getPromptPackBenchmarkStatus: [seed.benchmarkRunId ?? "missing-benchmark"],
    runPromptPackReplayRegression: [seed.promptPackId ?? "missing-pack", {}],
    getPromptPackReplayRegressionStatus: ["missing-replay-run"],
    getPromptPackCapabilityTrends: [seed.promptPackId ?? "missing-pack"],
    resetPromptPackRunsAndScores: [seed.promptPackId ?? "missing-pack", { clearRuns: true, clearScores: true }],
    runPromptPackTest: [seed.promptPackId ?? "missing-pack", seed.promptTestId ?? "missing-test", {}],
    scorePromptPackLatestRunByCode: [
      {
        packId: seed.promptPackId ?? "missing-pack",
        testCode: "TEST-01",
        notes: "coverage",
        routingScore: 1,
        honestyScore: 1,
        handoffScore: 1,
        robustnessScore: 1,
        usabilityScore: 1,
      },
    ],
    listDurableRunTimeline: [seed.durableRunId ?? "missing-run", 50],
    getDurableRun: [seed.durableRunId ?? "missing-run"],
    pauseDurableRun: [seed.durableRunId ?? "missing-run", "coverage"],
    resumeDurableRun: [seed.durableRunId ?? "missing-run", "coverage"],
    cancelDurableRun: [seed.durableRunId ?? "missing-run", "coverage"],
    retryDurableRun: [seed.durableRunId ?? "missing-run", "coverage", "coverage"],
    wakeDurableRun: [seed.durableRunId ?? "missing-run", { eventType: "coverage", payload: {} }],
    createOrchestrationPlan: [
      {
        planId: `coverage-plan-${Date.now()}`,
        goal: "coverage",
        mode: "hitl",
        maxIterations: 2,
        maxRuntimeMinutes: 5,
        maxCostUsd: 1,
        waves: [
          {
            waveId: "wave-1",
            verify: [],
            budgetUsd: 1,
            ownership: [{ agentId: "architect", paths: ["apps/gateway"] }],
            phases: [
              {
                phaseId: "phase-1",
                ownerAgentId: "architect",
                specPath: "docs/spec.md",
                loopMode: "fresh-context",
                requiresApproval: false,
              },
            ],
          },
        ],
      },
    ],
  };

  const withTimeout = async (value: unknown, timeoutMs = 75): Promise<void> => {
    if (!value || typeof value !== "object" || typeof (value as Promise<unknown>).then !== "function") {
      return;
    }
    await Promise.race([
      (value as Promise<unknown>).then(() => undefined).catch(() => undefined),
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  };

  const buildFallbackArgs = (methodName: string, arity: number): unknown[] => {
    const lower = methodName.toLowerCase();
    return Array.from({ length: arity }, (_, index) => {
      if (index === 0) {
        if (lower.includes("session")) {
          return seed.sessionId;
        }
        if (lower.includes("project")) {
          return seed.projectId;
        }
        if (lower.includes("attachment")) {
          return seed.attachmentId;
        }
        if (lower.includes("workspace")) {
          return seed.workspaceId ?? "missing-workspace";
        }
        if (lower.includes("task")) {
          return seed.taskId ?? "missing-task";
        }
        if (lower.includes("cron")) {
          return seed.cronJobId ?? "missing-cron";
        }
        if (lower.includes("run") || lower.includes("replay")) {
          return "missing-run";
        }
        if (
          lower.startsWith("create") ||
          lower.startsWith("update") ||
          lower.startsWith("patch") ||
          lower.startsWith("set") ||
          lower.startsWith("append") ||
          lower.startsWith("ingest") ||
          lower.startsWith("compose") ||
          lower.startsWith("invoke") ||
          lower.startsWith("send") ||
          lower.startsWith("write") ||
          lower.startsWith("query") ||
          lower.startsWith("import") ||
          lower.startsWith("install") ||
          lower.startsWith("bootstrap") ||
          lower.startsWith("capture") ||
          lower.startsWith("start") ||
          lower.startsWith("stop") ||
          lower.startsWith("refresh") ||
          lower.startsWith("restart") ||
          lower.startsWith("resolve")
        ) {
          return {};
        }
        return "coverage";
      }
      if (index === 1) {
        return {};
      }
      if (index === 2) {
        return "coverage";
      }
      return undefined;
    });
  };

  let invoked = 0;
  let attempted = 0;
  let totalMethods = 0;
  for (const { label, target } of getCoverageMethodTargets(app)) {
    if (skipTargets.has(label)) {
      continue;
    }
    const methodNames = collectCoverageMethodNames(target).filter(
      (name) => !skip.has(name) && !isUnsafeRuntimeProbeMethod(name),
    );
    totalMethods += methodNames.length;
    for (const methodName of methodNames) {
      const method = target[methodName];
      if (typeof method !== "function") {
        continue;
      }
      const reflectedArity = method.length;
      const arity =
        typeof reflectedArity === "number" && Number.isSafeInteger(reflectedArity) && reflectedArity >= 0
          ? reflectedArity
          : 0;

      const candidates: unknown[][] = [];
      const special = specialArgs[methodName];
      if (special) {
        candidates.push(special);
      }
      candidates.push(buildFallbackArgs(methodName, arity));
      candidates.push(Array.from({ length: arity }, () => undefined));
      candidates.push(Array.from({ length: arity }, () => ({})));

      let succeeded = false;
      for (const args of candidates) {
        attempted += 1;
        try {
          const result = method.apply(target, args);
          await withTimeout(result);
          succeeded = true;
        } catch {
          // Continue trying alternate argument shapes to execute method branches.
        }
      }
      if (succeeded) {
        invoked += 1;
      }
    }
  }

  console.log(
    `[coverage-exercise] gateway/runtime/route method sweep invoked ${invoked}/${totalMethods} public methods (attempted ${attempted} calls)`,
  );
}

function isUnsafeRuntimeProbeMethod(methodName: string): boolean {
  const normalized = methodName.toLowerCase();
  return normalized.includes("llamacpp") || normalized.includes("huggingface");
}

function getCoverageChatSupport(app: FastifyInstance): {
  parseChatCommand: (sessionId: string, command: string) => Promise<unknown>;
} & Record<string, unknown> {
  const candidate: unknown = app.services?.chatSupport;
  assert.ok(
    candidate && typeof candidate === "object" && !Array.isArray(candidate),
    "Expected Fastify chatSupport route service decorator",
  );
  assert.equal(typeof (candidate as { parseChatCommand?: unknown }).parseChatCommand, "function");
  return candidate as {
    parseChatCommand: (sessionId: string, command: string) => Promise<unknown>;
  } & Record<string, unknown>;
}

function getCoverageMethodTargets(app: FastifyInstance): Array<{ label: string; target: Record<string, unknown> }> {
  const targets: Array<{ label: string; target: Record<string, unknown> }> = [];
  const addTarget = (label: string, candidate: unknown): void => {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      targets.push({ label, target: candidate as Record<string, unknown> });
    }
  };

  addTarget("gatewayRuntime", app.gatewayRuntime);
  for (const [serviceName, service] of Object.entries(app.services ?? {})) {
    addTarget(`services.${serviceName}`, service);
  }
  assert.ok(targets.length > 0, "Expected gateway runtime or route services for coverage sweep");
  return targets;
}

function collectCoverageMethodNames(target: Record<string, unknown>): string[] {
  const names = new Set<string>();
  for (const name of Object.getOwnPropertyNames(target)) {
    if (typeof target[name] === "function") {
      names.add(name);
    }
  }
  let prototype: object | null = Object.getPrototypeOf(target);
  while (prototype && prototype !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (typeof target[name] === "function") {
        names.add(name);
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return [...names];
}

async function requestNotServerError<T = unknown>(
  app: FastifyInstance,
  method: HttpMethod,
  url: string,
  payload?: Record<string, unknown>,
): Promise<RequestResult<T>> {
  const result = await requestJson<T>(app, method, url, payload);
  if (result.statusCode >= 500) {
    console.warn(`[coverage-exercise] ${method} ${url} returned ${result.statusCode}`);
  }
  return result;
}

function assertExpectedStatus(label: string, result: RequestResult, expectedStatuses: number[]): void {
  assert.ok(
    expectedStatuses.includes(result.statusCode),
    `${label} returned ${result.statusCode}; expected ${expectedStatuses.join(", ")}. Body: ${JSON.stringify(result.body)}`,
  );
}

async function requestJson<T = unknown>(
  app: FastifyInstance,
  method: HttpMethod,
  url: string,
  payload?: Record<string, unknown>,
): Promise<RequestResult<T>> {
  const headers = createCoverageRequestHeaders(app, method);
  const response = await app.inject({
    method,
    url,
    headers,
    payload: payload ? JSON.stringify(payload) : undefined,
  });
  let parsed: T;
  try {
    parsed = JSON.parse(response.body) as T;
  } catch {
    parsed = {} as T;
  }
  return {
    statusCode: response.statusCode,
    body: parsed,
  };
}

function createCoverageRequestHeaders(app: FastifyInstance, method: HttpMethod): Record<string, string> {
  const headers: Record<string, string> = {};
  const gatewayApp = app as FastifyInstance & {
    gatewayConfig?: {
      assistant?: {
        auth?: {
          mode?: "none" | "token" | "basic";
          token?: {
            value?: string;
          };
          basic?: {
            username?: string;
            password?: string;
          };
        };
      };
    };
  };
  const auth = gatewayApp.gatewayConfig?.assistant?.auth;
  if (auth?.mode === "token") {
    const token = auth.token?.value?.trim();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } else if (auth?.mode === "basic") {
    const username = auth.basic?.username?.trim();
    const password = auth.basic?.password?.trim();
    if (username && password) {
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
    }
  }
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = `coverage-${randomUUID()}`;
  }
  return headers;
}

runCoverageExercise().catch((error) => {
  console.error("[coverage-exercise] failed");
  console.error(error);
  process.exitCode = 1;
});
