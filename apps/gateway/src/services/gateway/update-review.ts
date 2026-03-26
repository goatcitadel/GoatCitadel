import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ANSI_ESCAPE_RE = /\u001B\[[0-9;]*m/g;

export interface DependencyUpdateReviewItem {
  packageName: string;
  dependencyType?: string;
  currentVersion: string;
  latestVersion: string;
  dependents: string[];
}

export interface SkillSourceDriftReviewItem {
  skillId: string;
  sourceUrl?: string;
  currentVersion?: string;
  latestVersion?: string;
  status: "changed" | "unchanged" | "warning";
  message: string;
}

export interface UpdateReviewReport {
  generatedAt: string;
  dependencyDrift: {
    items: DependencyUpdateReviewItem[];
    warnings: string[];
  };
  skillSourceDrift: {
    items: SkillSourceDriftReviewItem[];
    warnings: string[];
  };
  summary: {
    outdatedDependencyCount: number;
    changedSkillSourceCount: number;
    warningCount: number;
    checkedSkillCount: number;
  };
}

interface InstalledSkillSourceManifest {
  manifestVersion?: number;
  installedAt?: string;
  lastReviewedAt?: string;
  lastCheckedAt?: string;
  duplicateFamily?: string;
  reviewDisposition?: string;
  marketplaceListingUrl?: string;
  resolvedUpstream?: {
    url?: string;
    ref?: string;
    version?: string;
  };
  candidate?: {
    sourceRef?: string;
    sourceUrl?: string;
    repositoryUrl?: string;
  };
}

type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    timeout?: number;
    windowsHide?: boolean;
    maxBuffer?: number;
  },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export async function collectWorkspaceDependencyDrift(
  rootDir: string,
  runCommand: ExecFileLike = execFileAsync,
): Promise<{ items: DependencyUpdateReviewItem[]; warnings: string[] }> {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  let stdout = "";
  let stderr = "";

  try {
    const result = await runCommand(command, ["outdated", "-r", "--no-color"], {
      cwd: rootDir,
      timeout: 30_000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    stdout = normalizeExecText(result.stdout);
    stderr = normalizeExecText(result.stderr);
  } catch (error) {
    stdout = normalizeExecText((error as { stdout?: string | Buffer }).stdout);
    stderr = normalizeExecText((error as { stderr?: string | Buffer }).stderr);
  }

  const items = parsePnpmOutdatedOutput(stdout);
  const warnings: string[] = [];
  if (stderr.trim().length > 0 && items.length === 0) {
    warnings.push(`pnpm outdated reported an error without parseable rows: ${stderr.trim()}`);
  }
  if (stdout.trim().length === 0 && warnings.length === 0) {
    warnings.push("pnpm outdated returned no dependency data.");
  }
  return { items, warnings };
}

export async function collectSkillSourceDrift(
  rootDir: string,
  runCommand: ExecFileLike = execFileAsync,
): Promise<{ items: SkillSourceDriftReviewItem[]; warnings: string[] }> {
  const manifests = await readInstalledSkillSourceManifests(rootDir);
  const items: SkillSourceDriftReviewItem[] = [];
  const warnings: string[] = [];

  for (const manifest of manifests) {
    const sourceUrl = manifest.resolvedUpstream?.url
      ?? manifest.candidate?.repositoryUrl
      ?? manifest.candidate?.sourceUrl
      ?? manifest.candidate?.sourceRef;
    const currentVersion = manifest.resolvedUpstream?.version;

    if (!sourceUrl) {
      const message = "No tracked upstream source is recorded in source.json.";
      items.push({
        skillId: manifest.skillId,
        status: "warning",
        message,
      });
      warnings.push(`${manifest.skillId}: ${message}`);
      continue;
    }

    if (!/github\.com/i.test(sourceUrl)) {
      const message = "Tracked upstream is not a GitHub repository; automatic drift probing is skipped.";
      items.push({
        skillId: manifest.skillId,
        sourceUrl,
        currentVersion,
        status: "warning",
        message,
      });
      warnings.push(`${manifest.skillId}: ${message}`);
      continue;
    }

    if (!currentVersion) {
      const message = "Tracked upstream repository has no recorded baseline version.";
      items.push({
        skillId: manifest.skillId,
        sourceUrl,
        status: "warning",
        message,
      });
      warnings.push(`${manifest.skillId}: ${message}`);
      continue;
    }

    try {
      const result = await runCommand("git", ["ls-remote", sourceUrl, "HEAD"], {
        cwd: rootDir,
        timeout: 12_000,
        windowsHide: true,
        maxBuffer: 512 * 1024,
      });
      const latestVersion = parseGitLsRemoteHead(normalizeExecText(result.stdout));
      if (!latestVersion) {
        const message = "Git upstream probe returned no HEAD revision.";
        items.push({
          skillId: manifest.skillId,
          sourceUrl,
          currentVersion,
          status: "warning",
          message,
        });
        warnings.push(`${manifest.skillId}: ${message}`);
        continue;
      }
      items.push({
        skillId: manifest.skillId,
        sourceUrl,
        currentVersion,
        latestVersion,
        status: latestVersion === currentVersion ? "unchanged" : "changed",
        message: latestVersion === currentVersion
          ? "Upstream repository HEAD matches the recorded installed revision."
          : "Upstream repository HEAD differs from the recorded installed revision.",
      });
    } catch (error) {
      const stderr = normalizeExecText((error as { stderr?: string | Buffer }).stderr).trim();
      const message = stderr || (error as Error).message || "Failed to query upstream repository.";
      items.push({
        skillId: manifest.skillId,
        sourceUrl,
        currentVersion,
        status: "warning",
        message,
      });
      warnings.push(`${manifest.skillId}: ${message}`);
    }
  }

  return { items, warnings };
}

export async function createDailyUpdateReview(
  rootDir: string,
  runCommand: ExecFileLike = execFileAsync,
): Promise<UpdateReviewReport> {
  const [dependencyDrift, skillSourceDrift] = await Promise.all([
    collectWorkspaceDependencyDrift(rootDir, runCommand),
    collectSkillSourceDrift(rootDir, runCommand),
  ]);
  const changedSkillSourceCount = skillSourceDrift.items.filter((item) => item.status === "changed").length;
  const warningCount = dependencyDrift.warnings.length
    + skillSourceDrift.warnings.length
    + skillSourceDrift.items.filter((item) => item.status === "warning").length;

  return {
    generatedAt: new Date().toISOString(),
    dependencyDrift,
    skillSourceDrift,
    summary: {
      outdatedDependencyCount: dependencyDrift.items.length,
      changedSkillSourceCount,
      warningCount,
      checkedSkillCount: skillSourceDrift.items.length,
    },
  };
}

export function renderUpdateReviewMarkdown(report: UpdateReviewReport): string {
  const lines: string[] = [];
  lines.push("# Daily Update Review");
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Outdated dependencies: ${report.summary.outdatedDependencyCount}`);
  lines.push(`- Skills checked: ${report.summary.checkedSkillCount}`);
  lines.push(`- Skills with upstream drift: ${report.summary.changedSkillSourceCount}`);
  lines.push(`- Warnings: ${report.summary.warningCount}`);
  lines.push("");

  lines.push("## Workspace Dependencies");
  lines.push("");
  if (report.dependencyDrift.items.length === 0) {
    lines.push("_No dependency drift detected by `pnpm outdated -r`._");
  } else {
    lines.push("| Package | Current | Latest | Dependents |");
    lines.push("| --- | --- | --- | --- |");
    for (const item of report.dependencyDrift.items) {
      const packageLabel = item.dependencyType ? `${item.packageName} (${item.dependencyType})` : item.packageName;
      lines.push(`| ${packageLabel} | ${item.currentVersion} | ${item.latestVersion} | ${item.dependents.join(", ") || "-"} |`);
    }
  }
  lines.push("");

  lines.push("## Skill Source Drift");
  lines.push("");
  if (report.skillSourceDrift.items.length === 0) {
    lines.push("_No repo-managed extra skills were available for drift review._");
  } else {
    lines.push("| Skill | Status | Installed | Latest | Notes |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const item of report.skillSourceDrift.items) {
      lines.push(`| ${item.skillId} | ${item.status} | ${item.currentVersion ?? "-"} | ${item.latestVersion ?? "-"} | ${item.message} |`);
    }
  }
  lines.push("");

  if (report.dependencyDrift.warnings.length > 0 || report.skillSourceDrift.warnings.length > 0) {
    lines.push("## Warnings");
    lines.push("");
    for (const warning of [...report.dependencyDrift.warnings, ...report.skillSourceDrift.warnings]) {
      lines.push(`- ${warning}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function parsePnpmOutdatedOutput(raw: string): DependencyUpdateReviewItem[] {
  const lines = raw.replace(/\r\n/g, "\n").replace(ANSI_ESCAPE_RE, "").split("\n");
  const items: DependencyUpdateReviewItem[] = [];
  let current:
    | {
        packageName: string;
        dependencyType?: string;
        currentVersion: string;
        latestVersion: string;
        dependents: string[];
      }
    | undefined;

  for (const line of lines) {
    if (!line.trim().startsWith("│")) {
      continue;
    }
    const columns = extractTableColumns(line);
    if (columns.length < 4) {
      continue;
    }
    const packageColumn = columns[0] ?? "";
    const currentColumn = columns[1] ?? "";
    const latestColumn = columns[2] ?? "";
    const dependentsColumn = columns[3] ?? "";
    if (packageColumn === "Package" || packageColumn === "") {
      if (packageColumn === "" && current && dependentsColumn) {
        current.dependents.push(...splitDependents(dependentsColumn));
      }
      continue;
    }

    if (current) {
      items.push(current);
    }

    const { packageName, dependencyType } = parsePackageColumn(packageColumn);
    current = {
      packageName,
      dependencyType,
      currentVersion: currentColumn,
      latestVersion: latestColumn,
      dependents: splitDependents(dependentsColumn),
    };
  }

  if (current) {
    items.push(current);
  }

  return items;
}

function extractTableColumns(line: string): string[] {
  return line
    .split("│")
    .slice(1, -1)
    .map((column) => column.trim());
}

function parsePackageColumn(value: string): { packageName: string; dependencyType?: string } {
  const match = value.match(/^(.*?)(?:\s+\(([^)]+)\))?$/);
  const packageName = match?.[1]?.trim() || value.trim();
  const dependencyType = match?.[2]?.trim() || undefined;
  return { packageName, dependencyType };
}

function splitDependents(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseGitLsRemoteHead(raw: string): string | undefined {
  const line = raw.split(/\r?\n/).find((entry) => entry.trim().length > 0);
  if (!line) {
    return undefined;
  }
  return line.split(/\s+/)[0]?.trim() || undefined;
}

async function readInstalledSkillSourceManifests(rootDir: string): Promise<Array<InstalledSkillSourceManifest & { skillId: string }>> {
  const extraRoot = path.resolve(rootDir, "skills", "extra");
  if (!fsSync.existsSync(extraRoot)) {
    return [];
  }

  const manifests: Array<InstalledSkillSourceManifest & { skillId: string }> = [];
  const entries = await fs.readdir(extraRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const manifestPath = path.join(extraRoot, entry.name, "source.json");
    if (!fsSync.existsSync(manifestPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as InstalledSkillSourceManifest;
      manifests.push({
        skillId: entry.name,
        ...parsed,
      });
    } catch {
      manifests.push({
        skillId: entry.name,
      });
    }
  }
  return manifests;
}

function normalizeExecText(value: string | Buffer | undefined): string {
  if (value === undefined) {
    return "";
  }
  return typeof value === "string" ? value : value.toString("utf8");
}
