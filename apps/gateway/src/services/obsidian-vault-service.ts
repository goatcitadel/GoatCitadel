import fs from "node:fs/promises";
import path from "node:path";
import type { ObsidianIntegrationConfig, ObsidianIntegrationStatus } from "@goatcitadel/contracts";
import type { SystemSettingsRepository } from "@goatcitadel/storage";

const OBSIDIAN_CONFIG_KEY = "obsidian_integration_v1";
const OBSIDIAN_STATUS_KEY = "obsidian_integration_status_v1";
const DEFAULT_ALLOWED_SUBPATHS = [
  "GoatCitadel",
  "GoatCitadel/Inbox",
  "GoatCitadel/Coordination",
  "GoatCitadel/Tasks",
  "GoatCitadel/Decisions",
];

interface ObsidianStatusState {
  vaultReachable: boolean;
  checkedAt: string;
  lastOperationAt?: string;
  lastError?: string;
}

export interface ObsidianSearchResult {
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
}

export class ObsidianVaultService {
  public constructor(private readonly systemSettings: SystemSettingsRepository) {}

  public getConfig(): ObsidianIntegrationConfig {
    const stored = this.systemSettings.get<Partial<ObsidianIntegrationConfig>>(OBSIDIAN_CONFIG_KEY)?.value;
    return normalizeConfig(stored);
  }

  public updateConfig(input: Partial<ObsidianIntegrationConfig>): ObsidianIntegrationConfig {
    const current = this.getConfig();
    const next = normalizeConfig({
      ...current,
      ...input,
      allowedSubpaths: input.allowedSubpaths ?? current.allowedSubpaths,
    });
    this.systemSettings.set(OBSIDIAN_CONFIG_KEY, next);
    return next;
  }

  public async getStatus(): Promise<ObsidianIntegrationStatus> {
    const config = this.getConfig();
    const status = await this.refreshStatus(config);
    return {
      ...config,
      ...status,
    };
  }

  public async testConnection(): Promise<ObsidianIntegrationStatus> {
    return this.getStatus();
  }

  public async searchNotes(query: string, limit = 20): Promise<ObsidianSearchResult[]> {
    const config = this.getConfig();
    this.assertReadEnabled(config);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      throw new Error("query is required");
    }

    const vaultRoot = await this.resolveVaultRootRealpath(config);
    const allowedRoots = await resolveExistingAllowedRoots(vaultRoot, config.allowedSubpaths);
    const files = await this.collectMarkdownFiles(allowedRoots, 2000);
    const results: ObsidianSearchResult[] = [];

    for (const filePath of files) {
      const rel = path.relative(vaultRoot, filePath).replaceAll("\\", "/");
      const baseName = path.basename(filePath, ".md");
      let content = "";
      const contentMatched =
        baseName.toLowerCase().includes(normalizedQuery) ||
        (await (async () => {
          try {
            content = await fs.readFile(filePath, "utf8");
            return content.toLowerCase().includes(normalizedQuery);
          } catch {
            return false;
          }
        })());

      if (!contentMatched) {
        continue;
      }

      const snippet = buildSnippet(content || baseName, normalizedQuery);
      const score = computeSearchScore(baseName, content, normalizedQuery);
      results.push({
        relativePath: rel,
        title: baseName,
        snippet,
        score,
      });
      if (results.length >= limit * 3) {
        break;
      }
    }

