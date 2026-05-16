/* eslint-disable max-lines -- Doctor currently centralizes audit and repair checks in one engine while sharing internal helpers across the command flow. */
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { syncUnifiedConfig } from "../config-sync-lib.js";
import { repoHasConfigMarker } from "../config-files.js";
import type {
  DoctorCheckResult,
  DoctorOperatorLinks,
  DoctorRepairResult,
  DoctorReport,
  DoctorRunOptions,
  DoctorSeverity,
  DoctorStatus,
} from "./types.js";

const REQUIRED_SPLIT_CONFIG_FILES = [
  "assistant.config.json",
  "tool-policy.json",
  "budgets.json",
  "llm-providers.json",
  "cron-jobs.json",
] as const;

/** @internal */
export interface JsonFileState<T = unknown> {
  path: string;
  exists: boolean;
  valid: boolean;
  value?: T;
  error?: string;
}

/** @internal */
export interface DoctorRuntimeContext {
  rootDir: string;
  configDir: string;
  gatewayBaseUrl: string;
  profileName?: string;
  profilePath?: string;
  deep: boolean;
  repairEnabled: boolean;
  autoRepair: boolean;
  yes: boolean;
  readOnly: boolean;
  authToken?: string;
  authMode?: "none" | "token" | "basic";
  tokenQueryParam?: string;
  missionControlOrigin?: string;
  promptConfirm?: (message: string) => Promise<boolean>;
}

/** @internal */
export interface GatewayHealthResult {
  reachable: boolean;
  statusText: string;
  detail: string;
}

