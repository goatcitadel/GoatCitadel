import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

import { GatewayService } from "./gateway-service.js";

const tempRoots: string[] = [];
const originalAllowedOrigins = process.env.GOATCITADEL_ALLOWED_ORIGINS;

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fsPromises.rm(root, { recursive: true, force: true })));
  if (originalAllowedOrigins === undefined) {
    delete process.env.GOATCITADEL_ALLOWED_ORIGINS;
  } else {
    process.env.GOATCITADEL_ALLOWED_ORIGINS = originalAllowedOrigins;
  }
});

function createGatewayHarness(): GatewayService & Record<string, any> {
  return Object.create(GatewayService.prototype) as GatewayService & Record<string, any>;
}

async function createTempRoot(): Promise<string> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "gc-gateway-loop32-"));
  tempRoots.push(root);
  return root;
}

function createRuntimeConfig(rootDir: string) {
  return {
    rootDir,
    assistant: {
      environment: "test",
      deploymentProfile: "local",
      defaultToolProfile: "balanced",
      dataDir: "data",
      transcriptsDir: "data/transcripts",
      auditDir: "data/audit",
      workspaceDir: "workspace",
      worktreesDir: "worktrees",
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        token: { queryParam: "gateway_token" },
        basic: {},
      },
      approvalExplainer: { enabled: true },
      memory: { enabled: true },
      web: {
        firecrawl: {
          enabled: false,
          baseUrl: "https://firecrawl.test",
        },
      },
      mesh: { nodeId: "node-loop32" },
      npu: { enabled: false },
      llamaCpp: { enabled: false },
      database: { driver: "sqlite" },
      sqlite: {},
      durable: {},
      features: {
        durableKernelV1Enabled: true,
        replayOverridesV1Enabled: false,
        memoryLifecycleAdminV1Enabled: true,
        memoryLifecycleAutoForgetEnabled: true,
        memoryMaintenanceV1Enabled: true,
        connectorDiagnosticsV1Enabled: true,
        computerUseGuardrailsV1Enabled: true,
        cronReviewQueueV1Enabled: true,
        replayRegressionV1Enabled: true,
        codeModeV1Enabled: true,
        improvementLedgerV1Enabled: true,
        improvementActivationV1Enabled: true,
      },
      budgets: {},
    },
    toolPolicy: {
      tools: { profile: "balanced", approvalMode: "on_demand" },
      sandbox: {
        writeJailRoots: ["workspace"],
        readOnlyRoots: ["data"],
        readAccessMode: "roots_only",
        networkAllowlist: ["api.firecrawl.test"],
      },
    },
    budgets: { mode: "balanced" },
  };
}

