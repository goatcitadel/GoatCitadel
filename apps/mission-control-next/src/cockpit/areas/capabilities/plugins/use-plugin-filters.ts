import { useCallback, useState } from "react";

/** What the Plugins tab's search box and its "Where it comes from" buttons hold. */
export interface PluginFilterState {
  search: string;
  /** The chosen trust labels' ids; empty means All. */
  trusts: string[];
  setSearch(text: string): void;
  setTrusts(ids: string[]): void;
  /** Empties the search and un-presses every button. */
  clearAll(): void;
}

export function usePluginFilters(): PluginFilterState {
  const [search, setSearch] = useState("");
  const [trusts, setTrusts] = useState<string[]>([]);
  const clearAll = useCallback(() => {
    setSearch("");
    setTrusts([]);
  }, []);
  return { search, trusts, setSearch, setTrusts, clearAll };
}
