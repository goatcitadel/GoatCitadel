import fs from "node:fs";
import path from "node:path";

/** Managed ports are distinct from the external-runtime attachment URL overrides. */
export function readInstalledRuntimeSettings(installRoot) {
  const settingsPath = path.join(installRoot, "runtime", "launcher-settings.json");
  if (!fs.existsSync(settingsPath)) return { gatewayPort: 8787, uiPort: 5173 };
  const stat = fs.lstatSync(settingsPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
    throw new Error("Installed runtime settings must be a regular JSON file below 4096 bytes.");
  }
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (settings.schemaVersion !== 1 || !isPort(settings.gatewayPort) || !isPort(settings.uiPort)
    || settings.gatewayPort === settings.uiPort) {
    throw new Error("Invalid launcher-settings.json: choose distinct gatewayPort and uiPort values from 1024 to 65535.");
  }
  return { gatewayPort: settings.gatewayPort, uiPort: settings.uiPort };
}

function isPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}
