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
  type SkillSourceListResponse,
} from "@goatcitadel/contracts";
import { logger } from "@goatcitadel/gateway-core";
import type { SkillUseCount } from "@goatcitadel/storage";
import { pluginsBySkillCheck } from "./capability-plugin-store.js";
import {
  CapabilitySkillActionsService,
  type CapabilitySkillActionStep,
  type PluginSkillListing,
} from "./capability-skill-actions-service.js";
import { CapabilitySkillDiscoverService } from "./capability-skill-discover-service.js";
import { CapabilitySkillUsageService } from "./capability-skill-usage-service.js";
import type { ShippedSkillDirs } from "./capability-skills-projection.js";
import { CapabilitySkillsService, type CapabilitySkillsSource } from "./capability-skills-service.js";
import type {
  CreateSkillHubOperatorApprovalInput,
  CreateSkillHubOperatorApprovalResponse,
  SkillHubOperatorListResponse,
} from "./skill-hub-operator-service.js";
import type { SkillHubReviewResult, SkillHubSourceReviewInput } from "./skill-hub-review-service.js";
import type { InstalledSkillSource, SkillSourceCatalog, SkillSourceReadOptions } from "./skill-import-service.js";
import type { SkillStateMutationAuthorityInput, SkillStateMutationOutcome } from "./skill-state-service.js";

const log = logger.child("capability-skills");

/** The approval list's largest page. */
const PENDING_APPROVAL_PAGE_LIMIT = 200;
/** 5,000 waiting approvals. Past that the read fails, rather than answering from a part of the list. */
const PENDING_APPROVAL_MAX_PAGES = 25;

/**
 * The existing owner of each source the Capabilities Skills tab reads, and of the approvals its switch and install
 * steps ask for. The tab writes nothing itself: a switch only asks the skill state owner, and an install step only asks
 * Skill Hub's approval owner, and when the operator's skip applies each resolves that owner's approval through the
 * Inbox's own resolve.
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
  /**
   * The skills a workspace's turns may load: the list Chat, scheduled turns and remote workers read
   * (`WorkspaceTurnSkills`), which keeps the skills its choices name and its own approved self-authored skills. A listed
   * skill missing from it is one the workspace's choices leave out.
   */
  listWorkspaceTurnSkills(workspaceId: string): Promise<readonly SkillListItem[]>;
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
  /**
   * Skill Hub's owners, as the old Skill Hub routes reach them: its source review, its operator list, and the approval
   * owner each install step asks. None of them installs anything; only an approved step's effect does.
   */
  skillHub: {
    reviewSkillHubSource(input: SkillHubSourceReviewInput): Promise<SkillHubReviewResult>;
    listSkillHub(input: { workspaceId: string; limit?: number }): Promise<SkillHubOperatorListResponse>;
    /** `options.pluginPass` is given only for a plugin's skill whose record the install steps have checked. */
    createSkillHubApproval(
      input: CreateSkillHubOperatorApprovalInput,
      options?: { pluginPass: { pluginId: string } },
    ): Promise<CreateSkillHubOperatorApprovalResponse>;
  };
  /**
   * Skill Hub's checks, read one at a time: to tell GoatCitadel's own pack from an import (Ruling R43), and a plugin's
   * skill from any other.
   */
  skillHubSnapshots: { find(snapshotId: string): Promise<SkillHubCheckSource | undefined> };
  /**
   * The plugin records, read through the Plugins tab's one store (never a second one): which plugin lists a check as
   * its skill, for a step on that skill and for the Skills tab's marks.
   */
  pluginRecords: { list(): Promise<readonly PluginSkillListing[]> };
  /**
   * The skill import owner's source reads, which Discover lists from: the curated entries and the marketplaces' listings
   * (the marketplaces only when asked), a catalog ranked by a search term, and the skills installed at runtime with the
   * sources they came from. Reading them installs nothing.
   */
  skillSources: {
    readSourceCatalog(options: SkillSourceReadOptions): Promise<SkillSourceCatalog>;
    presentSourceCatalog(
      catalog: SkillSourceCatalog,
      query: string | undefined,
      limit: number,
    ): SkillSourceListResponse;
    listInstalledSources(): readonly InstalledSkillSource[];
  };
}

