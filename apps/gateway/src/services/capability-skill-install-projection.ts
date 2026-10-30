import {
  findShippedSkillPack,
  isFullGitCommitSha,
  type CapabilitySkillInstall,
  type CapabilitySkillInstallAsks,
  type CapabilitySkillInstallStep,
} from "@goatcitadel/contracts";
import { projectImportProvenanceReferencesForPublic } from "./import-provenance-public-projection.js";
import type { SkillHubOperatorApprovalSummary, SkillHubOperatorItem } from "./skill-hub-operator-service.js";

/**
 * How many of the workspace's newest checks are read, to find a check again or list the installs in progress: Skill
 * Hub's operator list's largest page. Every check is a new one, so many checks can push an older install out of it.
 */
export const SKILL_HUB_LIST_LIMIT = 100;

/** The steps an install is past or not yet on: the installs list leaves these out. */
const SETTLED_OR_NOT_STARTED: ReadonlySet<CapabilitySkillInstallStep> = new Set(["check_passed", "blocked", "done"]);

/** Why an approved step stopped, by the step and its settlement, in plain words. */
const STEP_FAILURES = {
  install_inactive: {
    blocked: "GoatCitadel's checks stopped the install.",
    manual_reconciliation: "The install didn't finish and needs a manual fix.",
  },
  activate: {
    blocked: "GoatCitadel's checks stopped switching it on.",
    manual_reconciliation: "Switching it on didn't finish and needs a manual fix.",
  },
} as const;

/** A shipped pack's check records the pack's folder on the server: `.../import-packs/<packId>`, either separator. */
const PACK_FOLDER = /[\\/]import-packs[\\/]([^\\/]+)$/u;
const REQUIRE_PREFIX = "require:";

type StepReading = Pick<CapabilitySkillInstall, "step" | "approvalId" | "blockers" | "installedSkillId" | "failure">;

/**
 * One Skill Hub check as Capabilities shows it, with where its install is. Undefined for a check whose source can't be
 * named without a server path: a local folder that isn't one of GoatCitadel's own packs, or a hosted bundle, which only
 * the old Skill Hub routes can check.
 */
export function buildCapabilitySkillInstall(item: SkillHubOperatorItem): CapabilitySkillInstall | undefined {
  const source = publicSource(item.snapshot);
  if (!source) return undefined;
  const pack = source.kind === "pack" ? findShippedSkillPack(source.packId) : undefined;
  const install: CapabilitySkillInstall = {
    snapshotId: item.snapshotId,
    name: pack?.label ?? item.title,
    description: pack?.summary ?? "",
    source,
    ...readInstallStep(item),
    asksFor: asksFor(item.snapshot.permissionEnvelope),
  };
  // A Git address goes through the same public projection the skill sources route uses.
  return projectImportProvenanceReferencesForPublic(install);
}

/** Whether the install is on its way in, or stopped on the way: the installs list holds exactly these. */
export function isUnfinishedInstall(install: Pick<CapabilitySkillInstall, "step">): boolean {
  return !SETTLED_OR_NOT_STARTED.has(install.step);
}

/**
 * Where the install is (Ruling R41), read in this order: the check's own blocker codes; the switch-on approval and its
 * settlement, or an active version; the install approval and its settlement; an installed candidate; whether installing
 * is allowed. A declined or edited approval counts as never asked, so the install reads as the step before it. Skill
 * Hub keeps only the newest approval of each kind for a check.
 */
function readInstallStep(item: SkillHubOperatorItem): StepReading {
  if (item.snapshot.blockerCodes.length > 0) return { step: "blocked", blockers: [...item.snapshot.blockerCodes] };

  const activate = askedFor(item.approvals.activate);
  if (activate?.status === "pending") {
    return { step: "waiting_switch_on", approvalId: activate.approvalId, blockers: [] };
  }
  if (activate && !activate.settlement) return { step: "switching_on", blockers: [] };
  if (activate?.settlement && activate.settlement.disposition !== "applied") {
    return { step: "failed", failure: STEP_FAILURES.activate[activate.settlement.disposition], blockers: [] };
  }
  // Switched on: whether the AI can use it now is the Installed list's to say, since it may be off or paused since.
  if (activate || item.runtime.activeVersion) {
    return { step: "done", blockers: [], ...(item.skillId ? { installedSkillId: item.skillId } : {}) };
  }

  const install = askedFor(item.approvals.install_inactive);
  if (install?.status === "pending") return { step: "waiting_install", approvalId: install.approvalId, blockers: [] };
  if (install && !install.settlement) return { step: "installing", blockers: [] };
  if (install?.settlement && install.settlement.disposition !== "applied") {
    return { step: "failed", failure: STEP_FAILURES.install_inactive[install.settlement.disposition], blockers: [] };
  }

  if (item.runtime.inactiveCandidate) return { step: "installed_off", blockers: [] };
  if (item.actions.install_inactive.allowed) return { step: "check_passed", blockers: [] };
  // Installing isn't allowed: most often the source is already installed.
  return { step: "blocked", blockers: [...item.actions.install_inactive.blockers] };
}

/** A pending or approved approval; a declined or edited one was never asked as far as the install is concerned. */
function askedFor(approval: SkillHubOperatorApprovalSummary | undefined): SkillHubOperatorApprovalSummary | undefined {
  return approval?.status === "pending" || approval?.status === "approved" ? approval : undefined;
}

/** A pack by its id, never its folder; a Git source by its address, host and pinned commit. */
function publicSource(snapshot: SkillHubOperatorItem["snapshot"]): CapabilitySkillInstall["source"] | undefined {
  if (snapshot.sourceType === "local_path") {
    const packId = PACK_FOLDER.exec(snapshot.sourceRef)?.[1];
    return packId && findShippedSkillPack(packId) ? { kind: "pack", packId } : undefined;
  }
  if (snapshot.sourceType !== "git_url") return undefined;
  const host = hostOf(snapshot.sourceRef);
  return {
    kind: "git",
    sourceRef: snapshot.sourceRef,
    ...(host ? { host } : {}),
    ...(isFullGitCommitSha(snapshot.resolvedVersion) ? { commit: snapshot.resolvedVersion } : {}),
  };
}

/**
 * What the skill asks for, from the check's permission envelope (`SkillPermissionEnvelopeV1`, which the review
 * normalizes before it keeps it). Each dimension is read on its own, so one that doesn't read as a list of strings
 * can't hide the others.
 */
function asksFor(envelope: Record<string, unknown>): CapabilitySkillInstallAsks {
  const filesystem = asRecord(envelope.filesystem);
  const dependencies = asRecord(envelope.dependencies);
  return {
    tools: stringList(envelope.toolIds),
    networkHosts: [...new Set(stringList(envelope.networkOrigins).flatMap((origin) => hostOf(origin) ?? []))],
    envVars: stringList(envelope.environmentVariableNames),
    readsFiles: stringList(filesystem.readScopes),
    writesFiles: stringList(filesystem.writeScopes),
    includesScripts: stringList(envelope.scripts).length > 0,
    requires: stringList(dependencies.nativeRequirements)
      .filter((requirement) => requirement.startsWith(REQUIRE_PREFIX))
      .map((requirement) => requirement.slice(REQUIRE_PREFIX.length)),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}
