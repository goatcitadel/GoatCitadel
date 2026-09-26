import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  startFakeOpenAiCompatibleServer,
  type FakeOpenAiRequest,
  type FakeOpenAiResponse,
  type FakeOpenAiServer,
} from "./test/fake-openai-server.js";

// Full-stack orchestration runs: the real gateway, durable worker, orchestration
// engine and phase executor against a fake provider. Each phase dispatches a
// child Chat turn that the same single durable worker must execute, so these
// scenarios only complete when a phase parks its run instead of holding the
// worker. The workflow timeout sits at its 10 s floor so a regression fails
// fast rather than hanging.

const TOKEN = "orchestration-e2e-token-1234567890";
const AUTH = { authorization: `Bearer ${TOKEN}` };
const ENV_KEYS = [
  "GATEWAY_HOST",
  "GOATCITADEL_ALLOWED_ORIGINS",
  "GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS",
  "GOATCITADEL_AUTH_MODE",
  "GOATCITADEL_AUTH_TOKEN",
  "GOATCITADEL_RATE_LIMIT_ENABLED",
  "GOATCITADEL_DATABASE_DRIVER",
  "GOATCITADEL_ROOT_DIR",
] as const;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stopped_by_limit"]);

type App = Awaited<ReturnType<typeof buildApp>>;
type RunView = {
  runId: string;
  planId: string;
  status: string;
  executionState?: string;
  currentPhaseId?: string;
  totalIterations: number;
  lastError?: string;
};

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let fakeProvider: FakeOpenAiServer | undefined;

describe("orchestration plans run end to end on the durable worker", () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    await fakeProvider?.close();
    fakeProvider = undefined;
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("runs every phase of an auto plan to completion", async () => {
    await withGateway(async (app) => {
      const planId = `plan-auto-${randomUUID().slice(0, 8)}`;
      const run = await startPlan(app, twoPhasePlan(planId, { mode: "auto" }));

      const finished = await waitForRun(app, run.runId, (view) => view.status === "completed", "completion");

      expect(finished).toMatchObject({ status: "completed", executionState: "completed", totalIterations: 2 });
      expect(phasesSeenByProvider()).toEqual(expect.arrayContaining(["phase-a", "phase-b"]));
      const events = await listRunEvents(app, run.runId);
      expect(events.filter((event) => event === "run.waiting_for_child")).toHaveLength(2);
      expect(events.filter((event) => event === "phase.executed")).toHaveLength(2);
      expect(events.filter((event) => event === "phase.started")).toHaveLength(2);
    });
  }, 120_000);

  it("pauses before a gated phase and runs it after approval", async () => {
    await withGateway(async (app) => {
      const planId = `plan-gated-${randomUUID().slice(0, 8)}`;
      const run = await startPlan(app, twoPhasePlan(planId, { mode: "auto", gatePhaseB: true }));

      const paused = await waitForRun(app, run.runId, (view) => view.status === "paused", "the phase-b gate");
      expect(paused).toMatchObject({ currentPhaseId: "phase-b", executionState: "paused_for_approval" });
      expect(phasesSeenByProvider()).toContain("phase-a");
      expect(phasesSeenByProvider()).not.toContain("phase-b");

      await approve(app, run.runId, "phase-b");
      const finished = await waitForRun(app, run.runId, (view) => view.status === "completed", "completion");

      expect(finished).toMatchObject({ status: "completed", totalIterations: 2 });
      expect(phasesSeenByProvider()).toContain("phase-b");
    });
  }, 120_000);

  it("runs each phase of a hitl plan once after its approval", async () => {
    await withGateway(async (app) => {
      const planId = `plan-hitl-${randomUUID().slice(0, 8)}`;
      const run = await startPlan(app, twoPhasePlan(planId, { mode: "hitl" }));

      await waitForRun(app, run.runId, (view) => view.status === "paused" && view.currentPhaseId === "phase-a", "a");
      expect(phasesSeenByProvider()).toEqual([]);
      await approve(app, run.runId, "phase-a");
      await waitForRun(app, run.runId, (view) => view.status === "paused" && view.currentPhaseId === "phase-b", "b");
      expect(phasesSeenByProvider()).toEqual(["phase-a"]);
      await approve(app, run.runId, "phase-b");
      const finished = await waitForRun(app, run.runId, (view) => view.status === "completed", "completion");

      expect(finished).toMatchObject({ status: "completed", totalIterations: 2 });
      expect(phasesSeenByProvider()).toEqual(["phase-a", "phase-b"]);
    });
  }, 120_000);

  it("runs a two-agent starter recipe", async () => {
    await withGateway(async (app) => {
      const templates = await app.inject({
        method: "GET",
        url: "/api/v1/orchestration/recipes/templates",
        headers: AUTH,
      });
      expect(templates.statusCode).toBe(200);
      const template = (templates.json() as { items: Array<{ templateId: string; recipe: unknown }> }).items.find(
        (candidate) => candidate.templateId === "weekly-business-review",
      );
      expect(template).toBeDefined();

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/orchestration/recipes/plans",
        headers: { ...AUTH, "idempotency-key": randomUUID() },
        payload: { recipe: template!.recipe },
      });
      expect(created.statusCode, created.body).toBe(201);
      const { plan, run } = created.json() as {
        plan: { planId: string; waves: Array<{ ownership: Array<{ agentId: string }> }> };
        run: RunView;
      };
      expect(new Set(plan.waves.flatMap((wave) => wave.ownership.map((owner) => owner.agentId)))).toEqual(
        new Set(["analyst", "coordinator"]),
      );
      await runPlan(app, plan.planId);

      // The template gates only its final step for approval.
      await waitForRun(app, run.runId, (view) => view.status === "paused", "the step-2 gate");
      expect(phasesSeenByProvider()).toEqual(["step-1"]);
      await approve(app, run.runId, "step-2");
      const finished = await waitForRun(app, run.runId, (view) => view.status === "completed", "completion");

      expect(finished).toMatchObject({ status: "completed", totalIterations: 2 });
      expect(phasesSeenByProvider()).toEqual(["step-1", "step-2"]);
    });
  }, 120_000);
});

