import type { CapabilityCatalogEntry, SkillLifecycleState } from "./capabilities.js";
import type { SkillCategoryId, SkillOrigin } from "./skill-categories.js";
import type { SkillRuntimeState, SkillSourceProvider } from "./skills.js";

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
  /**
   * The plugin whose record lists the GoatCitadel check this skill was switched on from. Absent for every other skill,
   * and when the plugin records couldn't be read (an issue line says so).
   */
  fromPlugin?: { pluginId: string; name: string };
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
 * What switching a skill, or asking for an install step, did. Every change creates its approval; the operator's skip
 * only resolves it. The approval follows from the request, so asking again for the same change, before anything changes,
 * hands back the approval already made while that one waits or once it is approved.
 * - `approved`: approved, by the skip now or earlier, and its own effect applies the change (or already has).
 * - `waiting`: it waits for the operator's approval.
 * - `declined`: the switch answers this only for the expiry race: the approval ran out of time just as the skip approved
 *   it, so `expired` is `true` and nothing changes. Asking again makes a fresh approval, linked to this one, as it does
 *   after any decline or expiry. Install steps never answer it: their approvals don't expire, and a declined one is
 *   asked for afresh.
 * - `unchanged`: the skill is already in that state, so nothing was asked. Install steps never answer it either.
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

// ---------------------------------------------------------------------------
// Checking and installing a skill: POST /api/v1/capabilities/skills/reviews,
// GET /api/v1/capabilities/skills/installs and POST /api/v1/capabilities/skills/operations
// ---------------------------------------------------------------------------

/**
 * Where a skill to check comes from: one of GoatCitadel's own packs (`SHIPPED_SKILL_PACKS`), or an `https` Git address on
 * one of `TRUSTED_GIT_FORGE_HOSTS`. Nothing else can be checked from Capabilities.
 */
export type CapabilitySkillSource = { kind: "pack"; packId: string } | { kind: "git"; sourceRef: string };

/**
 * Where a checked skill is on its way in. The Gateway reads it from the check and its two approvals; the cockpit never
 * derives it.
 * - `check_passed`: it passed the checks and isn't installed; installing it can be asked for.
 * - `blocked`: it can't be installed. `blockers` says why: its own check codes, or (for a source already installed)
 *   the install guard's.
 * - `waiting_install` / `waiting_switch_on`: the step's approval waits for the operator (`approvalId`).
 * - `installing` / `switching_on`: the step was approved and is being applied.
 * - `installed_off`: installed, not switched on, so the AI can't use it yet.
 * - `done`: switched on (`installedSkillId`). The Installed list shows its real state, which may be off or paused.
 * - `failed`: a step was approved but stopped (`failure`).
 *
 * A declined approval counts as never asked, so the install reads as the step before it.
 */
export type CapabilitySkillInstallStep =
  | "check_passed"
  | "blocked"
  | "waiting_install"
  | "installing"
  | "installed_off"
  | "waiting_switch_on"
  | "switching_on"
  | "done"
  | "failed";

/** What a checked skill asks for, from its check's permission envelope. Every list is empty when it asks for nothing. */
export interface CapabilitySkillInstallAsks {
  /** Tool capability ids as the check maps them (`tool:shell.exec`); the cockpit labels them without the prefix. */
  tools: string[];
  /** The hosts its files reach. */
  networkHosts: string[];
  /** The environment variable names it reads. */
  envVars: string[];
  readsFiles: string[];
  writesFiles: string[];
  /** Whether it includes scripts. Installing it doesn't run them. */
  includesScripts: boolean;
  /** The programs it says it needs on this computer. */
  requires: string[];
}

/** One checked skill and where its install is. No server path ever appears in it. */
export interface CapabilitySkillInstall {
  /** The check's id; an install step names it. */
  snapshotId: string;
  name: string;
  /** A pack's summary. A Git source's is empty: its check doesn't keep the skill's description. */
  description: string;
  /** Where it comes from. A Git source adds its host and, when the check pinned one, the commit it read. */
  source: CapabilitySkillSource & { host?: string; commit?: string };
  step: CapabilitySkillInstallStep;
  /** The approval that waits, while `waiting_install` or `waiting_switch_on`. */
  approvalId?: string;
  /**
   * Why it is `blocked`: the codes as stored, never dropped. `SKILL_HUB_BLOCKER_CODES` names the ones with their own
   * meaning; any other is one of GoatCitadel's checks too. Empty at every other step.
   */
  blockers: string[];
  asksFor: CapabilitySkillInstallAsks;
  /** The installed skill's id, at `done`. */
  installedSkillId?: string;
  /** Why a step stopped, in plain words, at `failed`. */
  failure?: string;
}

/** Checks a source. The key makes a retry hand back the same check rather than a second one. */
export interface CapabilitySkillReviewRequest {
  workspaceId: string;
  source: CapabilitySkillSource;
  idempotencyKey: string;
}

