import {
  skillCategoryFor,
  SHIPPED_SKILL_PACKS,
  TRUSTED_GIT_FORGE_HOSTS,
  namesGitRepository,
  type CapabilitySkillDiscoverItem,
  type CapabilitySkillDiscoverState,
  type CapabilitySkillInstall,
  type CapabilitySkillSource,
  type ShippedSkillPack,
  type SkillMergedSourceResult,
  type SkillSourceSearchRecord,
} from "@goatcitadel/contracts";
import { publicSource } from "./capability-skill-install-projection.js";
import { normalizeRepoReference, type InstalledSkillSource } from "./skill-import-service.js";

const PACK_PROVIDER_LABEL = "GoatCitadel";

/**
 * Curated listings for a service GoatCitadel integrates natively, by canonical key. Discover leaves them out: a skill
 * for such a service would sit beside, and undercut, the native sign-in and its checks. Today that is the ClawHub "GoG"
 * listing, a Google CLI skill: native Google sign-in covers Google, and the operator dropped the gog skill on
 * 2026-10-25.
 */
const NATIVELY_INTEGRATED_SOURCE_KEYS: ReadonlySet<string> = new Set(["clawhub.ai/steipete/gog"]);

/** The installed skills' sources, by what a Discover item can be matched on. Each value is the skill's name. */
export interface InstalledSourceIndex {
  /** The shipped packs installed, by pack id. */
  packs: ReadonlyMap<string, string>;
  /** Every other recorded source, by its normalized reference. */
  references: ReadonlyMap<string, string>;
}

/**
 * The installs on their way in, by what a Discover item can be matched on. Each value is the check whose install
 * "Continue" opens: the newest one for the source that didn't stop, else the newest.
 */
export interface InstallingIndex {
  packs: ReadonlyMap<string, string>;
  references: ReadonlyMap<string, string>;
}

/** What Discover knows about the listings' providers and about what is installed, read once per answer. */
export interface DiscoverContext {
  installed: InstalledSourceIndex;
  installing: InstallingIndex;
  /** Each listing provider's name, by provider id. */
  providerLabels: ReadonlyMap<string, string>;
}

/** A listing as the source owner hands it over: merged, with the owner's own "already installed" flag. */
export type DiscoverListing = SkillMergedSourceResult & { alreadyInstalled?: boolean };

/**
 * A repository or listing address as one comparable key: lower-case host without `www.`, no `.git`, no query or
 * fragment, no trailing slash. The source owner's own key (which Discover also honours) keeps `www.`, and keeps a `.git`
 * that a trailing slash followed.
 */
export function normalizeSourceReference(value: string): string | undefined {
  return normalizeRepoReference(value)
    ?.replace(/^www\./u, "")
    .replace(/\.git$/u, "");
}

export function indexInstalledSources(installed: readonly InstalledSkillSource[]): InstalledSourceIndex {
  const packs = new Map<string, string>();
  const references = new Map<string, string>();
  for (const record of installed) {
    for (const sourceRef of record.sourceRefs) {
      // Only a local folder is a pack's folder: a Git repository that happens to be named like one is not.
      const source =
        record.sourceType === "local_path" ? publicSource({ sourceType: "local_path", sourceRef }) : undefined;
      if (source?.kind === "pack") {
        if (!packs.has(source.packId)) packs.set(source.packId, record.skillName);
        continue;
      }
      const reference = normalizeSourceReference(sourceRef);
      if (reference && !references.has(reference)) references.set(reference, record.skillName);
    }
  }
  return { packs, references };
}

/** `installs` is the installs list, newest first, as the installs read returns it. */
export function indexInstalling(installs: readonly CapabilitySkillInstall[]): InstallingIndex {
  const packs = new Map<string, CapabilitySkillInstall>();
  const references = new Map<string, CapabilitySkillInstall>();
  for (const install of installs) {
    const { source } = install;
    const key = source.kind === "pack" ? source.packId : normalizeSourceReference(source.sourceRef);
    if (!key) continue;
    const index = source.kind === "pack" ? packs : references;
    const chosen = index.get(key);
    // The newest comes first; a newer install that stopped gives way to an older one still on its way in.
    if (!chosen || (chosen.step === "failed" && install.step !== "failed")) index.set(key, install);
  }
  return { packs: checkIds(packs), references: checkIds(references) };
}

function checkIds(index: ReadonlyMap<string, CapabilitySkillInstall>): ReadonlyMap<string, string> {
  return new Map([...index].map(([key, install]) => [key, install.snapshotId]));
}

/** The providers' names that couldn't be read, once each, in the order the owner reported them. */
export function unavailableProviderLabels(providers: readonly SkillSourceSearchRecord[]): string[] {
  return [
    ...new Set(
      providers
        .filter((provider) => provider.status === "degraded" || provider.status === "unavailable")
        .map((provider) => provider.providerLabel),
    ),
  ];
}

