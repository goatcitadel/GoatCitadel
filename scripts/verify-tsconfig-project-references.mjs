#!/usr/bin/env node
/**
 * Cross-checks every workspace project's TypeScript "references" against the
 * workspace packages its compiled sources actually import.
 *
 * Why this needs a guard: a missing project reference does not break the build.
 * Both tsc 7 and the tsc 6 compatibility compiler build a workspace project
 * reached through a bare package-name import even when it is not declared, so
 * `tsc -b` and `pnpm --filter <pkg> typecheck` both exit 0. What breaks is
 * incremental correctness. An undeclared project's outputs are not inputs to
 * the consumer's up-to-date check, so after the dependency changes the consumer
 * is not rebuilt and silently compiles against stale declarations. apps/gateway
 * imported @goatcitadel/mission-control-shared this way: renaming an export in
 * mission-control-shared left the gateway typecheck passing with exit 0, which
 * is how a stale goatcitadel-session-control bin could ship.
 *
 * Import extraction runs through TypeScript's own scanner rather than a text
 * search, so comments and string literals never register as dependencies.
 * mission-control-shared names @goatcitadel/threaded-surface-core in five
 * comments (see src/state/chat-streaming-preview-store.ts, which documents the
 * one-way direction deliberately) while importing nothing from it; a text
 * search reports a package cycle there and this scanner correctly does not.
 *
 * Workspace packages without a tsconfig.json are outside the guard: they cannot
 * be the target of a project reference, so there is nothing to declare.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const WORKSPACE_SCOPE = "@goatcitadel/";
const SCANNED_SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export function collectProjectReferenceFindings(input) {
  const projects = input.projects ?? [];
  if (projects.length === 0) {
    return [
      {
        code: "WORKSPACE_DISCOVERY_EMPTY",
        filePath: "pnpm-workspace.yaml",
        message:
          "No workspace TypeScript projects were discovered, so the project-reference guard would pass without checking anything.",
      },
    ];
  }

  const packageNameByDirectory = new Map(projects.map((project) => [project.directory, project.packageName]));
  const directoryByPackageName = new Map(projects.map((project) => [project.packageName, project.directory]));
  const findings = [];

  for (const project of [...projects].sort((a, b) => a.tsconfigPath.localeCompare(b.tsconfigPath))) {
    if (project.parseError) {
      findings.push({
        code: "TSCONFIG_PARSE_FAILURE",
        filePath: project.tsconfigPath,
        message: `TypeScript could not read this project, so its references cannot be checked: ${project.parseError}`,
      });
      continue;
    }

    const referencedPackageNames = new Set();
    for (const reference of project.references ?? []) {
      const referencedName = reference.resolvedDirectory
        ? packageNameByDirectory.get(reference.resolvedDirectory)
        : undefined;
      if (referencedName === undefined) {
        findings.push({
          code: "UNRESOLVABLE_PROJECT_REFERENCE",
          filePath: project.tsconfigPath,
          message: `Reference '${reference.rawPath}' does not resolve to a workspace package with a tsconfig.json, so it cannot satisfy an import.`,
        });
        continue;
      }
      referencedPackageNames.add(referencedName);
    }

    for (const [packageName, sites] of groupImportsByPackage(project, directoryByPackageName)) {
      if (referencedPackageNames.has(packageName)) {
        continue;
      }
      findings.push({
        code: "MISSING_PROJECT_REFERENCE",
        filePath: project.tsconfigPath,
        message: buildMissingReferenceMessage(project, packageName, sites, directoryByPackageName),
      });
    }
  }

  return findings;
}

function groupImportsByPackage(project, directoryByPackageName) {
  const sitesByPackage = new Map();
  for (const importSite of project.imports ?? []) {
    if (importSite.packageName === project.packageName) {
      continue;
    }
    if (!directoryByPackageName.has(importSite.packageName)) {
      continue;
    }
    const sites = sitesByPackage.get(importSite.packageName);
    if (sites) {
      sites.push(importSite);
    } else {
      sitesByPackage.set(importSite.packageName, [importSite]);
    }
  }
  return [...sitesByPackage.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function buildMissingReferenceMessage(project, packageName, sites, directoryByPackageName) {
  const example = [...sites].sort((a, b) =>
    a.filePath === b.filePath ? a.specifier.localeCompare(b.specifier) : a.filePath.localeCompare(b.filePath),
  )[0];
  const otherSites = sites.length - 1;
  const suffix = otherSites > 0 ? ` and ${otherSites} other import${otherSites === 1 ? "" : "s"}` : "";
  const referencePath = path.posix.relative(
    path.posix.dirname(project.tsconfigPath),
    directoryByPackageName.get(packageName),
  );
  return (
    `${example.filePath} imports '${example.specifier}'${suffix}, but ${packageName} is not a declared reference. ` +
    `Add { "path": "${referencePath}" } to "references", otherwise this project is not rebuilt when ${packageName} changes and compiles against stale declarations.`
  );
}

export function workspacePackageNameFromSpecifier(specifier) {
  if (!specifier.startsWith(WORKSPACE_SCOPE)) {
    return null;
  }
  const withoutScope = specifier.slice(WORKSPACE_SCOPE.length);
  const packageSegment = withoutScope.split("/")[0];
  return packageSegment ? `${WORKSPACE_SCOPE}${packageSegment}` : null;
}

export function collectWorkspaceImports(ts, source) {
  const specifiers = ts.preProcessFile(source, true, true).importedFiles.map((reference) => reference.fileName);
  const workspaceImports = [];
  for (const specifier of specifiers) {
    const packageName = workspacePackageNameFromSpecifier(specifier);
    if (packageName) {
      workspaceImports.push({ packageName, specifier });
    }
  }
  return workspaceImports;
}

export function parseWorkspacePackageGlobs(source) {
  const lines = source.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line));
  if (startIndex === -1) {
    throw new Error("pnpm-workspace.yaml has no 'packages:' list; workspace discovery would silently scan nothing.");
  }

  const globs = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const entry = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (!entry) {
      break;
    }
    globs.push(entry[1].replace(/^["']|["']$/g, ""));
  }

  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml declares an empty 'packages:' list.");
  }
  return globs;
}

function resolveWorkspacePackageDirectories(rootDir, globs) {
  const directories = new Set();
  for (const glob of globs) {
    if (glob.startsWith("!")) {
      throw new Error(
        `Unsupported pnpm workspace exclusion '${glob}'. Teach this guard the pattern rather than letting it narrow the scan silently.`,
      );
    }
    if (glob.includes("*")) {
      if (!glob.endsWith("/*") || glob.slice(0, -2).includes("*")) {
        throw new Error(
          `Unsupported pnpm workspace glob '${glob}'. Teach this guard the pattern rather than letting it narrow the scan silently.`,
        );
      }
      const parent = glob.slice(0, -2);
      for (const entry of readDirectoryEntries(path.join(rootDir, parent))) {
        if (entry.isDirectory()) {
          directories.add(`${parent}/${entry.name}`);
        }
      }
      continue;
    }
    directories.add(glob.replace(/\/+$/, ""));
  }
  return [...directories].sort();
}

function readDirectoryEntries(directory) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readWorkspacePackageName(rootDir, directory) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(rootDir, directory, "package.json"), "utf8"));
    return typeof manifest.name === "string" ? manifest.name : null;
  } catch {
    return null;
  }
}

function toRepoRelativePosixPath(rootDir, absolutePath) {
  return path.relative(rootDir, absolutePath).replaceAll("\\", "/");
}

function loadTypeScript() {
  const require = createRequire(import.meta.url);
  try {
    const loaded = require("typescript");
    return loaded.default ?? loaded;
  } catch (error) {
    throw new Error("The project-reference guard needs the workspace TypeScript install.", { cause: error });
  }
}

function readProject(ts, rootDir, directory, packageName) {
  const tsconfigAbsolutePath = path.join(rootDir, directory, "tsconfig.json");
  const tsconfigPath = toRepoRelativePosixPath(rootDir, tsconfigAbsolutePath);
  const project = {
    packageName,
    directory,
    tsconfigPath,
    parseError: null,
    references: [],
    imports: [],
  };

  const unrecoverableDiagnostics = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(tsconfigAbsolutePath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      unrecoverableDiagnostics.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    },
  });

  if (!parsed) {
    project.parseError = unrecoverableDiagnostics.join("; ") || "tsconfig.json could not be parsed.";
    return project;
  }

  // A config error can leave `fileNames` empty, which would make this project
  // pass with no imports to check rather than fail. Surface it instead.
  const configErrors = (parsed.errors ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
  if (configErrors.length > 0) {
    project.parseError = configErrors.join("; ");
    return project;
  }

  project.references = (parsed.projectReferences ?? []).map((reference) => {
    const referenceAbsolutePath = reference.path.toLowerCase().endsWith(".json")
      ? path.dirname(reference.path)
      : reference.path;
    return {
      rawPath: reference.originalPath ?? toRepoRelativePosixPath(rootDir, reference.path),
      resolvedDirectory: toRepoRelativePosixPath(rootDir, referenceAbsolutePath),
    };
  });

  for (const fileName of parsed.fileNames) {
    if (!SCANNED_SOURCE_EXTENSIONS.has(path.extname(fileName).toLowerCase())) {
      continue;
    }
    let source;
    try {
      source = fs.readFileSync(fileName, "utf8");
    } catch {
      continue;
    }
    const filePath = toRepoRelativePosixPath(rootDir, fileName);
    for (const workspaceImport of collectWorkspaceImports(ts, source)) {
      project.imports.push({ ...workspaceImport, filePath });
    }
  }

  return project;
}

export function collectWorkspaceProjectInput(rootDir) {
  const ts = loadTypeScript();
  const globs = parseWorkspacePackageGlobs(fs.readFileSync(path.join(rootDir, "pnpm-workspace.yaml"), "utf8"));
  const projects = [];

  for (const directory of resolveWorkspacePackageDirectories(rootDir, globs)) {
    if (!fs.existsSync(path.join(rootDir, directory, "tsconfig.json"))) {
      continue;
    }
    const packageName = readWorkspacePackageName(rootDir, directory);
    if (!packageName) {
      continue;
    }
    projects.push(readProject(ts, rootDir, directory, packageName));
  }

  return { projects };
}

function main() {
  const rootDir = process.cwd();
  const findings = collectProjectReferenceFindings(collectWorkspaceProjectInput(rootDir));
  if (findings.length > 0) {
    console.error("TypeScript project reference check failed:");
    for (const finding of findings) {
      console.error(`- [${finding.code}] ${finding.filePath}: ${finding.message}`);
    }
    process.exit(1);
  }
  console.log("TypeScript project reference check passed.");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