/** Where one Skill Hub check read its skill from, and the workspace it belongs to. */
export interface SkillHubCheckSource {
  sourceType: string;
  sourceRef: string;
  /** `goatcitadel_plugin` for a skill a plugin brought. */
  sourceProvider: string;
  workspaceId: string;
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
  discover: CapabilitySkillDiscoverService;
}

/** Wires the Skills tab to its owners. */
export function composeCapabilitySkills({
  chatTurnCapabilityProfiles,
  skills,
  loadedSkills,
  listWorkspaceTurnSkills,
  capabilities,
  approvals,
  audit,
  features,
  deploymentProfile,
  rootDir,
  skillHub,
  skillHubSnapshots,
  pluginRecords,
  skillSources,
}: CapabilitySkillsOwners): CapabilitySkills {
  const readApprovalSkipSetting = () => features.isFeatureEnabled("settingsApprovalSkipEnabled");
  const shipped = shippedSkillDirs(rootDir);
  const skillsService = new CapabilitySkillsService(
    {
      // Every skill, whatever the workspace's choices, so the operator can see and switch the ones they leave out;
      // `listWorkspaceTurnSkills` says which of them the workspace's turns may load.
      listSkills: (workspaceId) => skills.listSkills("ALL", workspaceId),
      listInspectableCatalog: (workspaceId) => capabilities.listCapabilityCatalog("inspectable", "ALL", workspaceId),
      listPendingApprovals: () => readAllPendingApprovals((input) => approvals.listApprovalsPage(input)),
      listSwitchableSkillIds: async () => loadedSkills().map((skill) => skill.skillId),
      listWorkspaceTurnSkills,
      shippedSkillDirs: () => shipped,
      deploymentProfile,
      readApprovalSkipSetting,
      listSkillHub: (input) => skillHub.listSkillHub(input),
      findSkillHubSnapshot: (snapshotId) => skillHubSnapshots.find(snapshotId),
      listPluginSkills: async () => pluginsBySkillCheck(await pluginRecords.list()),
    },
    reportFailedRead,
  );
  return {
    usage: new CapabilitySkillUsageService((sinceIso) => chatTurnCapabilityProfiles.countSkillUsesSince(sinceIso)),
    skills: skillsService,
    actions: new CapabilitySkillActionsService(
      {
        // The switch carries no note; the approval's own preview shows the state change.
        setSkillState: (skillId, state, authority) => skills.setSkillState(skillId, state, undefined, authority),
        resolveApproval: (approvalId, input) => approvals.resolveApproval(approvalId, input),
        readApproval: (approvalId) => approvals.getApproval(approvalId),
        appendApprovalAudit: (event, payload) => audit.append("approvals", { event, ...payload }),
        deploymentProfile,
        readApprovalSkipSetting,
        reviewSkillHubSource: (input) => skillHub.reviewSkillHubSource(input),
        listSkillHub: (input) => skillHub.listSkillHub(input),
        // The plugin's pass, when the step gives one, reaches Skill Hub's owner exactly as given.
        createSkillHubApproval: (...args) => skillHub.createSkillHubApproval(...args),
        findSkillHubSnapshot: (snapshotId) => skillHubSnapshots.find(snapshotId),
        listPluginRecords: () => pluginRecords.list(),
      },
      reportFailedStep,
    ),
    discover: new CapabilitySkillDiscoverService(
      {
        readSourceCatalog: (options) => skillSources.readSourceCatalog(options),
        presentSourceCatalog: (catalog, query, limit) => skillSources.presentSourceCatalog(catalog, query, limit),
        listInstalledSources: () => skillSources.listInstalledSources(),
        // The installs the Skills tab lists, so a source on its way in reads the same in Discover. That read logs a
        // failed Skill Hub read itself, so Discover logs only what else it throws.
        listInstalls: async (workspaceId) => (await skillsService.installs(workspaceId)).installs,
      },
      { reportFailure: (error) => reportFailedRead("skill_hub", error) },
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
