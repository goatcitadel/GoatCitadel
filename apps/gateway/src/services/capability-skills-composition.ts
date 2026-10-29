import path from "node:path";
import {
  redactStructuredSecrets,
  SHIPPED_SKILL_PACKS,
  type ApprovalListResponse,
  type ApprovalRequest,
  type ApprovalResolveInput,
  type CapabilityCatalogEntry,
  type DeploymentProfile,
  type SkillListItem,
  type SkillRuntimeState,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { SkillUseCount } from "@goatcitadel/storage";
import { CapabilitySkillActionsService, type CapabilitySkillActionStep } from "./capability-skill-actions-service.js";
import { CapabilitySkillUsageService } from "./capability-skill-usage-service.js";
import type { ShippedSkillDirs } from "./capability-skills-projection.js";
import { CapabilitySkillsService, type CapabilitySkillsSource } from "./capability-skills-service.js";
import type { SkillStateMutationAuthorityInput, SkillStateMutationOutcome } from "./skill-state-service.js";

const log = logger.child("capability-skills");

/** The approval list's largest page. */
const PENDING_APPROVAL_PAGE_LIMIT = 200;
/** 5,000 waiting approvals. Past that the read fails, rather than answering from a part of the list. */
const PENDING_APPROVAL_MAX_PAGES = 25;

/**
 * The existing owner of each source the Capabilities Skills tab reads, and of the approval its switch asks for. The
 * tab writes nothing itself: a switch only asks the skill state owner and, when the operator's skip applies, resolves
 * that owner's approval through the Inbox's own resolve.
 */
export interface CapabilitySkillsOwners {
  chatTurnCapabilityProfiles: { countSkillUsesSince(sinceIso: string): Promise<readonly SkillUseCount[]> };
  skills: {
    /** The skill list; with a workspace it includes that workspace's approved self-authored skills. */
    listSkills(effectiveSkills: "ALL", workspaceId: string): Promise<readonly SkillListItem[]>;
    /** Asks for a skill's state change: a `skill.lifecycle` approval, or "nothing to change". */
    setSkillState(
      skillId: string,
      state: SkillRuntimeState,
      note: string | undefined,
      authority: SkillStateMutationAuthorityInput,
    ): Promise<SkillStateMutationOutcome>;
  };
  /**
   * The install's loaded skills: the list the skill state owner looks a skill up in before it asks for a change, so
   * the switch can reach exactly these. A workspace's self-authored skills are not in it.
   */
  loadedSkills(): readonly Pick<SkillListItem, "skillId">[];
  /** The catalog route's owner. */
  capabilities: {
    listCapabilityCatalog(
      scope: "inspectable",
      effectiveSkills: "ALL",
      workspaceId: string,
    ): Promise<readonly CapabilityCatalogEntry[]>;
  };
  /** The Inbox's owner: its list, one approval, and the resolve its Approve button uses. */
  approvals: {
    listApprovalsPage(input: { status: "pending"; limit: number; cursor?: string }): Promise<ApprovalListResponse>;
    getApproval(approvalId: string): Promise<ApprovalRequest>;
    resolveApproval(approvalId: string, input: ApprovalResolveInput): Promise<unknown>;
  };
  /** The audit log; the switch's skip goes to its approvals stream, as the Change Plan skip does. */
  audit: { append(stream: "approvals", payload: Record<string, unknown>): Promise<void> };
  features: { isFeatureEnabled(flag: "settingsApprovalSkipEnabled"): Promise<boolean> };
  /** The install's deployment profile, read on every list and every switch. */
  deploymentProfile(): DeploymentProfile;
  /** The install's root, under whose `skills` folder GoatCitadel's own skill folders and packs live. */
  rootDir: string;
}

/**
 * GoatCitadel's own skill folders that load as `extra` skills from outside `skills/extra`, as GatewayService lists them
 * among its skill sources.
 */
export const SHIPPED_EXTRA_SKILL_FOLDERS: readonly string[] = ["genie-npu-ir20"];

/** The services behind the Capabilities Skills routes. */
export interface CapabilitySkills {
  usage: CapabilitySkillUsageService;
  skills: CapabilitySkillsService;
  actions: CapabilitySkillActionsService;
}

/** Wires the Skills tab to its owners. */
export function composeCapabilitySkills({
  chatTurnCapabilityProfiles,
  skills,
  loadedSkills,
  capabilities,
  approvals,
  audit,
  features,
  deploymentProfile,
  rootDir,
}: CapabilitySkillsOwners): CapabilitySkills {
  const readApprovalSkipSetting = () => features.isFeatureEnabled("settingsApprovalSkipEnabled");
  const shipped = shippedSkillDirs(rootDir);
  return {
    usage: new CapabilitySkillUsageService((sinceIso) => chatTurnCapabilityProfiles.countSkillUsesSince(sinceIso)),
    skills: new CapabilitySkillsService(
      {
        // Every skill, whatever the workspace's choices: Chat doesn't filter by them, so the tab doesn't either.
        listSkills: (workspaceId) => skills.listSkills("ALL", workspaceId),
        listInspectableCatalog: (workspaceId) => capabilities.listCapabilityCatalog("inspectable", "ALL", workspaceId),
        listPendingApprovals: () => readAllPendingApprovals((input) => approvals.listApprovalsPage(input)),
        listSwitchableSkillIds: async () => loadedSkills().map((skill) => skill.skillId),
        shippedSkillDirs: () => shipped,
        deploymentProfile,
        readApprovalSkipSetting,
      },
      reportFailedRead,
    ),
    actions: new CapabilitySkillActionsService(
      {
        // The switch carries no note; the approval's own preview shows the state change.
        setSkillState: (skillId, state, authority) => skills.setSkillState(skillId, state, undefined, authority),
        resolveApproval: (approvalId, input) => approvals.resolveApproval(approvalId, input),
        readApproval: (approvalId) => approvals.getApproval(approvalId),
        appendApprovalAudit: (event, payload) => audit.append("approvals", { event, ...payload }),
        deploymentProfile,
        readApprovalSkipSetting,
      },
      reportFailedStep,
    ),
  };
}

/**
 * The same paths GatewayService gives its skill loader for GoatCitadel's own folders, and the folder Skill Hub's pack
 * review resolves each shipped pack to (`path.join(path.resolve(packRoot), packId)`), which an install records as its
 * source.
 */
function shippedSkillDirs(rootDir: string): ShippedSkillDirs {
  const packRoot = path.resolve(path.join(rootDir, "skills", "import-packs"));
  return {
    folders: new Set(SHIPPED_EXTRA_SKILL_FOLDERS.map((folder) => path.join(rootDir, "skills", folder))),
    packs: new Set(SHIPPED_SKILL_PACKS.map((pack) => path.join(packRoot, pack.packId))),
  };
}

/**
 * Every waiting approval, page by page, so a skill's wait is never cut off by a page size. Waiting approvals expire, so
 * the list stays short; a list longer than the cap fails the read and the tab says waits couldn't be read.
 */
async function readAllPendingApprovals(
  listPage: CapabilitySkillsOwners["approvals"]["listApprovalsPage"],
): Promise<ApprovalRequest[]> {
  const approvals: ApprovalRequest[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < PENDING_APPROVAL_MAX_PAGES; page += 1) {
    const result = await listPage({
      status: "pending",
      limit: PENDING_APPROVAL_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    approvals.push(...result.items);
    if (!result.nextCursor) return approvals;
    cursor = result.nextCursor;
  }
  throw new Error(`More than ${PENDING_APPROVAL_MAX_PAGES} pages of waiting approvals`);
}

/** The operator sees a plain line; the real error stays in the redacted server log. */
function reportFailedRead(source: CapabilitySkillsSource, error: unknown): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error("a Capabilities skills source could not be read", {
    source,
    err: redactStructuredSecrets(diagnostic).value,
  });
}

/** The answer stays plain (the approval waits, or the skip is recorded only on the approval); the real error is logged. */
function reportFailedStep(step: CapabilitySkillActionStep, error: unknown): void {
  const diagnostic =
    error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { value: error };
  log.error("a Capabilities skill switch step failed", {
    step,
    err: redactStructuredSecrets(diagnostic).value,
  });
}