export async function runDoctor(options: DoctorRunOptions = {}): Promise<DoctorReport> {
  const startedAt = new Date().toISOString();
  const rootDir = resolveDoctorRootDir(options.rootDir);
  const deep = options.deep ?? false;
  const readOnly = options.readOnly ?? false;
  const auditOnly = options.auditOnly ?? false;
  const noRepair = options.noRepair ?? false;
  const repairEnabled = !(readOnly || auditOnly || noRepair);
  const context: DoctorRuntimeContext = {
    rootDir,
    configDir: path.join(rootDir, "config"),
    gatewayBaseUrl: normalizeBaseUrl(
      options.gatewayBaseUrl ?? process.env.GOATCITADEL_GATEWAY_URL ?? "http://127.0.0.1:8787",
    ),
    profileName: options.profileName,
    profilePath: options.profilePath,
    deep,
    repairEnabled,
    autoRepair: repairEnabled,
    yes: options.yes ?? false,
    readOnly,
    authToken: options.authToken ?? process.env.GOATCITADEL_AUTH_TOKEN?.trim(),
    authMode: options.authMode,
    tokenQueryParam: options.tokenQueryParam,
    missionControlOrigin: process.env.MISSION_CONTROL_ORIGIN?.trim(),
    promptConfirm: options.promptConfirm,
  };

  const checks: DoctorCheckResult[] = [];
  const repairs: DoctorRepairResult[] = [];

  checks.push(await checkPrerequisites(context, repairs));
  checks.push(await checkManagedWorkspaceTooling(context, repairs));
  checks.push(await checkConfigIntegrity(context, repairs));
  checks.push(await checkAuthHostPosture(context, repairs));
  checks.push(await checkToolPolicyPaths(context, repairs));
  checks.push(await checkStoragePaths(context, repairs));
  checks.push(await checkStateValidationQuarantine(context));

  const gatewayHealth = await checkGatewayHealth(context, repairs);
  checks.push(gatewayHealth.check);
  checks.push(await checkDeepRuntime(context, repairs, gatewayHealth.health));

  const finishedAt = new Date().toISOString();
  const summary = summarizeDoctor(checks, repairs);
  const operatorLinks = await resolveDoctorOperatorLinks(context);
  return {
    startedAt,
    finishedAt,
    rootDir: context.rootDir,
    gatewayBaseUrl: context.gatewayBaseUrl,
    profileName: context.profileName,
    profilePath: context.profilePath,
    options: {
      deep: context.deep,
      repairEnabled: context.repairEnabled,
      autoRepair: context.autoRepair,
      readOnly: context.readOnly,
    },
    checks,
    repairs,
    operatorLinks,
    summary,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const operatorLinks = report.operatorLinks;
  lines.push("GoatCitadel Doctor");
  lines.push(`Root: ${report.rootDir}`);
  lines.push(`Gateway: ${report.gatewayBaseUrl}`);
  if (report.profileName) {
    lines.push(`Profile: ${report.profileName}`);
  }
  if (report.profilePath) {
    lines.push(`Profile path: ${report.profilePath}`);
  }
  lines.push(`Started: ${new Date(report.startedAt).toLocaleString()}`);
  lines.push(`Finished: ${new Date(report.finishedAt).toLocaleString()}`);
  lines.push("");
  lines.push("Checks");
  for (const check of report.checks) {
    lines.push(`- [${check.status.toUpperCase()}] ${check.title}: ${check.detail}`);
    if (check.repairAction) {
      lines.push(`  Repair: ${check.repairAction}`);
    }
  }
  lines.push("");
  lines.push("Repairs");
  if (report.repairs.length === 0) {
    lines.push("- none");
  } else {
    for (const repair of report.repairs) {
      const state = repair.applied ? "applied" : repair.skipped ? "skipped" : "none";
      lines.push(`- ${repair.checkId}: ${state}${repair.reason ? ` (${repair.reason})` : ""}`);
      if (repair.changes && repair.changes.length > 0) {
        for (const change of repair.changes) {
          lines.push(`  - ${change}`);
        }
      }
    }
  }
  if (operatorLinks && (operatorLinks.remoteMissionControlUrl || (operatorLinks.notes?.length ?? 0) > 0)) {
    lines.push("");
    lines.push("Operator links");
    if (operatorLinks.remoteMissionControlUrl) {
      lines.push(`- Mission Control: ${operatorLinks.remoteMissionControlUrl}`);
    }
    for (const note of operatorLinks.notes ?? []) {
      lines.push(`- Note: ${note}`);
    }
  }
  lines.push("");
  lines.push("Summary");
  lines.push(`- Checks: ${report.summary.totalChecks}`);
  lines.push(`- OK: ${report.summary.ok}`);
  lines.push(`- Fixed: ${report.summary.fixed}`);
  lines.push(`- Warnings: ${report.summary.warn}`);
  lines.push(`- Failures: ${report.summary.fail}`);
  lines.push(`- Repaired actions: ${report.summary.repairedCount}`);
  lines.push(`- Exit code: ${report.summary.exitCode}`);
  return lines.join("\n");
}

function summarizeDoctor(checks: DoctorCheckResult[], repairs: DoctorRepairResult[]) {
  const summary = {
    totalChecks: checks.length,
    ok: 0,
    warn: 0,
    fail: 0,
    fixed: 0,
    skipped: 0,
    unresolvedWarnings: 0,
    hardFailures: 0,
    repairedCount: repairs.filter((repair) => repair.applied).length,
    exitCode: 0,
  };

  for (const check of checks) {
    if (check.status === "ok") summary.ok += 1;
    if (check.status === "warn") {
      summary.warn += 1;
      summary.unresolvedWarnings += 1;
    }
    if (check.status === "fail") {
      summary.fail += 1;
      if (check.severity === "error") {
        summary.hardFailures += 1;
      }
    }
    if (check.status === "fixed") summary.fixed += 1;
    if (check.status === "skipped") summary.skipped += 1;
  }

  if (summary.hardFailures > 0) {
    summary.exitCode = 2;
  } else {
    summary.exitCode = 0;
  }

  return summary;
}

async function checkPrerequisites(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const id = "runtime.prerequisites";
  const messages: string[] = [];
  let hasHardFailure = false;
  let hasWarning = false;

  const nodeVersion = process.versions.node;
  const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
  if (major < 22) {
    hasHardFailure = true;
    messages.push(`Node ${nodeVersion} detected; GoatCitadel requires Node 22+.`);
  } else {
    messages.push(`Node ${nodeVersion} is compatible.`);
  }

  const pnpmAvailable = Boolean(process.env.npm_execpath) || commandAvailable("pnpm");
  if (!pnpmAvailable) {
    hasWarning = true;
    messages.push("pnpm is missing from PATH (scripts and updates may fail).");
  } else {
    messages.push("pnpm is available.");
  }

  const gitAvailable = commandAvailable("git");
  if (!gitAvailable) {
    hasWarning = true;
    messages.push("git is missing (update/install automation is limited).");
  } else {
    messages.push("git is available.");
  }

  repairs.push({
    checkId: id,
    applied: false,
    skipped: true,
    reason: "Manual install required for missing runtime prerequisites.",
  });

  return {
    id,
    group: "runtime",
    title: "Install/runtime prerequisites",
    status: hasHardFailure ? "fail" : hasWarning ? "warn" : "ok",
    severity: hasHardFailure ? "error" : hasWarning ? "warning" : "info",
    detail: messages.join(" "),
    repairable: false,
  };
}

async function checkManagedWorkspaceTooling(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const id = "runtime.managed-workspace-tooling";
  const tooling = inspectManagedWorkspaceTooling(context.rootDir);
  if (!tooling.isWorkspace) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Current root is not a GoatCitadel workspace checkout.",
    });
    return {
      id,
      group: "runtime",
      title: "Managed workspace tooling",
      status: "skipped",
      severity: "info",
      detail: "Skipped because the current root is not a pnpm workspace checkout.",
      repairable: false,
    };
  }

  if (tooling.missing.length === 0) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Managed workspace tooling is already present.",
    });
    return {
      id,
      group: "runtime",
      title: "Managed workspace tooling",
      status: "ok",
      severity: "info",
      detail: "Local workspace tooling is present for build, doctor, and package verification commands.",
      repairable: false,
    };
  }

  const missingSummary = tooling.missing.map((item) => `${item.label} (${item.purpose})`).join(", ");
  const pnpmRunner = resolveDoctorPnpmRunner();
  let repaired = false;
  const changes: string[] = [];
  if (context.repairEnabled && pnpmRunner) {
    const approved = await requestGuardedRepairApproval(
      context,
      `Install GoatCitadel workspace tooling now? This restores ${missingSummary} so doctor, build, and verification commands can run.`,
    );
    if (approved) {
      changes.push(`Explained install: restoring ${missingSummary}.`);
      const repairResult = installDoctorWorkspaceTooling(context.rootDir, pnpmRunner);
      repaired = repairResult.ok;
      changes.push(...repairResult.changes);
    }
  }

  repairs.push({
    checkId: id,
    applied: repaired,
    skipped: !repaired,
    guarded: true,
    reason: repaired
      ? undefined
      : pnpmRunner
        ? "Guarded install skipped or not approved."
        : "pnpm/corepack is unavailable, so GoatCitadel cannot repair local workspace tooling automatically.",
    changes,
  });

  return {
    id,
    group: "runtime",
    title: "Managed workspace tooling",
    status: repaired ? "fixed" : "warn",
    severity: repaired ? "info" : "warning",
    detail: repaired
      ? "Missing workspace tooling was restored."
      : `Missing local workspace tooling: ${missingSummary}.`,
    repairable: Boolean(pnpmRunner),
    repairAction: pnpmRunner
      ? "Allow doctor to run a workspace install so GoatCitadel can restore its local command shims."
      : "Install pnpm via Corepack, then rerun doctor so GoatCitadel can repair local tooling.",
  };
}

