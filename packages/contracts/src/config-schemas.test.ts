import { describe, expect, it } from "vitest";
import {
  AssistantConfigInputSchema,
  BudgetConfigSchema,
  CronJobsConfigSchema,
  LlmConfigFileSchema,
  ToolPolicyConfigSchema,
} from "./config-schemas.js";

describe("ToolPolicyConfigSchema", () => {
  it("accepts a valid tool policy config", () => {
    const input = {
      profiles: { minimal: ["session.status"], "chat-agent": ["session.status", "memory.read"] },
      tools: { profile: "chat-agent", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: ["./workspace"],
        readOnlyRoots: ["./skills"],
        readAccessMode: "approval_required",
        networkAllowlist: [],
        riskyShellPatterns: ["rm"],
        requireApprovalForRiskyShell: true,
      },
    };
    const result = ToolPolicyConfigSchema.parse(input);
    expect(result.tools.profile).toBe("chat-agent");
    expect(result.sandbox.readAccessMode).toBe("approval_required");
  });

  it("rejects when sandbox.writeJailRoots is not an array", () => {
    const input = {
      profiles: {},
      tools: { profile: "minimal", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: "bad",
        readOnlyRoots: [],
      },
    };
    expect(() => ToolPolicyConfigSchema.parse(input)).toThrow();
  });

  it("rejects when tools.profile is missing", () => {
    const input = {
      profiles: {},
      tools: { allow: [], deny: [] },
      agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [] },
    };
    expect(() => ToolPolicyConfigSchema.parse(input)).toThrow();
  });

  it("allows unknown keys via passthrough", () => {
    const input = {
      profiles: {},
      tools: { profile: "standard", allow: [], deny: [] },
      agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [] },
      futureField: true,
    };
    const result = ToolPolicyConfigSchema.parse(input);
    expect((result as Record<string, unknown>).futureField).toBe(true);
  });

  it("defaults readAccessMode when omitted", () => {
    const input = {
      profiles: {},
      tools: { profile: "standard", allow: [], deny: [] },
      agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [] },
    };
    const result = ToolPolicyConfigSchema.parse(input);
    expect(result.sandbox.readAccessMode).toBe("roots_only");
  });

  it("defaults loop detection to disabled with detector thresholds", () => {
    const input = {
      profiles: {},
      tools: { profile: "standard", allow: [], deny: [] },
      agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [] },
    };
    const result = ToolPolicyConfigSchema.parse(input);
    expect(result.tools.loopDetection).toMatchObject({
      enabled: false,
      historySize: 8,
      warningThreshold: 3,
      criticalThreshold: 4,
      globalThreshold: 6,
      detectors: {
        repeated_same_call: true,
        no_progress_polling: true,
        ping_pong: true,
      },
    });
  });
});

