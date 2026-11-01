import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackagedRuntimeAppDir, type RuntimeReleaseBindingPaths } from "./runtime-release-trust-filesystem.js";

/** Where a release bundle keeps the plugins that ship, inside its app folder (`scripts/packaging/build-bundle.mjs`). */
export const PACKAGED_BUILT_IN_PLUGINS_FOLDER = ["templates", "plugins"] as const;

/** The folders a packaged app may be in, and this Gateway's own files, which must sit inside the one it uses. */
export interface PackagedAppDiscovery {
  candidates: readonly (string | undefined)[];
  runtimePaths: RuntimeReleaseBindingPaths;
}

/**
 * The folder the plugins that ship with GoatCitadel are read from. A packaged install reads them from its release's
 * own app folder (`<app>/templates/plugins`), which the installer writes and nothing at runtime changes, and never from
 * the writable runtime root, so a folder placed there never reads as built in and a new release's plugins arrive with
 * it. A checkout or the Docker image reads `<rootDir>/plugins`.
 *
 * The app folder is found as the release-trust check finds it: the one the packaged launcher names in
 * `GOATCITADEL_APP_DIR` (or the Gateway's own working folder's), accepted only when it holds a `release-manifest.json`
 * and this Gateway's module, entry and Node runtime.
 */
export function builtInPluginsRoot(
  rootDir: string,
  discovery: PackagedAppDiscovery = thisGatewaysAppDiscovery(rootDir),
): string {
  const appDir = resolvePackagedRuntimeAppDir([...discovery.candidates], discovery.runtimePaths);
  return appDir ? path.join(appDir, ...PACKAGED_BUILT_IN_PLUGINS_FOLDER) : path.join(path.resolve(rootDir), "plugins");
}

/** The same candidates, in the same order, as GatewayService's release-trust check reads. */
function thisGatewaysAppDiscovery(rootDir: string): PackagedAppDiscovery {
  const cwd = process.cwd();
  return {
    candidates: [process.env.GOATCITADEL_APP_DIR, cwd, path.dirname(cwd), path.dirname(path.dirname(cwd)), rootDir],
    runtimePaths: {
      gatewayModulePath: fileURLToPath(import.meta.url),
      entryPath: process.argv[1] ?? "",
      executablePath: process.execPath,
    },
  };
}
