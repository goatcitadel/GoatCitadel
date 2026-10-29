import {
  redactStructuredSecrets,
  type ApprovalListResponse,
  type ApprovalRequest,
  type CapabilityCatalogEntry,
  type DeploymentProfile,
  type SkillListItem,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { SkillUseCount } from "@goatcitadel/storage";
import type { EffectiveCapabilitySet } from "./capability-scope-resolver.js";
import { CapabilitySkillUsageService } from "./capability-skill-usage-service.js";
import { CapabilitySkillsService, type CapabilitySkillsSource } from "./capability-skills-service.js";

const log = logger.child("capability-skills");

/** The approval list's largest page. */
const PENDING_APPROVAL_PAGE_LIMIT = 200;
/** 5,000 waiting approvals. Past that the read fails, rather than answering from a part of the list. */
const PENDING_APPROVAL_MAX_PAGES = 25;

/** The existing owner of each source the Capabilities Skills tab reads. Each is read-only here. */
export interface CapabilitySkillsOwners {
  chatTurnCapabilityProfiles: { countSkillUsesSince(sinceIso: string): Promise<readonly SkillUseCount[]> };
  /** The skill list; with a workspace it includes that workspace's approved self-authored skills. */
  skills: { listSkills(effectiveSkills: "ALL", workspaceId: string): Promise<readonly SkillListItem[]> };
  /** The workspace skill choices, as the skill list and catalog routes resolve them. */
  capabilityScope: { resolveEffectiveSkills(workspaceId: string): Promise<EffectiveCapabilitySet> };
  /** The catalog route's owner. */
  capabilities: {
    listCapabilityCatalog(
      scope: "inspectable",
      effectiveSkills: "ALL",
      workspaceId: string,
    ): Promise<readonly CapabilityCatalogEntry[]>;
  };
  /** The Inbox list's owner. */
  approvals: {
    listApprovalsPage(input: { status: "pending"; limit: number; cursor?: string }): Promise<ApprovalListResponse>;
  };
  features: { isFeatureEnabled(flag: "settingsApprovalSkipEnabled"): Promise<boolean> };
  /** The install's deployment profile, read on every list. */
  deploymentProfile(): DeploymentProfile;
}

/** The services behind the Capabilities Skills routes. */
export interface CapabilitySkills {
  usage: CapabilitySkillUsageService;
  skills: CapabilitySkillsService;
}

/** Wires the Skills tab to its owners. */
export function composeCapabilitySkills({
  chatTurnCapabilityProfiles,
  skills,
  capabilityScope,
  capabilities,
  approvals,
  features,
  deploymentProfile,
}: CapabilitySkillsOwners): CapabilitySkills {
  return {
    usage: new CapabilitySkillUsageService((sinceIso) => chatTurnCapabilityProfiles.countSkillUsesSince(sinceIso)),
    skills: new CapabilitySkillsService(
      {
        // Every skill, whatever the workspace's choices; the list marks the hidden ones instead of dropping them.
        listSkills: (workspaceId) => skills.listSkills("ALL", workspaceId),
        resolveEffectiveSkills: (workspaceId) => capabilityScope.resolveEffectiveSkills(workspaceId),
        listInspectableCatalog: (workspaceId) => capabilities.listCapabilityCatalog("inspectable", "ALL", workspaceId),
        listPendingApprovals: () => readAllPendingApprovals((input) => approvals.listApprovalsPage(input)),
        deploymentProfile,
        readApprovalSkipSetting: () => features.isFeatureEnabled("settingsApprovalSkipEnabled"),
      },
      reportFailedRead,
    ),
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
