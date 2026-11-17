import { TABS, type ChatInspectorTab } from "./chat-inspector-evidence";

export function ChatInspectorTabStrip({
  tab,
  onSelect,
}: {
  tab: ChatInspectorTab;
  onSelect: (tab: ChatInspectorTab) => void;
}) {
  return (
    <div role="tablist" aria-label="Conversation inspector" className="flex flex-wrap gap-1 rounded-md bg-sunken p-1">
      {TABS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          aria-selected={tab === entry.id}
          id={`cockpit-inspector-tab-${entry.id}`}
          tabIndex={tab === entry.id ? 0 : -1}
          aria-controls={`cockpit-inspector-${entry.id}`}
          onClick={() => onSelect(entry.id)}
          onKeyDown={(event) => {
            const index = TABS.findIndex((item) => item.id === tab);
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % TABS.length
                : event.key === "ArrowLeft"
                  ? (index + TABS.length - 1) % TABS.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? TABS.length - 1
                      : -1;
            if (next < 0) return;
            event.preventDefault();
            onSelect(TABS[next]!.id);
            (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
          }}
          className="min-h-8 rounded-md px-2 text-xs font-medium text-fg-secondary hover:bg-raised aria-selected:bg-raised aria-selected:text-fg max-sm:min-h-11"
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
