import { Command } from "cmdk";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { LibraryResourceDetail } from "../areas/library/LibraryResourceDetail";
import type { LibraryResource } from "../areas/library/library-resources";
import type { PaletteObject, PaletteScope, PaletteSearchGroup } from "./command-palette-search";

export const PALETTE_ITEM_CLASS =
  "cursor-pointer rounded-sm px-3 py-2 text-sm text-fg data-[selected=true]:bg-sunken data-[disabled=true]:opacity-60";

export function CommandPaletteResults({
  groups,
  onSelect,
}: {
  groups: PaletteSearchGroup[];
  onSelect: (item: PaletteObject) => void;
}) {
  return groups
    .filter((group) => group.items.length > 0)
    .map((group) => (
      <Command.Group key={group.id} heading={group.label} className="py-2 text-xs text-fg-muted">
        {group.items.map((item) => (
          <Command.Item
            key={item.id}
            value={`${group.id}:${item.id}`}
            className={PALETTE_ITEM_CLASS}
            onSelect={() => onSelect(item)}
          >
            <span className="block break-words font-medium">{item.label}</span>
            <span className="block break-words text-xs text-fg-secondary">{item.description}</span>
          </Command.Item>
        ))}
      </Command.Group>
    ));
}

/** Coverage is inspectable evidence, not a selectable listbox option. */
export function CommandPaletteCoverage({ groups }: { groups: PaletteSearchGroup[] }) {
  return groups.map((group) => (
    <section key={group.id} aria-label={`${group.label} search coverage`} className="py-2 text-xs text-fg-muted">
      <p className="px-3 font-medium">{group.label}</p>
      {group.error ? (
        <p role="status" className="px-3 py-1 text-sm text-fg-secondary">
          {group.error}
        </p>
      ) : null}
      {group.searching ? (
        <p role="status" className="px-3 py-1 text-xs text-fg-muted">
          Searching…
        </p>
      ) : !group.items.length && !group.error ? (
        <p className="px-3 py-1 text-xs text-fg-muted">No matches in this source’s returned window.</p>
      ) : null}
      {group.searching ? null : (
        <details
          className="px-3 py-1 text-xs text-fg-muted"
          onKeyDown={(event) => {
            // Let the native disclosure activate without cmdk submitting its selected command.
            // Escape and navigation shortcuts still reach their existing owners.
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
        >
          <summary>Search coverage</summary>
          <p className="mt-1 break-words">{group.coverage}</p>
        </details>
      )}
    </section>
  ));
}

export function PaletteResourcePreview({ resource, scope }: { resource: LibraryResource; scope: PaletteScope }) {
  const { activeWorkspaceId, activeCitadelId } = useUiPreferences();
  if (activeWorkspaceId !== scope.workspaceId || activeCitadelId !== scope.citadelId) {
    return (
      <p role="status" className="text-sm text-fg-secondary">
        The selected workspace changed. Search again to inspect its resources.
      </p>
    );
  }
  return <LibraryResourceDetail resource={resource} workspaceId={scope.workspaceId} citadelId={scope.citadelId} />;
}
