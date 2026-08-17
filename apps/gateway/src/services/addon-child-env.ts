import { SECRET_ENV_KEY_PATTERN } from "@goatcitadel/contracts";

const ADDON_CHILD_ENV_ALLOWLIST = new Set([
  "APPDATA",
  "COMSPEC",
  "COREPACK_HOME",
  "HOME",
  "LOCALAPPDATA",
  "NODE_NO_WARNINGS",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PNPM_HOME",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
]);

export function buildAddonChildEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || !isAllowedAddonChildEnvKey(key)) {
      continue;
    }
    env[key] = value;
  }
  return {
    ...env,
    ...extraEnv,
  };
}

function isAllowedAddonChildEnvKey(key: string): boolean {
  const normalized = key.toUpperCase();
  if (SECRET_ENV_KEY_PATTERN.test(normalized)) {
    return false;
  }
  return ADDON_CHILD_ENV_ALLOWLIST.has(normalized);
}
