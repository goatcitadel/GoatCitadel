import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const candidateFiles = getChangedTypeScriptFiles(repoRoot);
const violations = [];

for (const relativePath of candidateFiles) {
  if (!fs.existsSync(relativePath)) {
    continue;
  }
  const diff = readUnifiedDiff(repoRoot, relativePath);
  const addedLines = diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  for (const line of addedLines) {
    if (/catch\s*\{\s*\}/.test(line.slice(1))) {
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

function getChangedTypeScriptFiles(cwd) {
  try {
    const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], {
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

function readUnifiedDiff(cwd, relativePath) {
  try {
    return execFileSync("git", ["diff", "--unified=0", "HEAD", "--", relativePath], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}
