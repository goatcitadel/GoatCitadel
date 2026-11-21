import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectAssistantSourceFingerprint } from "./source-fingerprint.mjs";

test("native source identity includes untracked product code and excludes operator workspace files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gc-parity-source-"));
  try {
    // This is new, throwaway fixture metadata. The product checkout's Git state is untouched.
    execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
    await fs.mkdir(path.join(root, "apps"));
    await fs.mkdir(path.join(root, "workspace"));
    await fs.writeFile(path.join(root, "apps", "untracked.ts"), "export const behavior = 1;\n");
    const first = await collectAssistantSourceFingerprint(root);
    assert.equal(first.entries.length, 1);
    assert.equal(first.entries[0].path, "apps/untracked.ts");
    await fs.writeFile(path.join(root, "workspace", "private.txt"), "Operator data must not enter source evidence.");
    assert.equal((await collectAssistantSourceFingerprint(root)).sha256, first.sha256);
    await fs.writeFile(path.join(root, "apps", "untracked.ts"), "export const behavior = 2;\n");
    assert.notEqual((await collectAssistantSourceFingerprint(root)).sha256, first.sha256);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
