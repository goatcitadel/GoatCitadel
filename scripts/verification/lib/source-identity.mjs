import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

/** Source identity covers tracked and new implementation files, never generated evidence or operator secrets. */
export async function verificationSourceDigest(repoRoot) {
  const { stdout } = await promisify(execFile)(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps",
      "packages",
      "scripts",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      // Visual baselines are evidence the visual-rebaseline lane writes; they must not read as implementation drift.
      // Other baselines (API allowlists, architecture metrics, migrations) are proof inputs and stay in the digest.
      ":(exclude)scripts/verification/baselines/visual",
    ],
    { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  for (let offset = 0; offset < files.length; offset += 32) {
    const batch = files.slice(offset, offset + 32);
    const contents = await Promise.all(
      batch.map(async (file) => {
        try {
          return await fs.readFile(path.join(repoRoot, file));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          return Buffer.from("[deleted]");
        }
      }),
    );
    for (let index = 0; index < batch.length; index++) {
      hash.update(batch[index]);
      hash.update("\0");
      hash.update(createHash("sha256").update(contents[index]).digest());
    }
  }
  return hash.digest("hex");
}
