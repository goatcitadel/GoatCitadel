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
  violations.push(...findEmptyCatchViolations(relativePath, source));
}

if (violations.length > 0) {
  console.error("Empty catch blocks are not allowed in tracked TypeScript files:");
  for (const violation of violations) {
    console.error(`- ${violation.path}:${violation.line} (${violation.kind})`);
  }
  process.exit(1);
}

function findEmptyCatchViolations(relativePath, source) {
  const fileViolations = [];
  const patterns = [
    { kind: "catch-block", regex: /catch\s*(?:\([^)]*\)\s*)?\{([\s\S]*?)\}/gm },
    {
      kind: "promise-catch",
      regex: /\.catch\(\s*(?:\([^)]*\)|[$A-Z_a-z][$\w]*)\s*=>\s*\{([\s\S]*?)\}\s*\)/gm,
    },
  ];
  for (const { kind, regex } of patterns) {
    for (const match of source.matchAll(regex)) {
      const body = match[1] ?? "";
      if (isEffectivelyEmpty(body) && !hasExplicitEmptyCatchRationale(body)) {
        fileViolations.push({
          path: relativePath,
          line: lineNumberAt(source, match.index ?? 0),
          kind,
        });
      }
    }
  }
  return fileViolations;
}

function isEffectivelyEmpty(body) {
  return (
    body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\r\n]*/g, "$1")
      .trim() === ""
  );
}

function hasExplicitEmptyCatchRationale(body) {
  const comments = [...body.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)].map((match) => match[0]).join("\n");
  return /\b(ignore|ignored|skip|preserve|leave|keep|fallback|fall back|fall through|rethrow|continue|searching|cached state|restrict|already|surfaced|convenience|reinstall|proof available|best[- ]?effort|intentionally|optional|non[- ]?fatal|not fatal|shutdown|cleanup|no-op|noop)\b/i.test(
    comments,
  );
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
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