async function checkConfigIntegrity(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const id = "config.integrity";
  const unifiedPath = path.join(context.configDir, "goatcitadel.json");
  const splitPaths = REQUIRED_SPLIT_CONFIG_FILES.map((name) => path.join(context.configDir, name));

  const beforeUnified = await readJsonFile(unifiedPath);
  const beforeSplits = await Promise.all(splitPaths.map((filePath) => readJsonFile(filePath)));
  const beforeIssues = collectConfigIssues(beforeUnified, beforeSplits);
  if (beforeIssues.length === 0) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "No configuration issues detected.",
    });
    return {
      id,
      group: "config",
      title: "Config integrity and sync",
      status: "ok",
      severity: "info",
      detail: "Unified and split config files are present and valid JSON.",
      repairable: false,
    };
  }

  const repairLog: string[] = [];
  let repaired = false;
  if (context.repairEnabled) {
    await fs.mkdir(context.configDir, { recursive: true });

    if (!beforeUnified.exists || beforeSplits.some((item) => !item.exists)) {
      try {
        const syncResult = await syncUnifiedConfig(context.rootDir, { createUnifiedIfMissing: true });
        repaired = syncResult.createdUnified || syncResult.syncedSections.length > 0;
        if (syncResult.createdUnified) {
          repairLog.push(`Created ${path.relative(context.rootDir, syncResult.unifiedPath)}.`);
        }
        if (syncResult.syncedSections.length > 0) {
          repairLog.push(`Synced split config sections: ${syncResult.syncedSections.join(", ")}.`);
        }
      } catch (error) {
        repairLog.push(`Config sync failed: ${(error as Error).message}`);
      }
    }

    if (!beforeUnified.valid) {
      const rebuilt = await rebuildUnifiedFromSplit(context);
      if (rebuilt.rebuilt) {
        repaired = true;
        repairLog.push(rebuilt.message);
      } else if (rebuilt.message) {
        repairLog.push(rebuilt.message);
      }
    }

    const afterUnifiedCandidate = await readJsonFile(unifiedPath);
    if (beforeSplits.some((item) => !item.valid) && afterUnifiedCandidate.valid) {
      try {
        const syncResult = await syncUnifiedConfig(context.rootDir, { createUnifiedIfMissing: true });
        if (syncResult.syncedSections.length > 0) {
          repaired = true;
          repairLog.push(`Repaired split files from unified config: ${syncResult.syncedSections.join(", ")}.`);
        }
      } catch (error) {
        repairLog.push(`Failed to rewrite split config files: ${(error as Error).message}`);
      }
    }
  }

  const afterUnified = await readJsonFile(unifiedPath);
  const afterSplits = await Promise.all(splitPaths.map((filePath) => readJsonFile(filePath)));
  const afterIssues = collectConfigIssues(afterUnified, afterSplits);
  const unresolved = afterIssues.length > 0;

  repairs.push({
    checkId: id,
    applied: repaired && !unresolved,
    skipped: !context.repairEnabled,
    reason: !context.repairEnabled
      ? "Repair disabled (--audit-only/--no-repair/read-only)."
      : unresolved
        ? "Some config issues are still unresolved."
        : undefined,
    changes: repairLog,
  });

  if (!unresolved && repaired) {
    return {
      id,
      group: "config",
      title: "Config integrity and sync",
      status: "fixed",
      severity: "info",
      detail: "Config issues were detected and repaired.",
      repairable: true,
      repairAction: "Run `goatcitadel doctor --audit-only` to verify state without writes.",
    };
  }

  return {
    id,
    group: "config",
    title: "Config integrity and sync",
    status: unresolved ? "fail" : "warn",
    severity: unresolved ? "error" : "warning",
    detail: unresolved
      ? `Unresolved config issues: ${afterIssues.join(" ")}`
      : `Detected config issues: ${beforeIssues.join(" ")}`,
    repairable: true,
    repairAction: "Run `pnpm config:sync` and verify JSON syntax.",
  };
}

