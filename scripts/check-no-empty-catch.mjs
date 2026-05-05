import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const candidateFiles = getTrackedTypeScriptFiles(repoRoot);
const violations = [];

for (const relativePath of candidateFiles) {
  if (!fs.existsSync(relativePath)) {
    continue;
  }
  const source = fs.readFileSync(relativePath, "utf8");
  for (const line of source.split(/\r?\n/)) {
    if (/catch\s*\{\s*\}/.test(line)) {
      violations.push(relativePath);
      break;
    }
  }
}

if (violations.length > 0) {
  console.error("Empty catch blocks are not allowed in changed TypeScript files:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

function getTrackedTypeScriptFiles(cwd) {
  try {
    const output = execFileSync("git", ["ls-files", "*.ts", "*.tsx", "*.mts", "*.cts"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter((entry) => /\.(ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith(".d.ts"));
  } catch {
    return [];
  }
}
