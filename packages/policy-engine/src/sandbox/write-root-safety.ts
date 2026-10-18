import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Safety rules for folders an operator may open to tool writes outside the
 * runtime's own write jail, and for runtime write targets that must never be
 * written or deleted no matter which root or grant admits them.
 *
 * The module only classifies paths; it never widens access by itself. Callers
 * stay responsible for deny-wins, approvals, and the path-jail checks.
 *
 * Enforcement: `sandbox/tool-write-gate.ts` applies these rules to every
 * filesystem, artifact, and browser-output write in the policy engine and the
 * tool executor. Git tools and html render outputs keep the plain write-jail
 * check.
 */
export type WriteRootRejection =
  | "control_characters"
  | "not_absolute"
  | "filesystem_root"
  | "drive_root"
  | "unc_share_root"
  | "system_directory"
  | "users_root"
  | "user_profile_root"
  | "sensitive_user_directory"
  | "contains_runtime_root"
  | "runtime_protected_path"
  | "not_a_directory"
  | "symlink_escape";

export type WriteRootPreset = "os_temp";

export interface WriteRootSafetyContext {
  /**
   * GoatCitadel runtime root (absolute). When omitted, only the system,
   * credential, and profile rules apply (plus any `protectedRuntimePaths`).
   */
  rootDir?: string;
  /** Absolute runtime paths that are never writable. Defaults to config/ and the sensitive data/ subtrees. */
  protectedRuntimePaths?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  tmpDir?: string;
  /** Returns the canonical path of an existing entry; throws when it does not exist. */
  realpath?: (target: string) => string;
  isDirectory?: (target: string) => boolean;
}

export type WriteRootCanonicalization =
  | { ok: true; canonicalPath: string }
  | { ok: false; rejection: WriteRootRejection; detail: string };

function hasControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}
const SENSITIVE_HOME_SUBPATHS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"];
const SENSITIVE_WIN32_HOME_SUBPATHS = [
  "AppData\\Roaming\\Microsoft\\Credentials",
  "AppData\\Roaming\\Microsoft\\Protect",
  "AppData\\Roaming\\Microsoft\\SystemCertificates",
  "AppData\\Local\\Microsoft\\Credentials",
];
const SENSITIVE_POSIX_HOME_SUBPATHS = ["Library/Keychains"];
const WIN32_DRIVE_SYSTEM_FOLDERS = ["system volume information", "$recycle.bin"];
const POSIX_SYSTEM_DIRECTORIES = [
  "/bin",
  "/sbin",
  "/usr",
  "/etc",
  "/boot",
  "/dev",
  "/proc",
  "/sys",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/System",
  "/Library",
  "/private/etc",
];
const DEFAULT_PROTECTED_RUNTIME_SUBPATHS: readonly (readonly string[])[] = [
  ["config"],
  ["data", "secrets"],
  ["data", "postgres"],
  ["data", "audit"],
  ["data", "index.db"],
  ["data", "index.db-wal"],
  ["data", "index.db-shm"],
  ["data", "index.db-journal"],
];

/**
 * Validate and canonicalize a folder an operator wants to open to tool writes.
 * The folder must exist, be a directory, and not be (or resolve through a
 * link to) a system, credential, profile, or runtime-owned location.
 */
export function canonicalizeOperatorWriteRoot(input: string, ctx: WriteRootSafetyContext): WriteRootCanonicalization {
  const p = pathApi(ctx);
  const trimmed = input.trim();
  if (hasControlCharacters(trimmed)) {
    return reject("control_characters", "Folder path contains control characters.");
  }
  if (!trimmed || !p.isAbsolute(trimmed)) {
    return reject("not_absolute", "Folder path must be absolute.");
  }
  const lexicalPath = stripTrailingSeparator(p.resolve(trimmed), ctx);
  const lexicalRejection = classifyOperatorWriteRoot(lexicalPath, ctx);
  if (lexicalRejection) {
    return reject(lexicalRejection, describeRejection(lexicalRejection, lexicalPath));
  }
  let canonicalPath: string;
  try {
    canonicalPath = stripTrailingSeparator((ctx.realpath ?? fs.realpathSync.native)(lexicalPath), ctx);
  } catch {
    return reject("not_a_directory", `Folder does not exist: ${lexicalPath}`);
  }
  if (!(ctx.isDirectory ?? defaultIsDirectory)(canonicalPath)) {
    return reject("not_a_directory", `Path is not a folder: ${canonicalPath}`);
  }
  if (classifyOperatorWriteRoot(canonicalPath, ctx)) {
    return reject("symlink_escape", `Folder resolves through a link to a protected location: ${canonicalPath}`);
  }
  return { ok: true, canonicalPath };
}

