import { spawnSync } from "node:child_process";
import process from "node:process";
import type { AgenticHarnessAvailabilityRecord, AgenticHarnessAvailabilityStatus } from "@goatcitadel/contracts";

export type AgenticHarnessId = "codex_cli" | "claude_code" | "opencode" | "gemini_cli" | "acp" | "scripted_runner";

export type AgenticHarnessReasonKind = "executable" | "config" | "sandbox" | "permission";

export interface AgenticHarnessReason {
  kind: AgenticHarnessReasonKind;
  code: string;
  message: string;
}

export interface AgenticHarnessRegistryEntry {
  harnessId: AgenticHarnessId;
  label: string;
  executableNames: string[];
  configEnvKeys: string[];
  requiresSandbox: boolean;
  requiresPermission: boolean;
}

export interface AgenticHarnessProbeRecord extends AgenticHarnessAvailabilityRecord {
  harnessId: AgenticHarnessId;
  reasonDetails: AgenticHarnessReason[];
  executableNames: string[];
  configEnvKeys: string[];
  permissionSatisfied: boolean;
}

export interface AgenticHarnessSandboxProbe {
  required?: boolean;
  satisfied?: boolean;
  reason?: string;
}

export interface AgenticHarnessProbeOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => string;
  resolveExecutable?: (command: string) => string | undefined;
  configured?: Partial<Record<AgenticHarnessId, boolean>>;
  permissions?: Partial<Record<AgenticHarnessId, boolean>>;
  sandbox?: AgenticHarnessSandboxProbe;
  sandboxByHarness?: Partial<Record<AgenticHarnessId, AgenticHarnessSandboxProbe>>;
  policyApprovedToolNames?: string[];
}

export const AGENTIC_HARNESS_REGISTRY: AgenticHarnessRegistryEntry[] = [
  {
    harnessId: "codex_cli",
    label: "Codex CLI",
    executableNames: ["codex"],
    configEnvKeys: ["OPENAI_API_KEY", "CODEX_HOME"],
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    harnessId: "claude_code",
    label: "Claude Code",
    executableNames: ["claude"],
    configEnvKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"],
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    harnessId: "opencode",
    label: "OpenCode",
    executableNames: ["opencode"],
    configEnvKeys: ["OPENCODE_AUTH_TOKEN", "OPENCODE_CONFIG_DIR"],
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    harnessId: "gemini_cli",
    label: "Gemini CLI",
    executableNames: ["gemini"],
    configEnvKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"],
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    harnessId: "acp",
    label: "Agent Client Protocol",
    executableNames: ["acp"],
    configEnvKeys: ["GOATCITADEL_ACP_ENDPOINT", "ACP_ENDPOINT"],
    requiresSandbox: true,
    requiresPermission: true,
  },
  {
    harnessId: "scripted_runner",
    label: "Governed Scripted Runner",
    executableNames: [],
    configEnvKeys: ["GOATCITADEL_SCRIPTED_RUNNER_ENABLED"],
    requiresSandbox: true,
    requiresPermission: true,
  },
];

export function probeAgenticHarnessAvailability(options: AgenticHarnessProbeOptions = {}): AgenticHarnessProbeRecord[] {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());
  const resolveExecutable = options.resolveExecutable ?? resolveExecutableFromPath;

  return AGENTIC_HARNESS_REGISTRY.map((entry) =>
    probeAgenticHarnessEntry(entry, {
      env,
      now,
      resolveExecutable,
      configured: options.configured,
      permissions: options.permissions,
      sandbox: options.sandbox,
      sandboxByHarness: options.sandboxByHarness,
      policyApprovedToolNames: options.policyApprovedToolNames,
    }),
  );
}

