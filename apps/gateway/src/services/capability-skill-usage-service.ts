import {
  SKILL_USAGE_WINDOW_DAYS,
  type CapabilitySkillUsageEntry,
  type CapabilitySkillUsageResponse,
} from "@goatcitadel/contracts";
import type { SkillUseCount } from "@goatcitadel/storage";
import { createUsageCache, USAGE_CACHE_MS, type UsageCache } from "./capability-usage-cache.js";

const DAY_MS = 86_400_000;

/**
 * Skill use counts for the Capabilities Skills tab: how many chat turns loaded each skill in the last year. The counts
 * come from one storage query that is cached, so opening the tab never rescans the chat history.
 */
export class CapabilitySkillUsageService {
  private readonly cache: UsageCache<CapabilitySkillUsageResponse>;

  public constructor(
    private readonly readUses: (sinceIso: string) => Promise<readonly SkillUseCount[]>,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.cache = createUsageCache(() => this.load(), { cacheMs: USAGE_CACHE_MS, now });
  }

  /**
   * Concurrent reads share one query. `refresh` skips the cache and reads afresh; a failed read is never cached.
   * A read that fails rejects with the real error: the caller shows "Uses unknown", never a made-up 0.
   */
  public read(options: { refresh: boolean }): Promise<CapabilitySkillUsageResponse> {
    return this.cache.read(options);
  }

  private async load(): Promise<CapabilitySkillUsageResponse> {
    const readAt = this.now();
    const since = new Date(readAt.getTime() - SKILL_USAGE_WINDOW_DAYS * DAY_MS).toISOString();
    return { since, generatedAt: readAt.toISOString(), skills: toEntries(await this.readUses(since)) };
  }
}

/** Skills that were used, ordered by id here so the answer never depends on the database engine's row order. */
function toEntries(counts: readonly SkillUseCount[]): CapabilitySkillUsageEntry[] {
  return counts
    .filter((count) => count.skillId.length > 0 && Number.isSafeInteger(count.uses) && count.uses > 0)
    .map((count) => ({ skillId: count.skillId, uses: count.uses, lastUsedAt: count.lastUsedAt }))
    .sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : 0));
}
