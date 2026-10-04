#!/usr/bin/env node
/*
 * Cockpit copy guard. Inside the cockpit, "current Chat", "current controls" and similar
 * phrases read as "right here", but they were used to mean the classic shell. Handoffs must
 * say "classic view" instead. Descriptive uses that really mean the present Chat
 * ("do not govern current Chat", "current Chat turn", the "Current Chat question" label)
 * are allowed.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

const BANNED = [
  /\bcurrent (?:Ops(?: Kanban)?|controls|Settings|Approvals|Kanban|Runtime|Library)\b/,
  /\b(?:open|in|to|resolve it in|return to|review it in)\s+(?:the\s+)?current Chat\b(?!\s+turns?\b)/i,
  /label=["'{][^"'}]*\bcurrent\s/,
];

/** Lines that are code comments cannot reach the UI. */
function isComment(line) {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

export function findClassicHandoffCopy(filePath, contents) {
  const findings = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    if (isComment(line)) return;
    for (const pattern of BANNED) {
      const match = pattern.exec(line);
      if (match) {
        findings.push({ file: filePath, line: index + 1, text: match[0] });
        break;
      }
    }
  });
  return findings;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
    }),
  );
  return groups.flat();
}

async function main() {
  const files = await walk(cockpitRoot);
  const findings = [];
  for (const file of files) findings.push(...findClassicHandoffCopy(file, await fs.readFile(file, "utf8")));
  if (findings.length) {
    console.error('[cockpit-copy] say "classic view" for handoffs, not "current …":');
    for (const item of findings) console.error(`- ${path.relative(repoRoot, item.file)}:${item.line} -> ${item.text}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[cockpit-copy] ${files.length} cockpit files name the classic view plainly`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