export function probeAgenticHarnessEntry(
  entry: AgenticHarnessRegistryEntry,
  options: Required<Pick<AgenticHarnessProbeOptions, "env" | "now" | "resolveExecutable">> &
    Pick<
      AgenticHarnessProbeOptions,
      "configured" | "permissions" | "sandbox" | "sandboxByHarness" | "policyApprovedToolNames"
    >,
): AgenticHarnessProbeRecord {
  const executablePath = resolveHarnessExecutable(entry, options.resolveExecutable);
  const reasonDetails: AgenticHarnessReason[] = [];

  if (entry.executableNames.length > 0 && !executablePath) {
    reasonDetails.push({
      kind: "executable",
      code: "executable_missing",
      message: `Executable not found. Checked: ${entry.executableNames.join(", ")}.`,
    });
  }

  if (!isHarnessConfigured(entry, options)) {
    reasonDetails.push({
      kind: "config",
      code: "config_missing",
      message: buildConfigMissingMessage(entry),
    });
  }

  const sandbox = options.sandboxByHarness?.[entry.harnessId] ?? options.sandbox;
  const sandboxRequired = sandbox?.required ?? entry.requiresSandbox;
  const sandboxSatisfied = sandboxRequired ? sandbox?.satisfied === true : true;
  if (sandboxRequired && !sandboxSatisfied) {
    reasonDetails.push({
      kind: "sandbox",
      code: "sandbox_unsatisfied",
      message: sandbox?.reason?.trim() || "Required sandbox/isolation policy is not satisfied.",
    });
  }

  const permissionSatisfied = !entry.requiresPermission || options.permissions?.[entry.harnessId] === true;
  if (!permissionSatisfied) {
    reasonDetails.push({
      kind: "permission",
      code: "permission_missing",
      message: "Harness is not policy-approved for callable execution.",
    });
  }

  const status = resolveHarnessStatus(reasonDetails);

  return {
    harnessId: entry.harnessId,
    label: entry.label,
    status,
    executablePath,
    callable: status === "callable",
    reasons: reasonDetails.map((reason) => `${reason.kind}: ${reason.message}`),
    reasonDetails,
    checkedAt: options.now(),
    sandboxRequired,
    sandboxSatisfied,
    executableNames: [...entry.executableNames],
    configEnvKeys: [...entry.configEnvKeys],
    permissionSatisfied,
  };
}

function resolveHarnessExecutable(
  entry: AgenticHarnessRegistryEntry,
  resolveExecutable: (command: string) => string | undefined,
): string | undefined {
  for (const executableName of entry.executableNames) {
    const resolved = resolveExecutable(executableName)?.trim();
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function isHarnessConfigured(
  entry: AgenticHarnessRegistryEntry,
  options: Pick<AgenticHarnessProbeOptions, "configured" | "env" | "policyApprovedToolNames">,
): boolean {
  const configuredOverride = options.configured?.[entry.harnessId];
  if (configuredOverride !== undefined) {
    return configuredOverride;
  }

  if (entry.harnessId === "scripted_runner") {
    return (options.policyApprovedToolNames ?? []).some((toolName) => toolName.trim().length > 0);
  }

  return entry.configEnvKeys.some((key) => Boolean(options.env?.[key]?.trim()));
}

function buildConfigMissingMessage(entry: AgenticHarnessRegistryEntry): string {
  if (entry.harnessId === "scripted_runner") {
    return "No policy-approved tool names were provided for the scripted runner.";
  }
  return `Harness configuration is missing. Checked env keys: ${entry.configEnvKeys.join(", ")}.`;
}

function resolveHarnessStatus(reasons: AgenticHarnessReason[]): AgenticHarnessAvailabilityStatus {
  if (reasons.length === 0) {
    return "callable";
  }
  if (reasons.some((reason) => reason.kind === "executable")) {
    return "unavailable";
  }
  if (reasons.some((reason) => reason.kind === "config")) {
    return "not_configured";
  }
  return "blocked";
}

function resolveExecutableFromPath(command: string): string | undefined {
  const lookupCommand = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookupCommand, [command], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0 || !result.stdout) {
    return undefined;
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}
