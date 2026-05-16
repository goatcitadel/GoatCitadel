import { explainShellCommand, type ShellCommandExplanation } from "@goatcitadel/mission-control-shared";

export {
  explainShellCommand,
  type ShellCommandExplanation,
  type ShellExplanationDetail,
  type ShellRiskFinding,
  type ShellRiskLevel,
} from "@goatcitadel/mission-control-shared";

export function explainCommandsForApproval(commands: readonly string[]): readonly ShellCommandExplanation[] {
  return commands.map((cmd) => explainShellCommand(cmd));
}
