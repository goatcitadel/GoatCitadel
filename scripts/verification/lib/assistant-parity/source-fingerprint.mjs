import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Hash the actual product sources, including new files that have not been
 * committed. Personal workspace data and ignored runtime profiles are excluded. */
export async function collectAssistantSourceFingerprint(root) {
  const names = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "apps", "packages", "scripts", "config"],
    { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  const entries = [];
  for (const name of [...new Set(names.split("\0").filter(Boolean))].sort()) {
    if (path.isAbsolute(name) || name.split(/[\\/]/u).some((part) => part === ".."))
      throw new Error("Source evidence must stay within the product checkout.");
    try {
      entries.push({ path: name.replaceAll("\\", "/"), sha256: digest(await fs.readFile(path.join(root, name))) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push({ path: name.replaceAll("\\", "/"), deleted: true });
    }
  }
  return { sha256: digest(JSON.stringify(entries)), fileCount: entries.length, entries };
}
