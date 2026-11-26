/**
 * Deterministic checks for scripts shipped inside a skill. Each rule reads one line at a time, so a finding names the
 * line it came from. Dangerous rules are the ones that run code fetched or hidden at run time, or wipe a whole drive
 * or home folder; the rest are caution signals the operator should see.
 */

export type ScriptRuleId =
  | "destructive_delete"
  | "encoded_command"
  | "download_and_run"
  | "credential_access"
  | "persistence";

export interface ScriptFinding {
  ruleId: ScriptRuleId;
  dangerous: boolean;
  line: number;
}

/** Files treated as scripts: their text is checked by these rules and their comments by the promptware scan. */
export const SCRIPT_FILE_PATTERN = /\.(ps1|psm1|bat|cmd|sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|vbs)$/i;

const NETWORK_INDICATOR_PATTERN = /(https?:\/\/|fetch\s*\(|axios\.|curl\s+)/i;

const SCRIPT_RULES: ReadonlyArray<{ ruleId: ScriptRuleId; dangerous: boolean; patterns: readonly RegExp[] }> = [
  {
    ruleId: "download_and_run",
    dangerous: true,
    patterns: [
      /\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|iex|Invoke-Expression|python3?|node)\b/i,
    ],
  },
  {
    ruleId: "encoded_command",
    dangerous: true,
    patterns: [
      /\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*\s-(?:e|en|enc|enco|encodedcommand)\b/i,
      /\bbase64\s+(?:-d|--decode)\b[^\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node)\b/i,
    ],
  },
  {
    ruleId: "destructive_delete",
    dangerous: true,
    patterns: [
      /\brm\s+-(?:rf|fr)\s+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME)\/?\*?(?:\s|$)/i,
      /\bdel\s+(?:\/[a-z]\s+)*[a-z]:\\(?:\s|$|\*)/i,
      /\bRemove-Item\b[^\n]*-Recurse[^\n]*\s[a-z]:\\(?:\s|$|\*)/i,
    ],
  },
  {
    ruleId: "credential_access",
    dangerous: false,
    patterns: [/\.ssh[\\/]id_|\.aws[\\/]credentials|\bLogin Data\b|Microsoft[\\/]Credentials|\.git-credentials/i],
  },
  {
    ruleId: "persistence",
    dangerous: false,
    patterns: [
      /\bcrontab\s+-e\b|CurrentVersion\\Run(?:Once)?\b|\bschtasks\s+\/create\b|>>\s*~\/\.(?:bashrc|zshrc|profile|bash_profile)\b|\bsystemctl\s+enable\b|LaunchAgents/i,
    ],
  },
];

/** Every rule match in a script's text, one finding per rule per line, in line order. */
export function scanScriptText(text: string): ScriptFinding[] {
  const findings: ScriptFinding[] = [];
  text.split(/\r\n|\r|\n/u).forEach((lineText, index) => {
    for (const rule of SCRIPT_RULES) {
      if (rule.patterns.some((pattern) => pattern.test(lineText))) {
        findings.push({ ruleId: rule.ruleId, dangerous: rule.dangerous, line: index + 1 });
      }
    }
  });
  return findings;
}

/** Whether text reaches out to the internet: a URL, `fetch(`, axios or curl. */
export function hasNetworkIndicator(text: string): boolean {
  return NETWORK_INDICATOR_PATTERN.test(text);
}
