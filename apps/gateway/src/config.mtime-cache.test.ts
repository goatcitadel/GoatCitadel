import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetConfigMtimeCacheForTests, loadGatewayConfig } from "./config.js";

const TEMP_ROOTS: string[] = [];

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createConfigFixture(): Promise<{ rootDir: string; configDir: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-config-cache-"));
  TEMP_ROOTS.push(rootDir);
  const configDir = path.join(rootDir, "config");
  await mkdir(configDir, { recursive: true });

  await writeJson(path.join(configDir, "assistant.config.json"), {
    auth: { mode: "none" },
    durable: {
      enabled: false,
      executionEnabled: false,
      chatAutoPromoteEnabled: false,
    },
    features: { durableKernelV1Enabled: false },
  });

  await writeJson(path.join(configDir, "tool-policy.json"), {
    profiles: {},
    tools: { profile: "minimal", allow: [], deny: [] },
    agents: {},
    sandbox: { writeJailRoots: [], readOnlyRoots: [] },
  });

  await writeJson(path.join(configDir, "budgets.json"), {
    mode: "balanced",
    daily: { tokensWarning: 1000, tokensHardCap: 2000, usdWarning: 1, usdHardCap: 2 },
    session: { tokensHardCap: 1000, turnMaxInputTokens: 500, turnMaxOutputTokens: 500 },
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

beforeEach(() => {
  __resetConfigMtimeCacheForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("loadGatewayConfig mtime cache", () => {
  it("returns the cached config (same reference) when no source mtime advances", async () => {
    const { rootDir } = await createConfigFixture();
    const first = await loadGatewayConfig(rootDir);
    const second = await loadGatewayConfig(rootDir);
    // Reference identity is the strongest signal that we short-circuited the
    // parse + validate pipeline — only a cache hit can return the same object.
    expect(second).toBe(first);
    expect(second).toEqual(first);
  });

  it("invalidates cache when any source file mtime advances", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const first = await loadGatewayConfig(rootDir);

    // Advance assistant.config.json mtime well beyond any clock resolution.
    const configFile = path.join(configDir, "assistant.config.json");
    const newMtime = new Date(Date.now() + 60_000);
    await utimes(configFile, newMtime, newMtime);

    const readSpy = vi.spyOn(fsPromises, "readFile");
    const second = await loadGatewayConfig(rootDir);

    // Cache should have been invalidated and the loader should have re-read files.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    const configReads = readSpy.mock.calls.filter(([target]) => {
      return typeof target === "string" && target.endsWith("assistant.config.json");
    });
    expect(configReads.length).toBeGreaterThan(0);
  });

  it("invalidates cache when tool-policy.json mtime advances", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const first = await loadGatewayConfig(rootDir);

    const target = path.join(configDir, "tool-policy.json");
    const newMtime = new Date(Date.now() + 60_000);
    await utimes(target, newMtime, newMtime);

    const second = await loadGatewayConfig(rootDir);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("invalidates cache when budgets.json mtime advances", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const first = await loadGatewayConfig(rootDir);

    const target = path.join(configDir, "budgets.json");
    const newMtime = new Date(Date.now() + 60_000);
    await utimes(target, newMtime, newMtime);

    const second = await loadGatewayConfig(rootDir);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("invalidates cache when llm-providers.json mtime advances", async () => {
    const { rootDir, configDir } = await createConfigFixture();
    const first = await loadGatewayConfig(rootDir);

    const target = path.join(configDir, "llm-providers.json");
    const newMtime = new Date(Date.now() + 60_000);
    await utimes(target, newMtime, newMtime);

    const second = await loadGatewayConfig(rootDir);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("misses the cache when a different rootDir is requested", async () => {
    const { rootDir: rootA } = await createConfigFixture();
    const { rootDir: rootB } = await createConfigFixture();
    const a = await loadGatewayConfig(rootA);
    const b = await loadGatewayConfig(rootB);
    // Distinct rootDirs must produce distinct results — the single-slot cache
    // must not return rootA's value for a rootB request.
    expect(a.rootDir).not.toBe(b.rootDir);
    expect(b).not.toBe(a);
    // After switching back to rootA, the cache (now holding rootB) must miss
    // and rebuild — i.e. cache key includes rootDir.
    const readSpy = vi.spyOn(fsPromises, "readFile");
    const aAgain = await loadGatewayConfig(rootA);
    expect(aAgain.rootDir).toBe(a.rootDir);
    const aReads = readSpy.mock.calls.filter(([target]) => {
      return typeof target === "string" && target.endsWith("assistant.config.json");
    });
    expect(aReads.length).toBeGreaterThan(0);
  });
});
