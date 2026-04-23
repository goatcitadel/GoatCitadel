import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const servicesRoot = path.join(repoRoot, "apps", "gateway", "src", "services");
const outputPath = path.join(repoRoot, "artifacts", "architecture", "inline-sql-inventory.md");
const pattern =
  /(storage\.db|gatewayDb|gatewaySql|ctx\.gatewaySql|this\.gatewaySql|this\.ctx\.gatewaySql)\.(prepare|exec)\(/g;
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

const files = await collectFiles(servicesRoot);
const entries = [];
for (const filePath of files) {
  const relPath = normalizeRelPath(path.relative(repoRoot, filePath));
  const content = await fs.readFile(filePath, "utf8");
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (pattern.test(line)) {
      entries.push({
        file: relPath,
        line: index + 1,
        kind: /\.exec\(/.test(line) ? "exec" : "prepare",
        text: line.trim(),
        allowlisted: allowlist.has(relPath),
      });
    }
    pattern.lastIndex = 0;
  }
}

const markdown = [
  "# Gateway Inline SQL Inventory",
  "",
  `- Generated: ${new Date().toISOString()}`,
  `- Root: \`${normalizeRelPath(path.relative(repoRoot, servicesRoot))}\``,
  `- Total inline calls: **${entries.length}**`,
  `- Allowlisted calls: **${entries.filter((entry) => entry.allowlisted).length}**`,
  `- Non-allowlisted calls: **${entries.filter((entry) => !entry.allowlisted).length}**`,
  "",
  "## Calls",
  entries.length === 0
    ? "- none"
    : entries
        .map(
          (entry) =>
            `- ${entry.allowlisted ? "[allowlisted]" : "[blocking]"} ${entry.file}:L${entry.line} [${entry.kind}] \`${escapeMarkdownCodeSpan(entry.text)}\``,
        )
        .join("\n"),
  "",
].join("\n");

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, markdown, "utf8");
console.log(`[inventory:inline-sql] wrote ${path.relative(repoRoot, outputPath)}`);

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

function escapeMarkdownCodeSpan(value) {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`");
}
