import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import type { ChatInspectorTab } from "./chat-inspector-evidence";

export function buildEditorTurnId(active: MissionThreadedActiveSessionSurfaceProps | null): string | undefined {
  const selectedPath = active?.thread?.turns.filter((turn) => turn.branch.isSelectedPath) ?? [];
  return selectedPath.find((turn) => turn.turnId === active?.selectedTurnId)?.turnId ?? selectedPath.at(-1)?.turnId;
}

/** An ordinary turn opens the inspector on Message. A turn with an attached run opens on Run. */
export function inspectorTabFor(
  active: MissionThreadedActiveSessionSurfaceProps | null,
  turnId: string | null,
): ChatInspectorTab {
  const target = turnId ?? active?.selectedTurnId ?? buildEditorTurnId(active);
  return target && active?.delegationRun?.attachedTurnId === target ? "run" : "turn";
}

/** Only the one canonical artifact URL publication may complete this read. */
export function artifactInspectorHistoryMatches(origin: string, target: string, current: string) {
  if (current === origin) return true;
  const separator = origin.indexOf(":");
  const generation = Number(origin.slice(0, separator));
  return separator > 0 && Number.isSafeInteger(generation) && current === `${generation + 1}:${target}`;
}
