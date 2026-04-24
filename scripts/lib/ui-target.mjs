import path from "node:path";

export const DEFAULT_UI_PACKAGE = "@goatcitadel/mission-control-next";
export const LEGACY_UI_PACKAGE = "@goatcitadel/mission-control";

const DISPLAY_NAMES = new Map([
  ["@goatcitadel/mission-control", "Mission Control"],
  ["@goatcitadel/mission-control-next", "Mission Control Next"],
]);

export function resolveUiTarget(repoRoot, env = process.env) {
  const packageName = env.GOATCITADEL_UI_PACKAGE?.trim() || DEFAULT_UI_PACKAGE;
  const packageDirName = packageName.split("/").at(-1) || "mission-control";
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
