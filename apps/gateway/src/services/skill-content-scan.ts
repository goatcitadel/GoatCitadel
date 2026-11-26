import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SkillScanFinding, SkillScanFindingCode, SkillScanSummary } from "@goatcitadel/contracts";
import { PROMPTWARE_SCANNER_VERSION, scanPromptwareContent } from "./assembled-prompt-injection-guard.js";
import { SCRIPT_FILE_PATTERN, hasNetworkIndicator, scanScriptText } from "./skill-script-scan.js";

/**
 * One scan for every way a skill reaches the model. The findings are the same whatever the source; only the verdict
 * depends on it: a dangerous finding blocks an untrusted source and warns for the operator's own folders.
 */
export type SkillScanOrigin = "operator" | "untrusted";

export interface SkillScanFile {
  /** Path inside the skill folder, with `/` separators. */
  path: string;
  bytes: Uint8Array;
  /** The file's size on disk when the reader did not load an oversized file's bytes. */
  size?: number;
}

export const SKILL_SCAN_MAX_FILES = 80;
export const SKILL_SCAN_MAX_FILE_BYTES = 220_000;
const MAX_FINDINGS = 32;

/** Files read as prompt text by the promptware scan. Script files are read for their comments only. */
const PROMPT_TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|toml|html?|svg)$/i;
/** Images and fonts: not text, never sent to a model, so not scanned. */
const ASSET_FILE = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot)$/i;
const COMMENT_LINE = /^\s*(?:#|\/\/|--|;|\/\*|\*|<#|REM\b|::|'|<!--)/i;

export function scanSkillContents(
  files: readonly SkillScanFile[],
  origin: SkillScanOrigin,
  opts: { truncated?: boolean } = {},
): SkillScanSummary {
  const findings: SkillScanFinding[] = [];
  if (opts.truncated) findings.push({ code: "scan_incomplete", path: ".", dangerous: true });
  for (const file of files) findings.push(...scanOneFile(file));
  const sorted = dedupe(findings)
    .sort((left, right) => left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0))
    .slice(0, MAX_FINDINGS);
  return { verdict: verdictFor(sorted, origin), findings: sorted, scannerVersion: PROMPTWARE_SCANNER_VERSION };
}

function verdictFor(findings: readonly SkillScanFinding[], origin: SkillScanOrigin): SkillScanSummary["verdict"] {
  if (findings.length === 0) return "clean";
  return origin === "untrusted" && findings.some((finding) => finding.dangerous) ? "block" : "warn";
}

function scanOneFile(file: SkillScanFile): SkillScanFinding[] {
  if (ASSET_FILE.test(file.path)) return [];
  if ((file.size ?? file.bytes.length) > SKILL_SCAN_MAX_FILE_BYTES) {
    return [{ code: "scan_incomplete", path: file.path, dangerous: true }];
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return [{ code: "unreadable_file", path: file.path, dangerous: true }];
  }
  const isScript = SCRIPT_FILE_PATTERN.test(file.path);
  const findings: SkillScanFinding[] = [];
  const promptText = isScript ? commentsOnly(text) : PROMPT_TEXT_FILE.test(file.path) ? text : undefined;
  if (promptText !== undefined) {
    for (const finding of scanPromptwareContent({
      source: "imported_skill",
      sourcePath: file.path,
      content: promptText,
    })) {
      const code: SkillScanFindingCode =
        finding.ruleId === "hidden_text_obfuscation" ? "hidden_text" : "prompt_injection";
      findings.push({ code, path: file.path, line: finding.startLine, dangerous: true });
    }
  }
  for (const finding of scanScriptText(text)) {
    // Outside a script, a command is documentation the operator should see, not code that runs.
    const dangerous = isScript && finding.dangerous;
    findings.push({
      code: dangerous ? "unsafe_script" : "risky_script",
      path: file.path,
      line: finding.line,
      dangerous,
    });
  }
  if (hasNetworkIndicator(text)) {
    const line = text.split(/\r\n|\r|\n/u).findIndex((lineText) => hasNetworkIndicator(lineText)) + 1;
    findings.push({ code: "network_use", path: file.path, ...(line > 0 ? { line } : {}), dangerous: false });
  }
  return findings;
}

/** A script with its code lines blanked, so promptware line numbers still point at the right line. */
function commentsOnly(text: string): string {
  return text
    .split(/\r\n|\r|\n/u)
    .map((lineText) => (COMMENT_LINE.test(lineText) ? lineText : ""))
    .join("\n");
}

function dedupe(findings: SkillScanFinding[]): SkillScanFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\u0000${finding.path}\u0000${finding.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── readers ──────────────────────────────────────────────────────────

interface WalkEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function relativePath(root: string, fullPath: string): string {
  return path.relative(root, fullPath).replaceAll("\\", "/");
}

/** Every regular file under `dir` (not `.git`, not symlinks), up to SKILL_SCAN_MAX_FILES, read for the scan. */
export async function readSkillScanFiles(dir: string): Promise<{ files: SkillScanFile[]; truncated: boolean }> {
  const files: SkillScanFile[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: WalkEntry[];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= SKILL_SCAN_MAX_FILES) return { files, truncated: true };
      const size = (await fsp.stat(fullPath)).size;
      const bytes = size > SKILL_SCAN_MAX_FILE_BYTES ? new Uint8Array() : await fsp.readFile(fullPath);
      files.push({ path: relativePath(dir, fullPath), bytes, size });
    }
  }
  return { files, truncated: false };
}

/** The same walk as {@link readSkillScanFiles}, synchronously, for skill discovery. */
export function readSkillScanFilesSync(dir: string): { files: SkillScanFile[]; truncated: boolean } {
  const files: SkillScanFile[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: WalkEntry[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") queue.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= SKILL_SCAN_MAX_FILES) return { files, truncated: true };
      const size = fs.statSync(fullPath).size;
      const bytes = size > SKILL_SCAN_MAX_FILE_BYTES ? new Uint8Array() : fs.readFileSync(fullPath);
      files.push({ path: relativePath(dir, fullPath), bytes, size });
    }
  }
  return { files, truncated: false };
}