async function checkAuthHostPosture(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const id = "security.auth-host-posture";
  const assistantPath = path.join(context.configDir, "assistant.config.json");
  const unifiedPath = path.join(context.configDir, "goatcitadel.json");
  const assistantState = await readJsonFile<Record<string, unknown>>(assistantPath);
  if (!assistantState.valid || !assistantState.value) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "assistant.config.json is not readable; run config repair first.",
    });
    return {
      id,
      group: "security",
      title: "Auth + host safety posture",
      status: "warn",
      severity: "warning",
      detail: "Skipped auth posture check because assistant config is invalid.",
      repairable: false,
    };
  }

  const host = (process.env.GATEWAY_HOST ?? "127.0.0.1").trim();
  const auth = asRecord(assistantState.value.auth) ?? {};
  const authMode = (context.authMode ?? asString(auth.mode) ?? "none") as "none" | "token" | "basic";
  const token = asRecord(auth.token);
  const basic = asRecord(auth.basic);
  const tokenSet = Boolean((asString(token?.value) ?? "").trim());
  const basicSet = Boolean((asString(basic?.username) ?? "").trim() && (asString(basic?.password) ?? "").trim());
  const loopback = isLoopbackHost(host);
  const weak = authMode === "none" || (authMode === "token" && !tokenSet) || (authMode === "basic" && !basicSet);

  if (!weak || loopback) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Auth posture is acceptable for current bind host.",
    });
    return {
      id,
      group: "security",
      title: "Auth + host safety posture",
      status: "ok",
      severity: "info",
      detail: loopback
        ? `Gateway host ${host} is loopback; current auth mode ${authMode} is acceptable.`
        : `Gateway host ${host} with auth mode ${authMode} has credentials configured.`,
      repairable: false,
    };
  }

  let repaired = false;
  const changes: string[] = [];
  if (context.repairEnabled) {
    const approved = await requestGuardedRepairApproval(
      context,
      "Gateway is on a non-loopback host with weak auth. Harden to token auth now?",
    );
    if (approved) {
      const assistantConfig = assistantState.value;
      const nextAuth = asRecord(assistantConfig.auth) ?? {};
      const nextToken = asRecord(nextAuth.token) ?? {};
      const generated = `gc_${cryptoRandomHex(32)}`;
      nextAuth.mode = "token";
      nextAuth.allowLoopbackBypass = false;
      nextToken.queryParam = asString(nextToken.queryParam) || "access_token";
      nextToken.value = generated;
      nextAuth.token = nextToken;
      assistantConfig.auth = nextAuth;
      await writeJsonFile(assistantPath, assistantConfig);
      changes.push(`Set assistant auth mode to token in ${path.relative(context.rootDir, assistantPath)}.`);
      changes.push(`Generated a gateway token (prefix ${generated.slice(0, 8)}...).`);

      const unifiedState = await readJsonFile<Record<string, unknown>>(unifiedPath);
      if (unifiedState.valid && unifiedState.value) {
        unifiedState.value.assistant = assistantConfig;
        await writeJsonFile(unifiedPath, unifiedState.value);
        changes.push(`Synced auth hardening into ${path.relative(context.rootDir, unifiedPath)}.`);
      }
      repaired = true;
    }
  }

  repairs.push({
    checkId: id,
    applied: repaired,
    skipped: !repaired,
    guarded: true,
    reason: repaired ? undefined : "Guarded repair skipped or not approved.",
    changes,
  });

  return {
    id,
    group: "security",
    title: "Auth + host safety posture",
    status: repaired ? "fixed" : "warn",
    severity: repaired ? "info" : "warning",
    detail: repaired
      ? `Applied token-auth hardening for non-loopback host ${host}.`
      : `Non-loopback host ${host} with weak auth (${authMode}) detected.`,
    repairable: true,
    repairAction: "Enable token/basic auth before exposing GoatCitadel remotely.",
  };
}

async function checkToolPolicyPaths(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const id = "policy.paths";
  const policyPath = path.join(context.configDir, "tool-policy.json");
  const policyState = await readJsonFile<Record<string, unknown>>(policyPath);
  if (!policyState.valid || !policyState.value) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "tool-policy.json is not readable; run config repair first.",
    });
    return {
      id,
      group: "policy",
      title: "Tool-policy paths and jail roots",
      status: "fail",
      severity: "error",
      detail: "tool-policy.json is missing or invalid JSON.",
      repairable: false,
    };
  }

  const sandbox = asRecord(policyState.value.sandbox) ?? {};
  const roots = [...toStringArray(sandbox.writeJailRoots), ...toStringArray(sandbox.readOnlyRoots)];
  const missingPaths: string[] = [];
  const outsideRoot: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(context.rootDir, root);
    if (!isPathInsideRoot(context.rootDir, resolved)) {
      outsideRoot.push(root);
      continue;
    }
    if (!(await pathExists(resolved))) {
      missingPaths.push(resolved);
    }
  }

  const changes: string[] = [];
  let repaired = false;
  if (context.repairEnabled && missingPaths.length > 0) {
    for (const missing of missingPaths) {
      await fs.mkdir(missing, { recursive: true });
      repaired = true;
      changes.push(`Created missing policy path: ${path.relative(context.rootDir, missing)}.`);
    }
  }

  repairs.push({
    checkId: id,
    applied: repaired,
    skipped: !repaired,
    reason:
      !repaired && missingPaths.length > 0 ? "Repair disabled; missing policy paths were not created." : undefined,
    changes,
  });

  const status: DoctorStatus =
    outsideRoot.length > 0 ? "warn" : missingPaths.length > 0 ? (repaired ? "fixed" : "warn") : "ok";
  const severity: DoctorSeverity = outsideRoot.length > 0 ? "warning" : status === "ok" ? "info" : "warning";

  const notes: string[] = [];
  if (outsideRoot.length > 0) {
    notes.push(`Paths outside repo root detected: ${outsideRoot.join(", ")}.`);
  }
  if (missingPaths.length > 0) {
    notes.push(
      repaired
        ? "Missing policy paths were created."
        : `Missing policy paths: ${missingPaths.map((item) => path.relative(context.rootDir, item)).join(", ")}.`,
    );
  }
  if (notes.length === 0) {
    notes.push("Policy write/read roots are present and rooted safely.");
  }

  return {
    id,
    group: "policy",
    title: "Tool-policy paths and jail roots",
    status,
    severity,
    detail: notes.join(" "),
    repairable: missingPaths.length > 0,
    repairAction: missingPaths.length > 0 ? "Create missing directories under configured jail roots." : undefined,
  };
}

