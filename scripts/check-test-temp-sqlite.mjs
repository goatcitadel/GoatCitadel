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
const sqliteNamePattern = /\.(?:db|sqlite3?)\b/;
// `join(os.tmpdir(), <argument up to the closing paren on that line>)`
const tmpdirJoinPattern = /\b(?:join|resolve)\(\s*(?:os\.)?tmpdir\(\)\s*,([^\n]*)/g;
// `os.tmpdir() + "/name.db"`
const tmpdirConcatPattern = /(?:os\.)?tmpdir\(\)\s*\+[^\n]*/g;
// `const name = \`...\`.db` style assignments, so a computed filename is caught too.
const sqliteNameAssignmentPattern = /\b(?:const|let|var)\s+([$A-Z_a-z][$\w]*)\s*=\s*(?:`[^`]*`|"[^"]*"|'[^']*')/g;

export function findTempSqliteViolations(relativePath, source) {
  const sqliteNameVariables = new Set();
  for (const match of source.matchAll(sqliteNameAssignmentPattern)) {
    if (sqliteNamePattern.test(match[0].slice(match[0].indexOf("=")))) sqliteNameVariables.add(match[1]);
  }
  const violations = [];
  const report = (index, snippet) =>
    violations.push({ path: relativePath, line: lineNumberAt(source, index), snippet: snippet.trim() });

  for (const match of source.matchAll(tmpdirJoinPattern)) {
    const argument = firstArgument(match[1]);
    const identifier = argument.trim();
    if (sqliteNamePattern.test(argument) || sqliteNameVariables.has(identifier)) {
      report(match.index ?? 0, match[0].slice(0, match[0].length - match[1].length) + argument + ")");
    }
  }
  for (const match of source.matchAll(tmpdirConcatPattern)) {
    if (sqliteNamePattern.test(match[0])) report(match.index ?? 0, match[0]);
  }
  return violations.sort((left, right) => left.line - right.line);
}

/** The text of the call's next argument: up to the first top-level `,` or the closing `)`. */
function firstArgument(rest) {
  let depth = 0;
  let quote;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (quote) {
      if (char === quote && rest[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" || char === ",") {
      if (depth === 0) return rest.slice(0, index);
      if (char === ")") depth -= 1;
    }
  }
  return rest;
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
