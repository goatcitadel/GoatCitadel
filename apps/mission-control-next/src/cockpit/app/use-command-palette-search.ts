import { useEffect, useRef, useState } from "react";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { searchPaletteObjects, type PaletteScope, type PaletteSearchGroup } from "./command-palette-search";

export function useCommandPaletteSearch(open: boolean, scope: PaletteScope, query: string) {
  const text = query.trim().slice(0, 200);
  const binding = JSON.stringify([open, scope.workspaceId, scope.citadelId, text]);
  const view = useRef({ binding, epoch: 0 });
  if (view.current.binding !== binding) view.current = { binding, epoch: view.current.epoch + 1 };
  const epoch = view.current.epoch;
  const generation = useRef(0);
  const [result, setResult] = useState<{ epoch: number; groups?: PaletteSearchGroup[]; error?: string }>();
  useEffect(() => {
    const token = ++generation.current;
    if (!open || text.length < 2) return;
    const timer = window.setTimeout(() => {
      void searchPaletteObjects({ workspaceId: scope.workspaceId, citadelId: scope.citadelId }, text).then(
        (groups) => {
          if (generation.current === token) setResult({ epoch, groups });
        },
        (cause: unknown) => {
          if (generation.current === token) setResult({ epoch, error: describeApiError(cause).summary });
        },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [epoch, open, scope.workspaceId, scope.citadelId, text]);
  const current = result?.epoch === epoch ? result : undefined;
  return { groups: current?.groups ?? [], error: current?.error, loading: open && text.length >= 2 && !current };
}
