import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigValidationError } from "@goatcitadel/contracts";
import { loadGatewayConfig } from "./config.js";

const TEMP_ROOTS: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createConfigFixture(): Promise<{ rootDir: string; configDir: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-config-test-"));
  TEMP_ROOTS.push(rootDir);
  const configDir = path.join(rootDir, "config");
  await mkdir(configDir, { recursive: true });

  await writeJson(path.join(configDir, "assistant.config.json"), {
    auth: {
      mode: "none",
    },
    durable: {
      enabled: false,
      executionEnabled: false,
      chatAutoPromoteEnabled: false,
    },
    features: {
      durableKernelV1Enabled: false,
    },
  });

  await writeJson(path.join(configDir, "tool-policy.json"), {
    profiles: {},
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: {
      writeJailRoots: [],
      readOnlyRoots: [],
    },
  });

  await writeJson(path.join(configDir, "budgets.json"), {
    mode: "balanced",
    daily: {
      tokensWarning: 1000,
      tokensHardCap: 2000,
      usdWarning: 1,
      usdHardCap: 2,
    },
    session: {
      tokensHardCap: 1000,
      turnMaxInputTokens: 500,
      turnMaxOutputTokens: 500,
    },
  });

  await writeJson(path.join(configDir, "llm-providers.json"), {
    activeProviderId: "openai",
    providers: [],
  });

  await writeJson(path.join(configDir, "cron-jobs.json"), {
    jobs: [],
  });

  return { rootDir, configDir };
}

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("loadGatewayConfig", () => {
  it("defaults computer-use guardrails feature flag to true when omitted", async () => {
    const { rootDir } = await createConfigFixture();

    const config = await loadGatewayConfig(rootDir);
    expect(config.assistant.features.computerUseGuardrailsV1Enabled).toBe(true);
  });

  it("defaults Firecrawl and Docker digest posture to shipped fail-closed values", async () => {
    const { rootDir } = await createConfigFixture();

    const config = await loadGatewayConfig(rootDir);

    expect(config.assistant.web.firecrawl).toMatchObject({
      enabled: true,
      baseUrl: "http://127.0.0.1:3002",
      apiKeyEnv: "FIRECRAWL_API_KEY",
      defaultReadBackend: "firecrawl",
      fallbackToNative: true,
    });
    expect(config.assistant.capabilities.codeModeDockerBackend).toMatchObject({
      enabled: false,
      requireDigestPin: true,
    });
  });

  it("coerces the durable baseline on even when config asks to disable it", async () => {
    const { rootDir } = await createConfigFixture();

    const config = await loadGatewayConfig(rootDir);

    expect(config.assistant.durable.enabled).toBe(true);
    expect(config.assistant.durable.executionEnabled).toBe(true);
    expect(config.assistant.durable.chatAutoPromoteEnabled).toBe(true);
    expect(config.assistant.features.durableKernelV1Enabled).toBe(true);
  });

  it("returns contextual parse error for malformed assistant config", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await writeFile(path.join(configDir, "assistant.config.json"), "{invalid", "utf8");
    await expect(loadGatewayConfig(rootDir)).rejects.toThrow(/assistant\.config\.json/);
  });

  it("returns contextual parse error for malformed tool policy config", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await writeFile(path.join(configDir, "tool-policy.json"), "{invalid", "utf8");
    await expect(loadGatewayConfig(rootDir)).rejects.toThrow(/tool-policy\.json/);
  });

  it("returns contextual parse error for malformed budgets config", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await writeFile(path.join(configDir, "budgets.json"), "{invalid", "utf8");
    await expect(loadGatewayConfig(rootDir)).rejects.toThrow(/budgets\.json/);
  });

  it("returns contextual parse error for malformed llm config", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await writeFile(path.join(configDir, "llm-providers.json"), "{invalid", "utf8");
    await expect(loadGatewayConfig(rootDir)).rejects.toThrow(/llm-providers\.json/);
  });

  it("throws ConfigValidationError for structurally invalid budgets config", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await writeJson(path.join(configDir, "budgets.json"), {
      mode: "turbo",
      daily: { tokensWarning: "many", tokensHardCap: 2, usdWarning: 1, usdHardCap: 2 },
      session: { tokensHardCap: 1, turnMaxInputTokens: 1, turnMaxOutputTokens: 1 },
    });
    await expect(loadGatewayConfig(rootDir)).rejects.toThrow(ConfigValidationError);
  });

  it("throws ConfigValidationError for invalid tool-policy config", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await writeJson(path.join(configDir, "tool-policy.json"), {
      profiles: {},
      tools: { profile: 123, allow: [], deny: [] },
      agents: {},
      sandbox: { writeJailRoots: [], readOnlyRoots: [] },
    });
    await expect(loadGatewayConfig(rootDir)).rejects.toThrow(ConfigValidationError);
  });

  it("loads valid config without error", async () => {
    const { rootDir } = await createConfigFixture();
    const config = await loadGatewayConfig(rootDir);
    expect(config.assistant).toBeDefined();
    expect(config.toolPolicy).toBeDefined();
    expect(config.budgets).toBeDefined();
    expect(config.llm).toBeDefined();
  });
});