async function checkStoragePaths(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<DoctorCheckResult> {
  const id = "storage.paths";
  const assistantPath = path.join(context.configDir, "assistant.config.json");
  const assistantState = await readJsonFile<Record<string, unknown>>(assistantPath);
  if (!assistantState.valid || !assistantState.value) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "assistant.config.json is not readable; run config repair first.",
    });
    return {
      id,
      group: "storage",
      title: "Data/artifact directories and writability",
      status: "fail",
      severity: "error",
      detail: "assistant.config.json is missing or invalid JSON.",
      repairable: false,
    };
  }

  const assistant = assistantState.value;
  const configuredDirs = [
    asString(assistant.dataDir) || "./data",
    asString(assistant.transcriptsDir) || "./data/transcripts",
    asString(assistant.auditDir) || "./data/audit",
    asString(assistant.workspaceDir) || "./workspace",
    asString(assistant.worktreesDir) || "./.worktrees",
  ];

  const missing: string[] = [];
  for (const item of configuredDirs) {
    const absolute = path.resolve(context.rootDir, item);
    if (!(await pathExists(absolute))) {
      missing.push(absolute);
    }
  }

  let repaired = false;
  const changes: string[] = [];
  if (context.repairEnabled && missing.length > 0) {
    for (const folder of missing) {
      await fs.mkdir(folder, { recursive: true });
      repaired = true;
      changes.push(`Created missing directory: ${path.relative(context.rootDir, folder)}.`);
    }
  }

  const notWritable: string[] = [];
  for (const item of configuredDirs) {
    const absolute = path.resolve(context.rootDir, item);
    const writable = await isDirectoryWritable(absolute);
    if (!writable) {
      notWritable.push(absolute);
    }
  }

  repairs.push({
    checkId: id,
    applied: repaired,
    skipped: !repaired,
    reason: !repaired && missing.length > 0 ? "Repair disabled; missing directories were not created." : undefined,
    changes,
  });

  if (notWritable.length > 0) {
    return {
      id,
      group: "storage",
      title: "Data/artifact directories and writability",
      status: "fail",
      severity: "error",
      detail: `Directories not writable: ${notWritable.map((item) => path.relative(context.rootDir, item)).join(", ")}.`,
      repairable: false,
    };
  }
  if (missing.length > 0) {
    return {
      id,
      group: "storage",
      title: "Data/artifact directories and writability",
      status: repaired ? "fixed" : "warn",
      severity: repaired ? "info" : "warning",
      detail: repaired
        ? "Missing runtime directories were created and verified writable."
        : `Missing runtime directories: ${missing.map((item) => path.relative(context.rootDir, item)).join(", ")}.`,
      repairable: true,
      repairAction: "Create runtime directories listed in assistant config.",
    };
  }

  return {
    id,
    group: "storage",
    title: "Data/artifact directories and writability",
    status: "ok",
    severity: "info",
    detail: "Runtime directories exist and are writable.",
    repairable: false,
  };
}

async function checkStateValidationQuarantine(context: DoctorRuntimeContext): Promise<DoctorCheckResult> {
  const id = "state.validation.quarantine";
  const assistantPath = path.join(context.configDir, "assistant.config.json");
  const assistantState = await readJsonFile<{ dataDir?: string }>(assistantPath);
  const rawDataDir = (assistantState.valid && asString(assistantState.value?.dataDir)) || "./data";
  const dataDir = path.resolve(context.rootDir, rawDataDir);
  const dbPath = path.join(dataDir, "goatcitadel.db");

  if (!existsSync(dbPath)) {
    return {
      id,
      group: "storage",
      title: "Persisted-state validation quarantine",
      status: "ok",
      severity: "info",
      detail: "Storage database not initialized; no quarantine to inspect.",
      repairable: false,
    };
  }

  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='state_validation_quarantine'")
      .get();
    if (!tableRow) {
      return {
        id,
        group: "storage",
        title: "Persisted-state validation quarantine",
        status: "ok",
        severity: "info",
        detail: "Quarantine table not yet present.",
        repairable: false,
      };
    }

    const totalRow = db.prepare("SELECT COUNT(1) AS count FROM state_validation_quarantine").get() as
      | { count: number | bigint }
      | undefined;
    const total = Number(totalRow?.count ?? 0);
    const byStoreRows = db
      .prepare(
        "SELECT store, COUNT(1) AS count FROM state_validation_quarantine GROUP BY store ORDER BY count DESC LIMIT 5",
      )
      .all() as Array<{ store: string; count: number | bigint }>;

    if (total === 0) {
      return {
        id,
        group: "storage",
        title: "Persisted-state validation quarantine",
        status: "ok",
        severity: "info",
        detail: "No persisted-state shape failures recorded.",
        repairable: false,
      };
    }

    const topStores = byStoreRows.map((r) => `${r.store}=${Number(r.count)}`).join(", ");
    const severity: DoctorSeverity = total >= 100 ? "error" : "warning";
    const status: DoctorStatus = total >= 100 ? "fail" : "warn";
    return {
      id,
      group: "storage",
      title: "Persisted-state validation quarantine",
      status,
      severity,
      detail: `${total} persisted rows quarantined for shape failures (top: ${topStores}). Run 'doctor --fix' after review.`,
      repairable: false,
    };
  } finally {
    db.close();
  }
}

async function checkGatewayHealth(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
): Promise<{ check: DoctorCheckResult; health: GatewayHealthResult }> {
  const id = "gateway.health";
  const result = await probeGatewayHealth(context.gatewayBaseUrl);
  const localLoopbackUnreachable = !result.reachable && isLoopbackGatewayBaseUrl(context.gatewayBaseUrl);
  repairs.push({
    checkId: id,
    applied: false,
    skipped: true,
    reason: "No automatic repair for gateway runtime state.",
  });
  return {
    check: {
      id,
      group: "runtime",
      title: "Gateway reachability and health",
      status: result.reachable ? "ok" : localLoopbackUnreachable ? "skipped" : "warn",
      severity: result.reachable ? "info" : localLoopbackUnreachable ? "info" : "warning",
      detail: localLoopbackUnreachable
        ? "Gateway is not running yet on the local loopback address. Start GoatCitadel with `goat up`, then rerun `goat doctor --deep` for runtime checks."
        : result.detail,
      repairable: false,
    },
    health: result,
  };
}