    results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    await this.recordOperation();
    return results.slice(0, Math.max(1, Math.min(limit, 200)));
  }

  public async readNote(relativePath: string): Promise<{ relativePath: string; content: string }> {
    const config = this.getConfig();
    this.assertReadEnabled(config);
    const fullPath = await this.resolveExistingNotePath(config, relativePath);
    const content = await fs.readFile(fullPath, "utf8");
    await this.recordOperation();
    return {
      relativePath: normalizeRelativePath(relativePath),
      content,
    };
  }

  public async appendToNote(
    relativePath: string,
    markdownBlock: string,
  ): Promise<{ relativePath: string; appendedAt: string }> {
    const config = this.getConfig();
    this.assertWriteEnabled(config);
    const block = markdownBlock.trim();
    if (!block) {
      throw new Error("markdownBlock is required");
    }
    const fullPath = await this.resolveWritableNotePath(config, relativePath);
    const appendedAt = new Date().toISOString();
    const payload = `\n\n${block}\n`;
    await fs.appendFile(fullPath, payload, "utf8");
    await this.recordOperation();
    return {
      relativePath: normalizeRelativePath(relativePath),
      appendedAt,
    };
  }

  public async captureInboxEntry(input: {
    id: string;
    request: string;
    type?: string;
    priority?: string;
    neededBy?: string;
    owner?: string;
    state?: string;
    taskLink?: string;
    decisionLink?: string;
    notes?: string;
  }): Promise<{ relativePath: string; appendedAt: string; row: string }> {
    const row = buildInboxRow(input);
    const relativePath = "GoatCitadel/Inbox/GoatCitadel Inbox.md";
    const appendResult = await this.appendToNote(relativePath, row);
    return {
      ...appendResult,
      row,
    };
  }

  private async collectMarkdownFiles(roots: string[], maxFiles: number): Promise<string[]> {
    const queue = [...roots];
    const out: string[] = [];
    while (queue.length > 0 && out.length < maxFiles) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      const entries = await (async (): Promise<Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>> => {
        try {
          return await fs.readdir(current, { withFileTypes: true });
        } catch {
          return [];
        }
      })();
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          queue.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
          out.push(fullPath);
          if (out.length >= maxFiles) {
            break;
          }
        }
      }
    }
    return out;
  }

  private assertReadEnabled(config: ObsidianIntegrationConfig): void {
    if (!config.enabled) {
      throw new Error("Obsidian integration is disabled.");
    }
    if (!config.vaultPath.trim()) {
      throw new Error("Obsidian vault path is not configured.");
    }
  }

  private assertWriteEnabled(config: ObsidianIntegrationConfig): void {
    this.assertReadEnabled(config);
    if (config.mode !== "read_append") {
      throw new Error("Obsidian integration is read-only.");
    }
  }

  private resolveVaultRoot(config: ObsidianIntegrationConfig): string {
    const vaultPath = config.vaultPath.trim();
    if (!vaultPath) {
      throw new Error("Obsidian vault path is not configured.");
    }
    return path.resolve(vaultPath);
  }

  private async resolveVaultRootRealpath(config: ObsidianIntegrationConfig): Promise<string> {
    return fs.realpath(this.resolveVaultRoot(config));
  }

  private async resolveExistingNotePath(config: ObsidianIntegrationConfig, relativePath: string): Promise<string> {
    const { allowedRoots, fullPath } = await this.resolveLexicalNotePath(config, relativePath);
    const realPath = await fs.realpath(fullPath);
    if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, realPath))) {
      throw new Error("Path resolves outside configured Obsidian allowed subpaths.");
    }
    return realPath;
  }

  private async resolveWritableNotePath(config: ObsidianIntegrationConfig, relativePath: string): Promise<string> {
    const { allowedRoots, fullPath } = await this.resolveLexicalNotePath(config, relativePath);
    const parentPath = path.dirname(fullPath);
    try {
      await fs.mkdir(parentPath, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const parentRealpath = await fs.realpath(parentPath);
    if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, parentRealpath))) {
      throw new Error("Path resolves outside configured Obsidian allowed subpaths.");
    }
    const existingTargetRealpath = await realpathIfExists(fullPath);
    if (existingTargetRealpath && !allowedRoots.some((allowedRoot) => isWithin(allowedRoot, existingTargetRealpath))) {
      throw new Error("Path resolves outside configured Obsidian allowed subpaths.");
    }
    return fullPath;
  }

  private async resolveLexicalNotePath(
    config: ObsidianIntegrationConfig,
    relativePath: string,
  ): Promise<{ allowedRoots: string[]; fullPath: string }> {
    const vaultRoot = await this.resolveVaultRootRealpath(config);
    const normalizedRel = normalizeRelativePath(relativePath);
    if (!normalizedRel.toLowerCase().endsWith(".md")) {
      throw new Error("Only markdown note paths are allowed.");
    }
    const fullPath = path.resolve(vaultRoot, normalizedRel);
    if (!isWithin(vaultRoot, fullPath)) {
      throw new Error("Path escapes the configured Obsidian vault.");
    }
    const allowedRoots = resolveAllowedRoots(vaultRoot, config.allowedSubpaths);
    if (!allowedRoots.some((allowedRoot) => isWithin(allowedRoot, fullPath))) {
      throw new Error("Path is outside configured Obsidian allowed subpaths.");
    }
    return { allowedRoots, fullPath };
  }

  private async refreshStatus(config: ObsidianIntegrationConfig): Promise<ObsidianStatusState> {
    const now = new Date().toISOString();
    const previous = this.systemSettings.get<ObsidianStatusState>(OBSIDIAN_STATUS_KEY)?.value;
    let vaultReachable = false;
    const statusError = await (async (): Promise<string | undefined> => {
      if (!config.enabled) {
        return undefined;
      }
      if (!config.vaultPath.trim()) {
        return "Obsidian integration enabled but vault path is empty.";
      }

      try {
        const stat = await fs.stat(await this.resolveVaultRootRealpath(config));
        if (!stat.isDirectory()) {
          return "Configured Obsidian vault path is not a directory.";
        }
        vaultReachable = true;
        return undefined;
      } catch (error) {
        return (error as Error).message;
      }
    })();

    const next: ObsidianStatusState = {
      vaultReachable,
      checkedAt: now,
      lastOperationAt: previous?.lastOperationAt,
      lastError: statusError,
    };
    this.systemSettings.set(OBSIDIAN_STATUS_KEY, next);
    return next;
  }

  private async recordOperation(): Promise<void> {
    const current = this.systemSettings.get<ObsidianStatusState>(OBSIDIAN_STATUS_KEY)?.value;
    const now = new Date().toISOString();
    this.systemSettings.set(OBSIDIAN_STATUS_KEY, {
      vaultReachable: current?.vaultReachable ?? false,
      checkedAt: now,
      lastError: current?.lastError,
      lastOperationAt: now,
    } satisfies ObsidianStatusState);
  }
}

