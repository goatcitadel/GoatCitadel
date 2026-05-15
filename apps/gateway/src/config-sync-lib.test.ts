import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUnifiedConfigPayload, syncUnifiedConfig } from "./config-sync-lib.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.GOATCITADEL_VERBOSE;
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("syncUnifiedConfig", () => {
  it("builds a canonical unified payload shape", () => {
    const assistant = { environment: "local" };
    const toolPolicy = { profiles: { safe: [] } };
    const budgets = { mode: "balanced" };
    const llm = { activeProviderId: "local" };
    const cronJobs = { jobs: [] };

    expect(buildUnifiedConfigPayload(assistant, toolPolicy, budgets, llm, cronJobs)).toEqual({
      version: 1,
      assistant,
      toolPolicy,
      budgets,
      llm,
      cronJobs,
    });
  });

  it("creates config/goatcitadel.json from split files when missing", async () => {
    const root = await makeTempRoot();
    await seedSplitFiles(root);

    const result = await syncUnifiedConfig(root, { createUnifiedIfMissing: true });
    expect(result.createdUnified).toBe(true);
    expect(result.materializedExamples).toEqual([]);

    const unifiedRaw = await readFile(path.join(root, "config", "goatcitadel.json"), "utf8");
    const unified = JSON.parse(unifiedRaw) as Record<string, unknown>;
    expect(unified.version).toBe(1);
    expect(unified.assistant).toBeDefined();
    expect(unified.toolPolicy).toBeDefined();
    expect(unified.budgets).toBeDefined();
    expect(unified.llm).toBeDefined();
    expect(unified.cronJobs).toBeDefined();
  });

  it("syncs updated sections from config/goatcitadel.json into split files", async () => {
    const root = await makeTempRoot();
    await seedSplitFiles(root);
    const unifiedPath = path.join(root, "config", "goatcitadel.json");

    await writeFile(
      unifiedPath,
      JSON.stringify(
        {
          version: 1,
          assistant: {
            environment: "local",
            defaultToolProfile: "coding",
          },
          budgets: {
            mode: "power",
            daily: {
              tokensWarning: 10,
              tokensHardCap: 20,
              usdWarning: 1,
              usdHardCap: 2,
            },
            session: {
              tokensHardCap: 30,
              turnMaxInputTokens: 40,
              turnMaxOutputTokens: 50,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = await syncUnifiedConfig(root);
    expect(result.syncedSections).toContain("assistant.config.json");
    expect(result.syncedSections).toContain("budgets.json");
    expect(result.materializedExamples).toEqual([]);

    const assistantRaw = await readFile(path.join(root, "config", "assistant.config.json"), "utf8");
    const assistant = JSON.parse(assistantRaw) as { defaultToolProfile?: string };
    expect(assistant.defaultToolProfile).toBe("coding");

    const budgetsRaw = await readFile(path.join(root, "config", "budgets.json"), "utf8");
    const budgets = JSON.parse(budgetsRaw) as { mode?: string };
    expect(budgets.mode).toBe("power");
  });

  it("does not rewrite split config files when only CRLF normalization differs", async () => {
    const root = await makeTempRoot();
    const configDir = path.join(root, "config");
    const assistantPayload = {
      auth: { mode: "token", token: { value: "abc", queryParam: "access_token" } },
      features: { computerUseGuardrailsV1Enabled: true },
    };
    const unifiedPayload = {
      version: 1,
      assistant: assistantPayload,
    };

    await writeFile(path.join(configDir, "goatcitadel.json"), `${JSON.stringify(unifiedPayload, null, 2)}\n`, "utf8");
    const splitPath = path.join(configDir, "assistant.config.json");
    await writeFile(splitPath, `${JSON.stringify(assistantPayload, null, 2).replace(/\n/g, "\r\n")}\r\n`, "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await stat(splitPath);
    const result = await syncUnifiedConfig(root);
    const after = await stat(splitPath);
    const content = await readFile(splitPath, "utf8");

    expect(result.syncedSections).toEqual([]);
    expect(result.materializedExamples).toEqual([]);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(content.includes("\r\n")).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("does not rewrite or warn when split config only differs by trailing newline", async () => {
    const root = await makeTempRoot();
    const configDir = path.join(root, "config");
    const llmPayload = {
      activeProviderId: "local",
      providers: [
        {
          providerId: "local",
          label: "Local",
          baseUrl: "http://127.0.0.1:1234/v1",
          apiStyle: "openai-chat-completions",
          defaultModel: "local-model",
        },
      ],
    };
    const unifiedPayload = {
      version: 1,
      llm: llmPayload,
    };

    await writeFile(path.join(configDir, "goatcitadel.json"), `${JSON.stringify(unifiedPayload, null, 2)}\n`, "utf8");
    const splitPath = path.join(configDir, "llm-providers.json");
    await writeFile(splitPath, JSON.stringify(llmPayload, null, 2), "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await stat(splitPath);
    const result = await syncUnifiedConfig(root);
    const after = await stat(splitPath);
    const content = await readFile(splitPath, "utf8");

    expect(result.syncedSections).toEqual([]);
    expect(result.materializedExamples).toEqual([]);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(content.endsWith("\n")).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("materializes missing split files from example templates before building unified config", async () => {
    const root = await makeTempRoot();
    await writeExampleSplitFiles(root);

    const result = await syncUnifiedConfig(root, { createUnifiedIfMissing: true });

    expect(result.createdUnified).toBe(true);
    expect(result.materializedExamples).toEqual([
      "assistant.config.json",
      "tool-policy.json",
      "budgets.json",
      "llm-providers.json",
      "cron-jobs.json",
    ]);

    await expect(readFile(path.join(root, "config", "assistant.config.json"), "utf8")).resolves.toContain(
      '"defaultToolProfile"',
    );
    await expect(readFile(path.join(root, "config", "goatcitadel.json"), "utf8")).resolves.toContain('"version"');
  });

  it("leaves split config alone when unified config is missing and creation is disabled", async () => {
    const root = await makeTempRoot();
    await seedSplitFiles(root);

    await expect(syncUnifiedConfig(root)).resolves.toEqual({
      unifiedPath: path.join(root, "config", "goatcitadel.json"),
      createdUnified: false,
      materializedExamples: [],
      syncedSections: [],
    });
    await expect(readFile(path.join(root, "config", "goatcitadel.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects malformed unified config payloads before writing split files", async () => {
    const root = await makeTempRoot();
    const unifiedPath = path.join(root, "config", "goatcitadel.json");

    await writeFile(unifiedPath, "[]", "utf8");
    await expect(syncUnifiedConfig(root)).rejects.toThrow("Unified config must be a JSON object");

    await writeFile(unifiedPath, JSON.stringify({ assistant: [] }), "utf8");
    await expect(syncUnifiedConfig(root)).rejects.toThrow("Invalid section for assistant.config.json");

    await writeFile(unifiedPath, JSON.stringify({ cronJobs: "bad" }), "utf8");
    await expect(syncUnifiedConfig(root)).rejects.toThrow("Invalid section for cron-jobs.json");
  });

  it("warns before overriding a newer split config with unified values", async () => {
    const root = await makeTempRoot();
    const configDir = path.join(root, "config");
    const unifiedPath = path.join(configDir, "goatcitadel.json");
    const splitPath = path.join(configDir, "assistant.config.json");
    await writeFile(
      unifiedPath,
      JSON.stringify({ version: 1, assistant: { defaultToolProfile: "unified" } }, null, 2),
      "utf8",
    );
    await writeFile(splitPath, JSON.stringify({ defaultToolProfile: "split-newer" }, null, 2), "utf8");
    const future = new Date(Date.now() + 60_000);
    await utimes(splitPath, future, future);
    process.env.GOATCITADEL_VERBOSE = "true";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await syncUnifiedConfig(root);

    expect(result.syncedSections).toEqual(["assistant.config.json"]);
    expect(JSON.parse(await readFile(splitPath, "utf8"))).toEqual({ defaultToolProfile: "unified" });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[goatcitadel:config] warning: assistant.config.json is newer"),
    );
  });
});

async function makeTempRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `goatcitadel-config-sync-${randomUUID()}`);
  TEMP_ROOTS.push(root);
  await mkdir(path.join(root, "config"), { recursive: true });
  return root;
}

async function seedSplitFiles(root: string): Promise<void> {
  const configDir = path.join(root, "config");
  await writeFile(
    path.join(configDir, "assistant.config.json"),
    JSON.stringify(
      {
        environment: "local",
        defaultToolProfile: "minimal",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "tool-policy.json"),
    JSON.stringify(
      {
        profiles: { minimal: ["session.status"] },
        tools: { profile: "minimal", allow: [], deny: [] },
        agents: {},
        sandbox: {
          writeJailRoots: ["./workspace"],
          readOnlyRoots: ["./config"],
          networkAllowlist: [],
          riskyShellPatterns: [],
          requireApprovalForRiskyShell: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "budgets.json"),
    JSON.stringify(
      {
        mode: "balanced",
        daily: {
          tokensWarning: 100,
          tokensHardCap: 200,
          usdWarning: 1,
          usdHardCap: 2,
        },
        session: {
          tokensHardCap: 50,
          turnMaxInputTokens: 10,
          turnMaxOutputTokens: 20,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "llm-providers.json"),
    JSON.stringify(
      {
        activeProviderId: "local",
        providers: [
          {
            providerId: "local",
            label: "Local",
            baseUrl: "http://127.0.0.1:1234/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "local-model",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "cron-jobs.json"),
    JSON.stringify(
      {
        jobs: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function writeExampleSplitFiles(root: string): Promise<void> {
  const configDir = path.join(root, "config");
  await writeFile(
    path.join(configDir, "assistant.config.example.json"),
    JSON.stringify(
      {
        environment: "local",
        defaultToolProfile: "minimal",
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "tool-policy.example.json"),
    JSON.stringify(
      {
        profiles: { minimal: ["session.status"] },
        tools: { profile: "minimal", allow: [], deny: [] },
        agents: {},
        sandbox: {
          writeJailRoots: ["./workspace"],
          readOnlyRoots: ["./config"],
          networkAllowlist: [],
          riskyShellPatterns: [],
          requireApprovalForRiskyShell: true,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "budgets.example.json"),
    JSON.stringify(
      {
        mode: "balanced",
        daily: {
          tokensWarning: 100,
          tokensHardCap: 200,
          usdWarning: 1,
          usdHardCap: 2,
        },
        session: {
          tokensHardCap: 50,
          turnMaxInputTokens: 10,
          turnMaxOutputTokens: 20,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "llm-providers.example.json"),
    JSON.stringify(
      {
        activeProviderId: "local",
        providers: [
          {
            providerId: "local",
            label: "Local",
            baseUrl: "http://127.0.0.1:1234/v1",
            apiStyle: "openai-chat-completions",
            defaultModel: "local-model",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(configDir, "cron-jobs.example.json"),
    JSON.stringify(
      {
        jobs: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}
