import type { Ref } from "react";
import { CapabilitySearch } from "../CapabilitySearch";
import { CategoryFilter, type CategoryOption } from "../CategoryFilter";

export interface SkillsFilterBarProps {
  /** The region around the box and the buttons, so a view can send focus to the box when a button it pressed leaves. */
  regionRef?: Ref<HTMLDivElement>;
  placeholder: string;
  search: string;
  onSearch: (text: string) => void;
  categoryOptions: readonly CategoryOption[];
  categories: readonly string[];
  onCategories: (ids: string[]) => void;
  /** "Where it came from": the origins of the installed skills, or the providers of the skills on offer. */
  sourceOptions: readonly CategoryOption[];
  sources: readonly string[];
  onSources: (ids: string[]) => void;
  /** How many source buttons show before the rest go under a "+N" button. */
  sourceVisibleCount?: number;
}

/**
 * The search box and the two sets of buttons the Installed and Discover views share. A set with fewer than two buttons
 * is not shown, because one button narrows nothing. The views pass only the selections that still have a button.
 */
export function SkillsFilterBar({
  regionRef,
  placeholder,
  search,
  onSearch,
  categoryOptions,
  categories,
  onCategories,
  sourceOptions,
  sources,
  onSources,
  sourceVisibleCount,
}: SkillsFilterBarProps) {
  return (
    <div ref={regionRef} className="space-y-3">
      <CapabilitySearch tabLabel="Skills" value={search} onChange={onSearch} placeholder={placeholder} />
      {categoryOptions.length >= 2 ? (
        <CategoryFilter label="Categories" options={categoryOptions} selected={categories} onChange={onCategories} />
      ) : null}
      {sourceOptions.length >= 2 ? (
        <CategoryFilter
          label="Where it came from"
          options={sourceOptions}
          selected={sources}
          onChange={onSources}
          {...(sourceVisibleCount !== undefined ? { visibleCount: sourceVisibleCount } : {})}
        />
      ) : null}
    </div>
  );
}