function normalizeConfig(raw: Partial<ObsidianIntegrationConfig> | undefined): ObsidianIntegrationConfig {
  const mode = raw?.mode === "read_only" ? "read_only" : "read_append";
  const allowedSubpaths =
    Array.isArray(raw?.allowedSubpaths) && raw?.allowedSubpaths.length > 0
      ? raw.allowedSubpaths
      : DEFAULT_ALLOWED_SUBPATHS;
  return {
    enabled: raw?.enabled ?? false,
    vaultPath: (raw?.vaultPath ?? "").trim(),
    mode,
    allowedSubpaths: dedupeNormalizedSubpaths(allowedSubpaths),
  };
}

function dedupeNormalizedSubpaths(subpaths: string[]): string[] {
  const out = new Set<string>();
  for (const subpath of subpaths) {
    const normalized = normalizeRelativePath(subpath).replace(/\/+$/, "");
    if (!normalized || normalized === ".") {
      continue;
    }
    if (normalized.split("/").some((part) => part === "..")) {
      continue;
    }
    out.add(normalized);
  }
  if (out.size === 0) {
    return [...DEFAULT_ALLOWED_SUBPATHS];
  }
  return [...out];
}

function normalizeRelativePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Path is required.");
  }
  const normalized = trimmed.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized === ".") {
    throw new Error("Path is required.");
  }
  if (normalized.split("/").some((part) => part === "..")) {
    throw new Error("Parent-directory segments are not allowed.");
  }
  return normalized;
}

function resolveAllowedRoots(vaultRoot: string, allowedSubpaths: string[]): string[] {
  const roots: string[] = [];
  for (const relative of allowedSubpaths) {
    const normalized = normalizeRelativePath(relative);
    const full = path.resolve(vaultRoot, normalized);
    if (!isWithin(vaultRoot, full)) {
      continue;
    }
    roots.push(full);
  }
  if (roots.length === 0) {
    roots.push(vaultRoot);
  }
  return roots;
}

async function resolveExistingAllowedRoots(vaultRoot: string, allowedSubpaths: string[]): Promise<string[]> {
  const roots: string[] = [];
  for (const root of resolveAllowedRoots(vaultRoot, allowedSubpaths)) {
    try {
      const realRoot = await fs.realpath(root);
      if (isWithin(vaultRoot, realRoot)) {
        roots.push(realRoot);
      }
    } catch {
      // Skip missing allowed roots; they simply have no searchable markdown files yet.
    }
  }
  return roots;
}

async function realpathIfExists(targetPath: string): Promise<string | undefined> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function buildSnippet(content: string, normalizedQuery: string): string {
  const plain = content.replaceAll(/\s+/g, " ").trim();
  if (!plain) {
    return "";
  }
  const index = plain.toLowerCase().indexOf(normalizedQuery);
  if (index < 0) {
    return plain.slice(0, 220);
  }
  const start = Math.max(0, index - 80);
  const end = Math.min(plain.length, index + normalizedQuery.length + 120);
  return plain.slice(start, end);
}

function computeSearchScore(title: string, content: string, normalizedQuery: string): number {
  const titleLower = title.toLowerCase();
  const contentLower = content.toLowerCase();
  let score = 0;
  if (titleLower.includes(normalizedQuery)) {
    score += 8;
  }
  if (contentLower.includes(normalizedQuery)) {
    score += 4;
  }
  if (titleLower.startsWith(normalizedQuery)) {
    score += 2;
  }
  return score;
}

function buildInboxRow(input: {
  id: string;
  request: string;
  type?: string;
  priority?: string;
  neededBy?: string;
  owner?: string;
  state?: string;
  taskLink?: string;
  decisionLink?: string;
  notes?: string;
}): string {
  const cells = [
    sanitizeCell(input.id || "GC-IN-XXX"),
    sanitizeCell(input.request),
    sanitizeCell(input.type ?? "feature"),
    sanitizeCell(input.priority ?? "medium"),
    sanitizeCell(input.neededBy ?? ""),
    sanitizeCell(input.owner ?? "Unassigned"),
    sanitizeCell(input.state ?? "new"),
    sanitizeCell(input.taskLink ?? "[[GoatCitadel Tasks]]"),
    sanitizeCell(input.decisionLink ?? "-"),
    sanitizeCell(input.notes ?? ""),
  ];
  if (!cells[1]) {
    throw new Error("request is required");
  }
  return `| ${cells.join(" | ")} |`;
}

function sanitizeCell(value: string): string {
  return value.replaceAll("|", "\\|").trim();
}