function twoPhasePlan(planId: string, options: { mode: "auto" | "hitl"; gatePhaseB?: boolean }) {
  return {
    planId,
    goal: "Prove orchestration phases run on the durable worker",
    mode: options.mode,
    maxIterations: 5,
    maxRuntimeMinutes: 15,
    maxCostUsd: 5,
    waves: [
      {
        waveId: "wave-a",
        verify: [],
        budgetUsd: 2,
        ownership: [{ agentId: "planner", paths: ["specs/plan"] }],
        phases: [
          {
            phaseId: "phase-a",
            ownerAgentId: "planner",
            specPath: "specs/phase-a.md",
            loopMode: "fresh-context",
            requiresApproval: false,
          },
        ],
      },
      {
        waveId: "wave-b",
        verify: [],
        budgetUsd: 2,
        ownership: [{ agentId: "builder", paths: ["specs/build"] }],
        phases: [
          {
            phaseId: "phase-b",
            ownerAgentId: "builder",
            specPath: "specs/phase-b.md",
            loopMode: "fresh-context",
            requiresApproval: options.gatePhaseB ?? false,
          },
        ],
      },
    ],
  };
}

async function withGateway(run: (app: App) => Promise<void>): Promise<void> {
  fakeProvider = await startFakeOpenAiCompatibleServer(phaseAwareProvider);
  configureGateway(fakeProvider.baseUrl);
  const app = await buildApp();
  try {
    await app.ready();
    await run(app);
  } finally {
    await app.close();
  }
}

async function startPlan(app: App, plan: ReturnType<typeof twoPhasePlan>): Promise<RunView> {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/orchestration/plans",
    headers: { ...AUTH, "idempotency-key": randomUUID() },
    payload: plan,
  });
  expect(created.statusCode, created.body).toBe(201);
  const run = readRun(created.json());
  await runPlan(app, plan.planId);
  return run;
}