async function checkDeepRuntime(
  context: DoctorRuntimeContext,
  repairs: DoctorRepairResult[],
  health: GatewayHealthResult,
): Promise<DoctorCheckResult> {
  const id = "gateway.deep-runtime";
  if (!context.deep) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Deep checks not requested.",
    });
    return {
      id,
      group: "runtime",
      title: "Deep runtime checks",
      status: "skipped",
      severity: "info",
      detail: "Skipped (use --deep to include runtime settings/onboarding checks).",
      repairable: false,
    };
  }
  if (!health.reachable) {
    const localLoopbackUnreachable = isLoopbackGatewayBaseUrl(context.gatewayBaseUrl);
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Gateway unreachable; deep checks skipped.",
    });
    return {
      id,
      group: "runtime",
      title: "Deep runtime checks",
      status: "skipped",
      severity: localLoopbackUnreachable ? "info" : "warning",
      detail: localLoopbackUnreachable
        ? "Skipped deep runtime checks because the local gateway is not running yet."
        : "Skipped deep checks because gateway health probe failed.",
      repairable: false,
    };
  }

  const tokenQueryParam = context.tokenQueryParam ?? "access_token";
  const settings = await fetchGatewayJson(
    context.gatewayBaseUrl,
    "/api/v1/settings",
    context.authToken,
    tokenQueryParam,
  );
  if (!settings.ok) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Unable to query runtime settings for deep check.",
    });
    return {
      id,
      group: "runtime",
      title: "Deep runtime checks",
      status: "warn",
      severity: "warning",
      detail: `Deep check could not load /api/v1/settings: ${settings.detail}`,
      repairable: false,
    };
  }

  const onboarding = await fetchGatewayJson(
    context.gatewayBaseUrl,
    "/api/v1/onboarding/state",
    context.authToken,
    tokenQueryParam,
  );
  const details: string[] = [];
  details.push("Runtime settings API reachable.");
  if (onboarding.ok) {
    const payload = onboarding.payload as Record<string, unknown>;
    const checklist = Array.isArray(payload?.checklist) ? payload.checklist : [];
    const outstanding = checklist.filter((item) => {
      const status = asRecord(item)?.status;
      return status === "needs_input";
    }).length;
    if (outstanding > 0) {
      details.push(`${outstanding} onboarding checklist item(s) still need input.`);
      repairs.push({
        checkId: id,
        applied: false,
        skipped: true,
        reason: "Onboarding follow-up is informational only.",
      });
      return {
        id,
        group: "runtime",
        title: "Deep runtime checks",
        status: "warn",
        severity: "warning",
        detail: details.join(" "),
        repairable: false,
      };
    }
    details.push("Onboarding checklist is complete.");
  } else {
    details.push(`Onboarding state unavailable: ${onboarding.detail}`);
  }

  const voiceStatus = await fetchGatewayJson(
    context.gatewayBaseUrl,
    "/api/v1/voice/status",
    context.authToken,
    tokenQueryParam,
  );
  if (!voiceStatus.ok) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Voice status endpoint unavailable during deep runtime checks.",
    });
    return {
      id,
      group: "runtime",
      title: "Deep runtime checks",
      status: "warn",
      severity: "warning",
      detail: `${details.join(" ")} Voice status unavailable: ${voiceStatus.detail}`,
      repairable: false,
      repairAction: "Run `goatcitadel voice status` after the gateway starts.",
    };
  }

  const voiceRuntime = await fetchGatewayJson(
    context.gatewayBaseUrl,
    "/api/v1/voice/runtime",
    context.authToken,
    tokenQueryParam,
  );
  if (!voiceRuntime.ok) {
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Voice runtime endpoint unavailable during deep runtime checks.",
    });
    return {
      id,
      group: "runtime",
      title: "Deep runtime checks",
      status: "warn",
      severity: "warning",
      detail: `${details.join(" ")} Voice runtime unavailable: ${voiceRuntime.detail}`,
      repairable: false,
      repairAction: "Repair the managed voice runtime with `goatcitadel voice install`.",
    };
  }

  const runtimePayload = asRecord(voiceRuntime.payload);
  const voiceReadiness = typeof runtimePayload?.readiness === "string" ? runtimePayload.readiness : "missing";
  const selectedModelId =
    typeof runtimePayload?.selectedModelId === "string" ? runtimePayload.selectedModelId : undefined;
  if (voiceReadiness !== "ready") {
    const repairAction = selectedModelId
      ? `Run \`goatcitadel voice install --voice-model ${selectedModelId}\` or \`goatcitadel voice select ${selectedModelId}\`.`
      : "Run `goatcitadel voice install` to provision the managed whisper.cpp runtime.";
    repairs.push({
      checkId: id,
      applied: false,
      skipped: true,
      reason: "Voice runtime needs install or repair.",
    });
    return {
      id,
      group: "runtime",
      title: "Deep runtime checks",
      status: "warn",
      severity: "warning",
      detail: `${details.join(" ")} Voice runtime readiness is ${voiceReadiness}.`,
      repairable: false,
      repairAction,
    };
  }
  details.push("Managed voice runtime is ready.");

  repairs.push({
    checkId: id,
    applied: false,
    skipped: true,
    reason: "No repair needed for deep checks.",
  });

  return {
    id,
    group: "runtime",
    title: "Deep runtime checks",
    status: "ok",
    severity: "info",
    detail: details.join(" "),
    repairable: false,
  };
}

async function resolveDoctorOperatorLinks(context: DoctorRuntimeContext): Promise<DoctorOperatorLinks | undefined> {
  const notes: string[] = [];
  const origin = context.missionControlOrigin?.trim();
  if (!origin) {
    return {
      notes: ["MISSION_CONTROL_ORIGIN is not set, so the remote Mission Control link was omitted."],
    };
  }

  let normalizedOrigin: string;
  try {
    const url = new URL(origin);
    normalizedOrigin = url.toString();
  } catch {
    return {
      notes: [`MISSION_CONTROL_ORIGIN is invalid (${origin}), so the remote Mission Control link was omitted.`],
    };
  }

  const assistantState = await readJsonFile<Record<string, unknown>>(
    path.join(context.configDir, "assistant.config.json"),
  );
  if (!assistantState.valid || !assistantState.value) {
    return {
      notes: ["assistant.config.json is unavailable, so the remote Mission Control link was omitted."],
    };
  }

  const auth = asRecord(assistantState.value.auth) ?? {};
  const configMode = (context.authMode ?? asString(auth.mode) ?? "none") as "none" | "token" | "basic";
  if (configMode !== "token") {
    return {
      notes: [`Gateway auth mode is ${configMode}, so a token bootstrap link was not emitted.`],
    };
  }

  const configuredToken =
    context.authToken ?? process.env.GOATCITADEL_AUTH_TOKEN?.trim() ?? asString(asRecord(auth.token)?.value)?.trim();
  if (!configuredToken) {
    return {
      notes: ["Gateway token is not configured, so the remote Mission Control link was omitted."],
    };
  }

  return {
    remoteMissionControlUrl: buildRemoteMissionControlUrl(normalizedOrigin, configuredToken),
    notes,
  };
}

