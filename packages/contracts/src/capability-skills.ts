import type { CapabilityCatalogEntry, SkillLifecycleState } from "./capabilities.js";
import type { SkillCategoryId, SkillOrigin } from "./skill-categories.js";
import type { SkillRuntimeState } from "./skills.js";

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
  /**
   * `built_in` only for GoatCitadel's own skills: bundled ones, and shipped ones whose provenance shows they came from
   * GoatCitadel (its own skill folder, or its own pack installed through Skill Hub). A Git or remote import that shares
   * a shipped skill's name, or whose source can't be told, is `imported`.
   */
  origin: SkillOrigin;
  state: CapabilitySkillState;
  /**
   * Whether the AI can use it, exactly as the skill list reports it: from its review state and switch only. It ignores
   * the workspace's skill choices, which `leftOutOfWorkspace` reports.
   */
  callable: boolean;
  /** Sent back as `expectedRevision` when the switch changes. */
  revision: number;
  /**
   * Whether the switch can reach this skill. The skill state owner looks a skill up among the install's loaded skills,
   * without any workspace's self-authored ones, so those are `false`: the switch would refuse them. A pinned skill is
   * `true` but still refused (see `pinned`).
   */
  switchable: boolean;
  /**
   * `true` when the workspace's skill choices leave this skill out: the workspace's own selection, narrowed by its
   * Citadel's, doesn't include it, so its Chat turns, scheduled turns and remote workers neither load nor call it,
   * whatever its switch says. The row is listed anyway. `false` when they may load it: every skill when nothing is
   * chosen, and always the workspace's own approved self-authored skills, which no choice can name. When the workspace's
   * Citadel or choices can't be read, its turns use none of the installed skills, so every installed skill is `true`.
   * Absent when the list of skills the workspace's turns may load couldn't be read at all, with an issue line saying so.
   */
  leftOutOfWorkspace?: boolean;
  pinned: boolean;
  lifecycleState?: SkillLifecycleState;
  tags: string[];
  /** A `skill.lifecycle` approval for this skill that is still waiting. */
  pendingApprovalId?: string;
}

export interface CapabilitySkillsResponse {
  workspaceId: string;
  /** Every skill loaded for the workspace, including its approved self-authored skills, ordered by name. */
  items: CapabilitySkillItem[];
  /**
   * Candidate skills waiting for review across the whole install, not only this workspace, once per candidate. Absent
   * when it couldn't be read, or when the catalog's candidate list reached its limit, so an undercount is never shown as
   * exact.
   */
  candidatesWaiting?: number;
  /**
   * Whether the operator's setting to skip approvals for their own changes applies here, which is what decides
   * switching a skill on (or pausing one that is off). Turning a skill off, or pausing one that is on, applies without
   * asking whatever this says, because it only takes power away. Never on a `remote_hardened` install, where every
   * switch asks.
   */
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

// ---------------------------------------------------------------------------
// The skill switch: POST /api/v1/capabilities/skills/state
// ---------------------------------------------------------------------------

/**
 * What switching a skill did. Every change creates the skill's approval; the operator's skip only resolves it. The
 * approval's id follows from the request, so asking again for the same change, before the skill changes, hands back the
 * approval it already made while that one waits or once it is approved.
 * - `approved`: approved, by the skip now or earlier, and its own effect applies the change (or already has).
 * - `waiting`: it waits in the Inbox for the operator.
 * - `declined`: the switch answers this only for the expiry race: the approval ran out of time just as the skip approved
 *   it, so `expired` is `true` and nothing changes. Asking again makes a fresh approval, linked to this one, as it does
 *   after any decline or expiry. The type keeps `expired` as a flag for the Phase 3 install route, which reuses it.
 * - `unchanged`: the skill is already in that state, so nothing was asked.
 */
export type CapabilitySkillActionOutcome =
  | { status: "approved"; approvalId: string }
  | { status: "waiting"; approvalId: string }
  | { status: "declined"; approvalId: string; expired: boolean }
  | { status: "unchanged" };

/**
 * Why the switch refused a skill with a `409`, in the error body's `details.reason`; each also has its own `code`.
 * Every refusal comes before any approval exists, and its `error` is plain copy with no skill id.
 * - `pinned` (`STATE_CONFLICT`): the skill is pinned; change it through a proposal in Library.
 * - `stale` (`WRITE_CONFLICT`): the skill changed since the list was read; read it again and retry.
 * - `duplicate` (`ALREADY_EXISTS`): someone else already asked for this exact change from this exact state.
 *
 * A skill the switch can't reach (`switchable: false`) is a `404` (`ENTITY_NOT_FOUND`) instead.
 */
export type CapabilitySkillStateRefusal = "pinned" | "stale" | "duplicate";

/** The switch's request. There is no field that chooses the skip; the Gateway decides it. */
export interface CapabilitySkillStateRequest {
  workspaceId: string;
  skillId: string;
  state: SkillRuntimeState;
  /** The skill's `revision` from the list. A skill that changed since is refused with a 409. */
  expectedRevision: number;
}