describe("GatewayService loop32 runtime facade behavior", () => {
  it("requires critical init, memoizes deferred init, and removes completed background startup tasks", async () => {
    const gateway = createGatewayHarness();
    gateway.criticalInitComplete = false;
    gateway.deferredInitPromise = undefined;
    gateway.backgroundTasks = new Set<Promise<unknown>>();

    expect(() => GatewayService.prototype.startDeferredInit.call(gateway)).toThrow(
      "Gateway critical init must complete before deferred init starts.",
    );

    gateway.criticalInitComplete = true;
    const runDeferredInit = vi.fn(async () => undefined);
    gateway.runDeferredInit = runDeferredInit;

    const first = GatewayService.prototype.startDeferredInit.call(gateway);
    const second = GatewayService.prototype.startDeferredInit.call(gateway);

    expect(second).toBe(first);
    expect(runDeferredInit).toHaveBeenCalledTimes(1);
    expect(gateway.backgroundTasks.has(first)).toBe(true);

    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateway.backgroundTasks.size).toBe(0);
  });

  it("delegates runtime fallback and hardening guards without mutating config on rejection", () => {
    const gateway = createGatewayHarness();
    gateway.config = createRuntimeConfig("F:/tmp/gc-loop32") as never;

    const runtime = {
      activeProviderId: "openai",
      activeModel: "gpt-fallback",
      providers: [
        { providerId: "openai", defaultModel: "gpt-fallback", hasApiKey: true },
        { providerId: "moonshot", defaultModel: "kimi-k2", hasApiKey: true },
        { providerId: "anthropic", defaultModel: "claude", hasApiKey: false },
      ],
    };

    expect(GatewayService.prototype.resolveFallbackTargets.call(gateway, runtime, "openai", "gpt-primary")).toEqual([
      { providerId: "openai", model: "gpt-fallback" },
      { providerId: "moonshot", model: "kimi-k2" },
    ]);
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
    expect(() =>
      GatewayService.prototype.assertDeploymentProfileUpdate.call(gateway, {
        deploymentProfile: "remote_hardened",
        auth: { mode: "none", allowLoopbackBypass: true },
        networkAllowlist: ["*"],
      }),
    ).toThrow(/remote_hardened requires token or basic auth.*explicit non-loopback.*wildcard outbound host allowlists/);
    gateway.config.assistant.auth.mode = "token";
    gateway.config.assistant.auth.allowLoopbackBypass = false;
    gateway.config.toolPolicy.sandbox.networkAllowlist = ["api.openai.com"];
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "https://citadel.example.com";
    expect(() =>
      GatewayService.prototype.assertDeploymentProfileUpdate.call(gateway, {
        deploymentProfile: "remote_hardened",
        toolApprovalMode: "bypass",
      }),
    ).toThrow("remote_hardened disables approval bypass.");
    expect(() =>
      GatewayService.prototype.assertDeploymentProfileUpdate.call(gateway, {
        deploymentProfile: "remote_hardened",
        defaultToolProfile: "danger",
      }),
    ).toThrow("remote_hardened disables danger tool profiles.");
    gateway.config.toolPolicy.tools.profile = "danger";
    expect(() =>
      GatewayService.prototype.assertDeploymentProfileUpdate.call(gateway, {
        deploymentProfile: "remote_hardened",
        toolApprovalMode: "approve_risky",
        defaultToolProfile: "minimal",
      }),
    ).toThrow("remote_hardened disables danger tool profiles.");
    gateway.config.toolPolicy.tools.profile = "balanced";
    process.env.GOATCITADEL_ALLOWED_ORIGINS = "http://localhost:5173";
    expect(() =>
      GatewayService.prototype.assertDeploymentProfileUpdate.call(gateway, {
        deploymentProfile: "remote_hardened",
        toolApprovalMode: "approve_risky",
        defaultToolProfile: "minimal",
      }),
    ).toThrow("remote_hardened requires explicit non-loopback GOATCITADEL_ALLOWED_ORIGINS.");
    expect(() =>
      GatewayService.prototype.assertFirecrawlRuntimeUpdate.call(gateway, {
        web: { firecrawl: { enabled: true, baseUrl: "https://blocked.firecrawl.test" } },
      }),
    ).toThrow("web.firecrawl.baseUrl must be present in the outbound allowlist");
  });

  it("persists assistant, tool policy, budget, LLM, and unified config through facade writers", async () => {
    const rootDir = await createTempRoot();
    const gateway = createGatewayHarness();
    gateway.config = createRuntimeConfig(rootDir) as never;
    gateway.llmService = {
      exportConfigFile: vi.fn(() => ({ activeProviderId: "openai", providers: [] })),
    };
    gateway.storage = {
      cronJobs: {
        list: vi.fn(() => [
          {
            jobId: "job-1",
            name: "Runtime audit",
            action: "runtime.audit",
            actionConfig: { level: "strict" },
            description: "Check runtime",
            schedule: "0 * * * * America/Los_Angeles",
            enabled: true,
            lastRunAt: "2026-05-15T00:00:00.000Z",
            nextRunAt: "2026-05-15T01:00:00.000Z",
          },
        ]),
      },
    };
    gateway.readFeatureFlags = vi.fn(() => gateway.config.assistant.features);
    gateway.serializeRootPath = vi.fn((value: string) => `serialized:${value}`);

    GatewayService.prototype.persistLlmConfig.call(gateway);
    GatewayService.prototype.persistToolPolicyConfig.call(gateway);
    GatewayService.prototype.persistBudgetsConfig.call(gateway);
    GatewayService.prototype.persistAssistantConfig.call(gateway);

    const configDir = path.join(rootDir, "config");
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "llm-providers.json"), "utf8"))).toEqual({
      activeProviderId: "openai",
      providers: [],
    });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "tool-policy.json"), "utf8")).sandbox).toMatchObject({
      writeJailRoots: ["serialized:workspace"],
      readOnlyRoots: ["serialized:data"],
    });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "budgets.json"), "utf8"))).toEqual({ mode: "balanced" });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "assistant.config.json"), "utf8"))).toMatchObject({
      deploymentProfile: "local",
      database: { driver: "sqlite" },
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
      },
    });
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "goatcitadel.json"), "utf8"))).toMatchObject({
      assistant: {
        deploymentProfile: "local",
      },
      cronJobs: {
        jobs: [expect.objectContaining({ jobId: "job-1", action: "runtime.audit" })],
      },
    });
  });
});
