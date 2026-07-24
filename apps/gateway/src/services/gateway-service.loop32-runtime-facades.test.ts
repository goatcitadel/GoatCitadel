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
import { ConfigGenerationService } from "./config-generation-service.js";
import { LlmService } from "./llm-service.js";
import { SecretStoreService } from "./secret-store-service.js";

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

  it("projects cron specifications into unified config without runtime telemetry", () => {
    const gateway = createGatewayHarness();
    const runtimeConfig = createRuntimeConfig("F:/tmp/gc-loop32") as never;
    const source = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
    ) as Record<string, any>;
    gateway.storage = {
      cronJobs: {
        list: vi.fn(() => [
          {
            jobId: "operator-hourly",
            revision: 7,
            name: "Operator hourly",
            action: "task",
            description: "Run the operator task.",
            schedule: "0 * * * * America/Los_Angeles",
            enabled: true,
            workdir: "F:/code/personal-ai",
            contextFrom: "upstream",
            lastRunAt: "2026-07-13T12:00:00.000Z",
            nextRunAt: "2026-07-13T13:00:00.000Z",
            lastRunId: "run-telemetry",
            lastRunOutput: "must stay in Storage",
            updatedAt: "2026-07-13T12:00:01.000Z",
          },
        ]),
      },
    };
    gateway.serializeRootPath = vi.fn((value: string) => value);

    const payload = (GatewayService.prototype as any).buildUnifiedConfigPayloadForRuntime.call(
      gateway,
      runtimeConfig,
      source.llm,
      runtimeConfig.assistant.features,
    );

    expect(payload.cronJobs).toEqual({
      jobs: [
        {
          jobId: "operator-hourly",
          name: "Operator hourly",
          action: "task",
          description: "Run the operator task.",
          schedule: "0 * * * * America/Los_Angeles",
          enabled: true,
          workdir: "F:/code/personal-ai",
          contextFrom: "upstream",
        },
      ],
    });
  });

  it("commits provider secrets through the generation owner without legacy LLM persistence", async () => {
    const rootDir = await createTempRoot();
    const source = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), "../../config/goatcitadel.example.json"), "utf8"),
    ) as Record<string, any>;
    const configDir = path.join(rootDir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "goatcitadel.json"), `${JSON.stringify(source, null, 2)}\n`, "utf8");
    const secretStore = new MemorySecretStore();
    const gateway = createGatewayHarness();
    gateway.config = {
      rootDir,
      assistant: structuredClone(source.assistant),
      toolPolicy: structuredClone(source.toolPolicy),
      budgets: structuredClone(source.budgets),
      llm: structuredClone(source.llm),
    };
    gateway.llmService = new LlmService(structuredClone(source.llm), {}, { secretStore });
    gateway.storage = {
      cronJobs: { list: vi.fn(() => structuredClone(source.cronJobs.jobs ?? [])) },
    };
    gateway.readFeatureFlags = vi.fn(() => structuredClone(gateway.config.assistant.features));
    gateway.serializeRootPath = vi.fn((value: string) => value);
    gateway.configGenerationService = new ConfigGenerationService(rootDir);

    await expect(
      GatewayService.prototype.saveProviderSecret.call(gateway, {
        providerId: "openai",
        apiKey: "sk-generation-owned",
        expectedRevision: 1,
        storage: "keychain",
      }),
    ).resolves.toEqual({
      revision: 2,
      providerId: "openai",
      hasSecret: true,
      source: "keychain",
    });
    expect(secretStore.getProviderApiKey("openai")).toBe("sk-generation-owned");
    const activeRaw = fs.readFileSync(path.join(configDir, "goatcitadel.json"), "utf8");
    expect(activeRaw).not.toContain("sk-generation-owned");

    await expect(
      GatewayService.prototype.saveProviderSecret.call(gateway, {
        providerId: "openai",
        apiKey: "sk-stale",
        expectedRevision: 1,
        storage: "keychain",
      }),
    ).rejects.toMatchObject({ details: { expectedRevision: 1, currentRevision: 2 } });
    expect(secretStore.getProviderApiKey("openai")).toBe("sk-generation-owned");
  });
});

class MemorySecretStore extends SecretStoreService {
  private readonly values = new Map<string, string>();

  public override isAvailable(): boolean {
    return true;
  }

  public override setProviderApiKey(providerId: string, apiKey: string): void {
    this.values.set(providerId, apiKey);
  }

  public override getProviderApiKey(providerId: string): string | undefined {
    return this.values.get(providerId);
  }

  public override deleteProviderApiKey(providerId: string): void {
    this.values.delete(providerId);
  }
}