export const CAPABILITY_SKILL_SOURCE_REFUSED_CODE = "SKILL_SOURCE_REFUSED" as const;

/**
 * The reviews route's `422` body for a source it refused. `details.reason` is the check's own code (such as
 * `UNKNOWN_FRONTMATTER_DIMENSION` or `BUNDLE_MANIFEST_INVALID`), `UNTRUSTED_GIT_HOST` for a Git address that isn't
 * `https` on a trusted forge, or `SOURCE_REFUSED` when the source itself couldn't be read or isn't allowed. `error` is a
 * plain sentence.
 */
export interface CapabilitySkillSourceRefusal {
  error: string;
  code: typeof CAPABILITY_SKILL_SOURCE_REFUSED_CODE;
  details: { reason: string };
}

/**
 * The installs still on their way in, or stopped, in a workspace: every check whose step isn't `check_passed`, `blocked`
 * or `done`, newest first, so an install left between its steps is found again after a reload. Read from the newest 100
 * checks of the workspace.
 *
 * `GET /api/v1/capabilities/skills/installs?workspaceId=&snapshotId=`: with the optional `snapshotId` (1 to 256
 * characters), `installs` holds just that check at whatever step it is on, `done`, `check_passed` and `blocked` included,
 * or nothing when the workspace's checks don't hold it. An install flow reads it to tell a finished install from a
 * declined one, since both leave the in-progress list.
 */
export interface CapabilitySkillInstallsResponse {
  workspaceId: string;
  installs: CapabilitySkillInstall[];
  /**
   * Whether the operator's setting to skip approvals for their own changes applies here: with it, each install step
   * applies without asking. Never on a `remote_hardened` install.
   */
  operatorApprovalSkip: boolean;
  generatedAt: string;
}

/**
 * Asks for one install step of a checked skill. There is no field that chooses the skip; the Gateway decides it. A step
 * GoatCitadel's checks don't allow now is a `409` (`STATE_CONFLICT`, `details: { reason: "blocked", blockers }`).
 */
export interface CapabilitySkillOperationRequest {
  workspaceId: string;
  snapshotId: string;
  operationKind: "install_inactive" | "activate";
}

// ---------------------------------------------------------------------------
// Finding a skill to install: GET /api/v1/capabilities/skills/discover
// ---------------------------------------------------------------------------

/**
 * Where a skill on offer stands. The Gateway reads it; the cockpit never derives it.
 * - `installed`: a skill from this source is already installed (`installedSkillId` when the install can name it).
 * - `installing`: an install of it is on its way in or stopped on the way (Capabilities' installs list holds it), so the
 *   install flow continues it.
 * - `available`: it can be checked and installed from Capabilities.
 * - `view_only`: it can only be looked at: a listing GoatCitadel can't install from.
 *
 * `available` and `installing` always have an `install` source; `view_only` never does.
 */
export type CapabilitySkillDiscoverState = "available" | "installed" | "installing" | "view_only";

/** One skill on offer in Discover: one of GoatCitadel's own packs, or a listing from a curated list or a marketplace. */
export interface CapabilitySkillDiscoverItem {
  /** `pack:<packId>` for a pack, `source:<canonical key>` for a listing. */
  id: string;
  name: string;
  description: string;
  category: SkillCategoryId;
  provider: "goatcitadel" | SkillSourceProvider;
  /** `GoatCitadel` for the packs; else the provider's own name, such as `AgentSkill`. */
  providerLabel: string;
  state: CapabilitySkillDiscoverState;
  /**
   * What an install checks. Only a pack, or an `https` address on one of `TRUSTED_GIT_FORGE_HOSTS` whose entry is
   * installable, has one; every other item is only a listing and has none.
   */
  install?: CapabilitySkillSource;
  /** The listing's address. Offered only as "See listing" and in Technical details. */
  listingUrl?: string;
  /** The installed skill's id, at `installed`, when the install can name it. */
  installedSkillId?: string;
  /**
   * At `installing`: the check whose install is on its way in (the installs list's `snapshotId`), so "Continue" opens
   * that install. With more than one for the source, the newest that didn't stop, else the newest.
   */
  installSnapshotId?: string;
}

/**
 * What Discover offers. With no search term: GoatCitadel's own packs and the curated listings, with no network call.
 * With `q` (2 to 100 characters): the packs and listings that match it, with the marketplaces' listings ranked in. A
 * marketplace that couldn't be searched is named in `unavailableProviders` and the rest is still answered.
 *
 * `GET /api/v1/capabilities/skills/discover?workspaceId=&q=&refresh=`. The marketplaces' answer is kept for 10 minutes
 * and ranked for each term; `refresh=true` asks them again.
 */
export interface CapabilitySkillDiscoverResponse {
  /** The search term as the Gateway read it: trimmed and lower-cased. Absent without one. */
  query?: string;
  items: CapabilitySkillDiscoverItem[];
  /** The providers' names that couldn't be searched, once each. */
  unavailableProviders: string[];
  generatedAt: string;
}
