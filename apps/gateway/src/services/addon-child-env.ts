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

const ADDON_SECRET_ENV_PATTERN =
  /(?:API[_-]?KEY|AUTH|COOKIE|CREDENTIAL|DATABASE_URL|OPENAI|ANTHROPIC|GOOGLE|GEMINI|MOONSHOT|PERPLEXITY|MISTRAL|OPENROUTER|DEEPSEEK|GLM|GROQ|XAI|POSTGRES|PASSWORD|SECRET|TOKEN)/i;

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
  if (ADDON_SECRET_ENV_PATTERN.test(normalized)) {
    return false;
  }
  return ADDON_CHILD_ENV_ALLOWLIST.has(normalized);
}
