import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SkillScanFinding, SkillScanFindingCode, SkillScanSummary } from "@goatcitadel/contracts";
import { PROMPTWARE_SCANNER_VERSION, scanPromptwareContent } from "./assembled-prompt-injection-guard.js";
import {
  BROAD_SCRIPT_RISK_PATTERN,
  SCRIPT_FILE_PATTERN,
  SCRIPT_SCAN_MAX_LINE_CHARS,
  hasNetworkIndicator,
  hasOverlongLine,
  scanScriptText,
} from "./skill-script-scan.js";

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
  /** The reader couldn't open it (gone or locked mid-walk). */
  unreadable?: true;
}

export const SKILL_SCAN_MAX_FILES = 80;
export const SKILL_SCAN_MAX_FILE_BYTES = 220_000;
export const SKILL_SCAN_MAX_ENTRIES = 384;
const MAX_FINDINGS = 32;

/** Files read as prompt text by the promptware scan. Script files are read whole as well. */
const PROMPT_TEXT_FILE = /\.(md|markdown|txt|json|ya?ml|toml|html?|svg)$/i;
/** Images and fonts: not text, never sent to a model, so not scanned. */
const ASSET_FILE = /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot)$/i;

/** Images and fonts: the scan skips them, so a caller need not read their bytes. */
export function isSkillAssetPath(filePath: string): boolean {
  return ASSET_FILE.test(filePath);
}

export function scanSkillContents(
  files: readonly SkillScanFile[],
  origin: SkillScanOrigin,
  opts: { truncated?: boolean } = {},
): SkillScanSummary {
  return summarizeSkillFindings(collectSkillFindings(files, opts), origin);
}

const byPlace = (left: SkillScanFinding, right: SkillScanFinding) =>
  left.path.localeCompare(right.path) || (left.line ?? 0) - (right.line ?? 0);

/** Every finding, uncapped, by path and line. Callers that derive signals from findings must read this list. */
export function collectSkillFindings(
  files: readonly SkillScanFile[],
  opts: { truncated?: boolean } = {},
): SkillScanFinding[] {
  const findings: SkillScanFinding[] = [];
  if (opts.truncated) findings.push({ code: "scan_incomplete", path: ".", dangerous: true });
  for (const file of files) findings.push(...scanOneFile(file));
  return dedupe(findings).sort(byPlace);
}

/** The verdict from every finding, and the findings kept for display: at most 32, dangerous ones first. */
export function summarizeSkillFindings(all: readonly SkillScanFinding[], origin: SkillScanOrigin): SkillScanSummary {
  // The verdict reads every finding; the cap keeps dangerous findings first, so a block always shows its reason.
  const kept = [...all.filter((finding) => finding.dangerous), ...all.filter((finding) => !finding.dangerous)]
    .slice(0, MAX_FINDINGS)
    .sort(byPlace);
  return { verdict: verdictFor(all, origin), findings: kept, scannerVersion: PROMPTWARE_SCANNER_VERSION };
}

function verdictFor(findings: readonly SkillScanFinding[], origin: SkillScanOrigin): SkillScanSummary["verdict"] {
  // A link on its own is listed, not a warning: most skills mention a web address, and the label should mean something.
  if (findings.every((finding) => finding.code === "network_use")) return "clean";
  return origin === "untrusted" && findings.some((finding) => finding.dangerous) ? "block" : "warn";
}

function scanOneFile(file: SkillScanFile): SkillScanFinding[] {
  if (file.unreadable) return [{ code: "unreadable_file", path: file.path, dangerous: true }];
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
  // A script is checked whole: telling its comments from its code takes a parser per language, and every shortcut
  // was a way around the check. An injection phrase in a code string is flagged too.
  const promptText = isScript || PROMPT_TEXT_FILE.test(file.path) ? text : undefined;
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
  const scriptFindings = scanScriptText(text);
  if (hasOverlongLine(text)) findings.push({ code: "scan_incomplete", path: file.path, dangerous: true });
  const ruledLines = new Set(scriptFindings.map((finding) => finding.line));
  text.split(/\r\n|\r|\n/u).forEach((lineText, index) => {
    // The broader original check (any `rm -rf`) stays a caution signal where no rule already spoke.
    if (lineText.length > SCRIPT_SCAN_MAX_LINE_CHARS) return;
    if (!ruledLines.has(index + 1) && BROAD_SCRIPT_RISK_PATTERN.test(lineText)) {
      findings.push({ code: "risky_script", path: file.path, line: index + 1, dangerous: false });
    }
  });
  for (const finding of scriptFindings) {
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

function relativePath(root: string, fullPath: string): string {
  return path.relative(root, fullPath).replaceAll("\\", "/");
}

/** Reads regular files within both scan budgets, skipping symlinks and `.git` directories. */
export async function readSkillScanFiles(dir: string): Promise<{ files: SkillScanFile[]; truncated: boolean }> {
  const files: SkillScanFile[] = [];
  const queue = [dir];
  let entriesRead = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      for await (const entry of await fsp.opendir(current)) {
        if (++entriesRead > SKILL_SCAN_MAX_ENTRIES) return { files, truncated: true };
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && entry.name !== ".git") queue.push(fullPath);
        if (!entry.isFile()) continue;
        if (files.length >= SKILL_SCAN_MAX_FILES) return { files, truncated: true };
        try {
          const size = (await fsp.stat(fullPath)).size;
          const bytes = size > SKILL_SCAN_MAX_FILE_BYTES ? new Uint8Array() : await fsp.readFile(fullPath);
          files.push({ path: relativePath(dir, fullPath), bytes, size });
        } catch {
          files.push({ path: relativePath(dir, fullPath), bytes: new Uint8Array(), unreadable: true });
        }
      }
    } catch {
      files.push({ path: relativePath(dir, current) || ".", bytes: new Uint8Array(), unreadable: true });
    }
  }
  return { files, truncated: false };
}

/** The same walk as {@link readSkillScanFiles}, synchronously, for skill discovery. */
export function readSkillScanFilesSync(dir: string): { files: SkillScanFile[]; truncated: boolean } {
  const files: SkillScanFile[] = [];
  const queue = [dir];
  let entriesRead = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const directory = fs.opendirSync(current);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++entriesRead > SKILL_SCAN_MAX_ENTRIES) return { files, truncated: true };
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory() && entry.name !== ".git") queue.push(fullPath);
          if (!entry.isFile()) continue;
          if (files.length >= SKILL_SCAN_MAX_FILES) return { files, truncated: true };
          try {
            const size = fs.statSync(fullPath).size;
            const bytes = size > SKILL_SCAN_MAX_FILE_BYTES ? new Uint8Array() : fs.readFileSync(fullPath);
            files.push({ path: relativePath(dir, fullPath), bytes, size });
          } catch {
            files.push({ path: relativePath(dir, fullPath), bytes: new Uint8Array(), unreadable: true });
          }
        }
      } finally {
        directory.closeSync();
      }
    } catch {
      files.push({ path: relativePath(dir, current) || ".", bytes: new Uint8Array(), unreadable: true });
    }
  }
  return { files, truncated: false };
}
