import path from "node:path";
import os from "node:os";
import { realpathSync, symlinkSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigValidationError } from "@goatcitadel/contracts";
import { loadGatewayConfig } from "./config.js";
import { AUTO_NATIVE_BIN_DIR } from "./postgres-runtime-config.js";
import { syncUnifiedConfig } from "./config-sync-lib.js";
import { ConfigGenerationService } from "./services/config-generation-service.js";

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
  it("drops redacted sandbox root entries and keeps absolute roots outside the runtime root", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const outsideRoot = path.resolve(os.tmpdir(), "goat-operator-scratch");
    await writeJson(path.join(configDir, "tool-policy.json"), {
      profiles: {},
      tools: { profile: "minimal", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: ["./workspace", "[outside-root]", outsideRoot],
        readOnlyRoots: ["[outside-root]"],
      },
    });

    const config = await loadGatewayConfig(rootDir);
    expect(config.toolPolicy.sandbox.writeJailRoots).toEqual([path.join(rootDir, "workspace"), outsideRoot]);
    expect(config.toolPolicy.sandbox.readOnlyRoots).toEqual([]);
  });

  it("resolves operator write roots, drops unsafe entries, and derives runtime write protection", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const operatorRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-operator-root-"));
    TEMP_ROOTS.push(operatorRoot);
    await mkdir(path.join(rootDir, "workspace", "exports"), { recursive: true });
    await writeJson(path.join(configDir, "tool-policy.json"), {
      profiles: {},
      tools: { profile: "minimal", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: ["./workspace"],
        readOnlyRoots: [],
        operatorWriteRoots: [
          { path: operatorRoot, allowDelete: true, label: "Scratch" },
          { path: operatorRoot, allowDelete: false },
          { path: "./workspace/exports", allowDelete: false },
          { path: "./config", allowDelete: true },
          { path: rootDir, allowDelete: true },
          { path: path.join(rootDir, "missing-folder"), allowDelete: false },
        ],
        runtimeWriteProtection: { rootDir: "C:/forged", protectedPaths: [] },
      },
    });

    const config = await loadGatewayConfig(rootDir);
    const realOperatorRoot = realpathSync.native(operatorRoot);
    const realExports = realpathSync.native(path.join(rootDir, "workspace", "exports"));
    expect(config.toolPolicy.sandbox.operatorWriteRoots).toEqual([
      { path: realOperatorRoot, allowDelete: true, label: "Scratch" },
      { path: realExports, allowDelete: false },
    ]);
    const canonicalRoot = realpathSync(rootDir);
    expect(config.toolPolicy.sandbox.runtimeWriteProtection).toEqual({
      rootDir: canonicalRoot,
      protectedPaths: [
        path.join(canonicalRoot, "config"),
        path.join(canonicalRoot, "data", "secrets"),
        path.join(canonicalRoot, "data", "postgres"),
        path.join(canonicalRoot, "data", "audit"),
        path.join(canonicalRoot, "data", "index.db"),
        path.join(canonicalRoot, "data", "index.db-wal"),
        path.join(canonicalRoot, "data", "index.db-shm"),
        path.join(canonicalRoot, "data", "index.db-journal"),
      ],
    });
    expect(config.dbPath).toBe(path.join(rootDir, "data", "index.db"));
  });

  it("protects the SQLite database and its sidecars through a junctioned data dir", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const realData = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-real-db-data-"));
    TEMP_ROOTS.push(realData);
    symlinkSync(realData, path.join(rootDir, "db-link"), process.platform === "win32" ? "junction" : "dir");
    const assistantPath = path.join(configDir, "assistant.config.json");
    const assistantConfig = JSON.parse(await readFile(assistantPath, "utf8")) as Record<string, unknown>;
    await writeJson(assistantPath, { ...assistantConfig, dataDir: "./db-link" });

    const config = await loadGatewayConfig(rootDir);
    const realDataDir = realpathSync(realData);
    expect(config.toolPolicy.sandbox.runtimeWriteProtection?.protectedPaths).toEqual(
      expect.arrayContaining(
        ["index.db", "index.db-wal", "index.db-shm", "index.db-journal"].map((name) => path.join(realDataDir, name)),
      ),
    );
  });

  it("accepts preset-only operator roots and protects a relocated bundled Postgres data dir", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const assistantPath = path.join(configDir, "assistant.config.json");
    const assistantConfig = JSON.parse(await readFile(assistantPath, "utf8")) as Record<string, unknown>;
    await writeJson(assistantPath, {
      ...assistantConfig,
      database: { bundledPostgres: { dataDir: "./pg-cluster" } },
    });
    await writeJson(path.join(configDir, "tool-policy.json"), {
      profiles: {},
      tools: { profile: "minimal", allow: [], deny: [] },
      agents: {},
      sandbox: {
        writeJailRoots: ["./workspace"],
        readOnlyRoots: [],
        operatorWriteRoots: [{ preset: "os_temp", allowDelete: true }],
      },
    });

    // The fixture runtime root lives inside the real OS temp folder, which the
    // safety rules correctly refuse (it would contain the runtime). Point the
    // OS temp folder at a sibling directory for this load.
    const presetTemp = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-preset-temp-"));
    TEMP_ROOTS.push(presetTemp);
    const tempEnvKeys = ["TEMP", "TMP", "TMPDIR"] as const;
    const previousTempEnv = tempEnvKeys.map((key) => [key, process.env[key]] as const);
    for (const key of tempEnvKeys) {
      process.env[key] = presetTemp;
    }
    let config: Awaited<ReturnType<typeof loadGatewayConfig>>;
    try {
      config = await loadGatewayConfig(rootDir);
    } finally {
      for (const [key, value] of previousTempEnv) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    expect(config.toolPolicy.sandbox.operatorWriteRoots).toEqual([
      { preset: "os_temp", allowDelete: true, path: realpathSync.native(presetTemp) },
    ]);
    expect(config.toolPolicy.sandbox.runtimeWriteProtection?.protectedPaths).toContain(
      path.join(realpathSync(rootDir), "pg-cluster"),
    );
  });

  it("records protected paths through a junctioned data dir as their canonical targets", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const realData = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-real-data-"));
    TEMP_ROOTS.push(realData);
    symlinkSync(realData, path.join(rootDir, "data-link"), process.platform === "win32" ? "junction" : "dir");
    const assistantPath = path.join(configDir, "assistant.config.json");
    const assistantConfig = JSON.parse(await readFile(assistantPath, "utf8")) as Record<string, unknown>;
    await writeJson(assistantPath, { ...assistantConfig, dataDir: "./data-link" });

    const config = await loadGatewayConfig(rootDir);
    expect(config.toolPolicy.sandbox.runtimeWriteProtection?.protectedPaths).toContain(
      path.join(realpathSync(realData), "secrets"),
    );
  });

  it("defaults computer-use guardrails feature flag to true when omitted", async () => {
    const { rootDir } = await createConfigFixture();

    const config = await loadGatewayConfig(rootDir);
    expect(config.assistant.features.computerUseGuardrailsV1Enabled).toBe(true);
    expect(config.assistant.features.unifiedComposerPaletteV1Enabled).toBe(true);
    expect(config.assistant.features.attachedContextToolsV1Enabled).toBe(true);
    expect(config.assistant.features.chatSessionStatusV1Enabled).toBe(true);
    expect(config.assistant.features.conversationForksV1Enabled).toBe(true);
    expect(config.assistant.features.notificationRoutingV1Enabled).toBe(true);
    expect(config.assistant.features.chatTimersV1Enabled).toBe(true);
    expect(config.assistant.features.typedRunVariablesV1Enabled).toBe(true);
    expect(config.assistant.features.evolutionControlPlaneV1Enabled).toBe(true);
    expect(config.assistant.features.improvementLocalObservationV1Enabled).toBe(true);
    expect(config.assistant.features.improvementModelEvaluationV1Enabled).toBe(false);
    expect(config.assistant.features.productSourceEvolutionV1Enabled).toBe(false);
    // Sources selected in the Chat composer reach the model by default.
    expect(config.assistant.features.chatExplicitContextV1Enabled).toBe(true);
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

  describe("public web address", () => {
    async function loadWithAddress(publicWebAddress: unknown) {
      const { rootDir, configDir } = await createConfigFixture();
      const assistantPath = path.join(configDir, "assistant.config.json");
      const assistantConfig = JSON.parse(await readFile(assistantPath, "utf8")) as Record<string, unknown>;
      await writeJson(assistantPath, { ...assistantConfig, publicWebAddress });
      return await loadGatewayConfig(rootDir);
    }

    it("is unset when the config does not name one", async () => {
      const { rootDir } = await createConfigFixture();

      const config = await loadGatewayConfig(rootDir);

      expect(config.assistant.publicWebAddress).toBeUndefined();
      expect(Object.hasOwn(config.assistant, "publicWebAddress")).toBe(false);
    });

    it("reads the address tidied", async () => {
      const config = await loadWithAddress("  https://Example.com/goat/ ");

      expect(config.assistant.publicWebAddress).toBe("https://example.com/goat");
    });

    it.each([
      ["a plain http address", "http://example.com"],
      ["an address on a home network", "https://192.168.1.5"],
      ["an address with a login", "https://user:pw@example.com"],
      ["text that is not an address", "not an address"],
      ["an empty string", ""],
      ["a blank string", "   "],
    ])("leaves the address unset for %s", async (_label, value) => {
      const config = await loadWithAddress(value);

      expect(Object.hasOwn(config.assistant, "publicWebAddress")).toBe(false);
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

  it("repairs a stale split mirror from canonical startup truth without bumping its generation", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    await syncUnifiedConfig(rootDir, { createUnifiedIfMissing: true });
    const generation = new ConfigGenerationService(rootDir);
    await generation.commit({
      previousRuntime: null,
      buildCandidate: () => ({ payload: generation.getActivePayload(), runtime: null }),
      apply: () => undefined,
      restore: () => undefined,
    });

    const activePath = path.join(configDir, "goatcitadel.json");
    const before = JSON.parse(await readFile(activePath, "utf8")) as {
      assistant: Record<string, unknown>;
      generation: Record<string, unknown>;
    };
    await writeJson(path.join(configDir, "assistant.config.json"), {
      ...before.assistant,
      auth: { mode: "bearer" },
    });

    const loaded = await loadGatewayConfig(rootDir);
    const repairedMirror = JSON.parse(await readFile(path.join(configDir, "assistant.config.json"), "utf8"));
    const after = JSON.parse(await readFile(activePath, "utf8")) as {
      generation: Record<string, unknown>;
    };

    expect(loaded.assistant.auth.mode).toBe("none");
    expect(repairedMirror).toEqual(before.assistant);
    expect(after.generation).toEqual(before.generation);
  });

  describe("GOATCITADEL_BUNDLED_POSTGRES_BIN_DIR override", () => {
    const ENV_KEY = "GOATCITADEL_BUNDLED_POSTGRES_BIN_DIR";
    let previous: string | undefined;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = previous;
      }
    });

    function stashAndSet(value: string | undefined): void {
      previous = process.env[ENV_KEY];
      if (value === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = value;
      }
    }

    it("keeps the auto discover default when the env var is unset", async () => {
      const { rootDir } = await createConfigFixture();
      stashAndSet(undefined);

      const config = await loadGatewayConfig(rootDir);
      expect(config.assistant.database.bundledPostgres.binDir).toBe(AUTO_NATIVE_BIN_DIR);
    });

    it("disables the native backend (Docker-only) when the env var is set empty", async () => {
      const { rootDir } = await createConfigFixture();
      stashAndSet("");

      const config = await loadGatewayConfig(rootDir);
      // An empty string is authoritative: native discovery is skipped entirely so
      // the container-restart lane exercises the Docker fallback deterministically.
      expect(config.assistant.database.bundledPostgres.binDir).toBe("");
    });

    it("pins an explicit binDir path when the env var provides one", async () => {
      const { rootDir } = await createConfigFixture();
      stashAndSet("  /opt/postgres/bin  ");

      const config = await loadGatewayConfig(rootDir);
      expect(config.assistant.database.bundledPostgres.binDir).toBe("/opt/postgres/bin");
    });
  });

  describe("GOATCITADEL_POSTGRES_ASYNC_GATEWAY_ENABLED override", () => {
    const ENV_KEY = "GOATCITADEL_POSTGRES_ASYNC_GATEWAY_ENABLED";
    let previous: string | undefined;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = previous;
      }
    });

    it("defaults the async Gateway path on and accepts an explicit rollback override", async () => {
      const first = await createConfigFixture();
      previous = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      expect((await loadGatewayConfig(first.rootDir)).assistant.database.postgres.asyncGatewayEnabled ?? false).toBe(
        true,
      );

      const second = await createConfigFixture();
      process.env[ENV_KEY] = "false";
      expect((await loadGatewayConfig(second.rootDir)).assistant.database.postgres.asyncGatewayEnabled).toBe(false);
    });
  });

  describe("chatThinkingStreamV1Enabled default", () => {
    const ENV_KEY = "GOATCITADEL_FEATURE_CHAT_THINKING_STREAM_V1_ENABLED";
    let previous: string | undefined;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = previous;
      }
    });

    it("stays off (decided default, #343) when neither the env var nor a stored value is present", async () => {
      const { rootDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      expect((await loadGatewayConfig(rootDir)).assistant.features.chatThinkingStreamV1Enabled).toBe(false);
    });

    it("turns on when the operator opts in through the env var", async () => {
      const { rootDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = "true";
      expect((await loadGatewayConfig(rootDir)).assistant.features.chatThinkingStreamV1Enabled).toBe(true);
    });
  });

  describe("channelVoiceInboundV1Enabled default", () => {
    const ENV_KEY = "GOATCITADEL_FEATURE_CHANNEL_VOICE_INBOUND_V1_ENABLED";
    let previous: string | undefined;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = previous;
      }
    });

    it("is on when neither the env var nor a stored value is present", async () => {
      const { rootDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      expect((await loadGatewayConfig(rootDir)).assistant.features.channelVoiceInboundV1Enabled).toBe(true);
    });

    it("stays off when the env var is false", async () => {
      const { rootDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = "false";
      expect((await loadGatewayConfig(rootDir)).assistant.features.channelVoiceInboundV1Enabled).toBe(false);
    });

    it("stays off when the config explicitly stores false", async () => {
      const { rootDir, configDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      const assistantPath = path.join(configDir, "assistant.config.json");
      const assistantConfig = JSON.parse(await readFile(assistantPath, "utf8")) as {
        features?: Record<string, unknown>;
      };
      await writeJson(assistantPath, {
        ...assistantConfig,
        features: { ...assistantConfig.features, channelVoiceInboundV1Enabled: false },
      });
      expect((await loadGatewayConfig(rootDir)).assistant.features.channelVoiceInboundV1Enabled).toBe(false);
    });
  });

  describe("chatAsyncClarificationV1Enabled default", () => {
    const ENV_KEY = "GOATCITADEL_FEATURE_CHAT_ASYNC_CLARIFICATION_V1_ENABLED";
    let previous: string | undefined;

    afterEach(() => {
      if (previous === undefined) {
        delete process.env[ENV_KEY];
      } else {
        process.env[ENV_KEY] = previous;
      }
    });

    it("is on when neither the env var nor a stored value is present", async () => {
      const { rootDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
      expect((await loadGatewayConfig(rootDir)).assistant.features.chatAsyncClarificationV1Enabled).toBe(true);
    });

    it("stays off when the env var is false", async () => {
      const { rootDir } = await createConfigFixture();
      previous = process.env[ENV_KEY];
      process.env[ENV_KEY] = "false";
      expect((await loadGatewayConfig(rootDir)).assistant.features.chatAsyncClarificationV1Enabled).toBe(false);
    });
  });
});
