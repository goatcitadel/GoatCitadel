import path from "node:path";

export const DEFAULT_UI_PACKAGE = "@goatcitadel/mission-control-next";
/*
 * LEGACY_UI_PACKAGE remains exported solely for internal verification lanes
 * (verify:ui:parity legacy-surface smoke) that exercise the on-disk legacy
 * source until Track D Phase 3 archives it. The launcher's env-var fallback
 * (GOATCITADEL_UI_PACKAGE override) is now whitelisted to DEFAULT_UI_PACKAGE
 * only; users cannot opt into legacy through the dev or launcher path.
 */
export const LEGACY_UI_PACKAGE = "@goatcitadel/mission-control";

const SUPPORTED_LAUNCHER_PACKAGES = new Set([DEFAULT_UI_PACKAGE]);

const DISPLAY_NAMES = new Map([
  ["@goatcitadel/mission-control", "Mission Control"],
  ["@goatcitadel/mission-control-next", "Mission Control Next"],
]);

export function resolveUiTarget(repoRoot, env = process.env) {
  const packageName = env.GOATCITADEL_UI_PACKAGE?.trim() || DEFAULT_UI_PACKAGE;
  if (!SUPPORTED_LAUNCHER_PACKAGES.has(packageName)) {
    throw new Error(
      `Unsupported GOATCITADEL_UI_PACKAGE: ${packageName}. ` +
        `The legacy mission-control shell was retired from the launcher in 1.x; only ${DEFAULT_UI_PACKAGE} is supported here.`,
    );
  }
  const packageDirName = packageName.split("/").at(-1) || "mission-control-next";
  const appDir = path.join(repoRoot, "apps", packageDirName);
  const distDir = path.join(appDir, "dist");

  return {
    packageName,
    packageDirName,
    appDir,
    distDir,
    displayName: DISPLAY_NAMES.get(packageName) ?? packageDirName,
    screenshotDirName: packageDirName,
  };
}
