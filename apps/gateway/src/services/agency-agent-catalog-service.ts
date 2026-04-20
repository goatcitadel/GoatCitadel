import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { Storage } from "@goatcitadel/storage";
import { parseRichAgentMarkdown } from "@goatcitadel/skills";
import type {
  AgencyCatalogImportResponse,
  ChatMode,
  ChatSpecialistCandidateSuggestionRecord,
  ImportedAgentCatalogRecord,
  RichAgentParseSupportStatus,
} from "@goatcitadel/contracts";

const execFileAsync = promisify(execFile);

export const DEFAULT_AGENCY_REPO_URL = "https://github.com/msitarzewski/agency-agents.git";
export const DEFAULT_AGENCY_REF = "main";

const EXCLUDED_DIVISION_DIRECTORIES = new Set([
  ".git",
  ".github",
  ".vscode",
  "docs",
  "integrations",
  "node_modules",
  "scripts",
]);

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "build",
  "for",
  "help",
  "i",
  "in",
  "need",
  "of",
  "on",
  "please",
  "the",
  "to",
  "with",
]);

export async function importAgencyCatalog(input: {
  storage: Storage;
  workspaceId: string;
  repoUrl?: string;
  ref?: string;
  now?: string;
}): Promise<AgencyCatalogImportResponse> {
  const repoUrl = input.repoUrl?.trim() || DEFAULT_AGENCY_REPO_URL;
  const ref = input.ref?.trim() || DEFAULT_AGENCY_REF;
  const now = input.now ?? new Date().toISOString();
  const existingEntries = new Map(
    input.storage.importedAgentCatalog
      .list({ workspaceId: input.workspaceId, limit: 5000 })
      .map((entry) => [entry.entryId, entry]),
  );
  const source = await materializeAgencySource(repoUrl, ref);
  try {
    const records = await buildCatalogRecords({
      rootDir: source.rootDir,
      workspaceId: input.workspaceId,
      repoUrl,
      ref,
      commit: source.commit,
      importedAt: now,
      existingEntries,
    });
    input.storage.importedAgentCatalog.upsertMany(records);

    const parseCounts: Record<RichAgentParseSupportStatus, number> = {
      supported: 0,
      supported_with_warnings: 0,
      unsupported: 0,
    };
    for (const record of records) {
      parseCounts[record.definition.parseStatus] += 1;
    }

    return {
      workspaceId: input.workspaceId,
      repoUrl,
      ref,
      commit: source.commit,
      importedAt: now,
      importedCount: records.length,
      divisions: dedupeStrings(records.map((record) => record.division)).sort((left, right) =>
        left.localeCompare(right),
      ),
      parseCounts,
    };
  } finally {
    await source.cleanup();
  }
}

export function suggestImportedCatalogEntries(input: {
  entries: ImportedAgentCatalogRecord[];
  content: string;
  mode: ChatMode;
  limit?: number;
}): ChatSpecialistCandidateSuggestionRecord[] {
  const keywords = extractCatalogKeywords(input.content);
  if (keywords.length === 0) {
    return [];
  }
  return input.entries
    .filter((entry) => entry.state !== "retired" && entry.definition.parseStatus !== "unsupported")
    .map((entry) => ({
      entry,
      score: scoreCatalogEntry(entry, keywords),
    }))
    .filter((item) => item.score >= 0.22)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(input.limit ?? 3, 6)))
    .map(({ entry, score }) => buildCatalogSpecialistSuggestion(entry, input.mode, keywords, score));
}

export function buildCatalogSpecialistSuggestion(
  entry: ImportedAgentCatalogRecord,
  mode: ChatMode,
  objectiveKeywords: string[],
  score = 0.72,
): ChatSpecialistCandidateSuggestionRecord {
  const parseLabel =
    entry.definition.parseStatus === "supported"
      ? "supported"
      : entry.definition.parseStatus === "supported_with_warnings"
        ? "supported with warnings"
        : "unsupported";
  return {
    candidateId: entry.entryId,
    title: entry.definition.frontmatter.name,
    role: entry.definition.slug,
    summary: entry.definition.frontmatter.description,
    reason: `Imported Agency specialist from ${entry.division}. Parse status: ${parseLabel}.`,
    source: "catalog",
    confidence: Math.min(0.95, Math.max(0.58, score)),
    suggestedStatus: "drafted",
    suggestedRoutingMode: "manual_only",
    requiresApproval: true,
    suggestedSkills: [`catalog:${entry.entryId}`, `agency:${entry.definition.slug}`],
    routingHints: {
      preferredModes: mode === "code" ? ["code"] : mode === "cowork" ? ["cowork"] : ["chat", "cowork"],
      objectiveKeywords: objectiveKeywords.slice(0, 10),
      requiresProjectBinding: mode === "code",
      maxInvocationsPerRun: 1,
    },
    evidence: [
      {
        evidenceId: `catalog-${entry.entryId}`,
        kind: "skill_gap",
        summary: `Matched imported catalog entry ${entry.definition.frontmatter.name} from ${entry.division}.`,
        skillRef: `catalog:${entry.entryId}`,
        confidence: Math.min(0.92, Math.max(0.5, score)),
      },
    ],
  };
}