/** Whether a marketplace was read in full: a degraded or unavailable one stood in with curated entries. */
export function allProvidersAnswered(providers: readonly SkillSourceSearchRecord[]): boolean {
  return unavailableProviderLabels(providers).length === 0;
}

/** Whether every word of a search term appears in the pack's id, name, summary or program. */
export function packMatchesTerm(pack: ShippedSkillPack, term: string): boolean {
  const haystack = `${pack.packId} ${pack.label} ${pack.summary} ${pack.requiresCli}`.toLowerCase();
  return term.split(/\s+/u).every((word) => haystack.includes(word));
}

export function buildPackItems(context: DiscoverContext, term: string | undefined): CapabilitySkillDiscoverItem[] {
  return SHIPPED_SKILL_PACKS.filter((pack) => term === undefined || packMatchesTerm(pack, term)).map((pack) => {
    const installedName = context.installed.packs.get(pack.packId);
    const installing = installedName ? undefined : context.installing.packs.get(pack.packId);
    const state: CapabilitySkillDiscoverState = installedName ? "installed" : installing ? "installing" : "available";
    return {
      id: `pack:${pack.packId}`,
      name: pack.label,
      description: pack.summary,
      category: skillCategoryFor({ skillId: `extra:${pack.packId}`, tags: [] }),
      provider: "goatcitadel",
      providerLabel: PACK_PROVIDER_LABEL,
      state,
      install: { kind: "pack", packId: pack.packId },
      ...(installedName ? { installedSkillId: `extra:${installedName}` } : {}),
      ...(installing ? { installSnapshotId: installing } : {}),
    };
  });
}

/** The listings Discover offers, in the owner's order, without the ones for a natively integrated service. */
export function buildListingItems(
  listings: readonly DiscoverListing[],
  context: DiscoverContext,
): CapabilitySkillDiscoverItem[] {
  return listings
    .filter((listing) => !NATIVELY_INTEGRATED_SOURCE_KEYS.has(listing.canonicalKey))
    .map((listing) => listingItem(listing, context));
}

function listingItem(listing: DiscoverListing, context: DiscoverContext): CapabilitySkillDiscoverItem {
  const install = gitInstallFor(listing);
  const installedName = [listing.repositoryUrl, listing.sourceUrl]
    .flatMap((address) => (address ? [normalizeSourceReference(address)] : []))
    .map((reference) => (reference ? context.installed.references.get(reference) : undefined))
    .find((name) => name !== undefined);
  const installing =
    install?.kind === "git"
      ? context.installing.references.get(normalizeSourceReference(install.sourceRef) ?? "")
      : undefined;
  // The owner's flag also counts: it knows installs by its own key, though it can't name the skill.
  const installed = installedName !== undefined || listing.alreadyInstalled === true;
  const state: CapabilitySkillDiscoverState = installed
    ? "installed"
    : installing
      ? "installing"
      : install
        ? "available"
        : "view_only";
  return {
    id: `source:${listing.canonicalKey}`,
    name: listing.name,
    description: listing.description,
    category: skillCategoryFor({ skillId: "", tags: listing.tags }),
    provider: listing.sourceProvider,
    providerLabel: context.providerLabels.get(listing.sourceProvider) ?? listing.sourceProvider,
    state,
    ...(install ? { install } : {}),
    ...(isHttpsUrl(listing.sourceUrl) ? { listingUrl: listing.sourceUrl } : {}),
    ...(installedName !== undefined ? { installedSkillId: `extra:${installedName}` } : {}),
    ...(!installed && installing ? { installSnapshotId: installing } : {}),
  };
}

/**
 * An installable listing is one the owner calls direct whose repository (else listing) address is `https` on a trusted
 * Git forge, so what Discover offers is a source the check will read. Everything else can only be looked at.
 */
function gitInstallFor(listing: DiscoverListing): CapabilitySkillSource | undefined {
  if (listing.installability !== "direct") return undefined;
  const sourceRef = listing.repositoryUrl ?? listing.sourceUrl;
  return isTrustedGitAddress(sourceRef) ? { kind: "git", sourceRef } : undefined;
}

/**
 * `https` on an exact trusted forge host, with no credentials, query or fragment, and a path that names a repository
 * (an owner and a repository): the review refuses the rest.
 */
function isTrustedGitAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      TRUSTED_GIT_FORGE_HOSTS.includes(url.hostname.toLowerCase()) &&
      namesGitRepository(url.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * Whether an address is a plain `https` link. A listing's address is shown as a link the operator may follow, so
 * `javascript:`, `data:` and unencrypted addresses are never offered, whatever the listing says.
 */
function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function providerLabelsOf(providers: readonly SkillSourceSearchRecord[]): ReadonlyMap<string, string> {
  return new Map(providers.map((provider) => [provider.provider, provider.providerLabel]));
}
