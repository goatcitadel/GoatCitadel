import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@goatcitadel/gateway-core";
import { resolvePackagedRuntimeAppDir, type RuntimeReleaseBindingPaths } from "./runtime-release-trust-filesystem.js";

const log = logger.child("capability-plugins");

/** Where a release bundle keeps the plugins that ship, inside its app folder (`scripts/packaging/build-bundle.mjs`). */
export const PACKAGED_BUILT_IN_PLUGINS_FOLDER = ["templates", "plugins"] as const;

/** The file every release's app folder holds, and that the packaged launcher requires before it runs one. */
const RELEASE_MANIFEST = "release-manifest.json";

/** What the server log says when a packaged install's plugins can't be read. It names no folder. */
export const UNVERIFIED_APP_FOLDER_MESSAGE =
  "No plugins that ship with GoatCitadel are listed: this packaged install's app folder couldn't be verified.";

/** Where a packaged app may be, and this Gateway's own files, which must sit inside the app folder it uses. */
export interface PackagedAppDiscovery {
  /** `GOATCITADEL_APP_DIR`, the app folder the packaged launcher names for its Gateway. */
  appDirVariable: string | undefined;
  /** The other folders the app may be in: the Gateway's working folder, its two parents and the root folder. */
  otherCandidates: readonly string[];
  runtimePaths: RuntimeReleaseBindingPaths;
}

/**
 * The folder the plugins that ship with GoatCitadel are read from, or undefined when none may be read.
 *
 * - A packaged install reads its release's own app folder (`<app>/templates/plugins`), part of the `app/` payload that
 *   only installing or updating a release writes; the Gateway never does. The app folder is found as the release-trust
 *   check finds it, and used only when it holds a `release-manifest.json` and this Gateway's own module, entry and
 *   Node runtime.
 * - The `app` folder holding this Gateway's own module is a candidate too, so a packaged Gateway started without the
 *   launcher (no `GOATCITADEL_APP_DIR`, from another working folder) still finds its release, or reads none.
 * - When something points to a packaged install (`GOATCITADEL_APP_DIR` names a folder that isn't a source checkout, or
 *   a candidate may hold a release manifest) but no app folder passes that check, no plugin is read as built in: never
 *   the writable runtime root's `plugins` folder. `report` (the server log) gets one plain line, naming no folder; the
 *   Plugins tab's wiring asks once, at startup.
 * - Otherwise (a checkout, or the Docker image) it is `<rootDir>/plugins`.
 */
export function builtInPluginsRoot(
  rootDir: string,
  discovery: PackagedAppDiscovery = thisGatewaysAppDiscovery(rootDir),
  report: (message: string) => void = (message) => log.warn(message),
): string | undefined {
  const moduleApp = appFolderHolding(discovery.runtimePaths.gatewayModulePath);
  const candidates = [discovery.appDirVariable, ...discovery.otherCandidates, ...(moduleApp ? [moduleApp] : [])];
  const appDir = resolvePackagedRuntimeAppDir(candidates, discovery.runtimePaths);
  if (appDir) return path.join(appDir, ...PACKAGED_BUILT_IN_PLUGINS_FOLDER);
  if (!pointsToPackagedInstall(discovery.appDirVariable, candidates))
    return path.join(path.resolve(rootDir), "plugins");
  report(UNVERIFIED_APP_FOLDER_MESSAGE);
  return undefined;
}

/**
 * Whether anything says this Gateway runs from a release: the launcher names an app folder that isn't a source
 * checkout (one holding `pnpm-workspace.yaml` and `bin/goatcitadel.mjs`, the launcher's own rule), or a candidate may
 * hold a release manifest of any kind.
 */
function pointsToPackagedInstall(
  appDirVariable: string | undefined,
  candidates: readonly (string | undefined)[],
): boolean {
  const named = appDirVariable?.trim();
  if (named && !isSourceCheckout(path.resolve(named))) return true;
  return candidates.some(
    (candidate) => candidate?.trim() && mayExist(path.join(path.resolve(candidate), RELEASE_MANIFEST)),
  );
}

/** The nearest folder named `app` (a release's fixed layout) that holds `file`, or undefined when none does. */
function appFolderHolding(file: string): string | undefined {
  if (!file.trim()) return undefined;
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (path.basename(dir).toLowerCase() === "app") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function isSourceCheckout(dir: string): boolean {
  return exists(path.join(dir, "pnpm-workspace.yaml")) && exists(path.join(dir, "bin", "goatcitadel.mjs"));
}

/** Whether something is at `file`, a link included. */
function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** The same, failing closed: only a missing entry (or a missing folder on its way) says nothing is there. */
function mayExist(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** The same candidates, in the same order, as GatewayService's release-trust check reads. */
function thisGatewaysAppDiscovery(rootDir: string): PackagedAppDiscovery {
  const cwd = process.cwd();
  return {
    appDirVariable: process.env.GOATCITADEL_APP_DIR,
    otherCandidates: [cwd, path.dirname(cwd), path.dirname(path.dirname(cwd)), rootDir],
    runtimePaths: {
      gatewayModulePath: fileURLToPath(import.meta.url),
      entryPath: process.argv[1] ?? "",
      executablePath: process.execPath,
    },
  };
}
