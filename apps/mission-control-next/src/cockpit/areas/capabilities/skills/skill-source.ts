import type { CapabilitySkillDetail, SkillLifecycleState, SkillOrigin } from "@goatcitadel/contracts";

// Plain words for where a skill came from and how far it was reviewed. The origin and the review state are the
// Gateway's; this only words them, and names no more of a source address than its host.

type Provenance = CapabilitySkillDetail["provenance"];

const OUTSIDE = "Imported from outside GoatCitadel";

const ORIGIN_WORDS: Readonly<Record<Exclude<SkillOrigin, "imported">, string>> = {
  built_in: "Ships with GoatCitadel",
  self_authored: "Written by GoatCitadel from your chats",
  workspace: "From this workspace's skills folder",
};

const REVIEW_WORDS: Readonly<Record<SkillLifecycleState, string>> = {
  trusted: "Trusted",
  approved: "Reviewed",
  candidate: "Not reviewed yet",
  deprecated: "Retired",
  revoked: "Revoked",
  draft: "Draft",
};

/** Protocols a skill is fetched over. A local path (`C:/…`, `file:`) has no host to name. */
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);

/**
 * The host of a source address, without its credentials, port or path: `https://user:token@host:8443/a.git` and
 * `git@host:org/a.git` both give `host`. Undefined when the address names no host.
 */
function sourceHost(sourceRef: string | undefined): string | undefined {
  if (!sourceRef) return undefined;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/u.exec(sourceRef);
  if (scp) return scp[1];
  try {
    const url = new URL(sourceRef);
    return NETWORK_PROTOCOLS.has(url.protocol) && url.hostname ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Where a skill came from, in plain words. An imported skill names the host it came from, and says it was a Git
 * repository when its provenance records a commit.
 */
export function presentSkillSource(origin: SkillOrigin, provenance: Provenance): string {
  if (origin !== "imported") return ORIGIN_WORDS[origin];
  const host = sourceHost(provenance?.sourceRef);
  if (!host) return OUTSIDE;
  return provenance?.commitSha ? `Imported from a Git repository on ${host}` : `Imported from ${host}`;
}

/** How far a skill was reviewed, as one word; undefined when the list doesn't say. */
export function presentSkillReview(state: SkillLifecycleState | undefined): string | undefined {
  return state ? REVIEW_WORDS[state] : undefined;
}
