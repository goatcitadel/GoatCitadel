import type { ShellRiskFinding } from "@goatcitadel/contracts";
import { t } from "./i18n.js";

export type { ShellRiskFinding, ShellRiskLevel } from "@goatcitadel/contracts";

const SYSTEM_PATH_WRITE = /(^|\s)>{1,2}\s*\/(etc|usr|var|bin|sbin|boot|lib|lib64)(\/|\s|$)/;
const PIPE_TO_SHELL = /\|\s*(sh|bash)(\s|$)/;
const SUDO_PREFIX = /(^|\s)sudo(\s|$)/;
const CHMOD_WORLD = /\bchmod\b[^|;&]*\b777\b/;

export function prescreenShellRisks(command: string): readonly ShellRiskFinding[] {
  const findings: ShellRiskFinding[] = [];

  if (PIPE_TO_SHELL.test(command)) {
    findings.push({
      level: "danger",
      label: t("shell.risk.pipe_to_shell.label"),
      explanation: t("shell.risk.pipe_to_shell.explanation"),
    });
  }

  if (SUDO_PREFIX.test(command)) {
    findings.push({
      level: "caution",
      label: t("shell.risk.sudo.label"),
      explanation: t("shell.risk.sudo.explanation"),
    });
  }

  if (SYSTEM_PATH_WRITE.test(command)) {
    findings.push({
      level: "danger",
      label: t("shell.risk.system_path_write.label"),
      explanation: t("shell.risk.system_path_write.explanation"),
    });
  }

  if (CHMOD_WORLD.test(command)) {
    findings.push({
      level: "caution",
      label: t("shell.risk.world_writable.label"),
      explanation: t("shell.risk.world_writable.explanation"),
    });
  }

  return findings;
}
