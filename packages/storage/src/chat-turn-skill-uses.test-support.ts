import { canonicalJsonString, type ChatTurnCapabilityActivatedSkill } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";

const INCARNATION_GUARD = "trg_chat_turn_capability_profiles_incarnation_insert_guard";

/**
 * A profile row normally needs a frozen session incarnation and a sealed catalog snapshot. The skill-use count reads
 * only `profile_json` and `created_at`, so the fixtures write rows directly and switch that insert guard off.
 */
export function allowDirectProfileInserts(db: DatabaseClient): void {
  db.exec(
    db.dialect === "postgres"
      ? `ALTER TABLE chat_turn_capability_profiles DISABLE TRIGGER ${INCARNATION_GUARD}`
      : `DROP TRIGGER ${INCARNATION_GUARD}`,
  );
}

function activatedSkill(skillId: string): ChatTurnCapabilityActivatedSkill {
  return {
    capabilityId: `skill:${skillId}`,
    skillId,
    confidence: 0.9,
    reasons: ["matched the request"],
    treeSha256: "a".repeat(64),
    instructionSha256: "b".repeat(64),
    instructionBytes: 512,
    modules: [],
  };
}

export interface SkillProfileFixture {
  createdAt: string;
  /** Skills the turn loaded. Left out, the profile has no `activatedSkills`, as the write path omits an empty list. */
  activatedSkillIds?: string[];
  /** Skills the turn was allowed to use. These are not loads and must never count. */
  trustedSkillIds?: string[];
}

let sequence = 0;

/** Stores one profile row whose JSON has the shape the write path seals (`selection.activatedSkills[].skillId`). */
export function insertSkillProfile(db: DatabaseClient, fixture: SkillProfileFixture): void {
  sequence += 1;
  const profileJson = canonicalJsonString({
    profileId: `profile-${sequence}`,
    selection: {
      trustedSkills: (fixture.trustedSkillIds ?? []).map((skillId) => ({ skillId })),
      ...(fixture.activatedSkillIds ? { activatedSkills: fixture.activatedSkillIds.map(activatedSkill) } : {}),
    },
  });
  db.prepare(
    `INSERT INTO chat_turn_capability_profiles (
       profile_id, turn_id, session_id, workspace_id, durable_run_id, operator_id, auth_actor_id,
       schema_version, profile_hash, catalog_snapshot_id, inspectable_hash, callable_hash,
       selection_hash, governance_hash, preflight_fingerprint, profile_json, created_at
     ) VALUES (
       @profileId, @turnId, 'session-a', 'workspace-a', NULL, NULL, NULL,
       'chat.turn.capability-profile.v1', @hash, 'snapshot-a', @hash, @hash,
       @hash, @hash, @hash, @profileJson, @createdAt
     )`,
  ).run({
    profileId: `profile-${sequence}`,
    turnId: `turn-${sequence}`,
    hash: "c".repeat(64),
    profileJson,
    createdAt: fixture.createdAt,
  });
}
