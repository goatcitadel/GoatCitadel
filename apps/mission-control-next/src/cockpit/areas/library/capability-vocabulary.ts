import type {
  CandidateSkillVersionRecord,
  CapabilityCategory,
  CapabilityKind,
  CapabilityProposalStatus,
  CuratorSkillRecommendation,
  SkillLifecycleState,
  SkillRuntimeState,
  ToolApprovalMode,
  ToolEffectPotentialReason,
  ToolEffectSourceKind,
  WardEffect,
} from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** Plain words for capability enums. Typed records so a new enum value fails typecheck. */

/** A value the Gateway adds before this map learns it reads as a plain fallback, never as the raw token. */
const lookup = <K extends string>(map: Record<K, string>, value: string, fallback: string): string =>
  (map as Record<string, string | undefined>)[value] ?? fallback;

const KIND: Record<CapabilityKind, string> = {
  tool: "Tool",
  skill: "Skill",
  code_mode: "Code Mode",
  proposal: "Proposal",
  candidate_skill: "Candidate skill",
  mesh_tool: "Mesh tool",
  mesh_mcp_server: "Mesh MCP server",
  mesh_skill: "Mesh skill",
};
export const capabilityKindLabel = (value: string) => lookup(KIND, value, "Other capability");

const CATEGORY: Record<CapabilityCategory, string> = {
  built_in: "Built-in",
  optional: "Optional",
  project_local: "Project",
  self_generated: "Self-authored",
  community_imported: "Imported from the community",
  mesh_published: "Published by a mesh node",
};
export const capabilityCategoryLabel = (value: string) => lookup(CATEGORY, value, "Uncategorized");

const SKILL_STATE: Record<SkillRuntimeState, string> = { enabled: "Enabled", sleep: "Paused", disabled: "Disabled" };
export const skillStateLabel = (value: SkillRuntimeState) => SKILL_STATE[value];

const LIFECYCLE: Record<SkillLifecycleState, string> = {
  draft: "Draft",
  candidate: "Candidate",
  approved: "Approved",
  trusted: "Trusted",
  deprecated: "Deprecated",
  revoked: "Revoked",
};
export const skillLifecycleLabel = (value: string) => lookup(LIFECYCLE, value, "Lifecycle unknown");

const PROPOSAL_STATUS: Record<CapabilityProposalStatus, string> = {
  proposed: "Proposed",
  validating: "Being checked",
  pending_approval: "Waiting on you",
  approved: "Approved",
  rejected: "Rejected",
  activated: "Activated",
  failed: "Failed",
};
export const capabilityProposalStatusLabel = (value: string) => lookup(PROPOSAL_STATUS, value, "Status unknown");

const PROPOSAL_EVENT: Record<"created" | "validated" | "approved" | "rejected" | "activated" | "failed", string> = {
  created: "Created",
  validated: "Checked",
  approved: "Approved",
  rejected: "Rejected",
  activated: "Activated",
  failed: "Failed",
};
export const capabilityProposalEventLabel = (value: string) => lookup(PROPOSAL_EVENT, value, "Other event");

const VERSION_SOURCE: Record<CandidateSkillVersionRecord["sourceKind"], string> = {
  code_mode_generated: "Generated in Code Mode",
  manual: "Written by hand",
  learned_correction: "Learned from a correction",
  history_workshop: "From the history workshop",
  upstream_hub: "From an upstream hub",
  capability_pack: "From a capability pack",
  workflow_capture: "Captured from a workflow",
};
export const versionSourceLabel = (value: string) => lookup(VERSION_SOURCE, value, "Source unknown");

const LINEAGE: Record<NonNullable<CandidateSkillVersionRecord["lineageStatus"]>, string> = {
  legacy_missing: "Lineage missing (older record)",
  governed: "Governed lineage",
};
export const lineageLabel = (value: string | undefined) =>
  value ? lookup(LINEAGE, value, "Lineage unknown") : "Lineage unavailable";

const LIFECYCLE_ACTION: Record<"promote" | "revoke" | "rollback", string> = {
  promote: "Promote",
  revoke: "Revoke",
  rollback: "Roll back",
};
export const lifecycleActionLabel = (value: "promote" | "revoke" | "rollback") => LIFECYCLE_ACTION[value];

const APPROVAL_MODE: Record<ToolApprovalMode, string> = {
  approve_all: "Every tool call needs approval",
  approve_risky: "Risky tool calls need approval",
  bypass: "Approvals bypassed",
};
export const approvalModeLabel = (value: string) => lookup(APPROVAL_MODE, value, "Approval posture unknown");

const EFFECT_SOURCE: Record<ToolEffectSourceKind, string> = {
  builtin: "Built-in",
  browser: "Browser",
  shell: "Shell",
  mcp: "MCP",
  plugin: "Plugin",
  remote: "Remote",
  unknown: "Unknown",
};
export const effectSourceLabel = (value: string) => lookup(EFFECT_SOURCE, value, "Unknown");

const EFFECT_REASON: Record<ToolEffectPotentialReason, string> = {
  trusted_builtin_safe_read: "a trusted built-in read",
  browser_runtime_may_cross_boundary: "the browser may reach outside this machine",
  shell_runtime_may_mutate: "the shell may change things",
  mcp_runtime_untrusted: "the MCP server is not trusted",
  plugin_runtime_untrusted: "the plugin is not trusted",
  remote_runtime_may_cross_boundary: "the remote runtime may reach outside this machine",
  tool_may_mutate_runtime_state: "the tool may change runtime state",
  untrusted_read_only_hint: "its read-only hint is not trusted",
  descriptor_incomplete_or_untrusted: "its description is incomplete or not trusted",
};
export const effectReasonLabel = (value: string) => lookup(EFFECT_REASON, value, "reason not recognized");

const WARD_EFFECT: Record<WardEffect, string> = {
  allow: "Allowed",
  deny: "Denied",
  require_approval: "Needs approval",
  require_dry_run: "Needs a dry run first",
  redact: "Redacted",
  route_local: "Kept on this machine",
};
export const wardEffectLabel = (value: string) => lookup(WARD_EFFECT, value, "Effect unknown");

/**
 * Free text with no enum: trust labels the Gateway already writes as words ("Operator approved"), declared tool and
 * requirement names, provider names and policy reason codes. Words stay as written; a bare token reads as plain words.
 */
export const freeText = (value: string) => (/\s/u.test(value) ? value : humanizeToken(value) || value);

const CURATOR_RECOMMENDATION: Record<CuratorSkillRecommendation, string> = {
  keep: "Keep",
  archive: "Archive",
  prune_candidate: "Consider pruning",
  consolidate_candidate: "Consider consolidating",
};
export const curatorRecommendationLabel = (value: string) => lookup(CURATOR_RECOMMENDATION, value, "No recommendation");
