import type { OrchestrationWave } from "@goatcitadel/contracts";

export interface OwnershipConflict {
  waveId: string;
  pathA: string;
  agentA: string;
  pathB: string;
  agentB: string;
}

export function findOwnershipConflicts(wave: OrchestrationWave): OwnershipConflict[] {
  const conflicts: OwnershipConflict[] = [];

  const entries: Array<{ agentId: string; path: string }> = [];
  for (const owner of wave.ownership) {
    for (const ownedPath of owner.paths) {
      entries.push({ agentId: owner.agentId, path: normalize(ownedPath) });
    }
  }

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (!a || !b || a.agentId === b.agentId) {
        continue;
      }

      if (overlaps(a.path, b.path)) {
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

function normalize(p: string): string {
  return p.replaceAll("\\", "/").replace(/\*+$/, "").replace(/\/+$/, "");
}

function overlaps(a: string, b: string): boolean {
  // Paths like "/" or "**" normalize to "" and mean the repo root, which
  // overlaps every other path.
  if (a === "" || b === "") {
    return true;
  }
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
