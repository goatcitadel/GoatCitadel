import type { OrchestrationWave } from "@goatcitadel/contracts";

export interface OwnershipConflict {
  waveId: string;
  pathA: string;
  agentA: string;
  pathB: string;
  agentB: string;
}

/** Characters that start a glob pattern in an ownership path. */
const GLOB_CHARACTER = /[*?[{]/;

interface OwnershipClaim {
  agentId: string;
  /** Normalized path for reporting, without trailing glob-only segments. */
  path: string;
  /**
   * Lower-cased text the claim is compared by: the whole path, or for a glob
   * the text before its first glob character (which may end mid-segment).
   */
  literal: string;
  glob: boolean;
}

export function findOwnershipConflicts(wave: OrchestrationWave): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];

  const claims: OwnershipClaim[] = [];
  for (const owner of wave.ownership) {
    for (const ownedPath of owner.paths) {
      claims.push(toClaim(owner.agentId, ownedPath));
    }
  }

  for (let i = 0; i < claims.length; i += 1) {
    for (let j = i + 1; j < claims.length; j += 1) {
      const a = claims[i];
      const b = claims[j];
      if (!a || !b || a.agentId === b.agentId) {
        continue;
      }

      if (overlaps(a, b)) {
        conflicts.push({
          waveId: wave.waveId,
          pathA: a.path,
          agentA: a.agentId,
          pathB: b.path,
          agentB: b.agentId,
        });
      }
    }
  }

  return conflicts;
}

/**
 * True when an ownership path climbs above the repository root (for example
 * `../outside` or `apps/../../outside`), so it cannot name a path in the repo.
 */
export function ownershipPathEscapesRoot(ownedPath: string): boolean {
  return normalizeSegments(ownedPath) === undefined;
}

function toClaim(agentId: string, ownedPath: string): OwnershipClaim {
  // Plan validation rejects escaping paths; one that reaches here anyway is
  // treated as the repository root, so it conflicts with every other agent.
  const segments = normalizeSegments(ownedPath) ?? [];
  const normalized = segments.join("/");
  const globIndex = normalized.search(GLOB_CHARACTER);
  const displaySegments = [...segments];
  while (displaySegments.length > 0 && /^\*+$/.test(displaySegments.at(-1)!)) {
    displaySegments.pop();
  }
  return {
    agentId,
    path: displaySegments.join("/"),
    literal: (globIndex === -1 ? normalized : normalized.slice(0, globIndex)).toLowerCase(),
    glob: globIndex !== -1,
  };
}

/**
 * Splits a path into repository-relative segments: separators unified, empty
 * and `.` segments dropped, `..` resolved. Returns undefined when `..` climbs
 * above the root. A leading `/` means the repository root.
 */
function normalizeSegments(ownedPath: string): string[] | undefined {
  const segments: string[] = [];
  for (const segment of ownedPath.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}

function overlaps(a: OwnershipClaim, b: OwnershipClaim): boolean {
  // An empty literal ("/", "**", or a root-level glob like "*.md") can reach
  // every path.
  if (a.literal === "" || b.literal === "") {
    return true;
  }
  if (!a.glob && !b.glob) {
    return isWithin(a.literal, b.literal) || isWithin(b.literal, a.literal);
  }
  // A glob can match anything that starts with its literal text, including a
  // sibling sharing a partial segment ("apps/web*" reaches "apps/website").
  // Two globs can both match a path only if one literal starts with the other.
  if (a.glob && b.glob) {
    return a.literal.startsWith(b.literal) || b.literal.startsWith(a.literal);
  }
  const glob = a.glob ? a : b;
  const plain = a.glob ? b : a;
  // The glob reaches the plain path (or its subtree), or starts inside it.
  return plain.literal.startsWith(glob.literal) || isWithin(glob.literal, plain.literal);
}

/** True when `candidate` is `root` or a path under it. */
function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}
