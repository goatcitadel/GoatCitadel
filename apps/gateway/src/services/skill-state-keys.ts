/**
 * Where a skill's saved state lives besides its `skill_state` row: the shared metadata setting (pinned, use counts, last
 * use) keyed by skill id, and the idle-archive snapshot the curator keeps per skill. The skill state owner writes them;
 * a governed Skill Hub removal deletes one skill's share of them.
 */
export const SKILL_STATE_METADATA_SETTING_KEY = "skill_state_metadata_v1";

/** The curator snapshot key is the storage repository's own, which alone may delete it. */
export { curatorIdleSnapshotKey } from "@goatcitadel/storage";
