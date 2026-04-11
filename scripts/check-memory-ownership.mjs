import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const servicesRoot = path.join(repoRoot, "apps", "gateway", "src", "services");
const allowlist = new Set([
  "apps/gateway/src/services/memory-item-helpers.ts",
  "apps/gateway/src/services/memory-lifecycle-service.ts",
]);

const files = await collectFiles(servicesRoot);
const hits = [];

for (const filePath of files) {
  const relPath = normalizeRelPath(path.relative(repoRoot, filePath));
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/\b(memory_items|memory_change_history)\b/.test(line)) {
      continue;
    }
    hits.push({
      file: relPath,
      line: index + 1,
      text: line.trim(),
      allowlisted: allowlist.has(relPath),
    });
  }
}

const blockingHits = hits.filter((hit) => !hit.allowlisted);
if (blockingHits.length > 0) {
  console.error(`[check:memory-ownership] found ${blockingHits.length} non-allowlisted memory SQL ownership references.`);
  for (const hit of blockingHits) {
    console.error(`  - ${hit.file}:${hit.line} ${hit.text}`);
  }
  process.exit(1);
}

console.log(
  `[check:memory-ownership] passed: ${hits.length} memory ownership SQL references accounted for across services (${allowlist.size} allowlisted files).`,
);

async function collectFiles(root) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }
    if (!entry.isFile() || !fullPath.endsWith(".ts") || fullPath.endsWith(".test.ts")) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

function normalizeRelPath(value) {
  return value.replaceAll("\\", "/");
}