/**
 * Classify a resolved runtime write or delete target. Returns a rejection when
 * the target must be refused even inside an allowed root or grant; the tool
 * write gate enforces it (see the enforcement note above).
 * Pass a path already resolved through links (for example via the closest
 * existing ancestor), since this check is lexical.
 */
export function classifyHardForbiddenWritePath(
  resolvedPath: string,
  ctx: WriteRootSafetyContext,
): WriteRootRejection | undefined {
  const p = pathApi(ctx);
  if (hasControlCharacters(resolvedPath)) {
    return "control_characters";
  }
  if (!p.isAbsolute(resolvedPath)) {
    return "not_absolute";
  }
  return classifyOperatorWriteRoot(stripTrailingSeparator(p.resolve(resolvedPath), ctx), ctx);
}

/** Resolve a built-in root preset on the server; clients never supply the path. */
export function resolveWriteRootPreset(preset: WriteRootPreset, ctx: WriteRootSafetyContext): string {
  switch (preset) {
    case "os_temp":
      return pathApi(ctx).resolve(ctx.tmpDir ?? os.tmpdir());
  }
}

/** True when `target` is `root` or lies beneath it (case-insensitive on Windows). */
export function isSamePathOrDescendant(
  root: string,
  target: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = p.relative(fold(p.resolve(root)), fold(p.resolve(target)));
  if (relative === "") {
    return true;
  }
  return !p.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${p.sep}`);
}

function classifyOperatorWriteRoot(target: string, ctx: WriteRootSafetyContext): WriteRootRejection | undefined {
  return (
    classifyFilesystemRoot(target, ctx) ??
    classifySystemDirectory(target, ctx) ??
    classifyUserLocation(target, ctx) ??
    classifyRuntimeLocation(target, ctx)
  );
}

function classifyFilesystemRoot(target: string, ctx: WriteRootSafetyContext): WriteRootRejection | undefined {
  const p = pathApi(ctx);
  const parsedRoot = p.parse(target).root;
  if (!sameFolded(stripTrailingSeparator(parsedRoot, ctx), target, ctx)) {
    return undefined;
  }
  if (!isWin32(ctx)) {
    return "filesystem_root";
  }
  return parsedRoot.startsWith("\\\\") ? "unc_share_root" : "drive_root";
}

function classifySystemDirectory(target: string, ctx: WriteRootSafetyContext): WriteRootRejection | undefined {
  const forbidden = isWin32(ctx) ? win32SystemDirectories(ctx) : POSIX_SYSTEM_DIRECTORIES;
  if (forbidden.some((dir) => isSamePathOrDescendant(dir, target, platformOf(ctx)))) {
    return "system_directory";
  }
  if (isWin32(ctx)) {
    const segments = target.slice(path.win32.parse(target).root.length).split(/[\\/]+/u);
    if (WIN32_DRIVE_SYSTEM_FOLDERS.includes((segments[0] ?? "").toLowerCase())) {
      return "system_directory";
    }
  }
  return undefined;
}

function classifyUserLocation(target: string, ctx: WriteRootSafetyContext): WriteRootRejection | undefined {
  const home = resolveHomeDir(ctx);
  if (!home) {
    return undefined;
  }
  const p = pathApi(ctx);
  if (sameFolded(home, target, ctx)) {
    return "user_profile_root";
  }
  if (isSamePathOrDescendant(target, home, platformOf(ctx))) {
    return "users_root";
  }
  const sensitive = [
    ...SENSITIVE_HOME_SUBPATHS,
    ...(isWin32(ctx) ? SENSITIVE_WIN32_HOME_SUBPATHS : SENSITIVE_POSIX_HOME_SUBPATHS),
  ].map((subpath) => p.join(home, subpath));
  if (sensitive.some((dir) => isSamePathOrDescendant(dir, target, platformOf(ctx)))) {
    return "sensitive_user_directory";
  }
  return undefined;
}

function classifyRuntimeLocation(target: string, ctx: WriteRootSafetyContext): WriteRootRejection | undefined {
  const p = pathApi(ctx);
  const rootDir = ctx.rootDir ? p.resolve(ctx.rootDir) : undefined;
  if (rootDir && isSamePathOrDescendant(target, rootDir, platformOf(ctx))) {
    return "contains_runtime_root";
  }
  const protectedPaths =
    ctx.protectedRuntimePaths ??
    (rootDir ? DEFAULT_PROTECTED_RUNTIME_SUBPATHS.map((segments) => p.join(rootDir, ...segments)) : []);
  if (protectedPaths.some((dir) => isSamePathOrDescendant(dir, target, platformOf(ctx)))) {
    return "runtime_protected_path";
  }
  return undefined;
}

function win32SystemDirectories(ctx: WriteRootSafetyContext): string[] {
  const env = ctx.env ?? process.env;
  const systemDrive = env.SystemDrive ?? "C:";
  return [
    env.SystemRoot ?? env.windir ?? `${systemDrive}\\Windows`,
    env.ProgramFiles ?? `${systemDrive}\\Program Files`,
    env["ProgramFiles(x86)"] ?? `${systemDrive}\\Program Files (x86)`,
    env.ProgramW6432,
    env.ProgramData ?? `${systemDrive}\\ProgramData`,
  ].filter((dir): dir is string => typeof dir === "string" && dir.trim().length > 0);
}

function resolveHomeDir(ctx: WriteRootSafetyContext): string | undefined {
  const env = ctx.env ?? process.env;
  const candidate = ctx.homeDir ?? (isWin32(ctx) ? env.USERPROFILE : env.HOME) ?? os.homedir();
  return candidate ? stripTrailingSeparator(pathApi(ctx).resolve(candidate), ctx) : undefined;
}

function describeRejection(rejection: WriteRootRejection, target: string): string {
  const reasons: Record<WriteRootRejection, string> = {
    control_characters: "Folder path contains control characters.",
    not_absolute: "Folder path must be absolute.",
    filesystem_root: "The filesystem root cannot be opened to writes.",
    drive_root: "A drive root cannot be opened to writes.",
    unc_share_root: "A network share root cannot be opened to writes.",
    system_directory: "Operating-system and program folders cannot be opened to writes.",
    users_root: "The users folder (or a folder containing a user profile) cannot be opened to writes.",
    user_profile_root: "The whole user profile cannot be opened to writes; choose a folder inside it.",
    sensitive_user_directory: "Credential and key folders cannot be opened to writes.",
    contains_runtime_root: "A folder containing the GoatCitadel runtime cannot be opened to writes.",
    runtime_protected_path:
      "GoatCitadel configuration, secrets, database, and audit folders cannot be opened to writes.",
    not_a_directory: "Path is not an existing folder.",
    symlink_escape: "Folder resolves through a link to a protected location.",
  };
  return `${reasons[rejection]} (${target})`;
}

function reject(rejection: WriteRootRejection, detail: string): WriteRootCanonicalization {
  return { ok: false, rejection, detail };
}

function stripTrailingSeparator(value: string, ctx: WriteRootSafetyContext): string {
  const p = pathApi(ctx);
  const root = p.parse(value).root;
  if (value.length <= root.length) {
    return value;
  }
  return value.replace(/[\\/]+$/u, "");
}

function sameFolded(left: string, right: string, ctx: WriteRootSafetyContext): boolean {
  return isWin32(ctx) ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function defaultIsDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function platformOf(ctx: WriteRootSafetyContext): NodeJS.Platform {
  return ctx.platform ?? process.platform;
}

function isWin32(ctx: WriteRootSafetyContext): boolean {
  return platformOf(ctx) === "win32";
}

function pathApi(ctx: WriteRootSafetyContext): path.PlatformPath {
  return isWin32(ctx) ? path.win32 : path.posix;
}