async function buildCatalogRecords(input: {
  rootDir: string;
  workspaceId: string;
  repoUrl: string;
  ref: string;
  commit?: string;
  importedAt: string;
  existingEntries: Map<string, ImportedAgentCatalogRecord>;
}): Promise<ImportedAgentCatalogRecord[]> {
  const divisions = await discoverDivisionDirectories(input.rootDir);
  const records: ImportedAgentCatalogRecord[] = [];

  for (const division of divisions) {
    const markdownPaths = await collectDivisionMarkdownFiles(path.join(input.rootDir, division));
    for (const absolutePath of markdownPaths) {
      const rawMarkdown = await fs.readFile(absolutePath, "utf8");
      const parsed = parseRichAgentMarkdown(rawMarkdown);
      const relativePath = toPosixPath(path.relative(input.rootDir, absolutePath));
      const slug = sanitizeSlug(path.basename(relativePath, ".md"));
      const entryId = buildStableId("catalog", input.workspaceId, input.repoUrl, relativePath);
      const definitionId = buildStableId("definition", input.workspaceId, input.repoUrl, relativePath);
      const existing = input.existingEntries.get(entryId);

      records.push({
        entryId,
        workspaceId: input.workspaceId,
        division,
        state: existing?.state ?? "disabled",
        createdAt: existing?.createdAt ?? input.importedAt,
        updatedAt: input.importedAt,
        activatedAt: existing?.activatedAt,
        retiredAt: existing?.retiredAt,
        definition: {
          definitionId,
          slug,
          frontmatter: parsed.frontmatter ?? {
            name: slug,
            description: "",
          },
          rawMarkdown: parsed.rawMarkdown,
          bodyMarkdown: parsed.bodyMarkdown,
          sectionOrder: parsed.sectionOrder,
          sectionMap: parsed.sectionMap,
          parseStatus: parsed.parseStatus,
          parseWarnings: parsed.parseWarnings,
          provenance: {
            provider: "agency_agents",
            repoUrl: input.repoUrl,
            ref: input.ref,
            commit: input.commit,
            path: relativePath,
            sha256: sha256(rawMarkdown),
            importedAt: input.importedAt,
          },
        },
      });
    }
  }

  return records;
}

async function materializeAgencySource(
  repoUrl: string,
  ref: string,
): Promise<{
  rootDir: string;
  commit?: string;
  cleanup: () => Promise<void>;
}> {
  const localPath = resolveLocalRepoPath(repoUrl);
  if (localPath && (await pathExists(localPath))) {
    return {
      rootDir: localPath,
      commit: await readGitRef(localPath),
      cleanup: async () => undefined,
    };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "goatcitadel-agency-agents-"));
  const cloneDir = path.join(tempRoot, "repo");
  try {
    await execFileAsync("git", ["clone", "--depth", "1", "--branch", ref, repoUrl, cloneDir], {
      windowsHide: true,
    });
    return {
      rootDir: cloneDir,
      commit: await readGitRef(cloneDir),
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`Failed to clone Agency repo ${repoUrl}@${ref}: ${(error as Error).message}`, { cause: error });
  }
}

function resolveLocalRepoPath(repoUrl: string): string | undefined {
  if (!repoUrl.trim()) {
    return undefined;
  }
  if (repoUrl.startsWith("file://")) {
    const filePath = repoUrl.replace(/^file:\/\//, "");
    const resolved = path.resolve(filePath);
    return path.isAbsolute(resolved) ? resolved : undefined;
  }
  if (path.isAbsolute(repoUrl) || repoUrl.startsWith(".") || repoUrl.includes(path.sep)) {
    const resolved = path.resolve(repoUrl);
    return resolved;
  }
  return undefined;
}

async function pathExists(candidatePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidatePath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function discoverDivisionDirectories(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const divisions: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || EXCLUDED_DIVISION_DIRECTORIES.has(entry.name)) {
      continue;
    }
    const candidateDir = path.join(rootDir, entry.name);
    const candidateEntries = await fs.readdir(candidateDir, { withFileTypes: true });
    if (candidateEntries.some((item) => item.isFile() && item.name.toLowerCase().endsWith(".md"))) {
      divisions.push(entry.name);
    }
  }
  return divisions.sort((left, right) => left.localeCompare(right));
}

async function collectDivisionMarkdownFiles(divisionDir: string): Promise<string[]> {
  const entries = await fs.readdir(divisionDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      files.push(...(await collectDivisionMarkdownFiles(path.join(divisionDir, entry.name))));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.toLowerCase().endsWith(".md") || entry.name.toLowerCase() === "readme.md") {
      continue;
    }
    files.push(path.join(divisionDir, entry.name));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function readGitRef(rootDir: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
      windowsHide: true,
    });
    const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return stdout || undefined;
  } catch {
    return undefined;
  }
}

function scoreCatalogEntry(entry: ImportedAgentCatalogRecord, keywords: string[]): number {
  const searchable = [
    entry.division,
    entry.definition.slug,
    entry.definition.frontmatter.name,
    entry.definition.frontmatter.description,
    ...(entry.definition.frontmatter.services ?? []),
    ...entry.definition.sectionOrder.map((key) => {
      const section = entry.definition.sectionMap[key];
      return section ? `${section.heading} ${section.content}` : "";
    }),
  ]
    .join(" ")
    .toLowerCase();
  const overlap = keywords.filter((keyword) => searchable.includes(keyword)).length;
  const overlapScore = overlap / Math.max(1, keywords.length);
  const parseBoost =
    entry.definition.parseStatus === "supported"
      ? 0.2
      : entry.definition.parseStatus === "supported_with_warnings"
        ? 0.1
        : -0.25;
  return Math.max(0, overlapScore + parseBoost);
}

function extractCatalogKeywords(content: string): string[] {
  return dedupeStrings(
    content
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter((token) => token.length >= 3 && !STOP_WORDS.has(token)),
  );
}

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function buildStableId(prefix: string, workspaceId: string, repoUrl: string, relativePath: string): string {
  const digest = createHash("sha1").update(`${workspaceId}:${repoUrl}:${relativePath}`).digest("hex").slice(0, 24);
  return `${prefix}-${digest}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}
