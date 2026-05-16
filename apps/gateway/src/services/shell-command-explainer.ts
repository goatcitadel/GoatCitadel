import {
  explainShellCommand,
  type ShellCommandExplanation,
} from "@goatcitadel/mission-control-shared/content/shell-command-explainer";

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