function buildRemoteMissionControlUrl(origin: string, token: string): string {
  const url = new URL(origin);
  url.searchParams.set("tab", "dashboard");
  return `${url.toString()}#access_token=${encodeURIComponent(token)}`;
}

function collectConfigIssues(unified: JsonFileState, splitFiles: JsonFileState[]): string[] {
  const issues: string[] = [];
  if (!unified.exists) {
    issues.push("Unified config is missing.");
  } else if (!unified.valid) {
    issues.push(`Unified config is invalid JSON (${unified.error ?? "unknown parse error"}).`);
  }
  for (const split of splitFiles) {
    const label = path.basename(split.path);
    if (!split.exists) {
      issues.push(`${label} is missing.`);
      continue;
    }
    if (!split.valid) {
      issues.push(`${label} is invalid JSON (${split.error ?? "unknown parse error"}).`);
    }
  }
  return issues;
}

async function rebuildUnifiedFromSplit(context: DoctorRuntimeContext): Promise<{ rebuilt: boolean; message: string }> {
  const entries: Record<string, unknown> = {};
  for (const filename of REQUIRED_SPLIT_CONFIG_FILES) {
    const fullPath = path.join(context.configDir, filename);
    const state = await readJsonFile(fullPath);
    if (!state.valid || !state.value) {
      return {
        rebuilt: false,
        message: `Cannot rebuild unified config because ${filename} is invalid or missing.`,
      };
    }
    if (filename === "assistant.config.json") entries.assistant = state.value;
    if (filename === "tool-policy.json") entries.toolPolicy = state.value;
    if (filename === "budgets.json") entries.budgets = state.value;
    if (filename === "llm-providers.json") entries.llm = state.value;
    if (filename === "cron-jobs.json") entries.cronJobs = state.value;
  }
  entries.version = 1;

  const unifiedPath = path.join(context.configDir, "goatcitadel.json");
  if (await pathExists(unifiedPath)) {
    const backupPath = `${unifiedPath}.bak.${Date.now()}`;
    await fs.copyFile(unifiedPath, backupPath);
  }
  await writeJsonFile(unifiedPath, entries);
  return {
    rebuilt: true,
    message: "Rebuilt unified config from split config files.",
  };
}

async function readJsonFile<T = unknown>(filePath: string): Promise<JsonFileState<T>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    try {
      const value = JSON.parse(raw) as T;
      return {
        path: filePath,
        exists: true,
        valid: true,
        value,
      };
    } catch (error) {
      return {
        path: filePath,
        exists: true,
        valid: false,
        error: (error as Error).message,
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        path: filePath,
        exists: false,
        valid: false,
        error: "file not found",
      };
    }
    return {
      path: filePath,
      exists: false,
      valid: false,
      error: (error as Error).message,
    };
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(filePath, payload, "utf8");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function commandAvailable(command: string): boolean {
  const candidates = process.platform === "win32" ? [command, `${command}.cmd`, `${command}.exe`] : [command];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!result.error && result.status === 0) {
      return true;
    }
  }
  return false;
}

function inspectManagedWorkspaceTooling(rootDir: string): {
  isWorkspace: boolean;
  missing: Array<{ label: string; purpose: string }>;
} {
  const packageJsonPath = path.join(rootDir, "package.json");
  const workspaceFilePath = path.join(rootDir, "pnpm-workspace.yaml");
  if (!existsSync(packageJsonPath) || !existsSync(workspaceFilePath)) {
    return { isWorkspace: false, missing: [] };
  }
  const nodeModulesRoot = path.join(rootDir, "node_modules");
  if (!existsSync(nodeModulesRoot)) {
    return {
      isWorkspace: true,
      missing: [
        {
          label: "workspace dependencies",
          purpose: "GoatCitadel package commands and local tool binaries",
        },
      ],
    };
  }
  const requiredBins = [
    {
      label: "TypeScript compiler",
      bin: "tsc",
      purpose: "package builds and typechecks",
    },
    {
      label: "TSX runner",
      bin: "tsx",
      purpose: "doctor, gateway, and script execution",
    },
    {
      label: "Vitest runner",
      bin: "vitest",
      purpose: "targeted package verification",
    },
  ];
  const extension = process.platform === "win32" ? ".cmd" : "";
  return {
    isWorkspace: true,
    missing: requiredBins
      .filter((tool) => !existsSync(path.join(rootDir, "node_modules", ".bin", `${tool.bin}${extension}`)))
      .map(({ label, purpose }) => ({ label, purpose })),
  };
}

function resolveDoctorPnpmRunner(): { command: string; prefix: string[] } | null {
  if (commandAvailable("pnpm")) {
    return { command: "pnpm", prefix: [] };
  }
  if (commandAvailable("corepack")) {
    return { command: "corepack", prefix: ["pnpm"] };
  }
  return null;
}