describe("LlmConfigFileSchema", () => {
  it("accepts a valid LLM config", () => {
    const input = {
      activeProviderId: "openai",
      providers: [
        {
          providerId: "openai",
          label: "OpenAI",
          baseUrl: "https://api.openai.com/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "gpt-4.1-mini",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      ],
    };
    const result = LlmConfigFileSchema.parse(input);
    expect(result.providers).toHaveLength(1);
  });

  it("rejects when activeProviderId is missing", () => {
    const input = { providers: [] };
    expect(() => LlmConfigFileSchema.parse(input)).toThrow();
  });

  it("rejects when provider has invalid apiStyle", () => {
    const input = {
      activeProviderId: "test",
      providers: [
        {
          providerId: "test",
          label: "Test",
          baseUrl: "http://localhost",
          apiStyle: "invalid-style",
          defaultModel: "m",
        },
      ],
    };
    expect(() => LlmConfigFileSchema.parse(input)).toThrow();
  });

  it("accepts optional apiKey and headers fields", () => {
    const input = {
      activeProviderId: "test",
      providers: [
        {
          providerId: "test",
          label: "Test",
          baseUrl: "http://localhost",
          apiStyle: "openai-chat-completions",
          defaultModel: "m",
          apiKey: "sk-abc",
          headers: { "X-Custom": "value" },
        },
      ],
    };
    const result = LlmConfigFileSchema.parse(input);
    expect(result.providers[0]?.apiKey).toBe("sk-abc");
  });

  it("accepts canonical request transport config and legacy headers together", () => {
    const input = {
      activeProviderId: "test",
      providers: [
        {
          providerId: "test",
          label: "Test",
          baseUrl: "http://localhost",
          apiStyle: "openai-chat-completions",
          defaultModel: "m",
          headers: { "X-Legacy": "value" },
          request: {
            headers: { "X-Canonical": "value" },
            auth: { type: "header", headerName: "X-API-Key", valueEnv: "TEST_API_KEY" },
            proxy: {
              url: "http://127.0.0.1:8080",
              bypassHosts: ["localhost"],
              auth: { type: "bearer", tokenEnv: "TEST_PROXY_TOKEN" },
              tls: { serverName: "proxy.internal" },
            },
          },
        },
      ],
    };

    const result = LlmConfigFileSchema.parse(input);
    expect(result.providers[0]?.request?.headers).toEqual({ "X-Canonical": "value" });
    expect(result.providers[0]?.headers).toEqual({ "X-Legacy": "value" });
  });

  it("rejects query auth inside proxy transport config", () => {
    const input = {
      activeProviderId: "test",
      providers: [
        {
          providerId: "test",
          label: "Test",
          baseUrl: "http://localhost",
          apiStyle: "openai-chat-completions",
          defaultModel: "m",
          request: {
            proxy: {
              url: "http://127.0.0.1:8080",
              auth: { type: "query", queryParam: "token", value: "abc" },
            },
          },
        },
      ],
    };

    expect(() => LlmConfigFileSchema.parse(input)).toThrow(/invalid discriminator value/i);
  });

  it("rejects incomplete TLS client certificate config", () => {
    const input = {
      activeProviderId: "test",
      providers: [
        {
          providerId: "test",
          label: "Test",
          baseUrl: "http://localhost",
          apiStyle: "openai-chat-completions",
          defaultModel: "m",
          request: {
            tls: {
              clientCertPath: "/tmp/client.crt",
            },
          },
        },
      ],
    };

    expect(() => LlmConfigFileSchema.parse(input)).toThrow(/clientCertPath and clientKeyPath/i);
  });

  it("rejects conflicting TLS verification modes", () => {
    const input = {
      activeProviderId: "test",
      providers: [
        {
          providerId: "test",
          label: "Test",
          baseUrl: "http://localhost",
          apiStyle: "openai-chat-completions",
          defaultModel: "m",
          request: {
            tls: {
              insecureSkipVerify: true,
              caCertPath: "/tmp/ca.pem",
            },
          },
        },
      ],
    };

    expect(() => LlmConfigFileSchema.parse(input)).toThrow(/cannot be combined with insecureSkipVerify/i);
  });
});

describe("BudgetConfigSchema", () => {
  it("accepts a valid budget config", () => {
    const input = {
      mode: "balanced",
      daily: { tokensWarning: 300000, tokensHardCap: 1000000, usdWarning: 10, usdHardCap: 50 },
      session: { tokensHardCap: 120000, turnMaxInputTokens: 32000, turnMaxOutputTokens: 4096 },
    };
    const result = BudgetConfigSchema.parse(input);
    expect(result.mode).toBe("balanced");
  });

  it("rejects invalid mode value", () => {
    const input = {
      mode: "turbo",
      daily: { tokensWarning: 1, tokensHardCap: 2, usdWarning: 1, usdHardCap: 2 },
      session: { tokensHardCap: 1, turnMaxInputTokens: 1, turnMaxOutputTokens: 1 },
    };
    expect(() => BudgetConfigSchema.parse(input)).toThrow();
  });

  it("rejects when daily.tokensWarning is a string", () => {
    const input = {
      mode: "saver",
      daily: { tokensWarning: "many", tokensHardCap: 2, usdWarning: 1, usdHardCap: 2 },
      session: { tokensHardCap: 1, turnMaxInputTokens: 1, turnMaxOutputTokens: 1 },
    };
    expect(() => BudgetConfigSchema.parse(input)).toThrow();
  });

  it("allows unknown keys via passthrough", () => {
    const input = {
      mode: "power",
      daily: { tokensWarning: 1, tokensHardCap: 2, usdWarning: 1, usdHardCap: 2 },
      session: { tokensHardCap: 1, turnMaxInputTokens: 1, turnMaxOutputTokens: 1 },
      experimental: true,
    };
    const result = BudgetConfigSchema.parse(input);
    expect((result as Record<string, unknown>).experimental).toBe(true);
  });
});

describe("AssistantConfigInputSchema", () => {
  it("accepts a fully empty object (all optional)", () => {
    const result = AssistantConfigInputSchema.parse({});
    expect(result).toBeDefined();
  });

  it("accepts a realistic partial assistant config", () => {
    const input = {
      environment: "local",
      deploymentProfile: "trusted_local",
      auth: { mode: "token" },
      llamaCpp: {
        enabled: true,
        server: { baseUrl: "http://127.0.0.1:8080/v1" },
        launch: { alias: "gemma-4-local", modelsRootPath: "C:/models" },
      },
      web: { firecrawl: { enabled: true, baseUrl: "http://127.0.0.1:3002", defaultReadBackend: "firecrawl" } },
      features: { computerUseGuardrailsV1Enabled: true },
    };
    const result = AssistantConfigInputSchema.parse(input);
    expect(result.environment).toBe("local");
    expect(result.deploymentProfile).toBe("trusted_local");
    expect(result.llamaCpp?.launch?.alias).toBe("gemma-4-local");
    expect(result.llamaCpp?.launch?.modelsRootPath).toBe("C:/models");
    expect(result.web?.firecrawl?.defaultReadBackend).toBe("firecrawl");
  });

  it("rejects when auth.mode is an invalid value", () => {
    const input = { auth: { mode: "oauth2" } };
    expect(() => AssistantConfigInputSchema.parse(input)).toThrow();
  });

  it("rejects when a numeric field receives a string", () => {
    const input = { budgets: { dailyUsdWarning: "ten" } };
    expect(() => AssistantConfigInputSchema.parse(input)).toThrow();
  });

  it("allows unknown top-level keys via passthrough", () => {
    const input = { customPlugin: { enabled: true } };
    const result = AssistantConfigInputSchema.parse(input);
    expect((result as Record<string, unknown>).customPlugin).toEqual({ enabled: true });
  });
});

describe("CronJobsConfigSchema", () => {
  it("accepts valid cron jobs config", () => {
    const input = {
      jobs: [{ jobId: "backup", name: "Daily Backup", schedule: "0 2 * * *", enabled: true }],
    };
    const result = CronJobsConfigSchema.parse(input);
    expect(result.jobs).toHaveLength(1);
  });

  it("rejects when a job is missing jobId", () => {
    const input = {
      jobs: [{ name: "Backup", schedule: "0 2 * * *", enabled: true }],
    };
    expect(() => CronJobsConfigSchema.parse(input)).toThrow();
  });

  it("rejects when jobs is not an array", () => {
    const input = { jobs: "none" };
    expect(() => CronJobsConfigSchema.parse(input)).toThrow();
  });
});
