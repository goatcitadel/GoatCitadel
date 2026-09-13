import { useState, type Dispatch, type SetStateAction } from "react";
import type { ShellDetailPanelEntry } from "@goatcitadel/mission-control-shared/components/ShellDetailPanelContext";

/*
 * W4.4 (ship punchlist): inspector open/closed + active detail entry
 * extracted from the shell. Owns the trivially cohesive state pair
 * `inspectorOpen` + `detailEntry`. Entry refresh never changes open intent;
 * callers explicitly open through the shell detail-panel context.
 *
 * The `passiveInspectorEntry` useMemo stays in the shell because it pulls
 * from too many shell-only dependencies (status, route, realtime copy,
 * trust-report callback, active workspace name) to be portable.
 */

export interface UseShellInspectorResult {
  inspectorOpen: boolean;
  setInspectorOpen: Dispatch<SetStateAction<boolean>>;
  detailEntry: ShellDetailPanelEntry | null;
  setDetailEntry: Dispatch<SetStateAction<ShellDetailPanelEntry | null>>;
}

export function useShellInspector(initiallyPinned = false): UseShellInspectorResult {
  const [inspectorOpen, setInspectorOpen] = useState(initiallyPinned);
  const [detailEntry, setDetailEntry] = useState<ShellDetailPanelEntry | null>(null);

  return {
    inspectorOpen,
    setInspectorOpen,
    detailEntry,
    setDetailEntry,
  };
}
