import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { repoRoot } from "../shared.mjs";
import { prepareUsabilityRuntime } from "./usability-runtime-fixture.mjs";

test("fresh browser fixtures exclude operator config, private workspaces and schedules", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "goat-usability-isolation-test-"));
  try {
    const sourceRoot = path.join(parent, "source");
    await fs.mkdir(path.join(sourceRoot, "config"), { recursive: true });
    await fs.copyFile(path.join(repoRoot, "config", "goatcitadel.example.json"),
      path.join(sourceRoot, "config", "goatcitadel.example.json"));
    const privateBytes = "operator-only-canary";
    for (const filename of ["goatcitadel.json", "assistant.config.json", "llm-providers.json",
      "cron-jobs.json", "llm-model-metadata.json", "credentials.json"]) {
      await fs.writeFile(path.join(sourceRoot, "config", filename), privateBytes);
    }
    await fs.mkdir(path.join(sourceRoot, "workspaces", "private"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "workspaces", "private", "MEMORY.md"), privateBytes);
    await fs.mkdir(path.join(sourceRoot, "skills", "shipped"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "skills", "shipped", "SKILL.md"), "shipped skill fixture");
    const root = await prepareUsabilityRuntime("fixture", "http://127.0.0.1:12345/v1", { sourceRoot, tempParent: parent });
    assert.equal(path.dirname(root), parent);
    const files = await fs.readdir(path.join(root, "config"));
    assert.ok(!files.includes("credentials.json"));
    for (const filename of files) {
      assert.ok(!(await fs.readFile(path.join(root, "config", filename), "utf8")).includes(privateBytes));
    }
    await assert.rejects(fs.stat(path.join(root, "workspaces")), { code: "ENOENT" });
    const unified = JSON.parse(await fs.readFile(path.join(root, "config", "goatcitadel.json"), "utf8"));
    assert.equal(unified.generation, undefined);
    assert.deepEqual(unified.cronJobs, { jobs: [] });
    assert.equal(unified.llm.providers.length, 1);
    assert.equal(unified.llm.providers[0].baseUrl, "http://127.0.0.1:12345/v1");
    assert.equal(unified.assistant.dataDir, "./data");
    for (const [filename, section] of Object.entries({
      "assistant.config.json": "assistant", "tool-policy.json": "toolPolicy", "budgets.json": "budgets",
      "llm-providers.json": "llm", "cron-jobs.json": "cronJobs",
    })) {
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, "config", filename), "utf8")), unified[section]);
    }
    assert.equal(await fs.readFile(path.join(root, "skills", "shipped", "SKILL.md"), "utf8"), "shipped skill fixture");
    assert.equal(await fs.readFile(path.join(sourceRoot, "config", "goatcitadel.json"), "utf8"), privateBytes);
  } finally {
    // This exact temporary parent owns both the fake source and returned runtime.
    await fs.rm(parent, { recursive: true, force: true });
  }
});
