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
        networkAllowlist: [],
        riskyShellPatterns: ["rm"],
        requireApprovalForRiskyShell: true,
      },
    };
    const result = ToolPolicyConfigSchema.parse(input);
    expect(result.tools.profile).toBe("chat-agent");
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
      features: { computerUseGuardrailsV1Enabled: true },
    };
    const result = AssistantConfigInputSchema.parse(input);
    expect(result.environment).toBe("local");
    expect(result.deploymentProfile).toBe("trusted_local");
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
      jobs: [
        { jobId: "backup", name: "Daily Backup", schedule: "0 2 * * *", enabled: true },
      ],
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
