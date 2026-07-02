import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("shipped config defaults", () => {
  it("keep fresh local installs on unauthenticated startup defaults", async () => {
    const assistantRaw = await readFile(path.join(repoRoot, "config", "assistant.config.example.json"), "utf8");
    const unifiedRaw = await readFile(path.join(repoRoot, "config", "goatcitadel.example.json"), "utf8");
    const toolPolicyRaw = await readFile(path.join(repoRoot, "config", "tool-policy.example.json"), "utf8");
    const budgetsRaw = await readFile(path.join(repoRoot, "config", "budgets.example.json"), "utf8");
    const llmRaw = await readFile(path.join(repoRoot, "config", "llm-providers.example.json"), "utf8");
    const cronJobsRaw = await readFile(path.join(repoRoot, "config", "cron-jobs.example.json"), "utf8");

    const assistant = JSON.parse(assistantRaw) as {
      auth?: { mode?: string };
      capabilities?: { codeModeDockerBackend?: { requireDigestPin?: boolean } };
      web?: {
        firecrawl?: {
          enabled?: boolean;
          baseUrl?: string;
          apiKeyEnv?: string;
          defaultReadBackend?: string;
          fallbackToNative?: boolean;
        };
      };
      database?: { driver?: string; bundledPostgres?: { startTimeoutMs?: number } };
    };
    const unified = JSON.parse(unifiedRaw) as {
      assistant?: {
        auth?: { mode?: string };
        capabilities?: { codeModeDockerBackend?: { requireDigestPin?: boolean } };
        web?: {
          firecrawl?: {
            enabled?: boolean;
            baseUrl?: string;
            apiKeyEnv?: string;
            defaultReadBackend?: string;
            fallbackToNative?: boolean;
          };
        };
        database?: { driver?: string; bundledPostgres?: { startTimeoutMs?: number } };
      };
      llm?: { activeProviderId?: string; activeModel?: string };
      toolPolicy?: unknown;
      budgets?: unknown;
      cronJobs?: unknown;
    };
    const llm = JSON.parse(llmRaw) as { activeProviderId?: string; activeModel?: string };

    expect(assistant.auth?.mode ?? "none").toBe("none");
    expect(assistant.database?.driver ?? "").toBe("postgres");
    expect(assistant.database?.bundledPostgres?.startTimeoutMs ?? 0).toBeGreaterThanOrEqual(90_000);
    expect(assistant.database?.bundledPostgres?.startTimeoutMs ?? 0).toBeLessThanOrEqual(120_000);
    expect(assistant.web?.firecrawl?.enabled ?? false).toBe(true);
    expect(assistant.web?.firecrawl?.baseUrl ?? "").toBe("http://127.0.0.1:3002");
    expect(assistant.web?.firecrawl?.apiKeyEnv ?? "").toBe("FIRECRAWL_API_KEY");
    expect(assistant.web?.firecrawl?.defaultReadBackend ?? "").toBe("firecrawl");
    expect(assistant.web?.firecrawl?.fallbackToNative ?? false).toBe(true);
    expect(assistant.capabilities?.codeModeDockerBackend?.requireDigestPin ?? false).toBe(true);
    expect(unified.assistant?.auth?.mode ?? "none").toBe("none");
    expect(unified.assistant?.database?.driver ?? "").toBe("postgres");
    expect(unified.assistant?.database?.bundledPostgres?.startTimeoutMs ?? 0).toBeGreaterThanOrEqual(90_000);
    expect(unified.assistant?.database?.bundledPostgres?.startTimeoutMs ?? 0).toBeLessThanOrEqual(120_000);
    expect(unified.assistant?.web?.firecrawl?.enabled ?? false).toBe(true);
    expect(unified.assistant?.web?.firecrawl?.apiKeyEnv ?? "").toBe("FIRECRAWL_API_KEY");
    expect(unified.assistant?.web?.firecrawl?.defaultReadBackend ?? "").toBe("firecrawl");
    expect(unified.assistant?.capabilities?.codeModeDockerBackend?.requireDigestPin ?? false).toBe(true);
    expect(unified.llm?.activeProviderId ?? "").toBe("");
    expect(unified.llm?.activeModel ?? "").toBe("");
    expect(llm.activeProviderId ?? "").toBe("");
    expect(llm.activeModel ?? "").toBe("");
    expect(unified.assistant).toEqual(assistant);
    expect(unified.toolPolicy).toEqual(JSON.parse(toolPolicyRaw));
    expect(unified.budgets).toEqual(JSON.parse(budgetsRaw));
    expect(unified.llm).toEqual(llm);
    expect(unified.cronJobs).toEqual(JSON.parse(cronJobsRaw));
  });
});
