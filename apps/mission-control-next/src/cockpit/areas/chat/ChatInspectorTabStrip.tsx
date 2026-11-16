import { useScrollEdges } from "../../ui/use-scroll-edges";
import { TABS, type ChatInspectorTab } from "./chat-inspector-evidence";

/**
 * The inspector's tab list. It owns the edge measuring so the hook mounts together with the strip: the inspector body
 * renders the strip only once a conversation is open, and a measure taken before that would find no element.
 */
export function ChatInspectorTabStrip({
  tab,
  onSelect,
}: {
  tab: ChatInspectorTab;
  onSelect: (tab: ChatInspectorTab) => void;
}) {
  const { ref, start, end } = useScrollEdges<HTMLDivElement>([]);
  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Conversation inspector"
      data-overflow-start={start || undefined}
      data-overflow-end={end || undefined}
      className="cockpit-overflow-fade flex gap-1 overflow-x-auto whitespace-nowrap rounded-md bg-sunken p-1"
    >
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
          className="min-h-8 shrink-0 rounded-md px-2 text-xs font-medium text-fg-secondary hover:bg-raised aria-selected:bg-raised aria-selected:text-fg"
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}
