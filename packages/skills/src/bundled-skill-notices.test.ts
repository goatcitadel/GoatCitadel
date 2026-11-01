import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const bundledDir = path.join(repoRoot, "skills", "bundled");

// A bundled folder that vendors third-party text records it in UPSTREAM.md; the repo-wide notices must name it.
const adaptedFolders = fs
  .readdirSync(bundledDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(bundledDir, entry.name, "UPSTREAM.md")))
  .map((entry) => entry.name)
  .sort();

describe("bundled skill third-party notices", () => {
  it.each(adaptedFolders)("THIRD_PARTY_NOTICES.md names skills/bundled/%s/", (folder) => {
    const notices = fs.readFileSync(path.join(repoRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
    expect(notices).toContain(`skills/bundled/${folder}/`);
    expect(fs.existsSync(path.join(bundledDir, folder, "LICENSE"))).toBe(true);
  });
});
