#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectProjectReferenceFindings, collectWorkspaceProjectInput } from "./verify-tsconfig-project-references.mjs";

const LARGE_TRACKED_FILE_BYTES = 25 * 1024 * 1024;
const PERSONAL_PATH_SCAN_BYTES = 1 * 1024 * 1024;

const LOCAL_SETTINGS_EXACT_PATHS = new Set([".claude/settings.local.json"]);
const LOCAL_SETTINGS_SUFFIXES = [".local.json", ".local.toml", ".local.yaml", ".local.yml"];
const GENERATED_ARTIFACT_PREFIXES = ["artifacts/"];
const REQUIRED_GITATTRIBUTES_LINES = [
  "* text=auto eol=lf",
  "*.bat text eol=crlf",
  "*.cmd text eol=crlf",
  "*.ps1 text eol=crlf",
];
const INSTALLER_BINARY_EXTENSIONS = new Set([".appx", ".appxbundle", ".dmg", ".exe", ".msi", ".pkg"]);
const ARCHIVE_BINARY_EXTENSIONS = new Set([".7z", ".gz", ".rar", ".tar", ".tgz", ".zip"]);
const BINARY_SCAN_EXTENSIONS = new Set([
  ...INSTALLER_BINARY_EXTENSIONS,
  ...ARCHIVE_BINARY_EXTENSIONS,
  ".bin",
  ".dll",
  ".ico",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".png",
  ".wasm",
]);
const PERSONAL_PATH_PATTERNS = [
  { label: "Windows F drive source path", pattern: /\bF:[\\/]+code[\\/]+/i },
  { label: "MSYS F drive source path", pattern: /(^|[^\w])\/f\/code\//i },
  { label: "local user profile path", pattern: /\bC:[\\/]+Users[\\/]+spurn\b/i },
];
const PERSONAL_PATH_SCAN_SKIP_PATTERNS = [
  /\.test\.[cm]?[jt]sx?$/i,
  /\.spec\.[cm]?[jt]sx?$/i,
  /^docs\/review\//i,
  /^docs\/antigravity\//i,
  /^docs\/qa_1_0_readiness_manual_qa_2026-06-13\//i,
  /^docs\/QA_MANUAL_TEST_PLAN\.md$/i,
  /^docs\/GATEWAY_DECOMPOSITION_(?:REVIEW|IMPLEMENTATION_PLANNING)_PROMPT\.md$/i,
  /^eval-assets\/goatcitadel_prompt_pack\.md$/i,
];
const TRACKED_IGNORED_FILE_ALLOWLIST = new Set([
  "scripts/packaging/runtime/ui-static-server.mjs",
  "skills/bundled/goatcitadel-native-safe-self-improvement/templates/logs/ERRORS.md",
  "skills/bundled/goatcitadel-native-safe-self-improvement/templates/logs/EVAL_IDEAS.md",
  "skills/bundled/goatcitadel-native-safe-self-improvement/templates/logs/FEATURE_REQUESTS.md",
  "skills/bundled/goatcitadel-native-safe-self-improvement/templates/logs/LEARNINGS.md",
  "skills/bundled/goatcitadel-native-safe-self-improvement/templates/logs/ROUTING_GAPS.md",
]);

export function collectRepoHygieneFindings(input) {
  const trackedFiles = input.trackedFiles.map(normalizeRepoPath);
  const ignoredTrackedFiles = new Set((input.ignoredTrackedFiles ?? []).map(normalizeRepoPath));
  const fileInfoByPath = input.fileInfoByPath ?? new Map();
  const readTextFile = input.readTextFile;
  const findings = [];

  if (readTextFile && trackedFiles.includes(".gitattributes")) {
    const eolPolicyFindings = collectGitAttributesEolPolicyFindings(readTextFile(".gitattributes"));
    findings.push(...eolPolicyFindings);
  }

  if (readTextFile) {
    findings.push(...collectForcedProjectBuildFindings(trackedFiles, readTextFile));
  }

  for (const filePath of trackedFiles) {
    const info = fileInfoByPath.get(filePath);
    const size = info?.size;
    const lowerPath = filePath.toLowerCase();
    const ext = path.posix.extname(lowerPath);

    if (ignoredTrackedFiles.has(filePath) && !TRACKED_IGNORED_FILE_ALLOWLIST.has(filePath)) {
      findings.push({
        code: "TRACKED_IGNORED_FILE",
        filePath,
        message: "Tracked file is ignored by .gitignore and should be untracked or explicitly allowlisted.",
      });
    }
    if (LOCAL_SETTINGS_EXACT_PATHS.has(filePath) || LOCAL_SETTINGS_SUFFIXES.some((suffix) => lowerPath.endsWith(suffix))) {
      findings.push({
        code: "TRACKED_LOCAL_SETTINGS",
        filePath,
        message: "Local settings files must not be committed.",
      });
    }
    if (GENERATED_ARTIFACT_PREFIXES.some((prefix) => filePath.startsWith(prefix))) {
      findings.push({
        code: "TRACKED_GENERATED_ARTIFACT",
        filePath,
        message: "Generated release artifacts must live in release assets or workflow artifacts, not source.",
      });
    }
    if (INSTALLER_BINARY_EXTENSIONS.has(ext) || ARCHIVE_BINARY_EXTENSIONS.has(ext)) {
      findings.push({
        code: "TRACKED_BINARY_ARTIFACT",
        filePath,
        message: "Installer/archive binaries require an explicit release-asset path, not normal source tracking.",
      });
    }
    if (typeof size === "number" && size > LARGE_TRACKED_FILE_BYTES) {
      findings.push({
        code: "TRACKED_LARGE_FILE",
        filePath,
        message: `Tracked file is larger than ${LARGE_TRACKED_FILE_BYTES} bytes.`,
      });
    }
    if (readTextFile && shouldScanForPersonalPaths(filePath, size, ext)) {
      const source = readTextFile(filePath);
      for (const personalPath of PERSONAL_PATH_PATTERNS) {
        if (personalPath.pattern.test(source)) {
          findings.push({
            code: "TRACKED_PERSONAL_PATH",
            filePath,
            message: `Tracked file contains ${personalPath.label}.`,
          });
        }
      }
    }
  }

  return findings;
}

function collectGitAttributesEolPolicyFindings(source) {
  const configuredLines = new Set(
    source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#")),
  );
  return REQUIRED_GITATTRIBUTES_LINES.filter((line) => !configuredLines.has(line)).map((line) => ({
    code: "MISSING_EOL_POLICY",
    filePath: ".gitattributes",
    message: `.gitattributes must include '${line}' so cross-platform scripts keep deterministic line endings.`,
  }));
}

const WORKSPACE_PACKAGE_JSON = /^(?:packages|apps)\/[^/]+\/package\.json$/u;
const TSC_BUILD_FORCE = /\btsc\b[^&|]*\s-b\b[^&|]*\s--force\b/u;

/**
 * `tsc -b --force` rebuilds every project in the reference graph, not just the
 * package that ran it. `pnpm --filter <pkg>... build` runs sibling packages
 * concurrently, so one forced build rewrites a shared package's declaration
 * outputs while the siblings are reading them — surfacing as a transient
 * TS2306 "is not a module" against the shared package.
 *
 * A package that needs a guaranteed-fresh build should delete its own outputs
 * (dist AND its .tsbuildinfo, or tsc considers the project up to date and emits
 * nothing) and then run a plain `tsc -b`.
 */
function collectForcedProjectBuildFindings(trackedFiles, readTextFile) {
  const findings = [];
  for (const filePath of trackedFiles) {
    if (!WORKSPACE_PACKAGE_JSON.test(filePath)) continue;
    let scripts;
    try {
      scripts = JSON.parse(readTextFile(filePath) || "{}").scripts;
    } catch {
      continue;
    }
    for (const [name, command] of Object.entries(scripts ?? {})) {
      if (typeof command === "string" && TSC_BUILD_FORCE.test(command)) {
        findings.push({
          code: "TSC_BUILD_FORCE_REBUILDS_REFERENCES",
          filePath,
          message:
            `Script "${name}" passes --force to \`tsc -b\`, which rebuilds referenced projects too and races ` +
            "concurrent sibling builds. Delete this package's own dist and .tsbuildinfo, then run `tsc -b` without --force.",
        });
      }
    }
  }
  return findings;
}

export function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\/+/, "");
}

