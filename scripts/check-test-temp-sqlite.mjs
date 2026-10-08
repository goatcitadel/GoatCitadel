import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Tests must not drop SQLite files straight into os.tmpdir(). The old pattern
// (`path.join(os.tmpdir(), \`name-${randomUUID()}.db\`)` plus a best-effort rm)
// failed silently on Windows whenever the handle was still open, and one suite
// run left thousands of multi-MB databases in %TEMP%. Put each database in its
// own mkdtemp directory instead (storage tests: `TempSqliteFiles` from
// packages/storage/src/temp-sqlite.test-support.ts), close it, then remove the
// directory.
const directTempSqlitePattern = /\b(?:join|resolve)\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(?:`[^`]*|"[^"]*|'[^']*)\.(?:db|sqlite3?)\b/g;

export function findTempSqliteViolations(relativePath, source) {
  const violations = [];
  directTempSqlitePattern.lastIndex = 0;
  for (const match of source.matchAll(directTempSqlitePattern)) {
    violations.push({ path: relativePath, line: lineNumberAt(source, match.index ?? 0), snippet: match[0] });
  }
  return violations;
}

export function isTestSource(relativePath) {
  return /\.test\.(?:ts|tsx|mts|mjs)$|\.test-support\.ts$|test-(?:fixture|helpers?)s?\.ts$/.test(relativePath);
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function getTrackedTestFiles(cwd) {
  const output = execFileSync("git", ["ls-files", "apps", "packages", "scripts"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry && isTestSource(entry));
}

function main() {
  const violations = [];
  for (const relativePath of getTrackedTestFiles(process.cwd())) {
    if (!fs.existsSync(relativePath)) {
      continue;
    }
    violations.push(...findTempSqliteViolations(relativePath, fs.readFileSync(relativePath, "utf8")));
  }
  if (violations.length > 0) {
    console.error("Tests must create SQLite files inside a per-test mkdtemp directory, not directly in os.tmpdir():");
    for (const violation of violations) {
      console.error(`- ${violation.path}:${violation.line} ${violation.snippet}`);
    }
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
