import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, it } from "vitest";
import { deleteLocalEnvVar, loadLocalEnvFile, upsertLocalEnvVar } from "./env-file.js";

const TEMP_ROOTS: string[] = [];

afterEach(async () => {
  while (TEMP_ROOTS.length > 0) {
    const next = TEMP_ROOTS.pop();
    if (next) {
      await rm(next, { recursive: true, force: true });
    }
  }
});

describe("loadLocalEnvFile", () => {
  it("loads keys from .env without overriding existing shell environment", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-test-"));
    TEMP_ROOTS.push(tempRoot);
    await mkdir(path.join(tempRoot, "config"), { recursive: true });
    await writeFile(path.join(tempRoot, "config", "assistant.config.json"), "{}\n", "utf8");
    await writeFile(
      path.join(tempRoot, ".env"),
      [
        "OPENAI_API_KEY=from-dotenv",
        "GLM_API_KEY=\"glm value\"",
        "MOONSHOT_API_KEY='moonshot value'",
        "",
      ].join("\n"),
      "utf8",
    );

    const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
    const priorOpenai = process.env.OPENAI_API_KEY;
    const priorGlm = process.env.GLM_API_KEY;
    const priorMoonshot = process.env.MOONSHOT_API_KEY;

    try {
      process.env.GOATCITADEL_ROOT_DIR = tempRoot;
      process.env.OPENAI_API_KEY = "from-shell";
      delete process.env.GLM_API_KEY;
      delete process.env.MOONSHOT_API_KEY;

      const result = loadLocalEnvFile({ forceReload: true });
      assert.equal(result.path, path.join(tempRoot, ".env"));
      assert.equal(process.env.OPENAI_API_KEY, "from-shell");
      assert.equal(process.env.GLM_API_KEY, "glm value");
      assert.equal(process.env.MOONSHOT_API_KEY, "moonshot value");
    } finally {
      if (priorRoot === undefined) {
        delete process.env.GOATCITADEL_ROOT_DIR;
      } else {
        process.env.GOATCITADEL_ROOT_DIR = priorRoot;
      }

      if (priorOpenai === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = priorOpenai;
      }
      if (priorGlm === undefined) {
        delete process.env.GLM_API_KEY;
      } else {
        process.env.GLM_API_KEY = priorGlm;
      }
      if (priorMoonshot === undefined) {
        delete process.env.MOONSHOT_API_KEY;
      } else {
        process.env.MOONSHOT_API_KEY = priorMoonshot;
      }
    }
  });

  it("updates or appends env vars in the detected local env file", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-update-test-"));
    TEMP_ROOTS.push(tempRoot);
    await mkdir(path.join(tempRoot, "config"), { recursive: true });
    await writeFile(path.join(tempRoot, "config", "assistant.config.json"), "{}\n", "utf8");
    const envPath = path.join(tempRoot, ".env");
    await writeFile(
      envPath,
      [
        "# test env",
        "GOATCITADEL_AUTH_MODE=token",
        "",
      ].join("\n"),
      "utf8",
    );

    const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
    try {
      process.env.GOATCITADEL_ROOT_DIR = tempRoot;

      const first = upsertLocalEnvVar("GOATCITADEL_AUTH_TOKEN", "abc123");
      assert.equal(first.path, envPath);
      assert.equal(first.updated, true);

      const second = upsertLocalEnvVar("GOATCITADEL_AUTH_MODE", "basic");
      assert.equal(second.path, envPath);
      assert.equal(second.updated, true);

      const raw = await readFile(envPath, "utf8");
      assert.match(raw, /GOATCITADEL_AUTH_TOKEN="abc123"/);
      assert.match(raw, /GOATCITADEL_AUTH_MODE="basic"/);
    } finally {
      if (priorRoot === undefined) {
        delete process.env.GOATCITADEL_ROOT_DIR;
      } else {
        process.env.GOATCITADEL_ROOT_DIR = priorRoot;
      }
    }
  });

  it("creates a local .env file when a repo root exists but no env file has been materialized yet", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-create-test-"));
    TEMP_ROOTS.push(tempRoot);
    await mkdir(path.join(tempRoot, "config"), { recursive: true });
    await writeFile(path.join(tempRoot, "config", "assistant.config.json"), "{}\n", "utf8");
    const envPath = path.join(tempRoot, ".env");

    const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
    try {
      process.env.GOATCITADEL_ROOT_DIR = tempRoot;

      const result = upsertLocalEnvVar("OPENAI_API_KEY", "sk-test-value");
      assert.equal(result.path, envPath);
      assert.equal(result.updated, true);

      const raw = await readFile(envPath, "utf8");
      assert.match(raw, /OPENAI_API_KEY="sk-test-value"/);
    } finally {
      if (priorRoot === undefined) {
        delete process.env.GOATCITADEL_ROOT_DIR;
      } else {
        process.env.GOATCITADEL_ROOT_DIR = priorRoot;
      }
    }
  });

  it("removes env vars from the detected local env file", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "goatcitadel-env-delete-test-"));
    TEMP_ROOTS.push(tempRoot);
    await mkdir(path.join(tempRoot, "config"), { recursive: true });
    await writeFile(path.join(tempRoot, "config", "assistant.config.json"), "{}\n", "utf8");
    const envPath = path.join(tempRoot, ".env");
    await writeFile(
      envPath,
      [
        "OPENAI_API_KEY=\"sk-test-value\"",
        "GLM_API_KEY=\"glm-test-value\"",
        "",
      ].join("\n"),
      "utf8",
    );

    const priorRoot = process.env.GOATCITADEL_ROOT_DIR;
    try {
      process.env.GOATCITADEL_ROOT_DIR = tempRoot;

      const result = deleteLocalEnvVar("OPENAI_API_KEY");
      assert.equal(result.path, envPath);
      assert.equal(result.updated, true);

      const raw = await readFile(envPath, "utf8");
      assert.doesNotMatch(raw, /OPENAI_API_KEY=/);
      assert.match(raw, /GLM_API_KEY="glm-test-value"/);
    } finally {
      if (priorRoot === undefined) {
        delete process.env.GOATCITADEL_ROOT_DIR;
      } else {
        process.env.GOATCITADEL_ROOT_DIR = priorRoot;
      }
    }
  });
});
