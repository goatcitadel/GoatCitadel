import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const TARGET_DIRS = [
  path.join(ROOT, "apps", "mission-control-next", "src"),
  path.join(ROOT, "apps", "mission-control", "src"),
];

async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function collectTsxFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectTsxFiles(fullPath);
    }
    if (entry.isFile() && entry.name.endsWith(".tsx")) {
      return [fullPath];
    }
    return [];
  }));
  return files.flat();
}

function findJsxOpeningTagEnd(content, startIndex) {
  let quote = null;
  let braceDepth = 0;

  for (let index = startIndex; index < content.length; index += 1) {
    const char = content[index];
    const previous = content[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      braceDepth += 1;
      continue;
    }
    if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      continue;
    }
    if (char === ">" && braceDepth === 0) {
      return index;
    }
  }

  return -1;
}

export function collectButtonTypeViolations(content) {
  const violations = [];
  let cursor = 0;

  while (cursor < content.length) {
    const start = content.indexOf("<button", cursor);
    if (start === -1) {
      break;
    }
    const next = content[start + "<button".length];
    if (next && !/[\s>/]/u.test(next)) {
      cursor = start + "<button".length;
      continue;
    }
    const end = findJsxOpeningTagEnd(content, start + "<button".length);
    if (end === -1) {
      break;
    }
    const tag = content.slice(start, end + 1);
    if (!/\btype\s*=/u.test(tag)) {
      violations.push({
        index: start,
        snippet: tag.replace(/\s+/g, " ").slice(0, 120),
      });
    }
    cursor = end + 1;
  }

  return violations;
}

function getLineNumber(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

async function main() {
  const existingTargetDirs = [];
  for (const targetDir of TARGET_DIRS) {
    if (await directoryExists(targetDir)) {
      existingTargetDirs.push(targetDir);
    }
  }
  const files = (await Promise.all(existingTargetDirs.map((targetDir) => collectTsxFiles(targetDir)))).flat();
  const violations = [];

  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf8");
    for (const violation of collectButtonTypeViolations(content)) {
      const line = getLineNumber(content, violation.index);
      violations.push({
        filePath,
        line,
        snippet: violation.snippet,
      });
    }
  }

  if (violations.length > 0) {
    console.error("Button type check failed. Add explicit type=\"button\" or type=\"submit\".");
    for (const violation of violations) {
      const relative = path.relative(ROOT, violation.filePath).replace(/\\/g, "/");
      console.error(`- ${relative}:${violation.line} -> ${violation.snippet}`);
    }
    process.exit(1);
  }

  const scannedRoots = existingTargetDirs.map((dir) => path.relative(ROOT, dir).replace(/\\/g, "/")).join(", ");
  console.log(`Button type check passed${scannedRoots ? ` for ${scannedRoots}` : ""}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
