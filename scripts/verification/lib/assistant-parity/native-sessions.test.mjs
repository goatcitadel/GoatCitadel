import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sha256 } from "../agent-comparison.mjs";
import { loadReviewedNativeSessions } from "./native-sessions.mjs";

test("the CLI driver module must match reviewed bytes before any factory runs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-reviewed-sessions-"));
  try {
    const file = path.join(root, "driver.mjs"),
      code = "export async function createReviewedNativeSessions(){return {reviewed:true};}\n";
    await fs.writeFile(file, code);
    const options = {
      providerConfig: { nativeSessionsModule: { path: "driver.mjs", sha256: "0".repeat(64) } },
      providerConfigBaseDir: root,
      root,
    };
    await assert.rejects(loadReviewedNativeSessions(options), /changed after review/);
    options.providerConfig.nativeSessionsModule.sha256 = sha256(code);
    assert.deepEqual(await loadReviewedNativeSessions(options), { reviewed: true });
    await fs.appendFile(file, "// changed\n");
    await assert.rejects(loadReviewedNativeSessions(options), /changed after review/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("gc-reviewed-sessions-"));
    await fs.rm(root, { recursive: true, force: true });
  }
});
