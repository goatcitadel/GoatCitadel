import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayRuntimeConfig } from "../../config.js";
import {
  buildGatewayAuthCredentialPlan,
  resolveGatewayInstallToken,
} from "./auth-credential-planner.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("auth credential planner", () => {
  it("prefers env credentials and reports inline override warnings", async () => {
    const root = await createTempRoot({
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        token: {
          value: "inline-token",
          queryParam: "access_token",
        },
        basic: {},
      },
    });
    const runtimeConfig = createRuntimeConfig(root, {
      mode: "token",
      allowLoopbackBypass: false,
      token: {
        value: "env-token",
        queryParam: "access_token",
      },
      basic: {},
    });

    const plan = await buildGatewayAuthCredentialPlan({
      runtimeConfig,
      env: {
        GOATCITADEL_AUTH_MODE: "token",
        GOATCITADEL_AUTH_TOKEN: "env-token",
      },
    });

    expect(plan.token).toMatchObject({
      configured: true,
      source: "env",
    });
    expect(plan.warnings).toContain("GOATCITADEL_AUTH_TOKEN overrides assistant.config.json auth token.");
  });

  it("generates and persists a token into the local env file when requested", async () => {
    const root = await createTempRoot({
      auth: {
        mode: "token",
        allowLoopbackBypass: false,
        token: {
          queryParam: "access_token",
        },
        basic: {},
      },
    }, [
      "GOATCITADEL_AUTH_MODE=token",
      "",
    ]);
    const runtimeConfig = createRuntimeConfig(root, {
      mode: "token",
      allowLoopbackBypass: false,
      token: {
        queryParam: "access_token",
      },
      basic: {},
    });

    const resolution = await resolveGatewayInstallToken({
      runtimeConfig,
      env: {},
      generateWhenMissing: true,
      persistToEnv: true,
    });

    expect(resolution.source).toBe("generated");
    expect(resolution.token).toEqual(expect.any(String));
    expect(resolution.persistedToEnv).toBe(true);

    const envRaw = await readFile(path.join(root, ".env"), "utf8");
    expect(envRaw).toMatch(/GOATCITADEL_AUTH_TOKEN="/);
  });

  it("refuses install-token resolution outside token mode", async () => {
    const root = await createTempRoot({
      auth: {
        mode: "basic",
        allowLoopbackBypass: false,
        token: {
          queryParam: "access_token",
        },
        basic: {
          username: "operator",
          password: "password123",
        },
      },
    });
    const runtimeConfig = createRuntimeConfig(root, {
      mode: "basic",
      allowLoopbackBypass: false,
      token: {
        queryParam: "access_token",
      },
      basic: {
        username: "operator",
        password: "password123",
      },
    });

    const resolution = await resolveGatewayInstallToken({
      runtimeConfig,
      env: {},
      generateWhenMissing: true,
      persistToEnv: true,
    });

    expect(resolution.source).toBe("none");
    expect(resolution.token).toBeUndefined();
    expect(resolution.unavailableReason).toContain("basic");
  });
});

async function createTempRoot(
  assistantConfig: Record<string, unknown>,
  envLines: string[] = [],
): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-auth-plan-"));
  TEMP_ROOTS.push(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "assistant.config.json"), `${JSON.stringify(assistantConfig, null, 2)}\n`, "utf8");
  await writeFile(path.join(root, ".env"), envLines.join("\n"), "utf8");
  return root;
}

function createRuntimeConfig(rootDir: string, auth: GatewayRuntimeConfig["assistant"]["auth"]): GatewayRuntimeConfig {
  return {
    rootDir,
    dbPath: path.join(rootDir, "data", "index.db"),
    assistant: {
      environment: "test",
      deploymentProfile: "local_dev",
      defaultToolProfile: "standard",
      dataDir: "./data",
      transcriptsDir: "./data/transcripts",
      auditDir: "./data/audit",
      workspaceDir: "./workspace",
      worktreesDir: "./.worktrees",
      auth,
      approvalExplainer: {
        enabled: false,
        mode: "async",
        minRiskLevel: "caution",
        timeoutMs: 15000,
        maxPayloadChars: 4000,
      },
      memory: {
        enabled: false,
        qmd: {
          enabled: false,
          applyToChat: false,
          applyToOrchestration: false,
          minPromptChars: 0,
          maxContextTokens: 0,
          headroomTokens: 0,
          maxTranscriptEvents: 0,
          maxMemoryFiles: 0,
          maxBytesPerFile: 0,
          allowedExtensions: [],
          cacheTtlSeconds: 0,
          distiller: {
            timeoutMs: 0,
            fallbackCheapModel: "cheap",
          },
        },
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "test-node",
        discovery: {
          mdns: false,
          staticPeers: [],
        },
        security: {
          joinTokenEnv: "GOATCITADEL_MESH_JOIN_TOKEN",
          requireMtls: false,
          tailnet: {
            enabled: false,
          },
        },
        leases: {
          ttlSeconds: 30,
        },
        replication: {
          batchSize: 50,
        },
      },
      npu: {
        enabled: false,
        autoStart: false,
        sidecar: {
          baseUrl: "http://127.0.0.1:11440",
          command: "python",
          args: [],
          healthPath: "/health",
          modelsPath: "/v1/models",
          startTimeoutMs: 2000,
          requestTimeoutMs: 2000,
          restartBudget: {
            windowMs: 60000,
            maxRestarts: 2,
            backoffMs: 1000,
          },
        },
      },
      sqlite: {
        cacheSizeKb: 1024,
        tempStoreMemory: true,
        walAutoCheckpointPages: 1000,
      },
      durable: {
        enabled: false,
        diagnosticsEnabled: false,
        maxAttemptsDefault: 1,
        executionEnabled: false,
        chatAutoPromoteEnabled: false,
      },
      features: {
        durableKernelV1Enabled: false,
        memoryMaintenanceV1Enabled: false,
        replayOverridesV1Enabled: false,
        memoryLifecycleAdminV1Enabled: false,
        connectorDiagnosticsV1Enabled: false,
        computerUseGuardrailsV1Enabled: false,
        bankrBuiltinEnabled: false,
        cronReviewQueueV1Enabled: false,
        replayRegressionV1Enabled: false,
      },
      budgets: {
        dailyUsdWarning: 10,
        dailyUsdHardCap: 20,
        sessionTokenHardCap: 10000,
      },
    },
    toolPolicy: {
      profiles: {},
      tools: {
        profile: "standard",
        allow: [],
        deny: [],
      },
      agents: {},
      sandbox: {
        writeJailRoots: [],
        readOnlyRoots: [],
        networkAllowlist: [],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    },
    budgets: {
      mode: "balanced",
      daily: {
        tokensWarning: 1,
        tokensHardCap: 2,
        usdWarning: 1,
        usdHardCap: 2,
      },
      session: {
        tokensHardCap: 2,
        turnMaxInputTokens: 2,
        turnMaxOutputTokens: 2,
      },
    },
    llm: {
      activeProviderId: "test",
      providers: [],
    },
  };
}
