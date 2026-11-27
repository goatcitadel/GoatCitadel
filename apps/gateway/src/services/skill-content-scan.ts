import fs, { type BigIntStats } from "node:fs";
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
  const ordered = [...all].sort(byPlace);
  const kept = [...ordered.filter((finding) => finding.dangerous), ...ordered.filter((finding) => !finding.dangerous)]
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
  if (isSkillAssetPath(file.path)) return [];
  if (file.unreadable) return [{ code: "unreadable_file", path: file.path, dangerous: true }];
  if (file.bytes.length > SKILL_SCAN_MAX_FILE_BYTES || (file.size ?? 0) > SKILL_SCAN_MAX_FILE_BYTES) {
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
  for (const finding of scanPromptwareContent({
    source: "imported_skill",
    sourcePath: file.path,
    content: text,
  })) {
    const code: SkillScanFindingCode =
      finding.ruleId === "hidden_text_obfuscation" ? "hidden_text" : "prompt_injection";
    findings.push({ code, path: file.path, line: finding.startLine, dangerous: true });
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

const SCAN_OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (process.platform === "win32" ? 0 : (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
const scanStatOptions = { bigint: true } as const;

function assertSameScanEntry(before: BigIntStats, after: BigIntStats): void {
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.birthtimeNs !== after.birthtimeNs ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error("Skill scan entry changed.");
  }
}

function assertSameScanFile(before: BigIntStats, after: BigIntStats): void {
  assertSameScanEntry(before, after);
  if (!after.isFile() || before.size !== after.size) {
    throw new Error("Skill scan file changed.");
  }
}

function assertCanonicalScanPath(expected: string, canonical: string): void {
  if (path.relative(expected, canonical) !== "") throw new Error("Skill scan path resolves to a different entry.");
}

function unreadableScanFile(relative: string): SkillScanFile {
  return { path: relative, bytes: new Uint8Array(), unreadable: true };
}

function unreadableScanDirectory(root: string, directory: string): SkillScanFile {
  const relative = relativePath(root, directory);
  return unreadableScanFile(relative ? `${relative}/` : ".");
}

async function readScanFile(root: string, filename: string): Promise<SkillScanFile> {
  const relative = relativePath(root, filename);
  try {
    const before = await fsp.lstat(filename, scanStatOptions);
    if (!before.isFile()) return unreadableScanFile(relative);
    assertCanonicalScanPath(filename, await fsp.realpath(filename));
    const handle = await fsp.open(filename, SCAN_OPEN_FLAGS);
    try {
      const opened = await handle.stat(scanStatOptions);
      assertSameScanFile(before, opened);
      // Where no no-follow open is available, compare the opened handle with the checked path before reading.
      assertCanonicalScanPath(filename, await fsp.realpath(filename));
      assertSameScanFile(opened, await fsp.lstat(filename, scanStatOptions));
      const size = Number(opened.size);
      if (size > SKILL_SCAN_MAX_FILE_BYTES) return { path: relative, bytes: new Uint8Array(), size };
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; ) {
        const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
        if (bytesRead === 0) return unreadableScanFile(relative);
        offset += bytesRead;
      }
      assertSameScanFile(opened, await handle.stat(scanStatOptions));
      return { path: relative, bytes, size };
    } finally {
      await handle.close();
    }
  } catch {
    return unreadableScanFile(relative);
  }
}

function readScanFileSync(root: string, filename: string): SkillScanFile {
  const relative = relativePath(root, filename);
  try {
    const before = fs.lstatSync(filename, scanStatOptions);
    if (!before.isFile()) return unreadableScanFile(relative);
    assertCanonicalScanPath(filename, fs.realpathSync.native(filename));
    const fd = fs.openSync(filename, SCAN_OPEN_FLAGS);
    try {
      const opened = fs.fstatSync(fd, scanStatOptions);
      assertSameScanFile(before, opened);
      assertCanonicalScanPath(filename, fs.realpathSync.native(filename));
      assertSameScanFile(opened, fs.lstatSync(filename, scanStatOptions));
      const size = Number(opened.size);
      if (size > SKILL_SCAN_MAX_FILE_BYTES) return { path: relative, bytes: new Uint8Array(), size };
      const bytes = new Uint8Array(size);
      for (let offset = 0; offset < size; ) {
        const bytesRead = fs.readSync(fd, bytes, offset, size - offset, offset);
        if (bytesRead === 0) return unreadableScanFile(relative);
        offset += bytesRead;
      }
      assertSameScanFile(opened, fs.fstatSync(fd, scanStatOptions));
      return { path: relative, bytes, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return unreadableScanFile(relative);
  }
}

/** Reads regular files within both scan budgets, skipping symlinks and `.git` directories. */
export async function readSkillScanFiles(
  dir: string,
  options: { includeAssetBytes?: boolean } = {},
): Promise<{ files: SkillScanFile[]; truncated: boolean }> {
  let root: string;
  try {
    const before = await fsp.lstat(dir, scanStatOptions);
    if (!before.isDirectory()) throw new Error("Skill scan root is not a directory.");
    root = await fsp.realpath(dir);
    assertSameScanEntry(before, await fsp.lstat(root, scanStatOptions));
  } catch {
    return { files: [unreadableScanFile(".")], truncated: false };
  }
  const files: SkillScanFile[] = [];
  const queue = [root];
  let entriesRead = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const before = await fsp.lstat(current, scanStatOptions);
      if (!before.isDirectory()) throw new Error("Skill scan entry is not a directory.");
      assertCanonicalScanPath(current, await fsp.realpath(current));
      for await (const entry of await fsp.opendir(current)) {
        if (++entriesRead > SKILL_SCAN_MAX_ENTRIES) return { files, truncated: true };
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory() && entry.name !== ".git") queue.push(fullPath);
        if (!entry.isFile()) continue;
        if (isSkillAssetPath(entry.name) && !options.includeAssetBytes) continue;
        if (files.length >= SKILL_SCAN_MAX_FILES) return { files, truncated: true };
        files.push(await readScanFile(root, fullPath));
      }
      assertSameScanEntry(before, await fsp.lstat(current, scanStatOptions));
    } catch {
      files.push(unreadableScanDirectory(root, current));
    }
  }
  return { files, truncated: false };
}

/** The same walk as {@link readSkillScanFiles}, synchronously, for skill discovery. */
export function readSkillScanFilesSync(dir: string): { files: SkillScanFile[]; truncated: boolean } {
  let root: string;
  try {
    const before = fs.lstatSync(dir, scanStatOptions);
    if (!before.isDirectory()) throw new Error("Skill scan root is not a directory.");
    root = fs.realpathSync.native(dir);
    assertSameScanEntry(before, fs.lstatSync(root, scanStatOptions));
  } catch {
    return { files: [unreadableScanFile(".")], truncated: false };
  }
  const files: SkillScanFile[] = [];
  const queue = [root];
  let entriesRead = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    try {
      const before = fs.lstatSync(current, scanStatOptions);
      if (!before.isDirectory()) throw new Error("Skill scan entry is not a directory.");
      assertCanonicalScanPath(current, fs.realpathSync.native(current));
      const directory = fs.opendirSync(current);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++entriesRead > SKILL_SCAN_MAX_ENTRIES) return { files, truncated: true };
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory() && entry.name !== ".git") queue.push(fullPath);
          if (!entry.isFile()) continue;
          if (isSkillAssetPath(entry.name)) continue;
          if (files.length >= SKILL_SCAN_MAX_FILES) return { files, truncated: true };
          files.push(readScanFileSync(root, fullPath));
        }
      } finally {
        directory.closeSync();
      }
      assertSameScanEntry(before, fs.lstatSync(current, scanStatOptions));
    } catch {
      files.push(unreadableScanDirectory(root, current));
    }
  }
  return { files, truncated: false };
}
