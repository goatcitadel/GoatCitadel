import { useCallback, useState } from "react";

/**
 * What the Skills tab's search box and buttons hold. The tab owns it, so the search and the category buttons stay put
 * when the view changes between Installed and Discover. "Where it came from" is two sets: origins in Installed and
 * providers in Discover, which name different things, so each view keeps its own.
 */
export interface SkillFilterState {
  search: string;
  categories: string[];
  origins: string[];
  providers: string[];
  setSearch(text: string): void;
  setCategories(ids: string[]): void;
  setOrigins(ids: string[]): void;
  setProviders(ids: string[]): void;
  /** Un-presses every button and keeps the search. */
  clearButtons(): void;
  /** Empties the search and un-presses every button. */
  clearAll(): void;
}

export function useSkillFilters(): SkillFilterState {
  const [search, setSearch] = useState("");
  const [categories, setCategories] = useState<string[]>([]);
  const [origins, setOrigins] = useState<string[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const clearButtons = useCallback(() => {
    setCategories([]);
    setOrigins([]);
    setProviders([]);
  }, []);
  const clearAll = useCallback(() => {
    setSearch("");
    clearButtons();
  }, [clearButtons]);
  return {
    search,
    categories,
    origins,
    providers,
    setSearch,
    setCategories,
    setOrigins,
    setProviders,
    clearButtons,
    clearAll,
  };
}
