import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { verificationSourceDigest } from "./source-identity.mjs";

const git = (cwd, ...args) => promisify(execFile)("git", args, { cwd });

describe("verificationSourceDigest", () => {
  it("keeps other baselines, such as an API allowlist, in the digest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-identity-"));
    try {
      await git(root, "init", "-q");
      const allowlist = path.join(root, "scripts", "verification", "baselines", "api-compat", "allowlist.json");
      await fs.mkdir(path.dirname(allowlist), { recursive: true });
      await fs.writeFile(allowlist, "[]");
      const before = await verificationSourceDigest(root);

      await fs.writeFile(allowlist, '["GET /api/v1/anything"]');
      assert.notEqual(await verificationSourceDigest(root), before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("changes with implementation files but not with regenerated visual baselines", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "source-identity-"));
    try {
      await git(root, "init", "-q");
      const baseline = path.join(root, "scripts", "verification", "baselines", "visual", "a.png");
      await fs.mkdir(path.dirname(baseline), { recursive: true });
      await fs.mkdir(path.join(root, "apps"), { recursive: true });
      await fs.writeFile(baseline, "old");
      await fs.writeFile(path.join(root, "apps", "x.ts"), "export const x = 1;");
      const before = await verificationSourceDigest(root);

      await fs.writeFile(baseline, "new");
      assert.equal(await verificationSourceDigest(root), before);

      await fs.writeFile(path.join(root, "apps", "x.ts"), "export const x = 2;");
      assert.notEqual(await verificationSourceDigest(root), before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
