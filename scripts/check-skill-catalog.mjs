#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(repoRoot, "skills");
const coveragePath = path.join(skillsRoot, "catalog-coverage.json");
const generatedRoutingPath = path.join(repoRoot, "packages", "skills", "src", "routing-hints.generated.ts");

const coverage = JSON.parse(await fs.readFile(coveragePath, "utf8"));
const entries = Array.isArray(coverage.entries) ? coverage.entries : [];
const tokenBudget = Number.isFinite(coverage.tokenBudget) ? coverage.tokenBudget : 40000;
const findings = [];
const seen = new Set();
const skillFiles = await collectSkillFiles(skillsRoot);
const generatedRouting = (await fs.readFile(generatedRoutingPath, "utf8").catch(() => "")).toLowerCase();
let tokenEstimate = 0;

for (const skillFile of skillFiles) {
  const raw = await fs.readFile(skillFile, "utf8");
  const parsed = parseSkillMarkdown(raw);
  const source = sourceForSkillFile(skillFile);
  const name = parsed.frontmatter?.name;
  const skillId = name ? `${source}:${name}` : undefined;
  tokenEstimate += Math.ceil(raw.length / 4);

  if (!parsed.ok || !name || typeof parsed.frontmatter?.description !== "string") {
    findings.push(finding("error", "invalid_frontmatter", "Skill frontmatter must include name and description.", skillId, skillFile));
    continue;
  }
  if (!parsed.body.trim()) {
    findings.push(finding("error", "empty_body", "Skill body must not be empty.", skillId, skillFile));
  }
  if (/<PLACEHOLDER|TODO_PLACEHOLDER/i.test(raw)) {
    findings.push(finding("error", "unresolved_placeholder", "Skill contains an unresolved placeholder.", skillId, skillFile));
  }
  if (seen.has(skillId)) {
    findings.push(finding("error", "duplicate_skill", `Duplicate skill id ${skillId}.`, skillId, skillFile));
  }
  seen.add(skillId);
  if (!entries.some((entry) => entry.skillId === skillId)) {
    findings.push(finding("error", "missing_coverage", `Missing catalog coverage entry for ${skillId}.`, skillId, skillFile));
  }
  if (source === "bundled" && skillFile.endsWith(`${path.sep}SKILL.md`) && !generatedRouting.includes(name.toLowerCase())) {
    findings.push(finding("warning", "stale_generated_routing", `No generated routing hint found for ${skillId}.`, skillId, skillFile));
  }
}

for (const entry of entries) {
  if (!seen.has(entry.skillId)) {
    findings.push(finding("error", "missing_coverage", `Coverage entry has no matching skill file: ${entry.skillId}.`));
  }
}

if (tokenEstimate > tokenBudget) {
  findings.push(finding("error", "catalog_budget_exceeded", `Catalog estimate ${tokenEstimate} exceeds budget ${tokenBudget}.`));
}

const result = {
  ok: findings.every((item) => item.severity !== "error"),
  generatedAt: new Date().toISOString(),
  skillCount: skillFiles.length,
  tokenEstimate,
  tokenBudget,
  coverageEntries: entries,
  findings,
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`Skill catalog: ${result.skillCount} skills, estimated ${tokenEstimate}/${tokenBudget} tokens`);
  for (const item of findings) {
    console.log(`${item.severity.toUpperCase()} ${item.code}: ${item.message}${item.path ? ` (${item.path})` : ""}`);
  }
}

if (!result.ok) {
  process.exitCode = 1;
}

async function collectSkillFiles(root) {
  const files = [];
  await walk(root, files);
  return files
    .filter((file) => /(?:^|[\\/])SKILL\.md$/i.test(file) || /(?:^|[\\/])skill\.md$/i.test(file))
    .filter((file) => !file.includes(`${path.sep}workspace${path.sep}`))
    .sort();
}

async function walk(dir, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, files);
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
}

function parseSkillMarkdown(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(raw);
  if (!match) {
    return { ok: false, frontmatter: undefined, body: raw };
  }
  try {
    return { ok: true, frontmatter: parseSimpleFrontmatter(match[1]), body: match[2] ?? "" };
  } catch {
    return { ok: false, frontmatter: undefined, body: match[2] ?? "" };
  }
}

function parseSimpleFrontmatter(raw) {
  const frontmatter = {};
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const value = match[2].trim();
    if (value === "|" || value === ">") {
      const block = [];
      for (let blockIndex = index + 1; blockIndex < lines.length; blockIndex += 1) {
        if (/^[A-Za-z0-9_-]+:/u.test(lines[blockIndex])) {
          break;
        }
        block.push(lines[blockIndex].trim());
        index = blockIndex;
      }
      frontmatter[key] = block.join(" ").trim();
      continue;
    }
    if (!value) {
      continue;
    }
    frontmatter[key] = value.replace(/^["']|["']$/g, "");
  }
  return frontmatter;
}

function sourceForSkillFile(file) {
  const rel = path.relative(skillsRoot, file).split(path.sep);
  return rel[0] === "bundled" ? "bundled" : "extra";
}

function finding(severity, code, message, skillId, file) {
  return {
    severity,
    code,
    message,
    skillId,
    path: file ? path.relative(repoRoot, file).replace(/\\/g, "/") : undefined,
  };
}
