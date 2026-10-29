import type { CapabilityCatalogEntry, SkillLifecycleState } from "./capabilities.js";
import type { SkillCategoryId, SkillOrigin } from "./skill-categories.js";

// ---------------------------------------------------------------------------
// Skill use counts: GET /api/v1/capabilities/skills/usage
// ---------------------------------------------------------------------------

/** How far back the use counts reach. */
export const SKILL_USAGE_WINDOW_DAYS = 365;

/** One skill's chat turns in the window. A turn counts once for a skill, however often its profile lists it. */
export interface CapabilitySkillUsageEntry {
  skillId: string;
  uses: number;
  lastUsedAt: string;
}

export interface CapabilitySkillUsageResponse {
  /** The start of the window: now minus `SKILL_USAGE_WINDOW_DAYS`, ISO. */
  since: string;
  /** When the counts were read. A cached answer keeps the time of the read that filled the cache. */
  generatedAt: string;
  /** Only skills with at least one use, ordered by skill id. A skill that is not listed has no use in the window. */
  skills: CapabilitySkillUsageEntry[];
}

// ---------------------------------------------------------------------------
// Installed skills: GET /api/v1/capabilities/skills and /skills/detail
// ---------------------------------------------------------------------------

/** The skill's switch: `enabled` is on, `sleep` is paused (used only when named), `disabled` is off. */
export type CapabilitySkillState = "on" | "paused" | "off";

/** One installed skill as the Skills tab shows it. The Gateway computes every field; the cockpit never derives one. */
export interface CapabilitySkillItem {
  skillId: string;
  name: string;
  description: string;
  category: SkillCategoryId;
  origin: SkillOrigin;
  state: CapabilitySkillState;
  /** Whether the AI can use it, exactly as the skill list reports it. */
  callable: boolean;
  /** Sent back as `expectedRevision` when the switch changes. */
  revision: number;
  pinned: boolean;
  lifecycleState?: SkillLifecycleState;
  tags: string[];
  /**
   * This workspace's skill choices leave it out of its skill list. It is a fact about those choices; today it does not
   * by itself stop Chat from using the skill.
   */
  hiddenInWorkspace: boolean;
  /** A `skill.lifecycle` approval for this skill that is still waiting. */
  pendingApprovalId?: string;
}

export interface CapabilitySkillsResponse {
  workspaceId: string;
  /** Every skill loaded for the workspace, including its approved self-authored skills, ordered by name. */
  items: CapabilitySkillItem[];
  /** Candidate skills waiting for review, once per candidate. Absent when it couldn't be read. */
  candidatesWaiting?: number;
  /** Whether the operator's own clicks here apply without asking. Never on a `remote_hardened` install. */
  operatorApprovalSkip: boolean;
  /** Plain lines about the parts of the list that couldn't be read. */
  issues: string[];
  generatedAt: string;
}

/** One skill's details for its panel, including its SKILL.md text. */
export interface CapabilitySkillDetail {
  skillId: string;
  instructionBody: string;
  keywords: string[];
  declaredTools: string[];
  requires: string[];
  provenance?: {
    source: string;
    sourceRef?: string;
    sourceProvider?: string;
    commitSha?: string;
    treeSha256?: string;
  };
  trustLabel?: string;
  reviewWarning?: string;
  note?: string;
  stateUpdatedAt?: string;
  /** The inspectable catalog's `skill:<id>` entry, for the policy and source inspectors. Absent when unreadable. */
  catalogEntry?: CapabilityCatalogEntry;
}
