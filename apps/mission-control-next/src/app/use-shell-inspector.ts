import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { ShellDetailPanelEntry } from "@goatcitadel/mission-control-shared/components/ShellDetailPanelContext";

/*
 * W4.4 (ship punchlist): inspector open/closed + active detail entry
 * extracted from the shell. Owns the trivially cohesive state pair
 * `inspectorOpen` + `detailEntry` and the effect that auto-opens the
 * inspector whenever a route-driven detail entry becomes active.
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

export function useShellInspector(): UseShellInspectorResult {
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [detailEntry, setDetailEntry] = useState<ShellDetailPanelEntry | null>(null);

  useEffect(() => {
    if (detailEntry) {
      setInspectorOpen(true);
    }
  }, [detailEntry]);

  return {
    inspectorOpen,
    setInspectorOpen,
    detailEntry,
    setDetailEntry,
  };
}
