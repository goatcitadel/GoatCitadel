import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const servicesRoot = path.join(repoRoot, "apps", "gateway", "src", "services");
const allowlist = new Set([
  "apps/gateway/src/services/backup-retention-service.ts",
  "apps/gateway/src/services/database-cutover-service.ts",
  "apps/gateway/src/services/gateway-service.ts",
  "apps/gateway/src/services/improvement-service.ts",
  "apps/gateway/src/services/memory-maintenance-service.ts",
  "apps/gateway/src/services/prompt-pack-service.ts",
  "apps/gateway/src/services/chat-proactive-service.ts",
  "apps/gateway/src/services/gateway/cron-automation-service.ts",
]);

const pattern = /(storage\.db|gatewayDb|gatewaySql|ctx\.gatewaySql|this\.gatewaySql|this\.ctx\.gatewaySql)\.(prepare|exec)\(/g;
const files = await collectFiles(servicesRoot);
const hits = [];

for (const filePath of files) {
  const relPath = normalizeRelPath(path.relative(repoRoot, filePath));
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index] ?? "")) {
      hits.push({
        file: relPath,
        line: index + 1,
        text: (lines[index] ?? "").trim(),
        allowlisted: allowlist.has(relPath),
      });
    }
    pattern.lastIndex = 0;
  }
}

const blockingHits = hits.filter((hit) => !hit.allowlisted);
if (blockingHits.length > 0) {
  console.error(`[check:no-inline-sql] found ${blockingHits.length} non-allowlisted inline DB prepare/exec calls.`);
  for (const hit of blockingHits.slice(0, 40)) {
    console.error(`  - ${hit.file}:${hit.line} ${hit.text}`);
  }
  if (blockingHits.length > 40) {
    console.error(`  ... ${blockingHits.length - 40} more`);
  }
  process.exit(1);
}

console.log(
  `[check:no-inline-sql] passed: ${hits.length} inline DB calls accounted for across services (${allowlist.size} allowlisted files).`,
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
