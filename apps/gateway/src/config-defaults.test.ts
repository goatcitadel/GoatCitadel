import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("shipped config defaults", () => {
  it("keep fresh local installs on unauthenticated startup defaults", async () => {
    const assistantRaw = await readFile(path.join(repoRoot, "config", "assistant.config.example.json"), "utf8");
    const unifiedRaw = await readFile(path.join(repoRoot, "config", "goatcitadel.example.json"), "utf8");
    const llmRaw = await readFile(path.join(repoRoot, "config", "llm-providers.example.json"), "utf8");

    const assistant = JSON.parse(assistantRaw) as {
      auth?: { mode?: string };
      web?: { firecrawl?: { enabled?: boolean; baseUrl?: string } };
      database?: { driver?: string };
    };
    const unified = JSON.parse(unifiedRaw) as {
      assistant?: {
        auth?: { mode?: string };
        web?: { firecrawl?: { enabled?: boolean; baseUrl?: string } };
        database?: { driver?: string };
      };
      llm?: { activeProviderId?: string; activeModel?: string };
    };
    const llm = JSON.parse(llmRaw) as { activeProviderId?: string; activeModel?: string };

    expect(assistant.auth?.mode ?? "none").toBe("none");
    expect(assistant.database?.driver ?? "").toBe("postgres");
    expect(assistant.web?.firecrawl?.enabled ?? false).toBe(true);
    expect(assistant.web?.firecrawl?.baseUrl ?? "").toBe("http://127.0.0.1:3002");
    expect(unified.assistant?.auth?.mode ?? "none").toBe("none");
    expect(unified.assistant?.database?.driver ?? "").toBe("postgres");
    expect(unified.assistant?.web?.firecrawl?.enabled ?? false).toBe(true);
    expect(unified.llm?.activeProviderId ?? "").toBe("");
    expect(unified.llm?.activeModel ?? "").toBe("");
    expect(llm.activeProviderId ?? "").toBe("");
    expect(llm.activeModel ?? "").toBe("");
  });
});