function installDoctorWorkspaceTooling(
  rootDir: string,
  runner: { command: string; prefix: string[] },
): { ok: boolean; changes: string[] } {
  const changes: string[] = [
    "What: GoatCitadel workspace dependencies and local command shims under node_modules/.bin.",
    "Why: build, doctor, and package verification commands depend on local tools like tsc, tsx, and vitest.",
  ];
  const frozen = spawnSync(runner.command, [...runner.prefix, "--dir", rootDir, "install", "--frozen-lockfile"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!frozen.error && frozen.status === 0) {
    changes.push("Applied `pnpm install --frozen-lockfile` successfully.");
    return { ok: true, changes };
  }
  const combined = `${frozen.stdout ?? ""}\n${frozen.stderr ?? ""}`;
  if (/ERR_PNPM_OUTDATED_LOCKFILE|Cannot install with "frozen-lockfile"/i.test(combined)) {
    changes.push("Frozen lockfile install failed because package manifests moved ahead of pnpm-lock.yaml.");
    changes.push(
      "Retrying with `pnpm install --no-frozen-lockfile` so GoatCitadel can refresh lock metadata and restore tooling.",
    );
    const relaxed = spawnSync(runner.command, [...runner.prefix, "--dir", rootDir, "install", "--no-frozen-lockfile"], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (!relaxed.error && relaxed.status === 0) {
      changes.push("Applied `pnpm install --no-frozen-lockfile` successfully.");
      return { ok: true, changes };
    }
    changes.push(
      `Install retry failed: ${String(relaxed.stderr ?? relaxed.stdout ?? relaxed.error ?? `exit ${relaxed.status}`)}`.trim(),
    );
    return { ok: false, changes };
  }
  changes.push(
    `Frozen install failed: ${String(frozen.stderr ?? frozen.stdout ?? frozen.error ?? `exit ${frozen.status}`)}`.trim(),
  );
  return { ok: false, changes };
}

function normalizeBaseUrl(input: string): string {
  return input.replace(/\/+$/, "");
}

function resolveDoctorRootDir(rootDir?: string): string {
  if (rootDir?.trim()) {
    return path.resolve(rootDir.trim());
  }
  const envRoot = process.env.GOATCITADEL_ROOT_DIR?.trim();
  if (envRoot) {
    return path.resolve(envRoot);
  }
  const candidates = [process.cwd(), path.resolve(process.cwd(), ".."), path.resolve(process.cwd(), "../..")];
  for (const candidate of candidates) {
    if (commandLooksLikeRepoRoot(candidate)) {
      return candidate;
    }
  }
  return path.resolve(process.cwd());
}

function commandLooksLikeRepoRoot(candidate: string): boolean {
  return repoHasConfigMarker(candidate) && existsSync(path.join(candidate, "package.json"));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function isPathInsideRoot(rootDir: string, targetPath: string): boolean {
  const relative = path.relative(rootDir, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cryptoRandomHex(bytes: number): string {
  try {
    return randomBytes(bytes).toString("hex");
  } catch {
    return randomUUID().replace(/-/g, "");
  }
}

async function requestGuardedRepairApproval(context: DoctorRuntimeContext, message: string): Promise<boolean> {
  if (context.yes) {
    return true;
  }
  if (!context.promptConfirm) {
    return false;
  }
  return context.promptConfirm(message);
}

async function probeGatewayHealth(baseUrl: string): Promise<GatewayHealthResult> {
  const response = await fetchWithTimeout(
    `${baseUrl}/health`,
    {
      method: "GET",
    },
    4_000,
  );
  if (!response.ok) {
    return {
      reachable: false,
      statusText: "unreachable",
      detail: `Gateway health probe failed: ${response.detail}`,
    };
  }
  return {
    reachable: true,
    statusText: "ok",
    detail: `Gateway health check OK (${response.statusCode ?? 200}).`,
  };
}

function isLoopbackGatewayBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

async function fetchGatewayJson(
  baseUrl: string,
  endpoint: string,
  authToken?: string,
  tokenQueryParam = "access_token",
): Promise<{ ok: boolean; detail: string; payload?: unknown }> {
  const url = new URL(endpoint, `${baseUrl}/`);
  if (authToken?.trim()) {
    url.searchParams.set(tokenQueryParam, authToken.trim());
  }
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (authToken?.trim()) {
    headers.Authorization = `Bearer ${authToken.trim()}`;
  }
  let result = await fetchWithTimeout(
    url.toString(),
    {
      method: "GET",
      headers,
    },
    5_000,
  );
  if (!result.ok && result.aborted) {
    result = await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers,
      },
      10_000,
    );
  }
  if (!result.ok) {
    return {
      ok: false,
      detail: result.detail,
    };
  }
  return {
    ok: true,
    detail: "ok",
    payload: result.payload,
  };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; detail: string; statusCode?: number; payload?: unknown; aborted?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const statusCode = response.status;
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        statusCode,
        detail: `HTTP ${statusCode}: ${text.slice(0, 220) || "no response body"}`,
      };
    }
    let payload: unknown = undefined;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = text;
    }
    return {
      ok: true,
      statusCode,
      detail: "ok",
      payload,
    };
  } catch (error) {
    const message = (error as Error).message;
    const name = error instanceof Error ? error.name : "";
    const aborted = controller.signal.aborted || name === "AbortError" || /abort/i.test(message);
    return {
      ok: false,
      detail: message,
      aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function isDirectoryWritable(dirPath: string): Promise<boolean> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.doctor-write-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
    await fs.writeFile(probe, "ok\n", "utf8");
    await fs.rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export const __doctorEngineInternals = {
  buildRemoteMissionControlUrl,
  collectConfigIssues,
  commandLooksLikeRepoRoot,
  cryptoRandomHex,
  inspectManagedWorkspaceTooling,
  isLoopbackHost,
  isPathInsideRoot,
  normalizeBaseUrl,
  rebuildUnifiedFromSplit,
  requestGuardedRepairApproval,
  resolveDoctorRootDir,
  summarizeDoctor,
};
