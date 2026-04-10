import { describe, expect, it } from "vitest";
import type { GatewayRuntimeConfig } from "./config.js";
import {
  resolveGatewayPostgresConnectionOptions,
  resolveGatewayPostgresConnectionString,
} from "./postgres-runtime-config.js";

function buildConfig(): GatewayRuntimeConfig {
  return {
    rootDir: "F:/code/personal-ai",
    dbPath: "F:/code/personal-ai/data/index.db",
    toolPolicy: {
      profiles: {},
      tools: {
        profile: "minimal",
        allow: [],
        deny: [],
      },
      agents: {},
      sandbox: {
        writeJailRoots: [],
        readOnlyRoots: [],
        readAccessMode: "approval_required",
        networkAllowlist: [],
        riskyShellPatterns: [],
        requireApprovalForRiskyShell: true,
      },
    },
    budgets: {
      mode: "balanced",
      daily: {
        tokensWarning: 0,
        tokensHardCap: 0,
        usdWarning: 0,
        usdHardCap: 0,
      },
      session: {
        tokensHardCap: 0,
        turnMaxInputTokens: 0,
        turnMaxOutputTokens: 0,
      },
    },
    llm: {
      activeProviderId: "",
      activeModel: "",
      providers: [],
    },
    assistant: {
      environment: "local",
      deploymentProfile: "local_dev",
      defaultToolProfile: "minimal",
      dataDir: "./data",
      transcriptsDir: "./data/transcripts",
      auditDir: "./data/audit",
      workspaceDir: "./workspace",
      worktreesDir: "./.worktrees",
      auth: {
        mode: "none",
        allowLoopbackBypass: false,
        token: { queryParam: "access_token" },
        basic: {},
      },
      approvalExplainer: {
        enabled: true,
        mode: "async",
        minRiskLevel: "caution",
        timeoutMs: 1000,
        maxPayloadChars: 1000,
      },
      memory: {
        enabled: true,
        qmd: {
          enabled: true,
          applyToChat: true,
          applyToOrchestration: true,
          minPromptChars: 1,
          maxContextTokens: 1,
          headroomTokens: 1,
          maxTranscriptEvents: 1,
          maxMemoryFiles: 1,
          maxBytesPerFile: 1,
          allowedExtensions: [],
          cacheTtlSeconds: 1,
          distiller: {
            timeoutMs: 1,
            fallbackCheapModel: "x",
          },
        },
      },
      web: {
        firecrawl: {
          enabled: false,
          baseUrl: "http://127.0.0.1:3002",
          timeoutMs: 1000,
          defaultReadBackend: "native",
          fallbackToNative: true,
        },
      },
      mesh: {
        enabled: false,
        mode: "lan",
        nodeId: "node",
        discovery: { mdns: false, staticPeers: [] },
        security: {
          joinTokenEnv: "JOIN",
          requireMtls: true,
          tailnet: { enabled: false },
        },
        leases: { ttlSeconds: 30 },
        replication: { batchSize: 10 },
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
          startTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          restartBudget: {
            windowMs: 1000,
            maxRestarts: 1,
            backoffMs: 100,
          },
        },
      },
      llamaCpp: {
        enabled: false,
        autoStart: false,
        server: {
          baseUrl: "http://127.0.0.1:8080/v1",
          command: "llama-server",
          extraArgs: [],
          healthPath: "/health",
          modelsPath: "/v1/models",
          startTimeoutMs: 1000,
          requestTimeoutMs: 1000,
          restartBudget: {
            windowMs: 1000,
            maxRestarts: 1,
            backoffMs: 100,
          },
        },
        launch: {
          alias: "local",
        },
      },
      database: {
        driver: "postgres",
        postgres: {
          mode: "bundled",
          port: 5432,
          database: "goatcitadel",
          ssl: "prefer",
          pool: {
            min: 0,
            max: 10,
            idleTimeoutMs: 1000,
            connectionTimeoutMs: 1000,
          },
          migrationsTable: "schema_migrations",
        },
        bundledPostgres: {
          enabled: true,
          dataDir: "./data/postgres",
          port: 55432,
          autoStart: true,
          startTimeoutMs: 1000,
        },
        sqlite: {
          cacheSizeKb: 1024,
          tempStoreMemory: true,
          walAutoCheckpointPages: 1000,
        },
      },
      sqlite: {
        cacheSizeKb: 1024,
        tempStoreMemory: true,
        walAutoCheckpointPages: 1000,
      },
      durable: {
        enabled: true,
        diagnosticsEnabled: false,
        executionEnabled: true,
        chatAutoPromoteEnabled: true,
        maxAttemptsDefault: 3,
        workflowTimeoutMs: 1000,
      },
      features: {
        durableKernelV1Enabled: true,
        replayOverridesV1Enabled: false,
        memoryLifecycleAdminV1Enabled: false,
        memoryMaintenanceV1Enabled: false,
        connectorDiagnosticsV1Enabled: false,
        computerUseGuardrailsV1Enabled: true,
        bankrBuiltinEnabled: false,
        cronReviewQueueV1Enabled: false,
        replayRegressionV1Enabled: false,
        codeModeV1Enabled: false,
      },
      budgets: {
        dailyUsdWarning: 1,
        dailyUsdHardCap: 2,
        sessionTokenHardCap: 3,
      },
      capabilities: {
        candidateRoot: "./data/candidates",
        codeModeArtifactRoot: "./data/artifacts",
        tempRoot: "./data/temp",
        codeModeSandbox: {
          mode: "best_effort_host",
          required: true,
          bestEffortHostEnabled: false,
        },
      },
    },
  };
}

describe("resolveGatewayPostgresConnectionOptions", () => {
  it("uses bundled defaults when host is omitted", () => {
    const config = buildConfig();
    const resolved = resolveGatewayPostgresConnectionOptions(config);
    expect(resolved.host).toBe("127.0.0.1");
    expect(resolved.port).toBe(55432);
    expect(resolved.user).toBe("postgres");
    expect(resolved.database).toBe("goatcitadel");
  });

  it("builds a connection string from bundled defaults", () => {
    const config = buildConfig();
    const resolved = resolveGatewayPostgresConnectionString(config);
    expect(resolved).toBe("postgresql://postgres@127.0.0.1:55432/goatcitadel");
  });
});
