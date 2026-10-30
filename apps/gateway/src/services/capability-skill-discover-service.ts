import type {
  CapabilitySkillDiscoverResponse,
  CapabilitySkillInstall,
  SkillSourceListResponse,
} from "@goatcitadel/contracts";
import {
  allProvidersAnswered,
  buildListingItems,
  buildPackItems,
  indexInstalledSources,
  indexInstalling,
  providerLabelsOf,
  unavailableProviderLabels,
} from "./capability-skill-discover-projection.js";
import { createUsageCache, type UsageCache } from "./capability-usage-cache.js";
import { projectImportProvenanceReferencesForPublic } from "./import-provenance-public-projection.js";
import type { InstalledSkillSource, SkillSourceCatalog, SkillSourceReadOptions } from "./skill-import-service.js";

/** How long the marketplaces' answer is kept before they are asked again. */
const MARKETPLACE_CACHE_MS = 10 * 60 * 1000;
/** The source owner caps a list at 100. A search keeps the best 50 of what the marketplaces and the curated list hold. */
const SEARCH_RESULT_LIMIT = 50;
/** Without a search term the whole curated list is offered, which is well under the owner's cap. */
const CURATED_RESULT_LIMIT = 100;

/** One reader per place Discover is built from, each through its existing owner. None writes anything. */
export interface CapabilitySkillDiscoverSources {
  /** Reads the curated entries and, unless `network` is `false`, the marketplaces' listing pages. Never throws for a marketplace. */
  readSourceCatalog(options: SkillSourceReadOptions): Promise<SkillSourceCatalog>;
  /** Ranks a catalog read earlier by a search term and marks what is already installed. Reads no marketplace. */
  presentSourceCatalog(catalog: SkillSourceCatalog, query: string | undefined, limit: number): SkillSourceListResponse;
  /** The skills installed at runtime, with where each one's source file says it came from. */
  listInstalledSources(): readonly InstalledSkillSource[];
  /**
   * The workspace's installs still on their way in, or stopped on the way. A read that fails logs its own error, so
   * Discover only goes on without the marks.
   */
  listInstalls(workspaceId: string): Promise<readonly CapabilitySkillInstall[]>;
}

export interface CapabilitySkillDiscoverOptions {
  /** The clock the marketplaces' cache counts its 10 minutes on. */
  now?: () => Date;
}

/**
 * A marketplace answer that stands in for a down marketplace with curated entries. It is rejected out of the cache's
 * read so the cache keeps nothing (a failed read is never kept), and handed straight back to every search waiting on it.
 */
class UnkeptCatalog extends Error {
  public constructor(public readonly catalog: SkillSourceCatalog) {
    super("A marketplace could not be read, so its answer is not kept.");
  }
}

/**
 * The Capabilities Skills tab's Discover: GoatCitadel's own packs and the curated listings with no network call, and
 * with a search term the marketplaces' listings ranked in. The marketplaces' answer does not depend on the term (their
 * home pages are read and ranked here), so one answer is kept for 10 minutes and ranked for each term. Every field,
 * including whether a skill is installed or on its way in, is the Gateway's reading; the cockpit derives none of it.
 */
export class CapabilitySkillDiscoverService {
  private readonly marketplaces: UsageCache<SkillSourceCatalog>;
  private readonly now: () => Date;

  public constructor(
    private readonly sources: CapabilitySkillDiscoverSources,
    options: CapabilitySkillDiscoverOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.marketplaces = createUsageCache(
      async () => {
        const catalog = await sources.readSourceCatalog({ network: true });
        if (!allProvidersAnswered(catalog.providers)) throw new UnkeptCatalog(catalog);
        return catalog;
      },
      { cacheMs: MARKETPLACE_CACHE_MS, now: this.now },
    );
  }

  /**
   * What the workspace can install. `query` (trimmed and lower-cased here) adds the marketplaces; `refresh` asks them
   * again instead of using the kept answer. With no `query` nothing goes online, and `refresh` has nothing to refresh.
   */
  public async list(
    workspaceId: string,
    request: { query?: string; refresh?: boolean } = {},
  ): Promise<CapabilitySkillDiscoverResponse> {
    const query = request.query?.trim().toLowerCase() || undefined;
    const [catalog, installs] = await Promise.all([
      query ? this.readMarketplaces(request.refresh === true) : this.sources.readSourceCatalog({ network: false }),
      this.readInstalls(workspaceId),
    ]);
    // The same public projection the skill sources route applies: a listing's address can carry a credential.
    const listed = projectImportProvenanceReferencesForPublic(
      this.sources.presentSourceCatalog(catalog, query, query ? SEARCH_RESULT_LIMIT : CURATED_RESULT_LIMIT),
    );
    const context = {
      installed: indexInstalledSources(this.sources.listInstalledSources()),
      installing: indexInstalling(installs),
      providerLabels: providerLabelsOf(listed.providers),
    };
    return {
      ...(query ? { query } : {}),
      items: [...buildPackItems(context, query), ...buildListingItems(listed.items, context)],
      unavailableProviders: unavailableProviderLabels(listed.providers),
      generatedAt: this.now().toISOString(),
    };
  }

  /** The kept marketplace answer, or a fresh one. An answer with a marketplace down is used once and not kept. */
  private async readMarketplaces(refresh: boolean): Promise<SkillSourceCatalog> {
    try {
      return await this.marketplaces.read({ refresh });
    } catch (error) {
      if (error instanceof UnkeptCatalog) return error.catalog;
      throw error;
    }
  }

  /**
   * The installs in progress, to mark their sources. Without them an in-progress source reads as available, and
   * installing it again meets the same guards, so Discover is still answered. The failed read has logged its own error.
   */
  private async readInstalls(workspaceId: string): Promise<readonly CapabilitySkillInstall[]> {
    try {
      return await this.sources.listInstalls(workspaceId);
    } catch {
      return [];
    }
  }
}
