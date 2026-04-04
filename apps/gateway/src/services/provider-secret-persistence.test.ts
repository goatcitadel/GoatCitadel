import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, it } from "vitest";
import {
  deleteProviderApiKeyWithFallback,
  persistProviderApiKeyWithFallback,
} from "./provider-secret-persistence.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("provider secret persistence fallback", () => {
  it("writes the provider secret to the local env file when keychain storage is unavailable", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-provider-secret-test-"));
    TEMP_ROOTS.push(tempRoot);
    await mkdir(path.join(tempRoot, "config"), { recursive: true });
    await writeFile(path.join(tempRoot, "config", "assistant.config.json"), "{}\n", "utf8");
    const envPath = path.join(tempRoot, ".env");
    const env: NodeJS.ProcessEnv = {};
    const llmService = createStubLlmService({
      providerId: "openai",
      apiKeyRef: "OPENAI_API_KEY",
      setError: new Error("Secure keychain is unavailable on this host. Use apiKeyEnv for env-backed secrets."),
    });

    const status = persistProviderApiKeyWithFallback({
      providerId: "openai",
      apiKey: "sk-test-value",
      rootDir: tempRoot,
      llmService,
      env,
    });

    assert.deepEqual(status, {
      providerId: "openai",
      hasSecret: true,
      source: "env",
    });
    assert.equal(env.OPENAI_API_KEY, "sk-test-value");
    const raw = await readFile(envPath, "utf8");
    assert.match(raw, /OPENAI_API_KEY="sk-test-value"/);
  });

  it("removes env-backed provider secrets from both process env and local env file", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-provider-secret-delete-test-"));
    TEMP_ROOTS.push(tempRoot);
    await mkdir(path.join(tempRoot, "config"), { recursive: true });
    await writeFile(path.join(tempRoot, "config", "assistant.config.json"), "{}\n", "utf8");
    const envPath = path.join(tempRoot, ".env");
    await writeFile(envPath, "OPENAI_API_KEY=\"sk-test-value\"\n", "utf8");
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_KEY: "sk-test-value",
    };
    const llmService = createStubLlmService({
      providerId: "openai",
      apiKeyRef: "OPENAI_API_KEY",
      statusSource: "env",
    });

    const status = deleteProviderApiKeyWithFallback({
      providerId: "openai",
      rootDir: tempRoot,
      llmService,
      env,
    });

    assert.deepEqual(status, {
      providerId: "openai",
      hasSecret: false,
      source: "none",
    });
    assert.equal(env.OPENAI_API_KEY, undefined);
    const raw = await readFile(envPath, "utf8");
    assert.doesNotMatch(raw, /OPENAI_API_KEY=/);
  });
});

function createStubLlmService(options: {
  providerId: string;
  apiKeyRef: string;
  setError?: Error;
  statusSource?: "none" | "keychain" | "env" | "inline";
}) {
  return {
    setProviderApiKey: () => {
      if (options.setError) {
        throw options.setError;
      }
    },
    deleteProviderApiKey: () => undefined,
    getProviderSecretStatus: (providerId: string) => ({
      providerId,
      hasApiKey: options.statusSource !== "none",
      apiKeySource: options.statusSource ?? "none",
    }),
    getRuntimeConfig: () => ({
      providers: [
        {
          providerId: options.providerId,
          apiKeyRef: options.apiKeyRef,
        },
      ],
    }),
  };
}
