import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "@goatcitadel/storage";

import { buildApp } from "./app.js";
import { startFakeOpenAiCompatibleServer, type FakeOpenAiServer } from "./test/fake-openai-server.js";

// Full-stack check that Chat routes only accept the policy task and run ids of
// the session they are sent to. Boots the real gateway (sqlite, operator auth)
// against a fake OpenAI-compatible provider, records a delegation run in one
// session, and checks what each session may send.

const TOKEN = "policy-scope-token-1234567890";
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

const originalEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const tempRoots: string[] = [];
let fakeProvider: FakeOpenAiServer | undefined;
let requestCounter = 0;

describe("Chat policy scope binding (full stack)", () => {
  afterEach(async () => {
    for (const key of ENV_KEYS) {
      const original = originalEnv.get(key);
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    for (const root of tempRoots.splice(0)) {
      await fs.promises.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
    await fakeProvider?.close();
    fakeProvider = undefined;
  });

  it("accepts a session's own delegation run and task and rejects them from another session", async () => {
    fakeProvider = await startFakeOpenAiCompatibleServer();
    configureGateway(fakeProvider.baseUrl);
    const app = await buildApp();
    try {
      await app.ready();
      const post = async (url: string, payload: Record<string, unknown>) =>
        await app.inject({
          method: "POST",
          url,
          headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": `policy-scope-${++requestCounter}` },
          payload,
        });
      const createSession = async (title: string) => {
        const created = await post("/api/v1/chat/sessions", { title });
        expect(created.statusCode, created.body).toBe(201);
        return (created.json() as { sessionId: string }).sessionId;
      };
      const owner = await createSession("Delegation owner");
      const other = await createSession("Other session");

      // Record the owner's delegation run the way a delegation (or a turn's
      // orchestration run) does, through a second connection to the gateway's database.
      const runId = "delegation-run-owner";
      const taskId = "delegation-task-owner";
      const seedStorage = new Storage({
        dbPath: app.gatewayConfig.dbPath,
        transcriptsDir: path.join(app.gatewayConfig.rootDir, "seed-transcripts"),
        auditDir: path.join(app.gatewayConfig.rootDir, "seed-audit"),
      });
      try {
        seedStorage.chatDelegationRuns.create({
          runId,
          sessionId: owner,
          taskId,
          objective: "Review the release notes",
          roles: ["QA"],
          mode: "sequential",
          status: "running",
        });
      } finally {
        seedStorage.close();
      }

      const preflight = async (sessionId: string, scope: Record<string, string>) =>
        await post(`/api/v1/chat/sessions/${sessionId}/route-preflight`, {
          action: "send",
          content: "Continue the delegated review",
          ...scope,
        });

      // The ids Mission Control sends for the session's active delegation are accepted.
      const own = await preflight(owner, { policyRunId: runId, policyTaskId: taskId });
      expect(own.statusCode, own.body).toBe(200);
      const plain = await preflight(other, {});
      expect(plain.statusCode, plain.body).toBe(200);

      // The same ids from another session, and ids that name nothing, are rejected.
      for (const scope of [
        { policyRunId: runId },
        { policyTaskId: taskId },
        { policyRunId: "no-such-run" },
        { policyTaskId: "no-such-task" },
      ]) {
        const rejected = await preflight(other, scope);
        expect(rejected.statusCode, JSON.stringify(scope)).toBe(409);
        expect((rejected.json() as { error: string }).error).toMatch(/does not belong to Chat session/);
      }

      const send = await post(`/api/v1/chat/sessions/${other}/agent-send`, {
        content: "Borrow the other session's task grants",
        policyTaskId: taskId,
      });
      expect(send.statusCode, send.body).toBe(409);
      const research = await post(`/api/v1/chat/sessions/${other}/research/run`, {
        query: "anything",
        policyRunId: runId,
      });
      expect(research.statusCode, research.body).toBe(409);
      const delegate = await post(`/api/v1/chat/sessions/${other}/delegate`, {
        objective: "Delegate under another session's run",
        roles: ["QA"],
        policyRunId: runId,
      });
      expect(delegate.statusCode, delegate.body).toBe(409);
    } finally {
      await app.close();
    }
  }, 120_000);
});

function configureGateway(providerBaseUrl: string): void {
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
  process.env.GOATCITADEL_ALLOW_TAILNET_DEV_ORIGINS = "false";
  process.env.GOATCITADEL_AUTH_MODE = "token";
  process.env.GOATCITADEL_AUTH_TOKEN = TOKEN;
  process.env.GOATCITADEL_RATE_LIMIT_ENABLED = "false";
  process.env.GOATCITADEL_DATABASE_DRIVER = "sqlite";
  process.env.GOATCITADEL_ROOT_DIR = createIsolatedConfigRoot(providerBaseUrl);
}

function createIsolatedConfigRoot(providerBaseUrl: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-policy-scope-"));
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
  // The tracked example template keeps this hermetic; config/goatcitadel.json is gitignored.
  const unifiedConfigPath = path.join(root, "config", "goatcitadel.json");
  const baseConfigPath = path.join(root, "config", "goatcitadel.example.json");
  const unifiedConfig = JSON.parse(fs.readFileSync(baseConfigPath, "utf8")) as Record<string, unknown>;
  unifiedConfig.llm = llmConfig;
  fs.writeFileSync(unifiedConfigPath, `${JSON.stringify(unifiedConfig, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(root, "config", "llm-providers.json"), `${JSON.stringify(llmConfig, null, 2)}\n`, "utf8");
  tempRoots.push(root);
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
