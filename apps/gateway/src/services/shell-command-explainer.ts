import type {
  ApprovalRequest,
  ShellCommandExplanation,
  ShellRiskFinding,
  ShellRiskLevel,
} from "@goatcitadel/contracts";
import { parse as shellParse } from "shell-quote";
import type { ShellExplainerPolicyConfig } from "../config.js";
import { handleCommand } from "./shell-command-handlers.js";
import { t } from "./shell-command-explainer-i18n.js";
import { prescreenShellRisks } from "./shell-command-prescreen.js";

export {
  type ShellCommandExplanation,
  type ShellExplanationDetail,
  type ShellRiskFinding,
  type ShellRiskLevel,
} from "@goatcitadel/contracts";

const RISK_ORDER: ShellRiskLevel[] = ["info", "caution", "danger"];

function highest(risks: readonly ShellRiskFinding[]): ShellRiskLevel {
  let best: ShellRiskLevel = "info";
  for (const risk of risks) {
    if (RISK_ORDER.indexOf(risk.level) > RISK_ORDER.indexOf(best)) {
      best = risk.level;
    }
  }
  return best;
}

function dedupeRisks(risks: readonly ShellRiskFinding[]): ShellRiskFinding[] {
  const seen = new Set<string>();
  const out: ShellRiskFinding[] = [];
  for (const risk of risks) {
    const key = `${risk.level}:${risk.label}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(risk);
    }
  }
  return out;
}

function hasUnmatchedQuote(command: string): boolean {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (character === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (character === '"' && !inSingle) {
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

export function explainCommandsForApproval(commands: readonly string[]): readonly ShellCommandExplanation[] {
  return commands.map((cmd) => explainShellCommand(cmd));
}

const APPROVAL_LINKAGE_KEY = "__gcApprovalLinkage";

export function extractApprovalCommands(input: {
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
}): readonly string[] {
  const collected: string[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, fromKey?: string): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === "string") {
      if (fromKey && /^(command|cmd|script|shell)$/i.test(fromKey)) {
        if (!seen.has(value)) {
          seen.add(value);
          collected.push(value);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, fromKey);
      }
      return;
    }
    if (typeof value !== "object") {
      return;
    }
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === APPROVAL_LINKAGE_KEY) {
        continue;
      }
      if (/^(commands|cmds|scripts)$/i.test(key) && Array.isArray(nested)) {
        for (const item of nested) {
          if (typeof item === "string" && !seen.has(item)) {
            seen.add(item);
            collected.push(item);
          }
        }
        continue;
      }
      visit(nested, key);
    }
  };
  visit(input.preview);
  visit(input.payload);
  return collected;
}

export type ApprovalRiskLevel = ApprovalRequest["riskLevel"];

const RISK_RANK: Record<ApprovalRiskLevel, number> = {
  safe: 0,
  caution: 1,
  danger: 2,
  nuclear: 3,
};

export interface ShellExplainerPolicyOutcome {
  readonly explanations: readonly ShellCommandExplanation[];
  readonly elevatedRiskLevel?: ApprovalRiskLevel;
  readonly autoReject: boolean;
  readonly autoRejectReason?: string;
}

export function applyShellExplainerPolicy(
  input: {
    riskLevel: ApprovalRiskLevel;
    payload: Record<string, unknown>;
    preview: Record<string, unknown>;
  },
  policy: ShellExplainerPolicyConfig,
): ShellExplainerPolicyOutcome {
  const commands = extractApprovalCommands(input);
  if (commands.length === 0) {
    return { explanations: [], autoReject: false };
  }

  const explanations = explainCommandsForApproval(commands);

  if (!policy.enabled) {
    return { explanations, autoReject: false };
  }

  const dangerExplanations = explanations.filter((e) => e.highestRisk === "danger");
  if (dangerExplanations.length === 0) {
    return { explanations, autoReject: false };
  }

  let elevatedRiskLevel: ApprovalRiskLevel | undefined;
  if (policy.elevateOnDanger) {
    const target = policy.elevateOnDanger;
    if (RISK_RANK[target] > RISK_RANK[input.riskLevel]) {
      elevatedRiskLevel = target;
    }
  }

  const rejectThreshold = policy.autoRejectDangerThreshold ?? "danger";
  const effectiveRiskLevel = elevatedRiskLevel ?? input.riskLevel;
  const autoReject = policy.autoRejectOnDanger === true && RISK_RANK[effectiveRiskLevel] >= RISK_RANK[rejectThreshold];
  const autoRejectReason = autoReject
    ? `Auto-rejected: shell command "${dangerExplanations[0]?.command ?? "(unknown)"}" triggered danger policy`
    : undefined;

  return {
    explanations,
    elevatedRiskLevel,
    autoReject,
    autoRejectReason,
  };
}

export interface BackfillResult {
  readonly scanned: number;
  readonly backfilled: number;
}

export interface BackfillStorage {
  readonly approvals: {
    list(status?: ApprovalRequest["status"], limit?: number): Promise<readonly ApprovalRequest[]>;
    setShellExplanations(approvalId: string, explanations: readonly ShellCommandExplanation[]): Promise<boolean>;
  };
}

export async function backfillMissingShellExplanations(storage: BackfillStorage, limit = 500): Promise<BackfillResult> {
  const pending = await storage.approvals.list("pending", limit);
  let backfilled = 0;
  for (const approval of pending) {
    if (approval.shellExplanations && approval.shellExplanations.length > 0) {
      continue;
    }
    const commands = extractApprovalCommands(approval);
    if (commands.length === 0) {
      continue;
    }
    const explanations = explainCommandsForApproval(commands);
    await storage.approvals.setShellExplanations(approval.approvalId, explanations);
    backfilled++;
  }
  return { scanned: pending.length, backfilled };
}