function shouldScanForPersonalPaths(filePath, size, ext) {
  if (PERSONAL_PATH_SCAN_SKIP_PATTERNS.some((pattern) => pattern.test(filePath))) {
    return false;
  }
  if (BINARY_SCAN_EXTENSIONS.has(ext)) {
    return false;
  }
  return typeof size !== "number" || size <= PERSONAL_PATH_SCAN_BYTES;
}

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readNulSeparatedGitList(args, cwd) {
  const output = runGit(args, cwd);
  return output.split("\0").map((item) => item.trim()).filter(Boolean);
}

function collectLiveRepoInput(rootDir) {
  const trackedFiles = readNulSeparatedGitList(["ls-files", "-z"], rootDir);
  const ignoredTrackedFiles = readNulSeparatedGitList(["ls-files", "-z", "-ci", "--exclude-standard"], rootDir);
  const fileInfoByPath = new Map();
  for (const filePath of trackedFiles) {
    try {
      const stat = fs.statSync(path.join(rootDir, filePath));
      fileInfoByPath.set(filePath, { size: stat.size });
    } catch {
      // Deleted tracked files are reported by git status; the hygiene lane only classifies present files.
    }
  }
  return {
    trackedFiles,
    ignoredTrackedFiles,
    fileInfoByPath,
    readTextFile: (filePath) => {
      try {
        return fs.readFileSync(path.join(rootDir, filePath), "utf8");
      } catch {
        return "";
      }
    },
  };
}

function main() {
  const rootDir = process.cwd();
  const findings = [
    ...collectRepoHygieneFindings(collectLiveRepoInput(rootDir)),
    ...collectProjectReferenceFindings(collectWorkspaceProjectInput(rootDir)),
  ];
  if (findings.length > 0) {
    console.error("Repo hygiene check failed:");
    for (const finding of findings) {
      console.error(`- [${finding.code}] ${finding.filePath}: ${finding.message}`);
    }
    process.exit(1);
  }
  console.log("Repo hygiene check passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
