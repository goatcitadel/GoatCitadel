import { redactSecretText, type SkillLifecycleRecord, type LoadedSkill } from "@goatcitadel/contracts";
import { BUNDLED_SKILL_LOCK_VERSION, type BundledSkillLockEntry } from "@goatcitadel/skills";
import type { CapabilitySystemServiceOptions } from "./capability-system-service.js";
type ReleaseRetrustHost = Pick<CapabilitySystemServiceOptions, "storage" | "publishRealtime">;
const EXACT_BYTE_REVIEW_TRUST_LABEL = "Exact-byte review required";
const SKILL_LIFECYCLE_RETRUST_AUDIT_VERSION = "goatcitadel.skill-lifecycle-retrust-audit.v1" as const;
const BUNDLED_SKILL_RELEASE_LOCK_ACTOR_ID = "system:bundled-skill-release-lock" as const;
/** Retains write-ahead audit, immediate-transaction CAS, and post-commit signal ownership. */
export async function applyReleaseBoundSkillRetrust(
  host: ReleaseRetrustHost,
  skill: LoadedSkill,
  existing: SkillLifecycleRecord,
  projected: SkillLifecycleRecord,
  retrust: { lockEntry: BundledSkillLockEntry },
): Promise<SkillLifecycleRecord> {
  const previous = existing.provenance?.contentIntegrity;
  const current = retrust.lockEntry;
  try {
    await host.storage.audit.append(
      "approvals",
      {
        event: "skill_lifecycle.release_retrusted",
        schemaVersion: SKILL_LIFECYCLE_RETRUST_AUDIT_VERSION,
        skillId: skill.skillId,
        source: skill.source,
        category: projected.category,
        actorId: BUNDLED_SKILL_RELEASE_LOCK_ACTOR_ID,
        previousLifecycleState: existing.lifecycleState,
        lifecycleState: projected.lifecycleState,
        previousTrustLabel: existing.trustLabel,
        trustLabel: projected.trustLabel,
        previousContentIntegrity: previous
          ? {
              manifestVersion: previous.manifestVersion,
              treeSha256: previous.treeSha256,
              fileCount: previous.fileCount,
              totalBytes: previous.totalBytes,
              verified: previous.verified,
            }
          : null,
        contentIntegrity: {
          manifestVersion: current.manifestVersion,
          treeSha256: current.treeSha256,
          fileCount: current.fileCount,
          totalBytes: current.totalBytes,
          verified: true,
        },
        lockVersion: BUNDLED_SKILL_LOCK_VERSION,
        lockEntry: { ...current },
        occurredAt: projected.updatedAt,
      },
      {
        // One receipt per distinct transition of a distinct stored row; concurrent duplicates
        // of the same transition collapse, while A->B->A cycles keep their own receipts.
        deliveryId: `skill-lifecycle-release-retrust:${skill.skillId}:${previous?.treeSha256 ?? "none"}:${current.treeSha256}:${existing.updatedAt}`,
      },
    );
  } catch (error) {
    const reason = redactSecretText(error instanceof Error ? error.message : String(error)).value.slice(0, 160);
    const demoted = await commitSkillLifecycleIfUnchanged(host, existing, {
      ...projected,
      lifecycleState: "candidate",
      trustLabel: EXACT_BYTE_REVIEW_TRUST_LABEL,
      reviewWarning: `Release lock matched this skill tree but the re-trust audit receipt could not be written (${reason}); the skill stays non-callable until the receipt succeeds.`,
    });
    return demoted.record;
  }
  const committed = await commitSkillLifecycleIfUnchanged(host, existing, projected);
  if (committed.changed) {
    // Another writer owns the newer row; its truth wins and the next read re-evaluates from it.
    return committed.record;
  }
  const stored = committed.record;
  try {
    await host.publishRealtime("skill_lifecycle_retrusted", "capabilities", {
      skillId: skill.skillId,
      source: skill.source,
      previousLifecycleState: existing.lifecycleState,
      lifecycleState: stored.lifecycleState,
      previousTreeSha256: previous?.treeSha256,
      treeSha256: current.treeSha256,
      lockVersion: BUNDLED_SKILL_LOCK_VERSION,
    });
  } catch (realtimeError) {
    void realtimeError;
    // The lifecycle row and its audit receipt are canonical; realtime is an advisory projection.
  }
  return stored;
}

async function commitSkillLifecycleIfUnchanged(
  host: ReleaseRetrustHost,
  existing: SkillLifecycleRecord,
  record: SkillLifecycleRecord,
): Promise<{ changed: boolean; record: SkillLifecycleRecord }> {
  return await host.storage.runImmediateTransaction(async () => {
    const latest = await host.storage.skillLifecycle.find(existing.skillId);
    if (!latest || latest.lifecycleState !== existing.lifecycleState || latest.updatedAt !== existing.updatedAt) {
      return { changed: true, record: latest ?? existing };
    }
    return { changed: false, record: await host.storage.skillLifecycle.upsert(record) };
  });
}