async function runPlan(app: App, planId: string): Promise<void> {
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/orchestration/plans/${planId}/run`,
    headers: { ...AUTH, "idempotency-key": randomUUID() },
    payload: {},
  });
  expect(started.statusCode, started.body).toBe(200);
}

async function approve(app: App, runId: string, phaseId: string): Promise<void> {
  const approved = await app.inject({
    method: "POST",
    url: `/api/v1/orchestration/phases/${phaseId}/approve`,
    headers: { ...AUTH, "idempotency-key": randomUUID() },
    payload: { runId },
  });
  expect(approved.statusCode, approved.body).toBe(202);
}

async function waitForRun(
  app: App,
  runId: string,
  predicate: (view: RunView) => boolean,
  label: string,
  timeoutMs = 60_000,
): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  let last: RunView | undefined;
  while (Date.now() < deadline) {
    const response = await app.inject({ method: "GET", url: `/api/v1/orchestration/runs/${runId}`, headers: AUTH });
    expect(response.statusCode, response.body).toBe(200);
    last = readRun(response.json());
    if (predicate(last)) {
      return last;
    }
    if (TERMINAL_STATUSES.has(last.status)) {
      throw new Error(
        `Run ${runId} ended as ${last.status} while waiting for ${label}: ${last.lastError ?? "no error"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}; last run state: ${JSON.stringify(last)}`);
}

async function listRunEvents(app: App, runId: string): Promise<string[]> {
  const response = await app.inject({ method: "GET", url: `/api/v1/orchestration/runs/${runId}/trace`, headers: AUTH });
  expect(response.statusCode, response.body).toBe(200);
  return (response.json() as { runEvents: Array<{ eventType: string }> }).runEvents.map((event) => event.eventType);
}

function readRun(body: unknown): RunView {
  const record = body as { run?: RunView } & RunView;
  return record.run ?? record;
}

/** Phase ids in the order the provider first saw each phase prompt. */
function phasesSeenByProvider(): string[] {
  const seen: string[] = [];
  for (const request of fakeProvider?.requests ?? []) {
    const phaseId = readPhaseId(request);
    if (phaseId && !seen.includes(phaseId)) {
      seen.push(phaseId);
    }
  }
  return seen;
}

function readPhaseId(request: FakeOpenAiRequest): string | undefined {
  const messages = (request.body as { messages?: Array<{ content?: unknown }> } | undefined)?.messages ?? [];
  for (const message of messages) {
    const text =
      typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part) => (part as { text?: unknown }).text ?? "").join("\n")
          : "";
    const match = /^Phase: (\S+)$/m.exec(text);
    if (match && text.includes("You are executing one GoatCitadel Cowork orchestration phase.")) {
      return match[1];
    }
  }
  return undefined;
}

function phaseAwareProvider(request: FakeOpenAiRequest): FakeOpenAiResponse {
  if (request.method === "GET" && request.path === "/v1/models") {
    return { body: { data: [{ id: "fake-chat", object: "model", owned_by: "goatcitadel-test" }] } };
  }
  if (request.method !== "POST" || request.path !== "/v1/chat/completions") {
    return { status: 404, body: { error: { message: `No fake route for ${request.method} ${request.path}` } } };
  }
  const body = (request.body ?? {}) as { stream?: boolean; model?: string; response_format?: unknown };
  const phaseId = readPhaseId(request);
  const content = phaseId ? `Phase ${phaseId} output: decisions recorded, no blockers.` : "Acknowledged.";
  const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };
  if (body.stream === true) {
    return {
      sseFrames: [
        JSON.stringify({
          id: "fake-orchestration-stream",
          choices: [{ index: 0, delta: { content }, finish_reason: "stop" }],
          usage,
        }),
        "[DONE]",
      ],
    };
  }
  return {
    body: {
      id: "fake-orchestration-response",
      object: "chat.completion",
      model: body.model ?? "fake-chat",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: body.response_format ? JSON.stringify({ ok: true }) : content },
          finish_reason: "stop",
        },
      ],
      usage,
    },
  };
}

function configureGateway(providerBaseUrl: string): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedGitRoot(providerBaseUrl);
}

/**
 * An isolated gateway root that is also a git repository with one commit, so
 * each run can allocate its worktree (inside the default `.worktrees` write
 * jail) and read its phase specs from it.
 */
function createIsolatedGitRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-orchestration-e2e-"));
  tempRoots.push(root);
  const repoRoot = findRepoRoot();
  fs.cpSync(path.join(repoRoot, "config"), path.join(root, "config"), { recursive: true });
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
  const unifiedConfig = JSON.parse(
    fs.readFileSync(path.join(root, "config", "goatcitadel.example.json"), "utf8"),
  ) as Record<string, unknown> & { assistant: { durable?: Record<string, unknown> } };
  unifiedConfig.llm = llmConfig;
  unifiedConfig.assistant.durable = { ...unifiedConfig.assistant.durable, workflowTimeoutMs: 10_000 };
  fs.writeFileSync(
    path.join(root, "config", "goatcitadel.json"),
    `${JSON.stringify(unifiedConfig, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(llmConfig, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(root, "specs"), { recursive: true });
  fs.writeFileSync(path.join(root, "specs", "phase-a.md"), "Draft the plan for the change.\n", "utf8");
  fs.writeFileSync(path.join(root, "specs", "phase-b.md"), "Implement the planned change.\n", "utf8");
  // An inherited GIT_DIR (for example under a git hook) must not redirect these commands.
  const gitEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore", env: gitEnv });
  git("init", "-q");
  git("add", "-A");
  git(
    "-c",
    "user.name=GoatCitadel Test",
    "-c",
    "user.email=orchestration-e2e@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "Seed orchestration e2e root",
  );
  return root;
}

function findRepoRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(path.join(current, "config", "goatcitadel.example.json"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate repository root: missing config/goatcitadel.example.json in ancestors.");
    }
    current = parent;
  }
}
