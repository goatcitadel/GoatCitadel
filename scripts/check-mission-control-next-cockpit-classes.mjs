#!/usr/bin/env node
/* Cockpit components use named theme utilities, without arbitrary values. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");
const STRING_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function utilityPart(token) {
  let depth = 0;
  let lastColon = -1;
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index];
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) lastColon = index;
  }
  return token.slice(lastColon + 1);
}

export function findArbitraryClassValues(filePath, contents) {
  const findings = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(STRING_RE)) {
      for (const token of match[2].split(/\s+/).filter(Boolean)) {
        if (/^[a-z][a-z0-9-]*-[[(]/.test(utilityPart(token))) {
          findings.push({ file: filePath, line: index + 1, token });
        }
      }
    }
  });
  return findings;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(entries.map((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  }));
  return groups.flat();
}

async function main() {
  const files = await walk(cockpitRoot);
  const findings = [];
  for (const file of files) findings.push(...findArbitraryClassValues(file, await fs.readFile(file, "utf8")));
  if (findings.length) {
    console.error("[cockpit-classes] arbitrary theme values are not allowed:");
    for (const item of findings) console.error(`- ${path.relative(repoRoot, item.file)}:${item.line} -> ${item.token}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[cockpit-classes] ${files.length} cockpit files use named theme utilities`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
