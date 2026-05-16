import { parse as shellParse } from "shell-quote";
import { t } from "./i18n.js";
import { handleCommand } from "./shell-command-handlers.js";
import { prescreenShellRisks, type ShellRiskFinding, type ShellRiskLevel } from "./shell-command-prescreen.js";

export type { ShellRiskFinding, ShellRiskLevel } from "./shell-command-prescreen.js";
export type { ShellExplanationDetail } from "./shell-command-handlers.js";

export interface ShellCommandExplanation {
  readonly command: string;
  readonly parsed: boolean;
  readonly program?: string;
  readonly summary: string;
  readonly details: readonly import("./shell-command-handlers.js").ShellExplanationDetail[];
  readonly risks: readonly ShellRiskFinding[];
  readonly highestRisk: ShellRiskLevel;
}

const RISK_ORDER: ShellRiskLevel[] = ["info", "caution", "danger"];

function highest(risks: readonly ShellRiskFinding[]): ShellRiskLevel {
  let best: ShellRiskLevel = "info";
  for (const r of risks) {
    if (RISK_ORDER.indexOf(r.level) > RISK_ORDER.indexOf(best)) {
      best = r.level;
    }
  }
  return best;
}

function dedupeRisks(risks: readonly ShellRiskFinding[]): ShellRiskFinding[] {
  const seen = new Set<string>();
  const out: ShellRiskFinding[] = [];
  for (const r of risks) {
    const key = `${r.level}:${r.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

function hasUnmatchedQuote(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const ch of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    }
  }
  return inSingle || inDouble;
}

function tokenize(command: string): readonly string[] | undefined {
  if (hasUnmatchedQuote(command)) {
    return undefined;
  }
  try {
    const parsed = shellParse(command);
    const tokens: string[] = [];
    for (const item of parsed) {
      if (typeof item === "string") {
        tokens.push(item);
      } else {
        // operator object — stop tokenizing the head command at operators
        break;
      }
    }
    return tokens;
  } catch {
    return undefined;
  }
}

export function explainShellCommand(command: string): ShellCommandExplanation {
  const preRisks = prescreenShellRisks(command);

  if (command.trim().length === 0) {
    return {
      command,
      parsed: false,
      summary: t("shell.summary.empty"),
      details: [],
      risks: [],
      highestRisk: "info",
    };
  }

  const tokens = tokenize(command);
  if (!tokens || tokens.length === 0) {
    const risks = dedupeRisks(preRisks);
    return {
      command,
      parsed: false,
      summary: t("shell.summary.unparsed"),
      details: [],
      risks,
      highestRisk: highest(risks),
    };
  }

  const handled = handleCommand(tokens);
  const allRisks = dedupeRisks([...handled.risks, ...preRisks]);

  return {
    command,
    parsed: true,
    program: handled.program,
    summary: handled.summary,
    details: handled.details,
    risks: allRisks,
    highestRisk: highest(allRisks),
  };
}
