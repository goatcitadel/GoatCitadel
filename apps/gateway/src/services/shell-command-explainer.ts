import type { ApprovalRequest, ShellCommandExplanation } from "@goatcitadel/contracts";
import { explainShellCommand } from "@goatcitadel/mission-control-shared/content/shell-command-explainer";
import type { ShellExplainerPolicyConfig } from "../config.js";

export {
  explainShellCommand,
  type ShellCommandExplanation,
  type ShellExplanationDetail,
  type ShellRiskFinding,
  type ShellRiskLevel,
} from "@goatcitadel/mission-control-shared/content/shell-command-explainer";

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

  const autoReject = policy.autoRejectOnDanger === true;
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
    list(status?: ApprovalRequest["status"], limit?: number): readonly ApprovalRequest[];
    setShellExplanations(approvalId: string, explanations: readonly ShellCommandExplanation[]): boolean;
  };
}

export function backfillMissingShellExplanations(storage: BackfillStorage, limit = 500): BackfillResult {
  const pending = storage.approvals.list("pending", limit);
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
    storage.approvals.setShellExplanations(approval.approvalId, explanations);
    backfilled++;
  }
  return { scanned: pending.length, backfilled };
}
