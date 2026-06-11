import { memo, useMemo, useState } from "react";

/*
 * Owns the file picker filter query so typing re-renders the picker only,
 * not the whole CodeWorkbenchPanel. Handlers must be referentially stable
 * for the memo() to hold.
 */

const FILE_PICKER_RESULT_LIMIT = 12;

interface WorkbenchFilePickerProps {
  items: ReadonlyArray<{ path: string }>;
  onSelect: (path: string) => void;
  onClose: () => void;
}

export const WorkbenchFilePicker = memo(function WorkbenchFilePicker({
  items,
  onSelect,
  onClose,
}: WorkbenchFilePickerProps) {
  const [query, setQuery] = useState("");
  const filteredItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      return items.slice(0, FILE_PICKER_RESULT_LIMIT);
    }
    return items.filter((item) => item.path.toLowerCase().includes(normalized)).slice(0, FILE_PICKER_RESULT_LIMIT);
  }, [items, query]);

  return (
    <section className="mc-next-workbench-command-surface" aria-label="Workbench file picker">
      <div className="mc-next-panel-list-head">
        <strong>File picker</strong>
        <button type="button" className="mc-next-panel-button" onClick={onClose}>
          Close
        </button>
      </div>
      <input
        className="mc-next-workbench-command-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter files"
        aria-label="Filter files"
      />
      {filteredItems.length > 0 ? (
        <ul className="mc-next-workbench-command-list">
          {filteredItems.map((item) => (
            <li key={item.path}>
              <button type="button" className="mc-next-panel-button" onClick={() => onSelect(item.path)}>
                {item.path}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mc-next-workbench-empty">No matching files.</p>
      )}
    </section>
  );
});
